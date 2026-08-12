import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths';

/**
 * Log em arquivo. Existe porque um app de barra de menu falha em silêncio: sem
 * isto, "não funcionou" é impossível de diagnosticar.
 *
 * Nunca registra o texto transcrito, só tamanhos e tempos. O conteúdo do que
 * você fala não fica em disco.
 */

const logFile = path.join(dataDir, 'voice-input.log');
const MAX_BYTES = 512 * 1024;

let stream: fs.WriteStream | null = null;

function open(): fs.WriteStream {
  if (stream) return stream;
  try {
    // Rotação simples: um arquivo anterior basta para investigar.
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    /* segue com o arquivo atual */
  }
  stream = fs.createWriteStream(logFile, { flags: 'a' });
  return stream;
}

function write(level: string, message: string): void {
  const line = `${new Date().toISOString()} ${level} ${message}\n`;
  try {
    open().write(line);
  } catch {
    /* log nunca pode derrubar o app */
  }
  process.stdout.write(line);
}

export const log = {
  info: (message: string) => write('INFO ', message),
  warn: (message: string) => write('WARN ', message),
  error: (message: string, error?: unknown) => {
    const detail =
      error instanceof Error ? ` | ${error.name}: ${error.message}` : error ? ` | ${error}` : '';
    write('ERROR', message + detail);
  },
  path: logFile,
};
