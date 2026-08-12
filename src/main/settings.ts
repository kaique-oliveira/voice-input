import { BrowserWindow, ipcMain, shell, systemPreferences } from 'electron';
import path from 'node:path';
import { loadConfig, saveConfig, DEFAULT_CONFIG, type Config } from './config';
import { loadDictionary, saveDictionary, DEFAULT_DICTIONARY } from './dictionary';
import { dataDir } from './paths';
import { MODELS, isInstalled, installedModels, download, cancelDownload } from './model';
import * as helper from './helper';

/**
 * Janela de configurações: criada sob demanda, destruída ao fechar. Enquanto
 * ela não existe, o app não tem nenhum renderer vivo.
 */

let window: BrowserWindow | null = null;

export interface SettingsHooks {
  onConfigSaved(config: Config): void;
}

export function openSettings(): void {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }

  window = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'Voice Input',
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void window.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
  });
}

/**
 * Esconde a janela de configurações sem destruí-la.
 *
 * Chamado ao começar um ditado. Se ela ficasse aberta, bastaria o app ganhar
 * foco por um instante para ela saltar na frente do app onde você está
 * escrevendo, e ainda atrasar a colagem enquanto o foco volta. Esconder
 * preserva o que estiver digitado nela.
 */
export function hideSettings(): void {
  if (window && !window.isDestroyed() && window.isVisible()) window.hide();
}

function modelCatalog() {
  return MODELS.map((entry) => ({
    file: entry.file,
    label: entry.label,
    note: entry.note,
    bytes: entry.bytes,
    installed: isInstalled(entry.file),
  }));
}

export function registerSettingsIpc(hooks: SettingsHooks): void {
  ipcMain.handle('settings:load', async () => {
    let permissions: helper.PermissionStatus | null = null;
    try {
      permissions = await helper.permissionStatus();
    } catch {
      // Helper ausente: a UI mostra "desconhecido" em vez de quebrar.
    }
    return {
      config: loadConfig(),
      defaults: DEFAULT_CONFIG,
      dictionary: loadDictionary(),
      permissions,
      models: installedModels(),
      catalog: modelCatalog(),
    };
  });

  ipcMain.handle('model:download', async (_event, file: string) => {
    try {
      await download(file, (progress) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('model:progress', progress);
        }
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('model:cancel', () => cancelDownload());

  ipcMain.handle('settings:save-config', (_event, patch: Partial<Config>) => {
    const next = saveConfig(patch);
    hooks.onConfigSaved(next);
    return next;
  });

  ipcMain.handle('settings:save-dictionary', (_event, raw: string) => {
    // Validamos aqui para o erro de JSON aparecer na UI, não no console.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, error: `JSON inválido: ${(error as Error).message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'O dicionário precisa ser um objeto { "errado": "certo" }.' };
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const invalid = entries.find(([, value]) => typeof value !== 'string');
    if (invalid) {
      return { ok: false, error: `O valor de "${invalid[0]}" precisa ser texto.` };
    }
    saveDictionary(Object.fromEntries(entries) as Record<string, string>);
    return { ok: true, count: entries.length };
  });

  ipcMain.handle('settings:reset-dictionary', () => {
    saveDictionary(DEFAULT_DICTIONARY);
    return DEFAULT_DICTIONARY;
  });

  // Estado das permissões isolado do resto: a janela consulta isto em ciclo,
  // então o selo se atualiza sozinho quando você concede no painel do sistema.
  ipcMain.handle('settings:permissions', async () => {
    try {
      return await helper.permissionStatus();
    } catch {
      return null;
    }
  });

  ipcMain.handle('settings:request-accessibility', async () => {
    // Quem de fato posta o ⌘V é o vox-helper, então é o status dele que vale.
    const status = await helper.permissionStatus().catch(() => null);
    if (status?.accessibility) return true;

    // O pedido tem de partir do processo principal: é ele que roda dentro do
    // bundle, então é "Voice Input" que aparece na lista de Acessibilidade.
    systemPreferences.isTrustedAccessibilityClient(true);
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    );
    return false;
  });
  ipcMain.handle('settings:request-microphone', () => helper.requestMicrophone());
  ipcMain.handle('settings:open-data-dir', () => shell.openPath(dataDir));
}
