import { app, Menu, Notification, Tray, shell } from 'electron';
import path from 'node:path';
import { trayIcons } from './icons';
import { loadConfig, saveConfig } from './config';
import { dictionaryFile } from './paths';
import { log } from './log';
import * as helper from './helper';
import * as platform from './platform';
import type { Session } from './session';

/**
 * A interface inteira do app em estado de repouso: um ícone e um menu.
 * Nenhuma janela é criada até você abrir Configurações.
 */

const MODIFIER_SYMBOLS: Array<[RegExp, string]> = [
  [/CommandOrControl|Cmd|Command/gi, '⌘'],
  [/Control|Ctrl/gi, '⌃'],
  [/Option|Alt/gi, '⌥'],
  [/Shift/gi, '⇧'],
  [/Space/gi, 'Espaço'],
];

export function formatAccelerator(accelerator: string): string {
  let output = accelerator;
  for (const [pattern, symbol] of MODIFIER_SYMBOLS) output = output.replace(pattern, symbol);
  return output.replace(/\+/g, '');
}

function modelLabel(fileName: string): string {
  return fileName.replace(/^ggml-/, '').replace(/\.bin$/, '');
}

/**
 * Versão e commit do build em execução. Responde de uma vez a pergunta "o app
 * aberto é mesmo o que eu acabei de instalar?", que só se respondia comparando
 * datas de arquivo na mão.
 */
function buildLabel(): string {
  const version = app.getVersion();
  try {
    const manifest = require(path.join(app.getAppPath(), 'package.json')) as {
      buildRef?: string;
    };
    return manifest.buildRef ? `${version} (${manifest.buildRef})` : version;
  } catch {
    return version;
  }
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Diagnóstico da metade mais frágil do fluxo: cola um texto fixo no app em
 * foco, sem passar por microfone nem modelo. Se isto falhar, o problema é
 * permissão de Acessibilidade, não transcrição.
 */
async function testPaste(): Promise<void> {
  const front = await platform.frontApp();
  log.info(`teste de colagem → ${front?.name ?? '?'} (${front?.bundleId ?? '?'})`);
  try {
    await platform.paste('Voice Input funcionando.', {
      restoreClipboard: true,
      preDelayMs: 90,
      ensureFrontApp: front?.bundleId,
    });
    log.info('teste de colagem: ok');
  } catch (error) {
    const code = error instanceof helper.HelperError ? error.code : 'UNKNOWN';
    log.error(`teste de colagem falhou [${code}]`, error);
    new Notification({
      title: 'Voice Input: teste de colagem',
      body:
        code === 'AX_DENIED'
          ? 'Permissão de Acessibilidade negada. Abra Configurações e clique em Conceder.'
          : `Falhou: ${(error as Error).message}`,
    }).show();
  }
}

export interface TrayActions {
  openSettings(): void;
  reloadShortcut(): void;
  quit(): void;
}

export class TrayController {
  private readonly tray: Tray;
  private elapsedTimer: NodeJS.Timeout | null = null;
  private menu: Menu | null = null;

  constructor(
    private readonly session: Session,
    private readonly actions: TrayActions
  ) {
    this.tray = new Tray(trayIcons().idle);
    this.tray.setToolTip('Voice Input');

    // Clique esquerdo grava; direito abre o menu. Sem setContextMenu, porque
    // ele sequestraria o clique esquerdo para abrir o menu.
    this.tray.on('click', (event) => {
      // Ctrl+clique é o gesto clássico de menu contextual no macOS.
      if (event.ctrlKey) return this.openMenu();
      void this.session.toggle('ícone da barra');
    });
    this.tray.on('right-click', () => this.openMenu());

    this.session.on('state', () => this.render());
    this.render();
  }

  private openMenu(): void {
    if (this.menu) this.tray.popUpContextMenu(this.menu);
  }

  render(): void {
    const config = loadConfig();
    const state = this.session.state;
    const icons = trayIcons();

    this.tray.setImage(
      state === 'recording' ? icons.recording : state === 'idle' ? icons.idle : icons.busy
    );
    this.tray.setToolTip(`Voice Input: ${this.session.stateLabel}`);
    this.updateTitle();

    const modeLabel =
      config.mode === 'auto' ? `Automático (padrão: ${config.fallbackMode})` : config.mode;
    const warm = this.session.whisper.state;
    const warmLabel =
      warm === 'ready' ? 'em memória' : warm === 'loading' ? 'carregando…' : 'descarregado';

    this.menu = Menu.buildFromTemplate([
      { label: `🎙  Voice Input ${buildLabel()}`, enabled: false },
      { label: `Status: ${this.session.stateLabel}`, enabled: false },
      { label: 'Clique no ícone para gravar', enabled: false },
      { type: 'separator' },
      {
        label: `Modo: ${modeLabel}`,
        submenu: [
          {
            label: 'Automático (pelo app em foco)',
            type: 'radio',
            checked: config.mode === 'auto',
            click: () => this.setMode('auto'),
          },
          {
            label: 'Developer',
            type: 'radio',
            checked: config.mode === 'developer',
            click: () => this.setMode('developer'),
          },
          {
            label: 'Normal',
            type: 'radio',
            checked: config.mode === 'normal',
            click: () => this.setMode('normal'),
          },
        ],
      },
      {
        label: `Inserção: ${config.insertMode === 'paste' ? 'colar automaticamente' : 'só copiar'}`,
        submenu: [
          {
            label: 'Colar automaticamente (⌘V)',
            type: 'radio',
            checked: config.insertMode === 'paste',
            click: () => this.setInsertMode('paste'),
          },
          {
            label: 'Só copiar, eu colo',
            type: 'radio',
            checked: config.insertMode === 'clipboard',
            click: () => this.setInsertMode('clipboard'),
          },
        ],
      },
      { label: `Modelo: ${modelLabel(config.model)} · ${warmLabel}`, enabled: false },
      { label: `Atalho: ${formatAccelerator(config.shortcut)}`, enabled: false },
      { type: 'separator' },
      state === 'recording'
        ? { label: 'Parar e transcrever', click: () => void this.session.toggle('menu') }
        : {
            label: 'Iniciar ditado',
            enabled: state === 'idle',
            click: () => void this.session.toggle('menu'),
          },
      {
        label: 'Cancelar gravação',
        enabled: state === 'recording',
        click: () => this.session.cancel(),
      },
      { type: 'separator' },
      { label: 'Configurações…', click: () => this.actions.openSettings() },
      { label: 'Testar colagem', click: () => void testPaste() },
      { label: 'Abrir dicionário pessoal', click: () => void shell.openPath(dictionaryFile) },
      { label: 'Abrir log', click: () => void shell.openPath(log.path) },
      { type: 'separator' },
      { label: 'Sair', click: () => this.actions.quit() },
    ]);
  }

  /**
   * Durante a gravação o título mostra o tempo decorrido, é o feedback que
   * evita você falar por dois minutos achando que gravou trinta segundos.
   */
  private updateTitle(): void {
    if (this.session.state === 'recording') {
      if (!this.elapsedTimer) {
        this.elapsedTimer = setInterval(() => {
          this.tray.setTitle(` ${formatElapsed(this.session.recordingElapsedMs)}`);
        }, 500);
      }
      this.tray.setTitle(` ${formatElapsed(this.session.recordingElapsedMs)}`);
      return;
    }

    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this.tray.setTitle(this.session.state === 'idle' ? '' : ' …');
  }

  private setMode(mode: 'auto' | 'developer' | 'normal'): void {
    saveConfig({ mode });
    this.render();
  }

  private setInsertMode(insertMode: 'paste' | 'clipboard'): void {
    saveConfig({ insertMode });
    this.render();
  }

  destroy(): void {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.tray.destroy();
  }
}
