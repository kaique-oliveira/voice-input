import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { log } from './log';

/**
 * Painel flutuante que aparece enquanto você fala: tempo decorrido, um botão
 * para transcrever e um para cancelar.
 *
 * A regra que manda em tudo aqui: **ele não pode roubar o foco**. Se o app
 * virar o frontmost, o ⌘V da colagem cairia dentro do próprio overlay em vez
 * de voltar para o Cursor. Daí `focusable: false`.
 *
 * A janela é criada ao começar a gravar e destruída ao terminar, parado, o
 * app não mantém nenhum renderer vivo.
 */

const WIDTH = 176;
const HEIGHT = 56;
/** Distância até a borda de baixo, acima da Dock. */
const BOTTOM_MARGIN = 96;

let window: BrowserWindow | null = null;

export interface OverlayActions {
  stop(): void;
  cancel(): void;
}

export function registerOverlayIpc(actions: OverlayActions): void {
  ipcMain.on('overlay:stop', () => actions.stop());
  ipcMain.on('overlay:cancel', () => actions.cancel());
}

function create(): BrowserWindow {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;

  const overlay = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: Math.round(x + (width - WIDTH) / 2),
    y: Math.round(y + height - BOTTOM_MARGIN),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    // Sem foco: clicar nos botões não ativa o app nem tira o cursor de texto
    // de onde ele está.
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' fica acima até de apps em tela cheia.
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  overlay.on('closed', () => {
    window = null;
  });

  return overlay;
}

/** Mostra o overlay gravando. `startedAt` alimenta o cronômetro no renderer. */
export function showRecording(startedAt: number): void {
  try {
    if (!window || window.isDestroyed()) window = create();
    const target = window;
    const send = () => {
      if (!target.isDestroyed()) {
        target.webContents.send('overlay:state', { state: 'recording', startedAt });
        // showInactive em vez de show: nunca ativa o app.
        target.showInactive();
      }
    };
    if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send);
    else send();
  } catch (error) {
    // O overlay é conforto, não requisito: se falhar, o ditado continua.
    log.error('overlay: falha ao mostrar', error);
  }
}

/** Troca para o estado de processamento: some com os botões, mostra o passo. */
export function showBusy(label: string): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send('overlay:state', { state: 'busy', label });
}

export function hide(): void {
  if (!window || window.isDestroyed()) return;
  window.destroy();
  window = null;
}
