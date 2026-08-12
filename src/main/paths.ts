import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

/** Tudo que é estado do usuário mora aqui. Nada fica no diretório do projeto. */
export const dataDir = path.join(
  app.getPath('home'),
  'Library',
  'Application Support',
  'VoiceInput'
);

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

export const helperBin = path.join(binDir, 'vox-helper');
export const whisperServerBin = path.join(binDir, 'whisper-server');

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
