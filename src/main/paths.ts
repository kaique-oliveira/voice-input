import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Tudo que é estado do usuário mora aqui. Nada fica no diretório do projeto.
 *
 * No macOS o caminho é o clássico de Application Support. Fora dele, o
 * equivalente de cada sistema: %APPDATA%\VoiceInput no Windows e
 * ~/.config/VoiceInput no Linux. Hardcodar o caminho do macOS nos três
 * criava um C:\Users\x\Library\Application Support no Windows.
 */
export const dataDir =
  process.platform === 'darwin'
    ? path.join(app.getPath('home'), 'Library', 'Application Support', 'VoiceInput')
    : path.join(app.getPath('appData'), 'VoiceInput');

export const modelsDir = path.join(dataDir, 'models');
export const tmpDir = path.join(dataDir, 'tmp');
export const configFile = path.join(dataDir, 'config.json');
export const dictionaryFile = path.join(dataDir, 'dictionary.json');

/**
 * Em dev os binários ficam em resources/bin do projeto; empacotado, em
 * Contents/Resources/bin.
 */
export const binDir = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(app.getAppPath(), 'resources', 'bin');

// No Windows os executáveis têm sufixo. Sem ele, o existsSync nunca acha o
// binário e todo ditado morre em SERVER_MISSING antes de começar.
const exe = process.platform === 'win32' ? '.exe' : '';

export const helperBin = path.join(binDir, 'vox-helper');
export const whisperServerBin = path.join(binDir, `whisper-server${exe}`);
export const llamaServerBin = path.join(binDir, `llama-server${exe}`);

export function ensureDirs(): void {
  for (const dir of [dataDir, modelsDir, tmpDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // O tmp guarda só WAVs em trânsito; limpamos restos de execuções anteriores.
  for (const name of fs.readdirSync(tmpDir)) {
    try {
      fs.unlinkSync(path.join(tmpDir, name));
    } catch {
      /* arquivo em uso, ignora */
    }
  }
}

export function modelPath(fileName: string): string {
  return path.join(modelsDir, fileName);
}
