#!/usr/bin/env node
/**
 * Benchmark de termos técnicos.
 *
 * Mede o que realmente importa para este app: quantos termos de programação
 * saem escritos corretamente. Compara o modelo cru, o modelo com glossário no
 * prompt, e o pipeline completo (glossário + dicionário determinístico).
 *
 *   npm run bench                      # usa vozes do macOS (say), rápido
 *   npm run bench -- --record          # grava a SUA voz para cada frase
 *   npm run bench -- --model outro.bin # compara outro modelo
 *
 * O resultado com a sua voz é o que vale. O modo `say` serve para comparar
 * configurações entre si, não para estimar a qualidade real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'VoiceInput');
const binDir = path.join(root, 'resources', 'bin');
const audioDir = path.join(dataDir, 'bench-audio');

const args = process.argv.slice(2);
const useMicrophone = args.includes('--record');
// Fala mais rápida é mais difícil de transcrever. Serve para separar modelos
// que empatam na velocidade normal, onde todos acertam quase tudo.
const rate = args.includes('--rate') ? Number(args[args.indexOf('--rate') + 1]) : 180;
const voice = args.includes('--voice') ? args[args.indexOf('--voice') + 1] : 'Luciana';
const modelArg = args[args.indexOf('--model') + 1];
const model = path.join(
  dataDir,
  'models',
  args.includes('--model') ? modelArg : 'ggml-large-v3-turbo-q5_0.bin'
);

/** Frases de teste com os termos que precisam sobreviver à transcrição. */
const PHRASES = [
  { id: 'commit-push', text: 'commita essa alteração e dá push para a branch develop',
    terms: ['commit', 'push', 'branch'] },
  { id: 'pull-request', text: 'abre o pull request no GitHub e marca o time para revisar',
    terms: ['pull request', 'GitHub'] },
  { id: 'docker', text: 'sobe o container no Docker e roda o deploy no Kubernetes',
    terms: ['container', 'Docker', 'deploy', 'Kubernetes'] },
  { id: 'stack', text: 'esse projeto usa TypeScript com React e Next.js no frontend',
    terms: ['TypeScript', 'React', 'Next.js', 'frontend'] },
  { id: 'backend', text: 'cria um endpoint novo na API que consulta o PostgreSQL e devolve um JSON',
    terms: ['endpoint', 'API', 'PostgreSQL', 'JSON'] },
  { id: 'cache', text: 'coloca um cache no Redis para essa query do banco',
    terms: ['cache', 'Redis', 'query'] },
  { id: 'git-flow', text: 'faz o merge da branch de feature e depois um rebase na main',
    terms: ['merge', 'branch', 'rebase'] },
  { id: 'webhook', text: 'configura o webhook do GitLab para disparar o build no CI/CD',
    terms: ['webhook', 'GitLab', 'build', 'CI/CD'] },
  { id: 'node', text: 'roda npm install e depois sobe o servidor Node.js em localhost',
    terms: ['npm', 'Node.js', 'localhost'] },
  { id: 'debug', text: 'coloca um console.log ali para debugar esse componente do React',
    terms: ['console.log', 'debugar', 'React'] },
];


// Reaproveita corretor e glossário de verdade do app. Duplicar o prompt aqui
// já causou o benchmark medir uma configuração que o app não usava mais.
let applyDictionary, buildPrompt, termsFromDictionary;
try {
  ({ applyDictionary } = require(path.join(root, 'dist', 'main', 'corrector.js')));
  ({ buildPrompt, termsFromDictionary } = require(path.join(root, 'dist', 'main', 'glossary.js')));
} catch {
  console.error('Rode "npm run build" antes do benchmark.');
  process.exit(1);
}

const dictionary = JSON.parse(
  fs.readFileSync(path.join(dataDir, 'dictionary.json'), 'utf8')
);
const GLOSSARY_PROMPT = buildPrompt('developer', termsFromDictionary(dictionary));

// ---------------------------------------------------------------- áudio

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function recordPhrase(phrase, wav) {
  console.log(`\n  Leia em voz alta:\n    "${phrase.text}"`);
  await ask('  ENTER para começar a gravar… ');
  const child = spawn(path.join(binDir, 'vox-helper'), ['record', wav], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  await ask('  gravando, ENTER para parar… ');
  child.stdin.write('stop\n');
  await new Promise((resolve) => child.on('close', resolve));
}

async function ensureAudio() {
  fs.mkdirSync(audioDir, { recursive: true });
  for (const phrase of PHRASES) {
    const tag = useMicrophone ? 'voz' : `${voice.toLowerCase()}-${rate}`;
    const wav = path.join(audioDir, `${tag}-${phrase.id}.wav`);
    phrase.wav = wav;
    if (fs.existsSync(wav)) continue;
    if (useMicrophone) {
      await recordPhrase(phrase, wav);
    } else {
      const aiff = `${wav}.aiff`;
      execFileSync('say', ['-v', voice, '-r', String(rate), '-o', aiff, phrase.text]);
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
      fs.unlinkSync(aiff);
    }
  }
}

// ---------------------------------------------------------------- execução

function transcribe(wav, prompt) {
  const cliArgs = ['-m', model, '-l', 'pt', '-nt', '-np', '-t', '6', '-f', wav];
  if (prompt) cliArgs.push('--prompt', prompt);
  const started = Date.now();
  // stderr do whisper-cli é ruído de diagnóstico; só queremos o texto.
  const out = execFileSync(path.join(binDir, 'whisper-cli'), cliArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return { text: out.trim(), ms: Date.now() - started };
}

/** Um termo "sobreviveu" se aparece no texto final com a grafia exata. */
function score(text, terms) {
  const hits = terms.filter((term) => text.toLowerCase().includes(term.toLowerCase()) &&
    new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), '').test(text));
  return { hits: hits.length, total: terms.length, missing: terms.filter((t) => !hits.includes(t)) };
}

const VARIANTS = [
  { name: 'cru (sem prompt, sem dicionário)', prompt: '', dict: false },
  { name: 'glossário no prompt', prompt: GLOSSARY_PROMPT, dict: false },
  { name: 'glossário + dicionário', prompt: GLOSSARY_PROMPT, dict: true },
];

async function main() {
  if (!fs.existsSync(model)) {
    console.error(`Modelo não encontrado: ${model}`);
    process.exit(1);
  }
  console.log(`\nModelo: ${path.basename(model)}`);
  console.log(
    `Áudio:  ${useMicrophone ? 'sua voz' : `síntese do macOS (${voice}, ${rate} palavras/min)`}\n`
  );

  await ensureAudio();

  const totals = VARIANTS.map(() => ({ hits: 0, total: 0, ms: 0 }));
  const misses = VARIANTS.map(() => []);

  for (const phrase of PHRASES) {
    console.log(`\n\x1b[1m${phrase.id}\x1b[0m  "${phrase.text}"`);
    for (const [index, variant] of VARIANTS.entries()) {
      const { text: raw, ms } = transcribe(phrase.wav, variant.prompt);
      const text = variant.dict ? applyDictionary(raw, dictionary) : raw;
      const result = score(text, phrase.terms);
      totals[index].hits += result.hits;
      totals[index].total += result.total;
      totals[index].ms += ms;
      misses[index].push(...result.missing);
      const mark = result.hits === result.total ? '\x1b[32m●\x1b[0m' : '\x1b[33m●\x1b[0m';
      console.log(`  ${mark} ${String(result.hits).padStart(2)}/${result.total}  ${variant.name}`);
      console.log(`       ${text}`);
    }
  }

  console.log('\n\x1b[1mResumo: termos técnicos preservados\x1b[0m');
  for (const [index, variant] of VARIANTS.entries()) {
    const { hits, total, ms } = totals[index];
    const pct = ((hits / total) * 100).toFixed(1);
    console.log(
      `  ${String(pct).padStart(5)}%  (${hits}/${total})  ${String(Math.round(ms / PHRASES.length)).padStart(5)} ms/frase  ${variant.name}`
    );
    const unique = [...new Set(misses[index])];
    if (unique.length > 0) console.log(`          faltaram: ${unique.join(', ')}`);
  }
  console.log(
    `\nÁudios em ${audioDir}: apague para regravar.\n` +
    `Termos que faltarem viram entradas no seu dicionário pessoal.\n`
  );
}

void main();
