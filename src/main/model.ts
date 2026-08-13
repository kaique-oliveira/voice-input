import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { modelPath, modelsDir } from './paths';
import { log } from './log';

/**
 * Download dos modelos.
 *
 * Existe para quem instala o app pronto: o binário não carrega os 575 MB do
 * modelo junto, então a primeira execução busca o arquivo. É a única vez que
 * o app usa a rede.
 *
 * A busca é automática desde que o app aprendeu a lição de uma conta nova de
 * macOS: a pasta de modelos é por usuário, então migrar de conta deixava o app
 * mudo, gravando e falhando na hora de transcrever, com o motivo só no log.
 * Baixar sozinho o que a configuração pede resolve na origem.
 */

export interface ModelInfo {
  file: string;
  label: string;
  bytes: number;
  url: string;
  note: string;
}

const HUGGING_FACE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/**
 * Catálogo em ordem de capacidade.
 *
 * As porcentagens vêm do `npm run bench` rodado neste projeto e medem termos
 * técnicos preservados no pipeline completo, com glossário e dicionário.
 *
 * O `large-v3-turbo` é o padrão em qualquer máquina: mesmo sem GPU ele fica
 * acima do tempo real, ou seja, transcrever demora menos do que se levou
 * falando. Os menores existem para quem achar a espera longa demais, não
 * porque o hardware "não aguenta".
 */
export const MODELS: ModelInfo[] = [
  {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    label: 'large-v3-turbo q5_0',
    bytes: 574_041_195,
    url: `${HUGGING_FACE}/ggml-large-v3-turbo-q5_0.bin`,
    note: 'Recomendado, inclusive em máquina modesta. 93,9% dos termos técnicos, 830 MB de RAM.',
  },
  {
    file: 'ggml-small-q5_1.bin',
    label: 'small q5_1',
    bytes: 190_085_487,
    url: `${HUGGING_FACE}/ggml-small-q5_1.bin`,
    note: 'Alternativa se o turbo ficar lento demais. 90,9% dos termos, 500 MB, três vezes mais rápido.',
  },
  {
    file: 'ggml-base-q5_1.bin',
    label: 'base q5_1',
    bytes: 59_707_625,
    url: `${HUGGING_FACE}/ggml-base-q5_1.bin`,
    note: 'Só para hardware bem fraco. 72,7% dos termos, 245 MB de RAM.',
  },
  {
    file: 'ggml-tiny-q5_1.bin',
    label: 'tiny q5_1',
    bytes: 32_152_673,
    url: `${HUGGING_FACE}/ggml-tiny-q5_1.bin`,
    note: 'Último recurso. 48,5% dos termos: erra demais para uso técnico.',
  },
  {
    file: 'ggml-large-v3-q5_0.bin',
    label: 'large-v3 q5_0',
    bytes: 1_080_000_000,
    url: `${HUGGING_FACE}/ggml-large-v3-q5_0.bin`,
    note: 'Um pouco melhor em áudio difícil, cerca de duas vezes mais lento que o turbo.',
  },
];

/**
 * Modelos do segundo estágio. Separados dos de transcrição porque fazem outro
 * trabalho e aparecem em outro lugar da tela.
 */
export const POLISH_MODELS: ModelInfo[] = [
  {
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    label: 'Qwen3 1.7B',
    bytes: 1_282_000_000,
    url: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
    note: 'Recomendado. Pontua e capitaliza em ~280 ms, sem trocar palavra nenhuma.',
  },
  {
    file: 'gemma-3-1b-it-Q4_K_M.gguf',
    label: 'Gemma 3 1B',
    bytes: 806_000_000,
    url: 'https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf',
    note: 'Menor e um pouco mais rápido, mas troca palavra: virou "commita" em "commite" no teste.',
  },
];

export function findModel(file: string): ModelInfo | undefined {
  return [...MODELS, ...POLISH_MODELS].find((model) => model.file === file);
}

export function isInstalled(file: string): boolean {
  try {
    // Um arquivo truncado é pior que arquivo nenhum: o whisper falharia ao
    // carregar sem explicar por quê.
    return fs.statSync(modelPath(file)).size > 1_000_000;
  } catch {
    return false;
  }
}

export function installedModels(): string[] {
  try {
    return fs.readdirSync(modelsDir).filter((name) => name.endsWith('.bin')).sort();
  } catch {
    return [];
  }
}

/**
 * Arquivos de modelo no disco que configuração nenhuma aponta.
 *
 * Trocar de modelo não apaga o anterior, e é assim que 2 GB de peso morto
 * ficam esquecidos numa pasta que ninguém visita. Aqui só listamos: apagar é
 * decisão de quem está lendo a lista.
 */
export function unusedModels(inUse: Iterable<string>): Array<{ file: string; bytes: number }> {
  const keep = new Set(inUse);
  try {
    return fs
      .readdirSync(modelsDir)
      .filter((name) => /\.(bin|gguf)$/.test(name) && !keep.has(name))
      .map((file) => ({ file, bytes: fs.statSync(modelPath(file)).size }))
      .sort((a, b) => b.bytes - a.bytes);
  } catch {
    return [];
  }
}

/** Apaga por nome, e só dentro da pasta de modelos: nada de caminho relativo. */
export function removeModel(file: string): boolean {
  if (file.includes('/') || file.includes('..')) return false;
  try {
    fs.unlinkSync(modelPath(file));
    log.info(`modelo removido: ${file}`);
    return true;
  } catch {
    return false;
  }
}

export interface DownloadProgress {
  file: string;
  received: number;
  total: number;
}

let active: AbortController | null = null;

export function isDownloading(): boolean {
  return active !== null;
}

export function cancelDownload(): void {
  active?.abort();
  active = null;
}

export async function download(
  file: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  const model = findModel(file);
  if (!model) throw new Error(`Modelo desconhecido: ${file}`);
  if (active) throw new Error('Já existe um download em andamento.');

  const target = modelPath(file);
  // O ".part" garante que uma queda de conexão não deixe um modelo pela
  // metade parecendo instalado.
  const partial = `${target}.part`;
  fs.mkdirSync(modelsDir, { recursive: true });

  const controller = new AbortController();
  active = controller;
  log.info(`baixando modelo ${file}`);

  try {
    const response = await fetch(model.url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`O servidor respondeu ${response.status}.`);
    }

    const total = Number(response.headers.get('content-length')) || model.bytes;
    let received = 0;
    let lastReport = 0;

    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      // Reportar a cada 200 ms basta: mais que isso só gera tráfego de IPC.
      const now = Date.now();
      if (now - lastReport > 200) {
        lastReport = now;
        onProgress({ file, received, total });
      }
    });

    await pipeline(source, fs.createWriteStream(partial));
    fs.renameSync(partial, target);
    onProgress({ file, received: total, total });
    log.info(`modelo ${file} instalado`);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    if (controller.signal.aborted) {
      log.info(`download de ${file} cancelado`);
      return;
    }
    log.error(`falha ao baixar ${file}`, error);
    throw error;
  } finally {
    active = null;
  }
}

/**
 * Garante no disco todo modelo que a configuração usa, baixando o que faltar.
 *
 * Um de cada vez, porque `download` só admite um em andamento. Nada aqui
 * lança: sem rede, o app continua servindo, e quem faltar aparece na janela de
 * Configurações com o botão de baixar.
 */
export async function ensureModels(
  files: string[],
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  for (const file of files) {
    if (!file || isInstalled(file) || !findModel(file)) continue;
    if (isDownloading()) return;
    try {
      log.info(`modelo ${file} não está no disco, baixando`);
      await download(file, onProgress);
    } catch {
      // Já registrado por `download`. O próximo da fila ainda merece a chance.
    }
  }
}
