import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { llamaServerBin as serverBin, modelPath } from './paths';
import { log } from './log';
import type { Config } from './config';

/**
 * Modelo de linguagem local, usado só para arrumar a estrutura da fala.
 *
 * Mesmo desenho do `whisper.ts`, e de propósito: sobe sob demanda, atende por
 * HTTP em 127.0.0.1 e morre depois de um tempo sem uso. Parado, o app continua
 * sem nada de IA na memória.
 *
 * Nenhum byte sai da máquina. O llama-server só escuta no loopback.
 */

export class LlmError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'LlmError';
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

export class LlmService {
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
    const changed = config.polishModel !== this.config.polishModel;
    this.config = config;
    if (changed) this.shutdown();
  }

  get available(): boolean {
    return fs.existsSync(serverBin) && fs.existsSync(modelPath(this.config.polishModel));
  }

  get loaded(): boolean {
    return this.process !== null && this.starting === null;
  }

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
    if (!fs.existsSync(serverBin)) {
      throw new LlmError('LLM_SERVER_MISSING', 'llama-server não encontrado.');
    }
    const model = modelPath(this.config.polishModel);
    if (!fs.existsSync(model)) {
      throw new LlmError('LLM_MODEL_MISSING', `Modelo de polimento não instalado.`);
    }

    this.port = await findFreePort();
    this.stderrTail = '';

    const args = [
      '-m', model,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      // Contexto curto: entra uma transcrição, sai uma transcrição. Menos
      // contexto significa menos memória e carregamento mais rápido.
      '-c', '4096',
      '-ngl', '99', // tudo na GPU; no Metal isso é o que torna o passo viável
      '--no-webui',
      '-t', String(this.config.threads),
    ];

    const child = spawn(serverBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (exited) {
        throw new LlmError('LLM_LOAD_FAILED', `O modelo não carregou. ${this.lastErrorLine()}`);
      }
      if (await canConnect(this.port)) {
        log.info('modelo de polimento carregado');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    this.shutdown();
    throw new LlmError('LLM_LOAD_TIMEOUT', 'O modelo de polimento demorou demais.');
  }

  private lastErrorLine(): string {
    const lines = this.stderrTail.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? '';
  }

  /** Uma volta de conversa, sem histórico: cada ditado é independente. */
  async complete(system: string, user: string, maxTokens: number): Promise<string> {
    await this.ensureReady();

    const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // Temperatura zero: queremos a correção mais provável, não criatividade.
        temperature: 0,
        top_p: 1,
        max_tokens: maxTokens,
        stream: false,
        // O Qwen3 raciocina em voz alta antes de responder, o que aqui só
        // custaria segundos: não há o que deliberar em "onde vai a vírgula".
        // Modelo que não tem esse modo ignora o parâmetro.
        chat_template_kwargs: { enable_thinking: false },
      }),
    });

    if (!response.ok) {
      throw new LlmError('LLM_FAILED', `llama-server respondeu ${response.status}.`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content ?? '';
  }

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
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    force.unref();
  }
}
