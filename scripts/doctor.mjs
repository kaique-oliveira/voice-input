#!/usr/bin/env node
/**
 * Diagnóstico rápido: responde "por que não está funcionando?" sem abrir o app.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'VoiceInput');
const binDir = path.join(root, 'resources', 'bin');

let failures = 0;

function check(label, ok, hint = '') {
  if (!ok) failures++;
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${label}${ok || !hint ? '' : `\n      → ${hint}`}`);
}

console.log('\nVoice Input: diagnóstico\n');

console.log('Binários');
check('whisper-server', fs.existsSync(path.join(binDir, 'whisper-server')), 'rode: npm run setup');
check('vox-helper', fs.existsSync(path.join(binDir, 'vox-helper')), 'rode: npm run build:helper');

console.log('\nModelos');
const modelsDir = path.join(dataDir, 'models');
const models = fs.existsSync(modelsDir)
  ? fs.readdirSync(modelsDir).filter((name) => name.endsWith('.bin'))
  : [];
check(`${models.length} modelo(s) em ${modelsDir}`, models.length > 0, 'rode: npm run setup');
for (const name of models) {
  const size = fs.statSync(path.join(modelsDir, name)).size / 1024 / 1024;
  console.log(`      ${name}: ${size.toFixed(0)} MB`);
}

console.log('\nPermissões');
try {
  const raw = execFileSync(path.join(binDir, 'vox-helper'), ['status'], { encoding: 'utf8' });
  const status = JSON.parse(raw.trim().split('\n').pop());
  check(
    `microfone: ${status.microphone}`,
    status.microphone === 'authorized',
    'abra Configurações no app e clique em Conceder'
  );
  check(
    `acessibilidade: ${status.accessibility}`,
    status.accessibility,
    'abra Configurações no app e clique em Conceder (necessário para colar)'
  );
  check('dispositivo de entrada presente', status.inputDevice, 'conecte um microfone');
} catch (error) {
  check('vox-helper responde', false, String(error.message).split('\n')[0]);
}

console.log('\nConfiguração');
const configFile = path.join(dataDir, 'config.json');
if (fs.existsSync(configFile)) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  console.log(`      atalho: ${config.shortcut} · modo: ${config.mode} · modelo: ${config.model}`);
} else {
  console.log('      ainda usando os padrões (config.json será criado no primeiro uso)');
}

console.log(
  failures === 0
    ? '\n\x1b[32mTudo certo.\x1b[0m Rode: npm start\n'
    : `\n\x1b[31m${failures} problema(s).\x1b[0m Veja as dicas acima.\n`
);
process.exit(failures === 0 ? 0 : 1);
