import fs from 'node:fs';
import { dictionaryFile } from './paths';

/**
 * Dicionário determinístico pt-BR → grafia técnica correta.
 *
 * Regras de ouro para editar:
 *  - a chave é o que o Whisper ERRA, o valor é o que você quis dizer;
 *  - a comparação é case-insensitive e respeita fronteira de palavra;
 *  - chaves com espaço viram frases (o espaço casa com qualquer whitespace);
 *  - prefira frases quando a palavra isolada é uma palavra real do português.
 *    "puxe" sozinho é português legítimo; "dá puxe" quase certamente é "dá push".
 */
export const DEFAULT_DICTIONARY: Record<string, string> = {
  // Git
  comite: 'commit',
  comites: 'commits',
  cômite: 'commit',
  comitar: 'commitar',
  comita: 'commita',
  comitei: 'commitei',
  commitar: 'commitar',
  brench: 'branch',
  brenche: 'branch',
  branche: 'branch',
  brenches: 'branches',
  // "push" é o termo que o Whisper mais deforma em português. Todas as chaves
  // abaixo são frases porque "puxe" e "paz" são palavras legítimas sozinhas.
  'dá puxe': 'dá push',
  'da puxe': 'dá push',
  'o puxe': 'o push',
  'um puxe': 'um push',
  'faz o puxe': 'faz o push',
  'dá paz': 'dá push',
  'da paz': 'dá push',
  'e dá paz': 'e dá push',
  'dá um paz': 'dá um push',
  'faz o paz': 'faz o push',
  'pul request': 'pull request',
  'pull requeste': 'pull request',
  'pulrequest': 'pull request',
  'pull rêquest': 'pull request',
  guit: 'Git',
  guite: 'Git',
  'git rebeis': 'git rebase',
  rebeis: 'rebase',
  'guit hub': 'GitHub',
  'git hub': 'GitHub',
  github: 'GitHub',
  'git lab': 'GitLab',
  gitlab: 'GitLab',
  'cheri pick': 'cherry-pick',
  'cherry pick': 'cherry-pick',
  estache: 'stash',
  'merje': 'merge',
  'merdge': 'merge',

  // Linguagens e frameworks
  'tai script': 'TypeScript',
  'taipiscript': 'TypeScript',
  'type script': 'TypeScript',
  typescript: 'TypeScript',
  'java script': 'JavaScript',
  javascript: 'JavaScript',
  reacte: 'React',
  riacte: 'React',
  react: 'React',
  'next js': 'Next.js',
  'next ponto js': 'Next.js',
  nexte: 'Next.js',
  'nex js': 'Next.js',
  'node js': 'Node.js',
  'node ponto js': 'Node.js',
  'nod js': 'Node.js',
  'nest js': 'NestJS',
  'view js': 'Vue.js',
  taiwind: 'Tailwind',
  teilwind: 'Tailwind',
  tailwind: 'Tailwind',
  prisma: 'Prisma',
  'es lint': 'ESLint',
  eslint: 'ESLint',
  'python': 'Python',
  'raste': 'Rust',
  'eletron': 'Electron',
  'swift': 'Swift',

  // Infra
  dóquer: 'Docker',
  docker: 'Docker',
  'docker composs': 'Docker Compose',
  'docker compose': 'Docker Compose',
  quebernetes: 'Kubernetes',
  kubernets: 'Kubernetes',
  kubernetes: 'Kubernetes',
  contêiner: 'container',
  'local host': 'localhost',
  localhost: 'localhost',
  'ci cd': 'CI/CD',
  versel: 'Vercel',
  vercél: 'Vercel',
  vercel: 'Vercel',
  'supa base': 'Supabase',
  supabase: 'Supabase',
  'fire base': 'Firebase',
  firebase: 'Firebase',
  'deploi': 'deploy',
  'deployar': 'deployar',
  'bild': 'build',

  // Dados
  postgre: 'PostgreSQL',
  postgres: 'PostgreSQL',
  postgrés: 'PostgreSQL',
  'post gre sql': 'PostgreSQL',
  postgresql: 'PostgreSQL',
  'esquiel': 'SQL',
  sql: 'SQL',
  redis: 'Redis',
  'mongo db': 'MongoDB',
  mongodb: 'MongoDB',
  jason: 'JSON',
  jeison: 'JSON',
  json: 'JSON',
  cachê: 'cache',

  // Web
  api: 'API',
  apis: 'APIs',
  'end point': 'endpoint',
  endpoint: 'endpoint',
  'web hook': 'webhook',
  webhook: 'webhook',
  'front end': 'frontend',
  'back end': 'backend',
  'rest full': 'RESTful',
  http: 'HTTP',
  https: 'HTTPS',
  url: 'URL',

  // Ferramentas.
  // "Claude" vira "cloud" com muita frequência. Só mapeamos as formas em que
  // "cloud" quase certamente não é a palavra inglesa: sozinho ele continua
  // valendo, porque "cloud computing" e "a cloud da AWS" são legítimos.
  'cloud code': 'Claude Code',
  'clod code': 'Claude Code',
  'claude code': 'Claude Code',
  'cloud cod': 'Claude Code',
  'ponto cloud': '.claude',
  'pasta cloud': 'pasta .claude',
  'o cloud code': 'o Claude Code',
  'chat gpt': 'ChatGPT',
  chatgpt: 'ChatGPT',
  'vs code': 'VS Code',
  'vs cod': 'VS Code',
  'êne pê ême': 'npm',
  npm: 'npm',
  'debagar': 'debugar',
  'console ponto log': 'console.log',
  'console log': 'console.log',

  // Siglas e palavras que o ditado gruda na palavra anterior.
  'tudo kia': 'tudo com IA',
  'feito kia': 'feito com IA',
  'com i a': 'com IA',
  'read me': 'README',
  'readme': 'README',
  'open sorce': 'open source',
  'opem source': 'open source',
  'mit': 'MIT',
  'reposit ório': 'repositório',
};

export function loadDictionary(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(dictionaryFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Sem arquivo ainda: escreve o dicionário base para você poder editar.
  }
  saveDictionary(DEFAULT_DICTIONARY);
  return DEFAULT_DICTIONARY;
}

export function saveDictionary(dictionary: Record<string, string>): void {
  fs.writeFileSync(dictionaryFile, JSON.stringify(dictionary, null, 2), 'utf8');
}
