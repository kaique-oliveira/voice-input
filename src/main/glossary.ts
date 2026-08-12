import type { Mode } from './config';

/**
 * O `initial_prompt` do Whisper é o mecanismo mais eficaz que temos contra o
 * "abrasileiramento" de termos técnicos: o decoder recebe esse texto como se
 * fosse o trecho anterior da transcrição e passa a favorecer essa grafia.
 *
 * Limite duro: 224 tokens. Passar disso faz o whisper.cpp truncar pela
 * ESQUERDA, ou seja, você perde o começo da lista. Por isso o corte por
 * caracteres em `buildPrompt`.
 */
const DEVELOPER_PROMPT =
  'Ditado de um desenvolvedor brasileiro. O idioma é português do Brasil, e os ' +
  'termos técnicos em inglês são escritos como no original: git, commit, push, ' +
  'pull request, merge, rebase, branch, deploy, build, Docker, Kubernetes, ' +
  'TypeScript, React, Next.js, Node.js, PostgreSQL, Redis, API, endpoint, ' +
  'webhook, GitHub, npm, backend, frontend, cache, query, log, debug, README, ' +
  'open source, IA, MIT, Cursor, ChatGPT, Claude, Claude Code.';

/**
 * No modo normal só pedimos português correto e pontuado, sem enviesar para
 * vocabulário técnico, que atrapalharia uma conversa no WhatsApp. Ainda assim
 * o inglês precisa sair escrito direito: até em conversa pessoal aparece
 * "print", "e-mail", "link".
 */
const NORMAL_PROMPT =
  'Ditado em português do Brasil, com pontuação e acentuação corretas. ' +
  'Palavras em inglês são escritas como no original.';

/**
 * O whisper.cpp corta o prompt pelo FIM: se passar de 224 tokens, ele mantém
 * os últimos e joga fora o começo (ver whisper.cpp, prompt_past1). Por isso
 * duas decisões aqui:
 *
 *   1. o teto é conservador, ~3,4 caracteres por token no mix pt/en;
 *   2. os termos mais confundidos ficam no FINAL da lista, onde sobrevivem.
 *
 * Um glossário gigante não ajuda: ele estoura o limite e some justamente o
 * começo, sem aviso nenhum.
 */
const MAX_PROMPT_CHARS = 620;

/**
 * Monta o prompt final. Termos extras do usuário entram no fim e são cortados
 * primeiro se não couberem, o núcleo do glossário nunca é perdido.
 */
export function buildPrompt(mode: Mode, extraTerms: string[] = []): string {
  const base = mode === 'developer' ? DEVELOPER_PROMPT : NORMAL_PROMPT;
  if (extraTerms.length === 0) return base;

  let prompt = base;
  const budget = MAX_PROMPT_CHARS - base.length - ' Também: .'.length;
  if (budget <= 0) return base;

  const kept: string[] = [];
  let used = 0;
  for (const term of extraTerms) {
    const cost = term.length + 2;
    if (used + cost > budget) break;
    kept.push(term);
    used += cost;
  }
  if (kept.length > 0) prompt += ` Também: ${kept.join(', ')}.`;
  return prompt;
}

/**
 * Os valores do dicionário pessoal viram automaticamente termos do prompt:
 * se você ensinou "brench → branch", "branch" passa a ser sugerido ao decoder.
 * Assim uma correção só precisa ser cadastrada uma vez.
 */
export function termsFromDictionary(dictionary: Record<string, string>): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of Object.values(dictionary)) {
    const trimmed = value.trim();
    // Frases inteiras não ajudam o decoder e gastam o orçamento de tokens.
    if (!trimmed || trimmed.split(/\s+/).length > 3) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(trimmed);
  }
  return terms;
}
