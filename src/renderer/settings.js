/* Janela de configurações. JS puro: não há build para o renderer. */

const $ = (id) => document.getElementById(id);

/** Campos que salvam sozinhos ao mudar, com a conversão de tipo de cada um. */
const FIELDS = [
  ['mode', 'value'],
  ['fallbackMode', 'value'],
  ['model', 'value'],
  ['threads', 'number'],
  ['beamSize', 'number'],
  ['maxRecordingSec', 'number'],
  ['insertMode', 'value'],
  ['audioWhileRecording', 'value'],
  ['useGlossaryPrompt', 'checked'],
  ['useDictionary', 'checked'],
  ['removeDisfluencies', 'checked'],
  ['conversationalPunctuation', 'checked'],
  ['polish', 'checked'],
  ['dictionaryInNormalMode', 'checked'],
  ['restoreClipboard', 'checked'],
  ['playSounds', 'checked'],
  ['soundStart', 'value'],
  ['soundPasted', 'value'],
  ['soundClipboard', 'value'],
  ['soundError', 'value'],
  ['launchAtLogin', 'checked'],
];

/** Os sons que todo macOS tem em /System/Library/Sounds. */
const SOUNDS = [
  'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero',
  'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink',
];

let catalog = [];
let downloading = false;

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** Mostra a linha de download só quando o modelo escolhido não está no disco. */
function renderModelState() {
  const entry = catalog.find((item) => item.file === $('model').value);
  $('model-note').textContent = entry ? entry.note : 'Modelo personalizado.';

  const needsDownload = Boolean(entry) && !entry.installed;
  $('model-download-row').hidden = !needsDownload && !downloading;
  if (!entry) return;

  if (!downloading) {
    $('model-download-label').textContent = entry.installed
      ? 'Modelo instalado'
      : 'Modelo não instalado';
    $('model-download-hint').textContent = entry.installed
      ? ''
      : `${formatBytes(entry.bytes)}. Baixado uma vez, do Hugging Face.`;
    $('model-bar').hidden = true;
    $('model-download').hidden = false;
    $('model-cancel').hidden = true;
  }
}

const SYMBOLS = [
  [/CommandOrControl|Command|Cmd/g, '⌘'],
  [/Control|Ctrl/g, '⌃'],
  [/Option|Alt/g, '⌥'],
  [/Shift/g, '⇧'],
  [/Space/g, 'Espaço'],
];

function pretty(accelerator) {
  let out = accelerator;
  for (const [pattern, symbol] of SYMBOLS) out = out.replace(pattern, symbol);
  return out.replace(/\+/g, '');
}

function setStatus(el, ok, okText, badText) {
  el.textContent = ok ? okText : badText;
  el.className = `status ${ok ? 'ok' : 'bad'}`;
}

async function refresh() {
  const state = await window.api.load();
  const { config, dictionary, permissions, models } = state;

  // Os quatro seletores de som listam a biblioteca do macOS; fora dele o app
  // usa o beep do sistema e escolher nome de som seria mentira na tela.
  if (state.platform && state.platform !== 'darwin') {
    for (const select of document.querySelectorAll('select.sound')) {
      select.closest('.row').hidden = true;
    }
  }

  // Os seletores de som são iguais entre si: mesma lista, ordem alfabética.
  for (const select of document.querySelectorAll('select.sound')) {
    if (select.options.length) continue;
    for (const name of SOUNDS) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
  }

  for (const [id, kind] of FIELDS) {
    const el = $(id);
    if (kind === 'checked') el.checked = Boolean(config[id]);
    else el.value = config[id];
  }

  // O seletor lista o catálogo inteiro, não só o que está no disco: é assim
  // que você descobre que existe outro modelo para baixar.
  const modelSelect = $('model');
  const known = new Set(state.catalog.map((entry) => entry.file));
  modelSelect.innerHTML = '';
  for (const entry of state.catalog) {
    const option = document.createElement('option');
    option.value = entry.file;
    option.textContent = entry.installed ? entry.label : `${entry.label} (baixar)`;
    modelSelect.appendChild(option);
  }
  for (const name of models.filter((name) => !known.has(name))) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name.replace(/^ggml-/, '').replace(/\.bin$/, '');
    modelSelect.appendChild(option);
  }
  modelSelect.value = config.model;
  catalog = state.catalog;
  renderModelState();

  $('keepWarmMinutes').value = Math.round(config.keepModelWarmMs / 60000);
  $('shortcut').textContent = pretty(config.shortcut);
  $('dictionary').value = JSON.stringify(dictionary, null, 2);

  // Segundo estágio: a linha de download só aparece se o modelo faltar.
  const polishEntry = state.polishCatalog.find((e) => e.file === config.polishModel);
  polishModelFile = config.polishModel;
  const needsPolishModel = config.polish && polishEntry && !polishEntry.installed;
  $('polish-download-row').hidden = !needsPolishModel;
  if (polishEntry && !polishEntry.installed) {
    $('polish-label').textContent = 'Modelo não instalado';
    $('polish-hint').textContent = `${formatBytes(polishEntry.bytes)}. ${polishEntry.note}`;
  }

  applyPermissions(permissions);
  void renderUnused();
}

/** Modelos no disco que a configuração de hoje não usa. */
async function renderUnused() {
  const unused = await window.api.unusedModels();
  const bytes = unused.reduce((sum, entry) => sum + entry.bytes, 0);
  $('unused-label').textContent = unused.length
    ? `${unused.length} não usado${unused.length > 1 ? 's' : ''}, ${formatBytes(bytes)}`
    : 'Nada sobrando';
  $('unused-remove').hidden = unused.length === 0;
}

$('unused-remove').addEventListener('click', async () => {
  const result = await window.api.removeUnusedModels();
  $('unused-label').textContent = `${formatBytes(result.bytes)} liberados`;
  $('unused-remove').hidden = true;
});

let polishModelFile = '';

$('polish-download').addEventListener('click', async () => {
  $('polish-download').hidden = true;
  $('polish-bar').hidden = false;
  $('polish-label').textContent = 'Baixando…';
  const result = await window.api.downloadModel(polishModelFile);
  if (!result.ok && result.error) {
    $('polish-label').textContent = 'Falha no download';
    $('polish-hint').textContent = result.error;
    $('polish-download').hidden = false;
    $('polish-bar').hidden = true;
    return;
  }
  void refresh();
});

function applyPermissions(permissions) {
  if (!permissions) {
    $('mic-status').textContent = 'desconhecido';
    $('ax-status').textContent = 'desconhecido';
    return;
  }
  setStatus($('mic-status'), permissions.microphone === 'authorized', 'Concedido', 'Pendente');
  setStatus($('ax-status'), permissions.accessibility, 'Concedido', 'Pendente');
  $('mic-request').disabled = permissions.microphone === 'authorized';
  $('ax-request').disabled = permissions.accessibility;
}

// Você concede no painel do sistema, numa janela que não é esta. Sem esta
// consulta em ciclo, o selo ficaria dizendo "Pendente" para sempre.
setInterval(async () => {
  applyPermissions(await window.api.permissions());
}, 2000);

async function save(patch) {
  await window.api.saveConfig(patch);
}

// Trocar o som toca o som: escolher pelo nome seria adivinhação.
for (const select of document.querySelectorAll('select.sound')) {
  select.addEventListener('change', (event) => window.api.previewSound(event.target.value));
}

for (const [id, kind] of FIELDS) {
  $(id).addEventListener('change', (event) => {
    const target = event.target;
    const value =
      kind === 'checked' ? target.checked : kind === 'number' ? Number(target.value) : target.value;
    void save({ [id]: value });
  });
}

$('keepWarmMinutes').addEventListener('change', (event) => {
  void save({ keepModelWarmMs: Math.max(0, Number(event.target.value)) * 60000 });
});

// ---------------------------------------------------------------- atalho

let capturing = false;

function keyName(event) {
  const code = event.code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  const named = {
    Space: 'Space',
    Enter: 'Return',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Tab: 'Tab',
  };
  return named[code] || null;
}

$('shortcut').addEventListener('click', () => {
  capturing = true;
  $('shortcut').classList.add('capturing');
  $('shortcut').textContent = 'Pressione…';
});

window.addEventListener('keydown', async (event) => {
  if (!capturing) return;
  event.preventDefault();

  if (event.key === 'Escape') {
    capturing = false;
    $('shortcut').classList.remove('capturing');
    void refresh();
    return;
  }

  const key = keyName(event);
  if (!key) return; // ainda só modificadores: espera a tecla final

  const parts = [];
  if (event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  // Sem modificador o atalho engoliria a tecla no sistema inteiro.
  if (parts.length === 0) return;
  parts.push(key);

  capturing = false;
  $('shortcut').classList.remove('capturing');
  await save({ shortcut: parts.join('+') });
  void refresh();
});

// ---------------------------------------------------------------- dicionário

$('dict-save').addEventListener('click', async () => {
  const result = await window.api.saveDictionary($('dictionary').value);
  const msg = $('dict-msg');
  if (result.ok) {
    msg.textContent = `Salvo, ${result.count} entradas.`;
    msg.className = 'msg ok';
  } else {
    msg.textContent = result.error;
    msg.className = 'msg bad';
  }
});

$('dict-reset').addEventListener('click', async () => {
  const dictionary = await window.api.resetDictionary();
  $('dictionary').value = JSON.stringify(dictionary, null, 2);
  $('dict-msg').textContent = 'Dicionário padrão restaurado.';
  $('dict-msg').className = 'msg ok';
});

$('open-data').addEventListener('click', () => window.api.openDataDir());

// ---------------------------------------------------------------- modelo

$('model').addEventListener('change', renderModelState);

$('model-download').addEventListener('click', async () => {
  const file = $('model').value;
  downloading = true;
  $('model-download').hidden = true;
  $('model-cancel').hidden = false;
  $('model-bar').hidden = false;
  $('model-download-label').textContent = 'Baixando…';

  const result = await window.api.downloadModel(file);
  downloading = false;
  if (!result.ok && result.error) {
    $('model-download-label').textContent = 'Falha no download';
    $('model-download-hint').textContent = result.error;
    $('model-download').hidden = false;
    $('model-cancel').hidden = true;
    $('model-bar').hidden = true;
    return;
  }
  void refresh();
});

$('model-cancel').addEventListener('click', () => window.api.cancelModelDownload());

window.api.onModelProgress(({ file, received, total }) => {
  const percent = total > 0 ? (received / total) * 100 : 0;
  const label = `${formatBytes(received)} de ${formatBytes(total)} (${percent.toFixed(0)}%)`;
  // O mesmo evento serve aos dois downloads; o arquivo diz qual barra mexer.
  const isPolish = file === polishModelFile;
  $(isPolish ? 'polish-bar-fill' : 'model-bar-fill').style.width = `${percent.toFixed(1)}%`;
  $(isPolish ? 'polish-hint' : 'model-download-hint').textContent = label;
});

// ---------------------------------------------------------------- permissões

$('mic-request').addEventListener('click', async () => {
  await window.api.requestMicrophone();
  void refresh();
});

$('ax-request').addEventListener('click', async () => {
  // A consulta em ciclo acima cuida de atualizar o selo depois.
  await window.api.requestAccessibility();
});

window.addEventListener('focus', refresh);
void refresh();
