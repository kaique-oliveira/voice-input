/*
 * Gravador para Windows e Linux, onde não existe o helper nativo do macOS.
 *
 * Roda numa janela escondida porque a captura de áudio do Chromium só existe
 * no renderer. O resultado é o mesmo WAV 16 kHz mono 16-bit que o whisper.cpp
 * espera, montado aqui para não depender de ffmpeg nem de nenhum binário
 * externo instalado pelo usuário.
 */

let context = null;
let stream = null;
let node = null;
let chunks = [];
let frames = 0;
let peak = 0;

async function start() {
  chunks = [];
  frames = 0;
  peak = 0;

  // Os processamentos do navegador atrapalham a transcrição: o ganho
  // automático bombeia o ruído de fundo nas pausas e a supressão come fonemas.
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  // Pedir 16 kHz ao AudioContext faz o Chromium reamostrar por conta própria,
  // o que evita escrever um reamostrador aqui.
  context = new AudioContext({ sampleRate: 16000 });
  const source = context.createMediaStreamSource(stream);

  node = context.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    chunks.push(copy);
    frames += input.length;
    for (let i = 0; i < input.length; i++) {
      const value = Math.abs(input[i]);
      if (value > peak) peak = value;
    }
  };

  source.connect(node);
  // O ScriptProcessor só dispara se estiver ligado à saída. Um ganho zero
  // mantém o fluxo sem devolver o seu microfone para os alto-falantes.
  const silence = context.createGain();
  silence.gain.value = 0;
  node.connect(silence);
  silence.connect(context.destination);
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // tamanho do bloco fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes por segundo
  view.setUint16(32, 2, true); // alinhamento de bloco
  view.setUint16(34, 16, true); // bits por amostra
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function stop() {
  const sampleRate = context ? context.sampleRate : 16000;

  if (node) {
    node.disconnect();
    node.onaudioprocess = null;
    node = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (context) {
    void context.close();
    context = null;
  }

  const merged = new Float32Array(frames);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  chunks = [];

  return {
    wav: encodeWav(merged, sampleRate),
    seconds: frames / sampleRate,
    peak,
  };
}

window.recorder.onStart(async () => {
  try {
    await start();
    window.recorder.ready();
  } catch (error) {
    // Nome do erro identifica permissão negada versus ausência de microfone.
    window.recorder.failed(error && error.name ? error.name : String(error));
  }
});

window.recorder.onStop(() => {
  try {
    const result = stop();
    window.recorder.done(result.wav, result.seconds, result.peak);
  } catch (error) {
    window.recorder.failed(String(error));
  }
});
