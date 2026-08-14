import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, clipboard, Notification, shell } from 'electron';
import { tmpDir } from './paths';
import { loadConfig, type Config, type Mode, type SystemSound } from './config';
import { loadDictionary } from './dictionary';
import { buildPrompt, termsFromDictionary } from './glossary';
import { conversational, correct } from './corrector';
import { resolveMode, type FrontApp } from './context';
import * as helper from './helper';
import * as platform from './platform';
import * as overlay from './overlay';
import { hideSettings } from './settings';
import { log } from './log';
import { WhisperService, WhisperError } from './whisper';
import { LlmService } from './llm';
import { POLISH_SYSTEM_PROMPT, cleanModelOutput, isFaithful } from './polish';

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
  | 'polishing'
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
  polishing: 'Ajustando o texto…',
  pasting: 'Colando…',
};

/** A tecla de colar tem nome diferente em cada sistema, e as mensagens citam ela. */
const PASTE_KEY = platform.isMac ? '⌘V' : 'Ctrl+V';

/** Mensagens acionáveis: cada erro diz o que fazer, não só o que quebrou. */
const ERROR_MESSAGES: Record<string, string> = {
  MIC_DENIED: platform.isMac
    ? 'Permissão de microfone negada. Ajustes → Privacidade e Segurança → Microfone.'
    : 'Permissão de microfone negada. Libere o microfone nas configurações de privacidade do sistema.',
  NO_INPUT_DEVICE: 'Nenhum microfone disponível. Conecte um dispositivo de entrada.',
  ENGINE_FAIL: 'Não foi possível iniciar a captura de áudio.',
  WRITE_FAIL: 'Não foi possível gravar o arquivo de áudio temporário.',
  AX_DENIED:
    `Sem permissão de Acessibilidade para colar. O texto está na área de transferência, cole com ${PASTE_KEY}.`,
  PASTE_UNAVAILABLE:
    'Colagem automática não disponível aqui. O texto está na área de transferência, cole com Ctrl+V.',
  PASTE_FAILED:
    `Não consegui colar neste app. O texto está na área de transferência, cole com ${PASTE_KEY}.`,
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
  private warnedAboutAccessibility = false;
  /** Suspensão do áudio do sistema, pendente de restauração. */
  private audioSuspension: Promise<platform.AudioState> | null = null;

  readonly whisper: WhisperService;
  readonly llm: LlmService;

  constructor() {
    super();
    this.whisper = new WhisperService(loadConfig());
    this.llm = new LlmService(loadConfig());
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
    this.llm.setConfig(config);

    this.wavPath = path.join(tmpDir, `rec-${Date.now()}.wav`);
    this.startedAt = Date.now();

    // Ninguém dita e configura ao mesmo tempo. Deixar a janela aberta faz ela
    // saltar na frente do app de destino assim que o nosso app ganha foco.
    hideSettings();

    // Os dois processos sobem juntos: ler o app em foco não custa latência
    // porque acontece enquanto o gravador ainda está inicializando.
    const frontPromise = platform.frontApp();
    const recordPromise = platform.startRecording(this.wavPath);
    // Sai na frente para o som parar antes de o microfone captá-lo. Roda em
    // paralelo com o gravador, então não custa latência.
    this.audioSuspension = platform.suspendAudio(config.audioWhileRecording);
    this.audioSuspension.catch(() => undefined);
    // Uma falha na gravação enquanto esperamos o frontApp não pode virar
    // unhandled rejection. O erro real continua tratado no await lá embaixo.
    recordPromise.catch(() => undefined);

    this.setState('recording');
    this.play(config.soundStart, false);

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
    // O segundo estágio também esquenta durante a fala. Ele carrega em menos
    // de um segundo, mas de graça é melhor.
    if (config.polish && this.llm.available) this.llm.ensureReady().catch(() => undefined);

    try {
      this.recording = await recordPromise;
      log.info('gravando');
    } catch (error) {
      void this.restoreAudio();
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
      // Devolve o som agora, e não no fim: você apertou parar, a música volta.
      // Transcrever e colar acontecem depois, em silêncio nenhum.
      void this.restoreAudio();
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

      // Duas tentativas: falha transitória (servidor que morreu ou travou;
      // nos dois casos ele já foi derrubado) ganha um novo servidor limpo.
      // Erro determinístico (modelo ausente, sem binário) estoura direto.
      let raw: string;
      try {
        raw = await this.whisper.transcribe(this.wavPath, prompt);
      } catch (error) {
        const transient =
          error instanceof WhisperError && error.code === 'TRANSCRIBE_FAILED';
        if (!transient) throw error;
        log.warn('transcrição falhou, segunda tentativa com servidor novo');
        this.setState('loading');
        raw = await this.whisper.transcribe(this.wavPath, prompt);
        this.setState('transcribing');
      }
      // Nunca registramos o texto em si, só o tamanho, para diagnóstico.
      log.info(`transcrito: ${raw.length} caracteres, modo ${mode}`);

      this.setState('correcting');
      const useDictionary =
        config.useDictionary && (mode === 'developer' || config.dictionaryInNormalMode);
      const result = correct(raw, {
        mode,
        dictionary,
        useDictionary,
        removeDisfluencies: config.removeDisfluencies,
        conversationalPunctuation: config.conversationalPunctuation,
      });
      if (result.empty) throw new SessionError('EMPTY_AUDIO');

      let finalText = result.text;
      if (config.polish && this.llm.available) {
        this.setState('polishing');
        finalText = await this.polish(finalText);
        // O modelo pontua como prosa, então a pontuação de conversa é aplicada
        // de novo por cima do que ele devolveu.
        if (config.conversationalPunctuation) {
          finalText = conversational(
            finalText,
            new Set(Object.values(dictionary).map((value) => value.toLowerCase()))
          );
        }
      }

      this.setState('pasting');
      const outcome = await this.insert(finalText, config, front?.bundleId);
      log.info(
        config.insertMode === 'clipboard'
          ? `copiado para a área de transferência (${Date.now() - startedProcessing} ms)`
          : `colado em ${front?.name ?? '?'} (${Date.now() - startedProcessing} ms)`
      );

      this.emit('transcript', {
        text: finalText,
        mode,
        seconds,
        ms: Date.now() - startedProcessing,
      });
      this.play(outcome === 'pasted' ? config.soundPasted : config.soundClipboard);
      this.setState('idle');
    } catch (error) {
      this.setState('idle');
      this.reportError(error);
    } finally {
      // Rede de segurança: se algo estourou antes do restore acima, o áudio
      // não pode ficar mudo para sempre.
      void this.restoreAudio();
      overlay.hide();
      this.cleanupWav();
      this.whisper.scheduleUnload();
      this.llm.scheduleUnload();
      this.warmup = null;
    }
  }

  /**
   * Colar via ⌘V sintético. Se a Acessibilidade não estiver liberada, o texto
   * pelo menos fica na área de transferência, melhor perder o "automático"
   * do que perder o que você falou.
   */
  private async insert(
    text: string,
    config: Config,
    bundleId?: string
  ): Promise<'pasted' | 'clipboard'> {
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
      return 'clipboard';
    }

    try {
      const result = await platform.paste(text, {
        restoreClipboard: config.restoreClipboard,
        preDelayMs: config.pasteDelayMs,
        // Devolve o foco ao app de origem caso o overlay ou outra coisa o
        // tenha tirado no meio do caminho.
        ensureFrontApp: bundleId,
      });
      // Se o foco não estava no alvo, alguma janela nossa se meteu na frente.
      if (bundleId && result.frontBefore && result.frontBefore !== bundleId) {
        log.warn(`foco estava em ${result.frontBefore}, devolvido para ${bundleId}`);
      }
      return 'pasted';
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
    void this.restoreAudio();
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

    const retry = await platform.frontApp();
    if (retry && retry.bundleId && !SELF_BUNDLE_IDS.has(retry.bundleId)) {
      this.lastExternalApp = retry;
      return retry;
    }
    // Ainda nós: usa o último app externo conhecido, ou desiste de forçar o
    // foco e cola onde estiver.
    return this.lastExternalApp;
  }

  /**
   * Segundo estágio, com rede de proteção.
   *
   * Nunca lança e nunca piora: qualquer falha, timeout ou saída reprovada pela
   * verificação de fidelidade devolve o texto que entrou. O modelo de
   * linguagem é uma sugestão que precisa passar na conferência, não uma
   * autoridade sobre o que você falou.
   */
  private async polish(text: string): Promise<string> {
    const started = Date.now();
    try {
      const raw = await this.llm.complete(
        POLISH_SYSTEM_PROMPT,
        text,
        // Teto generoso: cortar no meio produziria texto truncado, que a
        // verificação reprovaria de qualquer forma.
        Math.min(2048, Math.ceil(text.length / 2) + 256)
      );
      const candidate = cleanModelOutput(raw);
      const check = isFaithful(text, candidate);
      if (!check.ok) {
        log.warn(`polimento descartado: ${check.reason} (${Date.now() - started} ms)`);
        return text;
      }
      log.info(`polimento aplicado (${Date.now() - started} ms)`);
      return candidate;
    } catch (error) {
      log.error('polimento falhou, seguindo com o texto original', error);
      return text;
    }
  }

  /**
   * Devolve o áudio do sistema ao estado anterior. Idempotente: pode ser
   * chamada por vários caminhos de saída sem desfazer duas vezes.
   */
  private async restoreAudio(): Promise<void> {
    const pending = this.audioSuspension;
    this.audioSuspension = null;
    if (!pending) return;
    try {
      await platform.restoreAudio(await pending);
    } catch (error) {
      log.error('falha ao restaurar o áudio do sistema', error);
    }
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

  private play(sound: SystemSound, fallbackBeep = true): void {
    if (!loadConfig().playSounds) return;
    // Feedback sonoro importa: você não olha para a barra de menu enquanto fala.
    if (!platform.isMac) {
      // Fora do macOS não existe a biblioteca de sons do sistema. O beep
      // padrão cobre os desfechos; o início fica mudo para não virar eco na
      // própria gravação.
      if (fallbackBeep) shell.beep();
      return;
    }
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
    // Colagem que falha não é a mesma coisa que ditado perdido: o texto está
    // inteiro na área de transferência, só falta o ⌘V. Merece o som de "quase",
    // não o de erro.
    const config = loadConfig();
    const salvaged = code === 'AX_DENIED' || code === 'PASTE_FAILED';
    this.play(salvaged ? config.soundClipboard : config.soundError);
    this.emit('error', { code, message });

    new Notification({ title: 'Voice Input', body: message }).show();

    // Falta de Acessibilidade quebra a função principal do app e tem conserto
    // em dois cliques. Abrimos as Configurações uma única vez por execução:
    // repetir a cada ditado seria pior que o problema.
    if (code === 'AX_DENIED' && !this.warnedAboutAccessibility) {
      this.warnedAboutAccessibility = true;
      this.emit('needs-accessibility');
    }
  }
}

class SessionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
