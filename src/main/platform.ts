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

// ---------------------------------------------------------------- áudio

export type AudioMode = 'pause' | 'mute' | 'off';

/** O que foi feito ao suspender, para saber o que desfazer depois. */
export interface AudioState {
  muted: boolean;
  mediaKeySent: boolean;
}

async function readMuted(): Promise<boolean | null> {
  try {
    if (isMac) {
      const { stdout } = await run('osascript', ['-e', 'output muted of (get volume settings)']);
      return stdout.trim() === 'true';
    }
    if (process.platform === 'linux') {
      const { stdout } = await run('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
      return stdout.includes('yes');
    }
  } catch {
    // Sem controle de volume disponível: seguimos sem silenciar.
  }
  return null;
}

async function setMuted(muted: boolean): Promise<void> {
  if (isMac) {
    await run('osascript', ['-e', `set volume output muted ${muted}`]);
    return;
  }
  if (process.platform === 'linux') {
    await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']);
    return;
  }
  // Windows não tem um comando simples e não destrutivo para isso, então lá
  // só a tecla de mídia atua.
}

async function sendPlayPause(): Promise<boolean> {
  try {
    if (usesNativeHelper) {
      await helper.mediaPlayPause();
      return true;
    }
    if (process.platform === 'win32') {
      await run('powershell', [
        '-NoProfile',
        '-Command',
        'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;' +
          'public class VK{[DllImport("user32.dll")]public static extern void keybd_event(' +
          "byte b,byte s,uint f,UIntPtr e);}';" +
          '[VK]::keybd_event(0xB3,0,0,[UIntPtr]::Zero);[VK]::keybd_event(0xB3,0,2,[UIntPtr]::Zero)',
      ]);
      return true;
    }
    // playerctl fala MPRIS, então pausa e retoma de forma explícita, sem o
    // risco de alternar para o lado errado.
    await run('playerctl', ['play-pause']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Silencia (e opcionalmente pausa) o que estiver tocando antes de gravar.
 *
 * Silenciar é a garantia: é exato, reversível e nunca liga nada sozinho.
 * A tecla de mídia é o extra que pausa o vídeo de verdade, mas ela é um
 * alternador e o macOS não expõe de forma confiável se há algo tocando. O
 * Chrome, por exemplo, aparece como "emitindo som" mesmo em silêncio.
 *
 * Por isso as duas coisas juntas: se a tecla ligar algo por engano, aquilo
 * toca mudo e a restauração pausa de volta. Você nunca ouve o engano.
 */
export async function suspendAudio(mode: AudioMode): Promise<AudioState> {
  if (mode === 'off') return { muted: false, mediaKeySent: false };

  const wasMuted = await readMuted();
  let muted = false;
  if (wasMuted === false) {
    try {
      await setMuted(true);
      muted = true;
    } catch {
      // Continua: a tecla de mídia ainda pode resolver sozinha.
    }
  }

  const mediaKeySent = mode === 'pause' ? await sendPlayPause() : false;
  log.info(`áudio suspenso (modo ${mode}, silenciado ${muted}, mídia ${mediaKeySent})`);
  return { muted, mediaKeySent };
}

/** Desfaz exatamente o que `suspendAudio` fez, e nada além disso. */
export async function restoreAudio(state: AudioState): Promise<void> {
  // A ordem importa: retomar antes de tirar o mudo evita o estalo do primeiro
  // instante de áudio sair alto.
  if (state.mediaKeySent) await sendPlayPause();
  if (state.muted) {
    try {
      await setMuted(false);
    } catch {
      log.error('não foi possível restaurar o volume');
    }
  }
  if (state.muted || state.mediaKeySent) log.info('áudio restaurado');
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
