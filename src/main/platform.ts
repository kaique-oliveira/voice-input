import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clipboard } from 'electron';
import * as helper from './helper';
import * as recorder from './recorder';
import { log } from './log';

/**
 * Roteia as três operações que dependem do sistema operacional.
 *
 * No macOS tudo vai para o vox-helper, que é rápido e resolve as permissões do
 * TCC. Fora do macOS, gravar usa o Chromium e colar usa a ferramenta padrão de
 * cada ambiente.
 *
 * Status: macOS é testado e usado todo dia. Windows e Linux são implementação
 * de melhor esforço, ainda sem validação em máquina real. Falha de colagem cai
 * sempre na área de transferência, então o pior caso é você colar com Ctrl+V.
 */

const run = promisify(execFile);

export const isMac = process.platform === 'darwin';
// Permite testar o caminho de Windows e Linux dentro do macOS.
const forceFallback = process.env.VOICE_INPUT_FORCE_FALLBACK === '1';
export const usesNativeHelper = isMac && !forceFallback;

export function startRecording(wavPath: string): Promise<helper.Recording> {
  return usesNativeHelper ? helper.startRecording(wavPath) : recorder.startRecording(wavPath);
}

export async function frontApp(): Promise<helper.FrontAppInfo | null> {
  if (usesNativeHelper) return helper.frontApp();
  // Fora do macOS ainda não há detecção confiável, principalmente no Wayland.
  // Sem ela o app cai no modo padrão configurado, que é um comportamento
  // correto, só não automático.
  return null;
}

/**
 * Cola no app em foco. O texto já está na área de transferência quando esta
 * função é chamada, então qualquer falha aqui é recuperável com um Ctrl+V.
 */
export async function paste(
  text: string,
  options: { restoreClipboard: boolean; preDelayMs: number; ensureFrontApp?: string }
): Promise<helper.PasteResult> {
  if (usesNativeHelper) return helper.paste(text, options);

  const previous = options.restoreClipboard ? clipboard.readText() : null;
  clipboard.writeText(text);
  await new Promise((resolve) => setTimeout(resolve, options.preDelayMs));

  try {
    if (process.platform === 'win32') {
      await run('powershell', [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms;' +
          "[System.Windows.Forms.SendKeys]::SendWait('^v')",
      ]);
    } else {
      // xdotool cobre X11. No Wayland ele não funciona, e aí só resta o modo
      // "só copiar", que é o padrão sugerido nesses ambientes.
      await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
    }
  } catch (error) {
    log.error('colagem sintética indisponível nesta plataforma', error);
    throw new helper.HelperError(
      'PASTE_UNAVAILABLE',
      process.platform === 'win32'
        ? 'Não foi possível simular Ctrl+V.'
        : 'Instale o xdotool, ou use o modo "só copiar". No Wayland a colagem automática não é permitida.'
    );
  }

  if (previous !== null) {
    setTimeout(() => {
      if (clipboard.readText() === text) clipboard.writeText(previous);
    }, 450);
  }

  return { frontBefore: '', frontAfter: '' };
}

export interface PlatformStatus {
  microphone: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
  accessibility: boolean;
  inputDevice: boolean;
}

export async function permissionStatus(): Promise<PlatformStatus> {
  if (usesNativeHelper) return helper.permissionStatus();
  // Windows e Linux não têm equivalente ao TCC: o navegador pede o microfone
  // na hora e não existe permissão de acessibilidade para simular teclas.
  return { microphone: 'authorized', accessibility: true, inputDevice: true };
}
