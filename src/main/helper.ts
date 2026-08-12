import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { helperBin } from './paths';

/**
 * Ponte com o vox-helper. Todo comando é um processo curto que imprime JSON e
 * morre, exceto `record`, que fica vivo enquanto você fala.
 */

export class HelperError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HelperError';
  }
}

interface HelperEvent {
  event: string;
  [key: string]: unknown;
}

function parseLine(line: string): HelperEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as HelperEvent;
  } catch {
    return null;
  }
}

function runOnce(args: string[], input?: string, timeoutMs = 15_000): Promise<HelperEvent> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(helperBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let last: HelperEvent | null = null;
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new HelperError('TIMEOUT', `vox-helper ${args[0]} não respondeu a tempo.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const event = parseLine(line);
        if (event) last = event;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', () => {
      clearTimeout(timer);
      reject(new HelperError('HELPER_MISSING', `Não foi possível executar ${helperBin}.`));
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (last?.event === 'error') {
        reject(new HelperError(String(last.code), String(last.message)));
      } else if (last) {
        resolve(last);
      } else {
        reject(new HelperError('HELPER_FAIL', stderr.trim() || 'vox-helper não retornou nada.'));
      }
    });

    if (input !== undefined) child.stdin.end(input, 'utf8');
    else child.stdin.end();
  });
}

export interface RecordingResult {
  seconds: number;
  peak: number;
}

export interface Recording {
  stop(): Promise<RecordingResult>;
  /** Descarta a gravação sem esperar o WAV ser finalizado. */
  abort(): void;
}

/**
 * Começa a gravar e só resolve quando o microfone está realmente capturando,
 * assim o app nunca diz "Recording" antes de estar gravando de verdade.
 */
export function startRecording(wavPath: string): Promise<Recording> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperBin, ['record', wavPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout });

    let settled = false;
    let stderr = '';
    let onDone: ((result: RecordingResult) => void) | null = null;
    let onFail: ((error: HelperError) => void) | null = null;

    const startTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new HelperError('TIMEOUT', 'O microfone não iniciou a tempo.'));
    }, 15_000);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    lines.on('line', (line) => {
      const event = parseLine(line);
      if (!event) return;

      if (event.event === 'ready' && !settled) {
        settled = true;
        clearTimeout(startTimer);
        resolve({
          stop() {
            return new Promise<RecordingResult>((resolveStop, rejectStop) => {
              const stopTimer = setTimeout(() => {
                child.kill('SIGKILL');
                rejectStop(new HelperError('TIMEOUT', 'A gravação não finalizou a tempo.'));
              }, 10_000);
              const clear = () => clearTimeout(stopTimer);
              onDone = (result) => {
                clear();
                resolveStop(result);
              };
              onFail = (error) => {
                clear();
                rejectStop(error);
              };
              child.stdin.write('stop\n');
            });
          },
          abort() {
            child.kill('SIGKILL');
          },
        });
        return;
      }

      if (event.event === 'done') {
        onDone?.({ seconds: Number(event.seconds) || 0, peak: Number(event.peak) || 0 });
        return;
      }

      if (event.event === 'error') {
        const error = new HelperError(String(event.code), String(event.message));
        if (!settled) {
          settled = true;
          clearTimeout(startTimer);
          reject(error);
        } else {
          onFail?.(error);
        }
      }
    });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      reject(new HelperError('HELPER_MISSING', `Não foi possível executar ${helperBin}.`));
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(startTimer);
        reject(
          new HelperError('HELPER_FAIL', stderr.trim() || `vox-helper saiu com código ${code}.`)
        );
      } else {
        // Saída sem evento "done": stop() pendente precisa ser liberado.
        onFail?.(new HelperError('RECORD_FAIL', stderr.trim() || 'A gravação foi interrompida.'));
      }
    });
  });
}

export async function paste(
  text: string,
  options: { restoreClipboard: boolean; preDelayMs: number; ensureFrontApp?: string }
): Promise<void> {
  const args = ['paste', '--pre-delay', String(options.preDelayMs)];
  if (!options.restoreClipboard) args.push('--no-restore');
  if (options.ensureFrontApp) args.push('--ensure-front', options.ensureFrontApp);
  await runOnce(args, text, 20_000);
}

export interface FrontAppInfo {
  bundleId: string;
  name: string;
}

export async function frontApp(): Promise<FrontAppInfo | null> {
  try {
    const event = await runOnce(['frontapp'], undefined, 3_000);
    return { bundleId: String(event.bundleId ?? ''), name: String(event.name ?? '') };
  } catch {
    // Saber o app em foco é um luxo, não um requisito: seguimos sem ele.
    return null;
  }
}

export interface PermissionStatus {
  microphone: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
  accessibility: boolean;
  inputDevice: boolean;
}

export async function permissionStatus(): Promise<PermissionStatus> {
  const event = await runOnce(['status'], undefined, 5_000);
  return {
    microphone: event.microphone as PermissionStatus['microphone'],
    accessibility: Boolean(event.accessibility),
    inputDevice: Boolean(event.inputDevice),
  };
}

export async function requestAccessibility(): Promise<boolean> {
  const event = await runOnce(['request-accessibility'], undefined, 5_000);
  return Boolean(event.trusted);
}

export async function requestMicrophone(): Promise<boolean> {
  const event = await runOnce(['request-mic'], undefined, 60_000);
  return Boolean(event.granted);
}
