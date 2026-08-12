import { BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { HelperError, type Recording, type RecordingResult } from './helper';
import { log } from './log';

/**
 * Gravação para Windows e Linux.
 *
 * No macOS quem grava é o vox-helper, que é mais leve e começa a capturar em
 * milissegundos. Fora do macOS não existe helper nativo, então usamos o próprio
 * Chromium: é a única forma de gravar sem exigir que o usuário instale ffmpeg
 * ou configure dispositivo na mão.
 *
 * A janela é criada ao gravar e destruída ao terminar, para o app continuar sem
 * nenhum renderer vivo quando está parado. O custo é uns 300 ms até a captura
 * começar, aceitável fora do macOS.
 */

const MEDIA_ERRORS: Record<string, string> = {
  NotAllowedError: 'MIC_DENIED',
  PermissionDeniedError: 'MIC_DENIED',
  NotFoundError: 'NO_INPUT_DEVICE',
  DevicesNotFoundError: 'NO_INPUT_DEVICE',
  NotReadableError: 'ENGINE_FAIL',
  TrackStartError: 'ENGINE_FAIL',
};

export function startRecording(wavPath: string): Promise<Recording> {
  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'recorder.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let settled = false;
    let onDone: ((result: RecordingResult) => void) | null = null;
    let onFail: ((error: HelperError) => void) | null = null;

    const cleanup = () => {
      ipcMain.removeListener('recorder:ready', handleReady);
      ipcMain.removeListener('recorder:failed', handleFailed);
      ipcMain.removeListener('recorder:done', handleDone);
      if (!window.isDestroyed()) window.destroy();
    };

    const startTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HelperError('TIMEOUT', 'O microfone não iniciou a tempo.'));
    }, 15_000);

    function handleReady(event: Electron.IpcMainEvent) {
      if (event.sender !== window.webContents || settled) return;
      settled = true;
      clearTimeout(startTimer);
      resolve({
        stop() {
          return new Promise<RecordingResult>((resolveStop, rejectStop) => {
            onDone = resolveStop;
            onFail = rejectStop;
            window.webContents.send('recorder:stop');
          });
        },
        abort() {
          cleanup();
        },
      });
    }

    function handleFailed(event: Electron.IpcMainEvent, reason: string) {
      if (event.sender !== window.webContents) return;
      const code = MEDIA_ERRORS[reason] ?? 'ENGINE_FAIL';
      const error = new HelperError(code, `Falha na captura de áudio: ${reason}`);
      if (!settled) {
        settled = true;
        clearTimeout(startTimer);
        cleanup();
        reject(error);
      } else {
        cleanup();
        onFail?.(error);
      }
    }

    function handleDone(
      event: Electron.IpcMainEvent,
      wav: ArrayBuffer,
      seconds: number,
      peak: number
    ) {
      if (event.sender !== window.webContents) return;
      try {
        fs.writeFileSync(wavPath, Buffer.from(wav));
        cleanup();
        onDone?.({ seconds, peak });
      } catch (error) {
        cleanup();
        onFail?.(new HelperError('WRITE_FAIL', `Não foi possível gravar ${wavPath}.`));
        log.error('recorder: falha ao escrever o wav', error);
      }
    }

    ipcMain.on('recorder:ready', handleReady);
    ipcMain.on('recorder:failed', handleFailed);
    ipcMain.on('recorder:done', handleDone);

    void window
      .loadFile(path.join(__dirname, '..', 'renderer', 'recorder.html'))
      .then(() => window.webContents.send('recorder:start'))
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        cleanup();
        reject(new HelperError('ENGINE_FAIL', String(error)));
      });
  });
}
