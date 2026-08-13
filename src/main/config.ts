import fs from 'node:fs';
import os from 'node:os';
import { configFile } from './paths';
import { DEFAULT_APP_MODES, DEFAULT_NAME_RULES } from './context';

export type Mode = 'developer' | 'normal';

/** Sons de /System/Library/Sounds. Todo macOS tem estes. */
export type SystemSound =
  | 'Basso' | 'Blow' | 'Bottle' | 'Frog' | 'Funk' | 'Glass' | 'Hero'
  | 'Morse' | 'Ping' | 'Pop' | 'Purr' | 'Sosumi' | 'Submarine' | 'Tink';

export interface Config {
  /** Acelerador no formato do Electron. */
  shortcut: string;
  /** Idioma passado ao Whisper. 'auto' detecta, mas custa qualidade. */
  language: string;
  model: string;
  threads: number;
  /**
   * Busca em feixe. 5 melhora sensivelmente termos técnicos; 1 (guloso) é
   * ~2x mais rápido. Vale medir com `npm run bench`.
   */
  beamSize: number;
  /** 'auto' resolve pelo app em foco; senão força um modo. */
  mode: 'auto' | Mode;
  /** Usado quando o app em foco não está mapeado. */
  fallbackMode: Mode;
  appModes: Record<string, Mode>;
  nameRules: Array<{ pattern: string; mode: Mode }>;
  /** Quanto tempo o modelo fica em RAM depois do uso. 0 = descarrega já. */
  keepModelWarmMs: number;
  maxRecordingSec: number;
  /** Abaixo disso consideramos que você não falou nada. */
  minRecordingSec: number;
  /** Pico de amplitude mínimo para considerar que houve voz. */
  minPeak: number;
  useGlossaryPrompt: boolean;
  useDictionary: boolean;
  /**
   * Remover gagueira, som de hesitação e trecho repetido enquanto se pensa.
   * É subtração pura: nada é reescrito, só sai o que não foi dito de verdade.
   */
  removeDisfluencies: boolean;
  /** Aplicar o dicionário técnico também no modo normal (WhatsApp etc). */
  dictionaryInNormalMode: boolean;
  /**
   * Pontuar como conversa: ponto final no meio do texto vira vírgula, a
   * palavra seguinte perde a maiúscula que só existia por causa dele, e o
   * texto nunca termina em ponto. É onde o texto vai parar que manda: em
   * mensagem e em prompt ninguém escreve como em livro.
   */
  conversationalPunctuation: boolean;
  /**
   * 'paste' cola sozinho com ⌘V no app de origem.
   * 'clipboard' só copia e avisa, você cola quando e onde quiser.
   */
  insertMode: 'paste' | 'clipboard';
  /**
   * Segundo estágio: um modelo de linguagem local pontua e capitaliza, e só.
   * A saída dele é comparada palavra por palavra com a entrada; qualquer
   * palavra diferente descarta o polimento inteiro.
   */
  polish: boolean;
  polishModel: string;
  /**
   * O que fazer com o áudio que estiver tocando enquanto você grava.
   * 'pause' silencia e manda pausar, 'mute' só silencia, 'off' não mexe.
   */
  audioWhileRecording: 'pause' | 'mute' | 'off';
  /**
   * Devolver o conteúdo anterior da área de transferência depois de colar.
   *
   * Desligado por padrão de propósito: deixar a transcrição lá é a rede de
   * segurança para quando a colagem falha em silêncio, o que acontece em campo
   * de senha, em app que ignora ⌘V e quando a permissão é revogada.
   */
  restoreClipboard: boolean;
  pasteDelayMs: number;
  playSounds: boolean;
  /**
   * Três desfechos, três sons, porque você não olha para a barra de menu
   * enquanto fala. O som é o único jeito de saber o que aconteceu.
   *
   * `soundStart`   começou a gravar
   * `soundPasted`  colou no app: acabou, não há nada a fazer
   * `soundClipboard` o texto ficou na área de transferência e espera um ⌘V
   * `soundError`   não saiu texto nenhum
   *
   * Qualquer nome de /System/Library/Sounds serve.
   */
  soundStart: SystemSound;
  soundPasted: SystemSound;
  soundClipboard: SystemSound;
  soundError: SystemSound;
  launchAtLogin: boolean;
}

export const DEFAULT_CONFIG: Config = {
  // ⌃⌥Espaço em vez de ⌥Espaço: apps como Raycast e Alfred capturam teclas por
  // event tap, que tem precedência sobre o atalho global e engole ⌥Espaço sem
  // que o registro falhe. Esta combinação raramente é disputada.
  shortcut: 'Control+Alt+Space',
  language: 'pt',
  model: 'ggml-large-v3-turbo-q5_0.bin',
  // Deixa folga para o resto do sistema: você trabalha com tudo aberto.
  threads: Math.max(4, Math.min(8, os.cpus().length - 4)),
  beamSize: 5,
  mode: 'auto',
  fallbackMode: 'developer',
  appModes: DEFAULT_APP_MODES,
  nameRules: DEFAULT_NAME_RULES,
  keepModelWarmMs: 5 * 60 * 1000,
  maxRecordingSec: 300,
  minRecordingSec: 0.35,
  // Fala de perto passa de 0.1 fácil; ruído de sala fica abaixo de 0.002.
  // Margem folgada de propósito: rejeitar fala de verdade é pior que aceitar
  // um silêncio, que o filtro de alucinação descarta depois.
  minPeak: 0.004,
  useGlossaryPrompt: true,
  useDictionary: true,
  removeDisfluencies: true,
  // Ligado de novo, agora que o escopo é só pontuação e maiúscula e o modelo
  // é pequeno: medido em ~280 ms, contra os 6 a 15 segundos do arranjo
  // anterior. Sem o modelo baixado, esta etapa simplesmente não roda.
  polish: true,
  polishModel: 'Qwen3-1.7B-Q4_K_M.gguf',
  dictionaryInNormalMode: false,
  conversationalPunctuation: true,
  insertMode: 'paste',
  audioWhileRecording: 'pause',
  restoreClipboard: false,
  pasteDelayMs: 90,
  playSounds: true,
  soundStart: 'Tink',
  // Colou: sino curto, som de coisa concluída.
  soundPasted: 'Glass',
  // Ficou na área de transferência: som neutro, nem festa nem erro. É o aviso
  // de que falta um ⌘V seu.
  soundClipboard: 'Pop',
  // Erro de verdade: nada de texto saiu.
  soundError: 'Basso',
  launchAtLogin: false,
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  let stored: Partial<Config> = {};
  try {
    stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    // Primeira execução ou arquivo corrompido: os defaults resolvem.
  }
  cached = { ...DEFAULT_CONFIG, ...stored };
  return cached;
}

export function saveConfig(patch: Partial<Config>): Config {
  const next = { ...loadConfig(), ...patch };
  cached = next;
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
