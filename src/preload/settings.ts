import { contextBridge, ipcRenderer } from 'electron';

/**
 * Superfície mínima exposta ao renderer. Sem Node, sem fs, sem rede,
 * a janela de configurações só sabe pedir e salvar.
 */
contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('settings:load'),
  permissions: () => ipcRenderer.invoke('settings:permissions'),
  saveConfig: (patch: unknown) => ipcRenderer.invoke('settings:save-config', patch),
  saveDictionary: (raw: string) => ipcRenderer.invoke('settings:save-dictionary', raw),
  resetDictionary: () => ipcRenderer.invoke('settings:reset-dictionary'),
  requestAccessibility: () => ipcRenderer.invoke('settings:request-accessibility'),
  requestMicrophone: () => ipcRenderer.invoke('settings:request-microphone'),
  openDataDir: () => ipcRenderer.invoke('settings:open-data-dir'),
  downloadModel: (file: string) => ipcRenderer.invoke('model:download', file),
  cancelModelDownload: () => ipcRenderer.invoke('model:cancel'),
  onModelProgress: (
    handler: (progress: { file: string; received: number; total: number }) => void
  ) => {
    ipcRenderer.on('model:progress', (_event, progress) => handler(progress));
  },
});
