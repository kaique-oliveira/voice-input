import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, clipboard, Notification } from 'electron';
import { tmpDir } from './paths';
import { loadConfig, type Config, type Mode } from './config';
import { loadDictionary } from './dictionary';
import { buildPrompt, termsFromDictionary } from './glossary';
import { correct } from './corrector';
import { resolveMode, type FrontApp } from './context';
import * as helper from './helper';
import * as overlay from './overlay';
import { log } from './log';
import { WhisperService, WhisperError } from './whisper';

/**
 * A máquina de estados do app. É aqui que o fluxo inteiro vive:
 *
 *   idle → recording → (loading) → transcribing → correcting → pasting → idle
 *
 * Detalhe que importa para a latência percebida: o modelo começa a carregar
 * no mesmo instante em que a gravação começa. Enquanto você fala, o whisper
 * esquenta. Quando você para, quase sempre ele já está pronto.
 */

export type SessionState =
  | 'idle'
  | 'recording'
  | 'loading'
  | 'transcribing'
  | 'correcting'
  | 'pasting';

/**
 * O próprio app nunca pode ser alvo da colagem. Inclui o bundle do Electron
 * porque em desenvolvimento é ele que hospeda o app.
 */
const SELF_BUNDLE_IDS = new Set(['com.voiceinput.app', 'com.github.Electron']);

const STATE_LABELS: Record<SessionState, string> = {
  idle: 'Pronto',
  recording: 'Gravando…',
  loading: 'Carregando modelo…',
  transcribing: 'Transcrevendo…',
  correcting: 'Corrigindo…',
  pasting: 'Colando…',
};

/** Mensagens acionáveis: cada erro diz o que fazer, não só o que quebrou. */
const ERROR_MESSAGES: Record<string, string> = {
  MIC_DENIED:
    'Permissão de microfone negada. Ajustes → Privacidade e Segurança → Microfone.',
  NO_INPUT_DEVICE: 'Nenhum microfone disponível. Conecte um dispositivo de entrada.',
  ENGINE_FAIL: 'Não foi possível iniciar a captura de áudio.',
  WRITE_FAIL: 'Não foi possível gravar o arquivo de áudio temporário.',
  AX_DENIED:
    'Sem permissão de Acessibilidade para colar. O texto está na área de transferência, cole com ⌘V.',
  PASTE_FAILED:
    'Não consegui colar neste app. O texto está na área de transferência, cole com ⌘V.',
  EMPTY_TEXT: 'Nada para colar.',
  EMPTY_AUDIO: 'Não ouvi nada. Fale um pouco mais perto do microfone.',
  TOO_SHORT: 'Gravação curta demais.',
  MODEL_MISSING: 'Modelo não instalado. Abra Configurações e clique em Baixar.',
  SERVER_MISSING: 'whisper-server não encontrado. Reinstale o app.',
  MODEL_LOAD_FAILED: 'O modelo não carregou. Verifique memória disponível e o arquivo do modelo.',
  MODEL_LOAD_TIMEOUT: 'O modelo demorou demais para carregar.',
  TRANSCRIBE_FAILED: 'Falha na transcrição.',
  HELPER_MISSING: 'vox-helper não encontrado. Rode "npm run build".',
  TIMEOUT: 'A operação demorou demais.',
};

export interface SessionEvents {
  state: [SessionState];
  error: [{ code: string; message: string }];
  transcript: [{ text: string; mode: Mode; seconds: number; ms: number }];
}

export class Session extends EventEmitter {
  private currentState: SessionState = 'idle';
  private recording: helper.Recording | null = null;
  private wavPath = '';
  private warmup: Promise<void> | null = null;
  private frontAppPromise: Promise<FrontApp | null> = Promise.resolve(null);
  private maxDurationTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  /** Último app que não era o nosso, alvo de reserva para a colagem. */
  private lastExternalApp: FrontApp | null = null;

  readonly whisper: WhisperService;

  constructor() {
    super();
    this.whisper = new WhisperService(loadConfig());
  }

  get state(): SessionState {
    return this.currentState;
  }

  get stateLabel(): string {
    return STATE_LABELS[this.currentState];
  }

  get busy(): boolean {
    return this.currentState !== 'idle' && this.currentState !== 'recording';
  }

  private setState(state: SessionState): void {
    this.currentState = state;
    log.info(`estado: ${state}`);
    if (state !== 'idle' && state !== 'recording') overlay.showBusy(STATE_LABELS[state]);
    this.emit('state', state);
  }

  /**
   * Ponto de entrada único, atalho global, clique no ícone ou menu.
   * `source` só existe para o log: é como se descobre se o atalho global
   * está mesmo chegando até aqui.
   */
  async toggle(source = 'atalho'): Promise<void> {
    log.info(`toggle via ${source} (estado ${this.currentState})`);
    if (this.currentState === 'idle') return this.begin();
    if (this.currentState === 'recording') return this.finish();
    // Ocupado processando: ignorar é melhor que enfileirar outra gravação.
  }

  private async begin(): Promise<void> {
    const config = loadConfig();
    this.whisper.setConfig(config);

    this.wavPath = path.join(tmpDir, `rec-${Date.now()}.wav`);
    this.startedAt = Date.now();

    // Os dois processos sobem juntos: ler o app em foco não custa latência
    // porque acontece enquanto o gravador ainda está inicializando.
    const frontPromise = helper.frontApp();
    const recordPromise = helper.startRecording(this.wavPath);
    // Uma falha na gravação enquanto esperamos o frontApp não pode virar
    // unhandled rejection. O erro real continua tratado no await lá embaixo.
    recordPromise.catch(() => undefined);

    this.setState('recording');
    this.play('Tink');

    // A ordem aqui não é estética. Ler o app em foco tem de vir ANTES de
    // qualquer janela nossa aparecer: criar o overlay torna o Voice Input o
    // app frontmost, e o alvo da colagem viraria o próprio app.
    const target = await this.resolveTarget(await frontPromise);
    this.frontAppPromise = Promise.resolve(target);
    log.info(`app alvo: ${target?.name ?? '…'} (${target?.bundleId ?? '…'})`);

    overlay.showRecording(this.startedAt);

    // Aquece o modelo em paralelo com a fala. O catch evita rejeição solta;
    // o erro real é recuperado em finish().
    this.warmup = this.whisper.ensureReady();
    this.warmup.catch(() => undefined);

    try {
      this.recording = await recordPromise;
      log.info('gravando');
    } catch (error) {
      overlay.hide();
      this.setState('idle');
      this.reportError(error);
      return;
    }

    this.maxDurationTimer = setTimeout(() => {
      if (this.currentState === 'recording') void this.finish();
    }, config.maxRecordingSec * 1000);
  }

  private async finish(): Promise<void> {
    const config = loadConfig();
    const recording = this.recording;
    this.recording = null;
    this.clearMaxDurationTimer();
    if (!recording) {
      this.setState('idle');
      return;
    }

    const startedProcessing = Date.now();
    this.setState('transcribing');

    try {
      const { seconds, peak } = await recording.stop();
      log.info(`gravação: ${seconds.toFixed(2)}s, pico ${peak.toFixed(4)}`);

      if (seconds < config.minRecordingSec) throw new SessionError('TOO_SHORT');
      if (peak < config.minPeak) throw new SessionError('EMPTY_AUDIO');

      // Se o modelo ainda não subiu, é agora que o usuário precisa saber.
      if (this.whisper.state !== 'ready') this.setState('loading');
      await (this.warmup ?? this.whisper.ensureReady());
      this.setState('transcribing');

      const front = await this.frontAppPromise;
      const mode = resolveMode(config, front);
      const dictionary = loadDictionary();
      const prompt = config.useGlossaryPrompt
        ? buildPrompt(mode, termsFromDictionary(dictionary))
        : '';

      const raw = await this.whisper.transcribe(this.wavPath, prompt);
      // Nunca registramos o texto em si, só o tamanho, para diagnóstico.
      log.info(`transcrito: ${raw.length} caracteres, modo ${mode}`);

      this.setState('correcting');
      const useDictionary =
        config.useDictionary && (mode === 'developer' || config.dictionaryInNormalMode);
      const result = correct(raw, { mode, dictionary, useDictionary });
      if (result.empty) throw new SessionError('EMPTY_AUDIO');

      this.setState('pasting');
      await this.insert(result.text, config, front?.bundleId);
      log.info(
        config.insertMode === 'clipboard'
          ? `copiado para a área de transferência (${Date.now() - startedProcessing} ms)`
          : `colado em ${front?.name ?? '?'} (${Date.now() - startedProcessing} ms)`
      );

      this.emit('transcript', {
        text: result.text,
        mode,
        seconds,
        ms: Date.now() - startedProcessing,
      });
      this.play('Pop');
      this.setState('idle');
    } catch (error) {
      this.setState('idle');
      this.reportError(error);
    } finally {
      overlay.hide();
      this.cleanupWav();
      this.whisper.scheduleUnload();
      this.warmup = null;
    }
  }

  /**
   * Colar via ⌘V sintético. Se a Acessibilidade não estiver liberada, o texto
   * pelo menos fica na área de transferência, melhor perder o "automático"
   * do que perder o que você falou.
   */
  private async insert(text: string, config: Config, bundleId?: string): Promise<void> {
    // A transcrição vai para a área de transferência ANTES de qualquer
    // tentativa de colar. Colar tem várias formas de falhar que não dependem
    // de nós: campo protegido por Secure Input, app que ignora ⌘V, permissão
    // revogada. Em todas elas o texto continua recuperável com um ⌘V manual.
    clipboard.writeText(text);

    if (config.insertMode === 'clipboard') {
      new Notification({
        title: 'Voice Input: copiado',
        body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
      }).show();
      return;
    }

    try {
      await helper.paste(text, {
        restoreClipboard: config.restoreClipboard,
        preDelayMs: config.pasteDelayMs,
        // Devolve o foco ao app de origem caso o overlay ou outra coisa o
        // tenha tirado no meio do caminho.
        ensureFrontApp: bundleId,
      });
    } catch (error) {
      const code = error instanceof helper.HelperError ? error.code : 'desconhecido';
      log.error(`colagem falhou [${code}], texto preservado na área de transferência`);
      // AX_DENIED tem conserto e merece a mensagem própria. O resto vira um
      // aviso único que diz o que fazer agora.
      if (error instanceof helper.HelperError && error.code === 'AX_DENIED') throw error;
      throw new SessionError('PASTE_FAILED');
    }
  }

  /** Cancela a gravação em andamento sem transcrever. */
  cancel(): void {
    if (this.currentState !== 'recording') return;
    log.info('gravação cancelada');
    this.clearMaxDurationTimer();
    this.recording?.abort();
    this.recording = null;
    overlay.hide();
    this.cleanupWav();
    this.whisper.scheduleUnload();
    this.setState('idle');
  }

  /**
   * Decide para onde o texto volta.
   *
   * Se o Voice Input for o app em foco, a janela de Configurações aberta, por
   * exemplo, colar nele seria inútil. `app.hide()` devolve o foco a quem
   * estava antes, que é exatamente o alvo que queremos.
   */
  private async resolveTarget(front: FrontApp | null): Promise<FrontApp | null> {
    if (front && front.bundleId && !SELF_BUNDLE_IDS.has(front.bundleId)) {
      this.lastExternalApp = front;
      return front;
    }

    log.info('o próprio app estava em foco, devolvendo o foco ao anterior');
    app.hide();
    await new Promise((resolve) => setTimeout(resolve, 180));

    const retry = await helper.frontApp();
    if (retry && retry.bundleId && !SELF_BUNDLE_IDS.has(retry.bundleId)) {
      this.lastExternalApp = retry;
      return retry;
    }
    // Ainda nós: usa o último app externo conhecido, ou desiste de forçar o
    // foco e cola onde estiver.
    return this.lastExternalApp;
  }

  private clearMaxDurationTimer(): void {
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }

  private cleanupWav(): void {
    if (!this.wavPath) return;
    // Privacidade: o áudio existe só entre a fala e a transcrição.
    fs.promises.unlink(this.wavPath).catch(() => undefined);
    this.wavPath = '';
  }

  private play(sound: 'Tink' | 'Pop' | 'Basso'): void {
    if (!loadConfig().playSounds) return;
    // Feedback sonoro importa: você não olha para a barra de menu enquanto fala.
    const child = spawn('/usr/bin/afplay', [`/System/Library/Sounds/${sound}.aiff`], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    child.on('error', () => undefined);
  }

  get recordingElapsedMs(): number {
    return this.currentState === 'recording' && this.startedAt > 0
      ? Date.now() - this.startedAt
      : 0;
  }

  private reportError(error: unknown): void {
    const code =
      error instanceof SessionError ||
      error instanceof helper.HelperError ||
      error instanceof WhisperError
        ? error.code
        : 'UNKNOWN';
    const message =
      ERROR_MESSAGES[code] ?? (error instanceof Error ? error.message : 'Erro inesperado.');

    log.error(`falhou [${code}] ${message}`, error);
    this.play('Basso');
    this.emit('error', { code, message });

    new Notification({ title: 'Voice Input', body: message }).show();
  }
}

class SessionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
