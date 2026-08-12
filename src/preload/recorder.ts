import { contextBridge, ipcRenderer } from 'electron';

/** Ponte da janela escondida de gravação. Quatro mensagens, nada além disso. */
contextBridge.exposeInMainWorld('recorder', {
  onStart: (handler: () => void) => ipcRenderer.on('recorder:start', () => handler()),
  onStop: (handler: () => void) => ipcRenderer.on('recorder:stop', () => handler()),
  ready: () => ipcRenderer.send('recorder:ready'),
  failed: (reason: string) => ipcRenderer.send('recorder:failed', reason),
  done: (wav: ArrayBuffer, seconds: number, peak: number) =>
    ipcRenderer.send('recorder:done', wav, seconds, peak),
});
