import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { whisperServerBin, modelPath } from './paths';
import type { Config } from './config';

/**
 * Ciclo de vida do whisper-server.
 *
 * O ponto central do projeto: **nada de IA fica vivo enquanto você não usa**.
 * O servidor sobe no momento em que você aperta o atalho (em paralelo com a
 * gravação, para o modelo já estar quente quando você parar de falar) e é
 * derrubado depois de `keepModelWarmMs` sem uso.
 */

export class WhisperError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'WhisperError';
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Não foi possível reservar uma porta.')));
      }
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
  });
}

export type WhisperState = 'stopped' | 'loading' | 'ready';

export class WhisperService {
  private process: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail = '';
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  setConfig(config: Config): void {
    const modelChanged =
      config.model !== this.config.model ||
      config.threads !== this.config.threads ||
      config.beamSize !== this.config.beamSize ||
      config.language !== this.config.language;
    this.config = config;
    // Trocar de modelo só faz efeito no próximo carregamento.
    if (modelChanged) this.shutdown();
  }

  get state(): WhisperState {
    if (!this.process) return 'stopped';
    return this.starting ? 'loading' : 'ready';
  }

  /** Sobe o servidor se necessário. Chamadas concorrentes compartilham a mesma promise. */
  async ensureReady(): Promise<void> {
    this.cancelIdleTimer();
    if (this.process && !this.starting) return;
    if (this.starting) return this.starting;

    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const model = modelPath(this.config.model);
    if (!fs.existsSync(model)) {
      throw new WhisperError(
        'MODEL_MISSING',
        `Modelo não instalado: ${this.config.model}.`
      );
    }
    if (!fs.existsSync(whisperServerBin)) {
      throw new WhisperError(
        'SERVER_MISSING',
        'whisper-server não compilado. Rode "npm run setup".'
      );
    }

    this.port = await findFreePort();
    this.stderrTail = '';

    const args = [
      '-m', model,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '-t', String(this.config.threads),
      '-l', this.config.language,
      '-bs', String(this.config.beamSize),
      '-nt', // sem timestamps: queremos texto puro para colar
    ];

    const child = spawn(whisperServerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = child;

    const collect = (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let exited = false;
    child.on('exit', () => {
      exited = true;
      if (this.process === child) this.process = null;
    });
    child.on('error', () => {
      exited = true;
      if (this.process === child) this.process = null;
    });

    // O servidor só abre a porta depois de carregar o modelo, então "porta
    // aceitando conexão" é um sinal de prontidão confiável.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (exited) {
        throw new WhisperError(
          'MODEL_LOAD_FAILED',
          `O modelo não carregou. ${this.lastErrorLine()}`
        );
      }
      if (await canConnect(this.port)) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    this.shutdown();
    throw new WhisperError('MODEL_LOAD_TIMEOUT', 'O modelo demorou demais para carregar.');
  }

  private lastErrorLine(): string {
    const lines = this.stderrTail
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines[lines.length - 1] ?? '';
  }

  async transcribe(wavPath: string, prompt: string): Promise<string> {
    await this.ensureReady();

    const audio = await fs.promises.readFile(wavPath);
    // Um servidor que TRAVA (sem morrer) deixava este fetch pendurado para
    // sempre: a sessão ficava em "transcrevendo…" e o app ignorava qualquer
    // toggle até ser reiniciado. O teto é proporcional ao áudio, com folga
    // para CPU fraca: um i3 leva ~4x o tempo real, e aqui cabe 8x.
    const audioSeconds = audio.length / 32_000; // 16 kHz, 16 bits, mono
    const timeoutMs = 30_000 + Math.ceil(audioSeconds * 8_000);
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('language', this.config.language);
    form.append('temperature', '0.0');
    form.append('temperature_inc', '0.2');
    if (prompt) {
      form.append('prompt', prompt);
      // Sem isto o glossário vale só para os primeiros 30 s de áudio: nas
      // janelas seguintes o whisper substitui o prompt pelo texto já
      // decodificado. Ditados longos perdiam o viés no meio do caminho.
      form.append('carry_initial_prompt', 'true');
    }

    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Servidor morto OU pendurado: nos dois casos ele não merece confiança,
      // derruba e o próximo ditado sobe um limpo.
      this.shutdown();
      if ((error as Error).name === 'TimeoutError') {
        throw new WhisperError(
          'TRANSCRIBE_FAILED',
          `A transcrição passou de ${Math.round(timeoutMs / 1000)}s e foi abortada.`
        );
      }
      throw new WhisperError(
        'TRANSCRIBE_FAILED',
        `Falha ao falar com o servidor local: ${(error as Error).message}`
      );
    }

    if (!response.ok) {
      throw new WhisperError(
        'TRANSCRIBE_FAILED',
        `whisper-server respondeu ${response.status}. ${this.lastErrorLine()}`
      );
    }

    const payload = (await response.json()) as { text?: string; error?: string };
    if (payload.error) throw new WhisperError('TRANSCRIBE_FAILED', payload.error);
    return (payload.text ?? '').trim();
  }

  /** Agenda o descarregamento. Chamado depois de cada transcrição. */
  scheduleUnload(): void {
    this.cancelIdleTimer();
    if (!this.process) return;
    if (this.config.keepModelWarmMs <= 0) {
      this.shutdown();
      return;
    }
    this.idleTimer = setTimeout(() => this.shutdown(), this.config.keepModelWarmMs);
    this.idleTimer.unref();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  shutdown(): void {
    this.cancelIdleTimer();
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.kill('SIGTERM');
    // Se não sair sozinho em 2s, não insistimos com educação.
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    force.unref();
  }
}
