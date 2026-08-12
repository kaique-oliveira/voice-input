import type { Mode } from './config';

/**
 * Correção determinística: sem LLM, sem rede, custo em microssegundos.
 *
 * A regra que guia tudo aqui é a sua: NÃO reescrever a fala. Só limpar
 * artefato de transcrição e consertar a grafia de termos técnicos.
 */

/** Frases que o Whisper inventa quando o áudio é silêncio ou ruído. */
const HALLUCINATIONS = [
  'legendas pela comunidade amara.org',
  'legendas pela comunidade amara org',
  'obrigado por assistir',
  'obrigado por assistir!',
  'inscreva-se no canal',
  'até o próximo vídeo',
  'tchau tchau',
  'amara.org',
  'thanks for watching',
  'thank you for watching',
  'subscribe',
  'you',
  '.',
  '...',
];

/** Marcadores de evento não-verbal: sempre lixo para o nosso caso de uso. */
const ARTIFACT_PATTERN =
  /\[(?:blank_audio|música|musica|music|silence|silêncio|aplausos|applause|risos|laughter|inaudível|inaudible)\]|\((?:música|musica|music|risos|aplausos|inaudível)\)/gi;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fronteira de palavra ciente de acentuação. O `\b` do JavaScript trata "ç" e
 * "á" como não-letras, o que estragaria "comitação" ou "não".
 */
function buildEntryRegex(key: string): RegExp {
  const body = escapeRegex(key.trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu');
}

let compiledCache: { source: Record<string, string>; entries: Array<[RegExp, string]> } | null = null;

/**
 * Compila e memoriza os regexes. O dicionário muda raramente (só quando você
 * edita), então recompilar a cada transcrição seria desperdício.
 */
function compile(dictionary: Record<string, string>): Array<[RegExp, string]> {
  if (compiledCache && compiledCache.source === dictionary) return compiledCache.entries;

  const entries = Object.entries(dictionary)
    .filter(([key, value]) => key.trim().length > 0 && typeof value === 'string')
    // Chaves mais longas primeiro: "git hub" tem de ganhar de "git".
    .sort((a, b) => b[0].length - a[0].length)
    .map(([key, value]) => [buildEntryRegex(key), value] as [RegExp, string]);

  compiledCache = { source: dictionary, entries };
  return entries;
}

export function applyDictionary(text: string, dictionary: Record<string, string>): string {
  let output = text;
  for (const [regex, replacement] of compile(dictionary)) {
    // `$` no valor viraria referência de grupo; escapamos para colar literal.
    output = output.replace(regex, replacement.replace(/\$/g, '$$$$'));
  }
  return output;
}

/**
 * Marcadores de concordância que o Whisper pontua como pergunta.
 *
 * "configuração e tudo mais, né?" não é uma pergunta: é o jeito de falar. O
 * ponto de interrogação muda o tom da frase escrita, então vira vírgula.
 * A lista é curta de propósito, só com marcadores que praticamente nunca são
 * pergunta de verdade. "sabe?" e "certo?" ficam de fora porque muitas vezes
 * são.
 */
const TAG_MARKERS = ['né', 'viu'];

function softenTagQuestions(text: string, protectedWords: Set<string>): string {
  const pattern = new RegExp(
    `(^|[\\s,])(${TAG_MARKERS.join('|')})\\?(\\s*)(\\S+)?`,
    'giu'
  );

  return text.replace(pattern, (_match, before: string, marker: string, _gap: string, next?: string) => {
    // No fim do texto não cabe vírgula: encerra a frase.
    if (!next) return `${before}${marker}.`;

    // Whisper capitaliza a palavra seguinte porque tratou como nova frase.
    // Só desfazemos isso quando é claramente palavra comum: nada de "GitHub"
    // virar "gitHub" nem "Claude" virar "claude".
    const bare = next.replace(/[^\p{L}\p{N}]/gu, '');
    const isOrdinaryWord =
      /^\p{Lu}\p{Ll}+$/u.test(bare) && !protectedWords.has(bare.toLowerCase());
    const following = isOrdinaryWord ? next[0].toLowerCase() + next.slice(1) : next;

    return `${before}${marker}, ${following}`;
  });
}

/** Remove repetição consecutiva de frase, laço clássico do decoder. */
function dedupeLoops(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    if (previous && previous.trim().toLowerCase() === part.trim().toLowerCase()) continue;
    out.push(part);
  }
  return out.join(' ');
}

function tidy(text: string): string {
  return text
    .replace(ARTIFACT_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    // Espaço antes de pontuação é artefato de segmentação, não de fala.
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

export interface CorrectionResult {
  text: string;
  /** Vazio quer dizer: não havia fala utilizável. O chamador aborta. */
  empty: boolean;
}

export function correct(
  raw: string,
  options: { mode: Mode; dictionary: Record<string, string>; useDictionary: boolean }
): CorrectionResult {
  let text = tidy(raw);
  if (!text) return { text: '', empty: true };

  const normalized = text.toLowerCase().replace(/[!?.]+$/, '').trim();
  if (HALLUCINATIONS.includes(normalized)) return { text: '', empty: true };

  text = dedupeLoops(text);

  if (options.useDictionary) {
    text = applyDictionary(text, options.dictionary);
  }

  // Depois do dicionário: os valores dele são justamente os termos que não
  // podem ter a inicial rebaixada.
  text = softenTagQuestions(text, new Set(Object.values(options.dictionary).map((v) => v.toLowerCase())));

  // Única liberdade que damos ao modo normal: garantir maiúscula inicial.
  // Nada de reescrever, resumir ou "melhorar" a frase.
  if (options.mode === 'normal' && text.length > 0) {
    text = text[0].toUpperCase() + text.slice(1);
  }

  return { text, empty: text.length === 0 };
}
