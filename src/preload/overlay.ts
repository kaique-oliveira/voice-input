import { contextBridge, ipcRenderer } from 'electron';

/** Duas ações e um evento de estado, o overlay não precisa de mais nada. */
contextBridge.exposeInMainWorld('overlay', {
  stop: () => ipcRenderer.send('overlay:stop'),
  cancel: () => ipcRenderer.send('overlay:cancel'),
  onState: (handler: (payload: { state: string; startedAt?: number; label?: string }) => void) => {
    ipcRenderer.on('overlay:state', (_event, payload) => handler(payload));
  },
});
