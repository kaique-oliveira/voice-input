import { app, globalShortcut, Notification, systemPreferences } from 'electron';
import { ensureDirs } from './paths';
import { loadConfig, type Config } from './config';
import { Session } from './session';
import { TrayController, formatAccelerator } from './tray';
import { openSettings, registerSettingsIpc } from './settings';
import { registerOverlayIpc } from './overlay';
import { log } from './log';
import { isInstalled } from './model';

import * as platform from './platform';

/**
 * Voice Input: ditado local por voz para macOS.
 *
 * Este processo é o que fica vivo o tempo todo. Ele não carrega modelo, não
 * abre janela e não grava nada: só escuta um atalho global.
 */

let session: Session;
let tray: TrayController;
let registeredShortcut = '';

// Instância única: dois apps registrando o mesmo atalho global brigariam.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/**
 * Em desenvolvimento o Electron.app não está registrado no sistema e o macOS
 * recusa a operação. Só chamamos quando o valor realmente muda, e a falha não
 * pode derrubar o boot.
 */
function applyLoginItem(enabled: boolean): void {
  try {
    if (app.getLoginItemSettings().openAtLogin === enabled) return;
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch {
    // Sem "abrir ao fazer login" em dev: irrelevante para o funcionamento.
  }
}

function registerShortcut(config: Config): void {
  if (registeredShortcut) {
    globalShortcut.unregister(registeredShortcut);
    registeredShortcut = '';
  }

  const ok = globalShortcut.register(config.shortcut, () => {
    void session.toggle('atalho global');
  });

  if (ok) {
    registeredShortcut = config.shortcut;
    log.info(`atalho registrado: ${config.shortcut}`);
    return;
  }

  log.error(`atalho ${config.shortcut} recusado pelo sistema (já em uso)`);

  // Conflito com Spotlight, Raycast, Alfred… O usuário precisa saber agora,
  // não quando apertar o atalho e nada acontecer.
  new Notification({
    title: 'Voice Input',
    body: `Não foi possível registrar ${formatAccelerator(config.shortcut)}. Outro app já usa esse atalho, escolha outro em Configurações.`,
  }).show();
  openSettings();
}

app.whenReady().then(() => {
  ensureDirs();

  // Sem ícone no Dock e sem foco: o app nunca rouba o cursor de texto do app
  // em que você está digitando. É isso que faz a colagem funcionar.
  app.dock?.hide();

  log.info('---- Voice Input iniciado ----');

  session = new Session();

  registerOverlayIpc({
    stop: () => void session.toggle('painel flutuante'),
    cancel: () => session.cancel(),
  });

  registerSettingsIpc({
    onConfigSaved: (config) => {
      session.whisper.setConfig(config);
      if (config.shortcut !== registeredShortcut) registerShortcut(config);
      applyLoginItem(config.launchAtLogin);
      tray.render();
    },
  });

  tray = new TrayController(session, {
    openSettings,
    reloadShortcut: () => registerShortcut(loadConfig()),
    quit: () => app.quit(),
  });

  session.on('error', () => tray.render());
  session.on('needs-accessibility', () => openSettings());

  const config = loadConfig();
  registerShortcut(config);
  applyLoginItem(config.launchAtLogin);

  // Permissão faltando vira aviso, não janela: a de Configurações só abre
  // quando você pede. Uma janela aparecendo sozinha no boot é intrusiva.
  void platform
    .permissionStatus()
    .then((status) => {
      // isTrustedAccessibilityClient só existe no macOS.
      const mainTrusted = platform.isMac
        ? systemPreferences.isTrustedAccessibilityClient(false)
        : 'n/a';
      log.info(
        `plataforma: ${process.platform} · permissões: microfone=${status.microphone} ` +
          `acessibilidade=${status.accessibility} (processo principal: ${mainTrusted})`
      );

      const config = loadConfig();
      const missing: string[] = [];
      if (status.microphone !== 'authorized') missing.push('permissão de Microfone');
      if (platform.isMac && !status.accessibility && config.insertMode === 'paste') {
        missing.push('permissão de Acessibilidade');
      }
      if (!isInstalled(config.model)) missing.push('o modelo de transcrição');
      if (missing.length === 0) return;

      new Notification({
        title: 'Voice Input',
        body: `Falta configurar: ${missing.join(' e ')}. Clique com o botão direito no ícone e abra Configurações.`,
      }).show();
    })
    .catch((error) => log.error('não foi possível checar permissões', error));
});

app.on('window-all-closed', () => {
  // Menu bar app: fechar a janela de configurações não encerra nada.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  session?.whisper.shutdown();
});
