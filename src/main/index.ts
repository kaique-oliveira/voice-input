import fs from 'node:fs';
import { app, globalShortcut, Notification, systemPreferences } from 'electron';
import { configFile, ensureDirs } from './paths';
import { loadConfig, type Config } from './config';
import { Session } from './session';
import { TrayController, formatAccelerator } from './tray';
import { openSettings, registerSettingsIpc, sendDone, sendProgress } from './settings';
import { registerOverlayIpc } from './overlay';
import { log } from './log';
import { ensureModels, isInstalled } from './model';

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

// Quem clica no .exe de novo (comum no Windows, onde o app "não abriu" porque
// vive na bandeja) merece ver alguma coisa em vez de um processo que morre em
// silêncio: a primeira instância abre as Configurações.
app.on('second-instance', () => openSettings());

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


/**
 * Busca em segundo plano o que faltar, sem travar nada e sem pedir permissão:
 * é download do que a sua própria configuração já escolheu.
 */
async function fetchModels(config: Config): Promise<void> {
  const wanted = [config.model];
  if (config.polish) wanted.push(config.polishModel);
  const missing = wanted.filter((file) => file && !isInstalled(file));
  if (missing.length === 0) return;

  new Notification({
    title: 'Voice Input',
    body: 'Baixando o modelo, uma vez só. Dá para usar assim que terminar.',
  }).show();

  let announced = 0;
  await ensureModels(missing, (progress) => {
    sendProgress(progress);
    const { file, received, total } = progress;
    // O log é o único lugar onde isso aparece enquanto a janela está fechada.
    const percent = total ? Math.floor((received / total) * 100) : 0;
    if (percent >= announced + 25) {
      announced = percent;
      log.info(`${file}: ${percent}%`);
    }
  });

  for (const file of missing) sendDone(file);

  const pending = wanted.filter((file) => file && !isInstalled(file));
  if (pending.length === 0) {
    log.info('todos os modelos em uso estão instalados');
    new Notification({ title: 'Voice Input', body: 'Modelo pronto. Pode ditar.' }).show();
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
  // As notificações no Windows só aparecem quando o AppUserModelID do processo
  // bate com o do atalho instalado. Sem isto, o aviso de "modelo baixando",
  // que é o único feedback do primeiro boot, simplesmente não existe.
  if (process.platform === 'win32') app.setAppUserModelId('com.voiceinput.app');

  // A primeira execução precisa ser detectada antes de qualquer loadConfig,
  // porque salvar a config cria o arquivo que serve de marcador.
  const firstRun = !fs.existsSync(configFile);

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

  // Os modelos que a configuração usa são buscados sozinhos, em segundo plano.
  // É o que faltava para instalar numa conta nova de macOS e sair ditando: a
  // pasta de modelos é por usuário, e antes o app só reclamava no log.
  void fetchModels(config);

  // Fora do macOS o app abre sem nenhuma janela e com um ícone discreto na
  // bandeja, que no Windows ainda pode cair no overflow (a setinha ^). Na
  // primeira execução isso é indistinguível de "não abriu". As Configurações
  // abertas são a prova de vida, e explicam onde o app mora.
  if (!platform.isMac && firstRun) {
    openSettings();
    new Notification({
      title: 'Voice Input',
      body: 'O app fica na bandeja, perto do relógio. Clique no ícone do microfone para gravar, ou use o atalho.',
    }).show();
  }

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
      // O modelo não entra nesta lista: ele já está sendo buscado sozinho.
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
  session?.llm.shutdown();
});
