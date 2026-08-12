/**
 * Segundo estágio: arrumar a estrutura da fala com um modelo de linguagem local.
 *
 * Existe por um motivo específico que nenhum reconhecedor resolve. Quando o
 * falante começa uma frase, se interrompe e recomeça de outro jeito, a
 * transcrição fiel fica assim:
 *
 *   "Então eu queria que ele, na verdade, o que eu quero é que ele entenda..."
 *
 * O whisper está certo: foi isso que a pessoa disse. Escolher a versão que ela
 * de fato quis dizer é interpretar intenção, e isso é trabalho de modelo de
 * linguagem. A correção determinística de `corrector.ts` não alcança, porque
 * aqui não há repetição literal, há reformulação.
 *
 * O RISCO é conhecido: modelo de linguagem adora reescrever. Por isso nada aqui
 * é confiado ao modelo. Toda saída passa pela verificação de `isFaithful`, e o
 * texto original prevalece em qualquer dúvida. O pior caso deste arquivo é não
 * melhorar. Nunca é transformar o que você falou em outra coisa.
 */

/**
 * Instrução deliberadamente restritiva: proíbe mais do que permite.
 *
 * Os exemplos não são enfeite. Sem eles, um modelo de 4B entende "corrija" como
 * "melhore" e começa a trocar palavras. Mostrar uma entrada e uma saída ancora
 * o comportamento muito melhor que qualquer quantidade de regra escrita.
 */
export const POLISH_SYSTEM_PROMPT = [
  'Você é um revisor de transcrições de fala em português do Brasil.',
  'Seu trabalho é pontuar e desembaraçar, nunca reescrever.',
  '',
  'PROIBIDO:',
  '- trocar uma palavra por sinônimo',
  '- resumir, encurtar ou apagar qualquer ideia dita',
  '- adicionar informação que não foi dita',
  '- responder ao conteúdo (você revisa, não conversa)',
  '- mexer na grafia de termos técnicos, comandos, nomes próprios ou palavras',
  '  em inglês',
  '',
  'PERMITIDO:',
  '- pontuação, acentuação e maiúsculas',
  '- remover hesitação: "é, é", "ãh", "tipo assim", "sabe"',
  '- quando a pessoa começou uma frase, se interrompeu e recomeçou de outro',
  '  jeito, ficar só com o recomeço',
  '',
  'Exemplo 1',
  'Entrada: então eu queria que ele, na verdade, o que eu quero é que ele',
  'entenda melhor o tom, sabe, tipo assim, quando eu me perco no meio da frase',
  'ele escreve uma coisa sem pé nem cabeça',
  'Saída: O que eu quero é que ele entenda melhor o tom. Quando eu me perco no',
  'meio da frase, ele escreve uma coisa sem pé nem cabeça.',
  '',
  'Exemplo 2',
  'Entrada: commita essa alteração e dá push pra branch develop, e aí depois,',
  'ah, na verdade, antes disso roda o teste',
  'Saída: Commita essa alteração e dá push pra branch develop. E aí depois, na',
  'verdade antes disso, roda o teste.',
  '',
  'Responda somente com o texto revisado. Sem aspas, sem explicação, sem',
  'comentário, sem prefixo.',
].join('\n');

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}.]+/u)
    .filter(Boolean);
}

/**
 * Palavras que o polimento tem permissão de eliminar. São exatamente as que ele
 * foi contratado para tirar, então sumirem não é sinal de reescrita.
 */
const REMOVABLE = new Set([
  'e', 'ah', 'ahn', 'ne', 'ta', 'tipo', 'assim', 'sabe', 'entao', 'ai', 'la',
  'so', 'ja', 'que', 'de', 'do', 'da', 'em', 'no', 'na', 'o', 'a', 'os', 'as',
  'um', 'uma', 'para', 'pra', 'com', 'e', 'eh', 'hum', 'verdade', 'meio',
]);

export interface FaithfulnessCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Decide se a saída do modelo ainda é a fala do usuário.
 *
 * Três perguntas, todas verificáveis sem modelo nenhum:
 *
 *   1. Ele inventou palavras que não estavam na entrada?
 *   2. Ele apagou conteúdo demais?
 *   3. Ele perdeu algum termo técnico que estava lá?
 *
 * Qualquer "sim" descarta o polimento. Os limites são propositalmente
 * apertados: preferimos deixar passar um texto imperfeito a devolver um texto
 * que a pessoa não disse.
 */
export function isFaithful(
  original: string,
  polished: string,
  protectedTerms: Iterable<string>
): FaithfulnessCheck {
  const before = words(original);
  const after = words(polished);

  if (after.length === 0) return { ok: false, reason: 'saída vazia' };

  // 1. Palavras novas. Um pouco é esperado (acentuação, concordância ao juntar
  //    frases), muito significa que o modelo escreveu por conta própria.
  const pool = new Map<string, number>();
  for (const word of before) pool.set(word, (pool.get(word) ?? 0) + 1);
  let novel = 0;
  for (const word of after) {
    const left = pool.get(word) ?? 0;
    if (left > 0) pool.set(word, left - 1);
    else novel++;
  }
  const novelRatio = novel / after.length;
  if (novelRatio > 0.18) {
    return { ok: false, reason: `${Math.round(novelRatio * 100)}% de palavras novas` };
  }

  // 2. Conteúdo removido. Descontamos as palavras que ele tinha licença para
  //    tirar, senão uma fala cheia de hesitação seria reprovada injustamente.
  const meaningfulBefore = before.filter((word) => !REMOVABLE.has(word));
  const meaningfulAfter = new Set(after.filter((word) => !REMOVABLE.has(word)));
  const survivors = meaningfulBefore.filter((word) => meaningfulAfter.has(word));
  const keptRatio = meaningfulBefore.length ? survivors.length / meaningfulBefore.length : 1;
  // O limite é frouxo de propósito. Descartar o trecho abandonado de um
  // recomeço é justamente o serviço contratado, e isso apaga palavras de
  // conteúdo. Apertar aqui reprovaria os acertos. Quem protege contra resumo
  // de verdade é a checagem do final, logo abaixo, que é mais específica.
  if (keptRatio < 0.72) {
    return { ok: false, reason: `só ${Math.round(keptRatio * 100)}% do conteúdo sobreviveu` };
  }

  // Modelos pequenos gostam de "concluir" cedo e engolir o final da fala. Uma
  // razão global alta esconde isso, porque o começo intacto compensa. Então o
  // último terço é conferido à parte.
  const tail = meaningfulBefore.slice(Math.floor(meaningfulBefore.length * 0.66));
  if (tail.length >= 3) {
    const tailKept = tail.filter((word) => meaningfulAfter.has(word)).length / tail.length;
    if (tailKept < 0.7) {
      return { ok: false, reason: `perdeu o final da fala (${Math.round(tailKept * 100)}%)` };
    }
  }

  // 3. Termos técnicos. Estes são o motivo do projeto existir: perder um é
  //    reprovação imediata, por menor que seja o resto da mudança.
  const polishedLower = polished.toLowerCase();
  const originalLower = original.toLowerCase();
  for (const term of protectedTerms) {
    const needle = term.toLowerCase();
    if (originalLower.includes(needle) && !polishedLower.includes(needle)) {
      return { ok: false, reason: `perdeu o termo "${term}"` };
    }
  }

  return { ok: true };
}

/** Tira aspas e prefixos que modelos gostam de acrescentar mesmo proibidos. */
export function cleanModelOutput(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  text = text.replace(/^(?:texto corrigido|corrigido|saída|resposta)\s*:\s*/i, '');
  // Aspas envolvendo o texto inteiro, não as que fazem parte da fala.
  const wrapped = /^"([\s\S]+)"$/.exec(text) ?? /^'([\s\S]+)'$/.exec(text);
  if (wrapped) text = wrapped[1];
  return text.trim();
}
