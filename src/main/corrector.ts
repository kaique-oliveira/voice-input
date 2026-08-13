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

/**
 * Devolve a palavra sem a maiúscula que só existia por causa de uma pontuação
 * que deixou de ser fim de frase.
 *
 * Só desce a inicial quando é claramente palavra comum: nada de "GitHub" virar
 * "gitHub" nem "Claude" virar "claude". Uma letra só conta como palavra comum,
 * senão o "E" e o "A" do português ficariam de maiúscula no meio da frase.
 */
function lowerIfOrdinary(word: string, protectedWords: Set<string>): string {
  const bare = word.replace(/[^\p{L}\p{N}]/gu, '');
  const isOrdinaryWord =
    /^\p{Lu}\p{Ll}*$/u.test(bare) && !protectedWords.has(bare.toLowerCase());
  return isOrdinaryWord ? word[0].toLowerCase() + word.slice(1) : word;
}

function softenTagQuestions(text: string, protectedWords: Set<string>): string {
  const pattern = new RegExp(
    `(^|[\\s,])(${TAG_MARKERS.join('|')})\\?(\\s*)(\\S+)?`,
    'giu'
  );

  return text.replace(pattern, (_match, before: string, marker: string, _gap: string, next?: string) => {
    // No fim do texto não cabe vírgula: encerra a frase.
    if (!next) return `${before}${marker}.`;

    // Whisper capitaliza a palavra seguinte porque tratou como nova frase.
    return `${before}${marker}, ${lowerIfOrdinary(next, protectedWords)}`;
  });
}

/**
 * Sons que não são palavra em nenhum contexto. Removidos sempre.
 * "ah" fica de fora: aparece demais em fala legítima ("ah, entendi").
 */
const NOISE_WORDS = /(?<![\p{L}\p{N}])(ãh|ahn|hã|hum+|hmm+|uhum|ehm|eh|uh)(?![\p{L}\p{N}])[\s,]*/giu;

/**
 * Sequências de "é, é, é" e "ah, ah". Só remove quando há repetição, porque
 * "é" sozinho é o verbo e "ah" sozinho pode ser fala de verdade.
 */
const REPEATED_FILLER = /(?<![\p{L}\p{N}])((?:é|ah|ó)\s*,\s*)(?:(?:é|ah|ó)\s*,\s*)+/giu;

/** Repetições legítimas do português, que não são gagueira. */
const INTENTIONAL_REPEATS = new Set(['que', 'já', 'quase', 'não']);

/** "eu eu tô" vira "eu tô". */
function collapseStutters(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{N}])(\p{L}[\p{L}\p{N}'’-]*)((?:\s*,?\s+)\1)+(?![\p{L}\p{N}])/giu,
    (match, word: string) => (INTENTIONAL_REPEATS.has(word.toLowerCase()) ? match : word)
  );
}

/**
 * Colapsa trechos repetidos lado a lado.
 *
 * É o padrão de quem está pensando enquanto fala: "eu tô pensando, eu tô
 * pensando, eu tô pensando" vira "eu tô pensando". Compara por forma
 * normalizada, sem acento de pontuação nem maiúscula, e descarta a cópia da
 * esquerda para preservar a pontuação que vem depois.
 *
 * Trechos de 2 a 6 palavras. Repetição legítima desse tamanho praticamente não
 * existe na fala, e o separador costuma resolver: em "muito bom, inclusive,
 * muito bom mesmo" as duas ocorrências não são adjacentes.
 */
function collapseRepeatedPhrases(text: string): string {
  // Uma passada só resolve um nível de repetição. Repetir até estabilizar
  // limpa "A B A B A" em cadeia, com teto para nunca virar laço infinito.
  let current = text;
  for (let round = 0; round < 4; round++) {
    const next = collapseRepeatedPhrasesOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Marcadores de recomeço: o que se diz ao reiniciar a frase que já se estava
 * dizendo. A lista é curtíssima de propósito. "inclusive" fica de fora, senão
 * "muito bom, inclusive, muito bom mesmo" perderia a ênfase que foi intencional.
 */
const RESTART_MARKERS = new Set([
  'na verdade',
  'tipo',
  'tipo assim',
  'assim',
  'sabe',
  'então',
  'aí',
  'quer dizer',
]);

function isRestartMarker(normalized: string[], start: number, length: number): boolean {
  const phrase = normalized.slice(start, start + length).join(' ').trim();
  return RESTART_MARKERS.has(phrase);
}

function collapseRepeatedPhrasesOnce(text: string): string {
  const tokens = text.match(/\S+/g) ?? [];
  const normalized = tokens.map((token) =>
    token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  );
  const keep = new Array<boolean>(tokens.length).fill(true);

  let index = 0;
  while (index < tokens.length) {
    let collapsed = false;
    const maxSize = Math.min(6, Math.floor((tokens.length - index) / 2));

    outer: for (let size = maxSize; size >= 2; size--) {
      // gap 0 é a repetição colada. Os outros cobrem o recomeço de fala:
      // "se você puder, na verdade, se você puder".
      for (let gap = 0; gap <= 3; gap++) {
        if (index + size + gap + size > tokens.length) continue;
        if (gap > 0 && !isRestartMarker(normalized, index + size, gap)) continue;

        let same = true;
        for (let offset = 0; offset < size; offset++) {
          const left = normalized[index + offset];
          const right = normalized[index + size + gap + offset];
          if (!left || left !== right) {
            same = false;
            break;
          }
        }
        if (!same) continue;

        // Descarta a cópia da esquerda e o marcador de recomeço junto.
        for (let offset = 0; offset < size + gap; offset++) keep[index + offset] = false;
        // Reavalia a partir da cópia sobrevivente: assim o terceiro "eu tô
        // pensando" também colapsa.
        index += size + gap;
        collapsed = true;
        break outer;
      }
    }

    if (!collapsed) index++;
  }

  return tokens.filter((_, position) => keep[position]).join(' ');
}

/**
 * Devolve a maiúscula de início de frase perdida ao remover um "Ah," ou "É,".
 * Termos com grafia própria ficam intactos: "npm install" não vira "Npm".
 */
function recapitalize(text: string, protectedWords: Set<string>): string {
  return text.replace(/(^|[.!?]\s+)(\p{Ll})(\p{L}*)/gu, (match, before, first, rest) => {
    const word = `${first}${rest}`.toLowerCase();
    if (protectedWords.has(word)) return match;
    return `${before}${first.toUpperCase()}${rest}`;
  });
}

/**
 * Remove vícios de fala sem tocar no conteúdo.
 *
 * Tudo aqui é subtração: nada é reescrito, invertido ou resumido. As palavras
 * que sobram são exatamente as que foram ditas, na mesma ordem.
 */
function removeDisfluencies(text: string, protectedWords: Set<string>): string {
  let output = text.replace(REPEATED_FILLER, '').replace(NOISE_WORDS, ' ');
  output = collapseStutters(output);
  output = collapseRepeatedPhrases(output);
  output = output
    .replace(/\s+/g, ' ')
    // A remoção deixa buracos de pontuação: ", ," e vírgula solta no começo.
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,;:])(\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .trim();
  return recapitalize(output, protectedWords);
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

/**
 * Pontuação de conversa: ponto final vira vírgula, e o texto não termina em
 * ponto.
 *
 * O Whisper pontua fala corrida como prosa de livro: cada respiro vira ponto
 * final, e a palavra seguinte vem com maiúscula. Escrito, isso soa formal
 * demais para onde o texto de fato vai parar — mensagem de WhatsApp e prompt
 * não terminam em ponto, e "de agosto. De setembro" não era duas frases, era
 * uma pausa no meio da mesma.
 *
 * A conversão é só de ponto final. Interrogação e exclamação carregam tom e
 * ficam onde estão.
 */
const SENTENCE_BREAK = /(?<=[\p{L}\p{N}])\.\s+(["'“‘(]?)(\p{L}[\p{L}\p{N}'’-]*)/gu;

export function conversational(text: string, protectedWords: Set<string>): string {
  const output = text.replace(SENTENCE_BREAK, (_match, open: string, word: string) => {
    return `, ${open}${lowerIfOrdinary(word, protectedWords)}`;
  });

  return (
    output
      // A conversão encosta vírgula em vírgula quando a fala já tinha uma.
      .replace(/,(\s*,)+/g, ',')
      .replace(/\s+([,.!?;:])/g, '$1')
      // O ponto do fim é o que mais incomoda: nunca sobrevive. "?" e "!" sim.
      .replace(/[\s.…]+$/u, '')
      .trim()
  );
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
  options: {
    mode: Mode;
    dictionary: Record<string, string>;
    useDictionary: boolean;
    removeDisfluencies?: boolean;
    conversationalPunctuation?: boolean;
  }
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
  // podem ter a inicial mexida.
  const protectedWords = new Set(
    Object.values(options.dictionary).map((value) => value.toLowerCase())
  );

  if (options.removeDisfluencies !== false) {
    text = removeDisfluencies(text, protectedWords);
  }

  text = softenTagQuestions(text, protectedWords);

  if (options.conversationalPunctuation !== false) {
    text = conversational(text, protectedWords);
  }

  // Única liberdade que damos ao modo normal: garantir maiúscula inicial.
  // Nada de reescrever, resumir ou "melhorar" a frase.
  if (options.mode === 'normal' && text.length > 0) {
    text = text[0].toUpperCase() + text.slice(1);
  }

  return { text, empty: text.length === 0 };
}
