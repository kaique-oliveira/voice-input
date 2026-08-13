/**
 * Segundo estágio: um modelo de linguagem local só para pontuar e capitalizar.
 *
 * O escopo já foi maior. A versão anterior mandava o modelo desembaraçar frase
 * reformulada, o que é interpretar intenção, e para isso usava um modelo de 4B.
 * Medido em uso real, aquilo custava de 6 a 15 segundos por ditado e devolvia
 * saída vazia em toda tentativa registrada no log. O trabalho que sobra aqui é
 * o que a correção determinística não faz: maiúscula de nome próprio e vírgula
 * onde a fala pedia. Isso um modelo pequeno resolve em menos de 300 ms.
 *
 * A regra é dura e simples: o modelo pode mudar pontuação, acentuação e
 * maiúsculas, mais nada. `isFaithful` compara a sequência de palavras dos dois
 * textos e reprova qualquer diferença, então uma palavra trocada nunca chega
 * até você. O pior caso deste arquivo é não melhorar. Nunca é virar outra coisa.
 */

/**
 * Instrução deliberadamente restritiva: proíbe mais do que permite.
 *
 * O exemplo não é enfeite. Sem ele, um modelo pequeno entende "corrija" como
 * "melhore" e começa a trocar palavras. Mostrar uma entrada e uma saída ancora
 * o comportamento muito melhor que qualquer quantidade de regra escrita.
 */
export const POLISH_SYSTEM_PROMPT = [
  'Você recebe a transcrição de uma fala em português do Brasil.',
  'Devolva o MESMO texto, mudando apenas pontuação, acentuação e maiúsculas.',
  '',
  'PROIBIDO:',
  '- trocar, acrescentar ou remover qualquer palavra',
  '- reordenar, resumir ou responder ao conteúdo',
  '- mexer em termo técnico, comando ou palavra em inglês',
  '- usar travessão, ponto e vírgula ou reticências',
  '',
  'Exemplo',
  'Entrada: então eu preciso commitar isso na branch develop. depois roda o',
  'teste no git hub actions',
  'Saída: Então eu preciso commitar isso na branch develop, depois roda o teste',
  'no GitHub Actions.',
  '',
  'Responda somente com o texto.',
].join('\n');

/**
 * Sequência de palavras, sem acento, sem maiúscula e sem pontuação.
 *
 * É a forma canônica da fala: tudo que o polimento tem permissão de mudar
 * desaparece nesta normalização. Duas sequências iguais significam que só a
 * pontuação, a acentuação e as maiúsculas mudaram.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export interface FaithfulnessCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Decide se a saída do modelo ainda é a fala do usuário.
 *
 * A pergunta é uma só: as palavras são exatamente as mesmas, na mesma ordem?
 *
 * Antes eram três perguntas com limiares (18% de palavras novas, 72% de
 * conteúdo preservado, 70% do último terço), porque o modelo tinha licença
 * para apagar hesitação e escolher entre duas versões de uma frase. Com o
 * escopo reduzido a pontuação e maiúsculas, licença nenhuma sobra, e limiar
 * vira brecha: uma troca de "eu" por "você" num texto de 17 palavras dá 6% de
 * palavras novas e passava batido. Foi o que o Gemma 1B fez no teste.
 *
 * Comparar a sequência inteira não tem brecha e ainda diz onde quebrou.
 */
export function isFaithful(original: string, polished: string): FaithfulnessCheck {
  const before = words(original);
  const after = words(polished);

  if (after.length === 0) return { ok: false, reason: 'saída vazia' };
  if (after.length !== before.length) {
    return { ok: false, reason: `${before.length} palavras viraram ${after.length}` };
  }

  for (let index = 0; index < before.length; index++) {
    if (before[index] !== after[index]) {
      return { ok: false, reason: `trocou "${before[index]}" por "${after[index]}"` };
    }
  }

  return { ok: true };
}

/** Tira aspas e prefixos que modelos gostam de acrescentar mesmo proibidos. */
export function cleanModelOutput(raw: string): string {
  // Rede de segurança para modelo que raciocina em voz alta: se o bloco de
  // pensamento escapar, ele não pode virar texto colado no seu editor.
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  text = text.replace(/^(?:texto corrigido|corrigido|saída|resposta)\s*:\s*/i, '');
  // Aspas envolvendo o texto inteiro, não as que fazem parte da fala.
  const wrapped = /^"([\s\S]+)"$/.exec(text) ?? /^'([\s\S]+)'$/.exec(text);
  if (wrapped) text = wrapped[1];
  return text.trim();
}
