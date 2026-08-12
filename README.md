<div align="center">

<img src="public/logo.png" width="120" alt="Voice Input">

# Voice Input

**Ditado por voz para macOS, 100% local.**

Aperte o atalho, fale, aperte de novo. O texto aparece onde o cursor estava.

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black)](https://github.com/kaique-oliveira/voice-input/releases)
[![License](https://img.shields.io/badge/license-MIT-e41b22)](LICENSE)
[![Offline](https://img.shields.io/badge/rede-zero-2ea44f)](#privacidade)

</div>

---

## Por que existe

Ditado comum destrói vocabulário técnico. Você fala:

> commita essa alteração e dá push para a branch develop

E recebe:

> comita essa alteração e da puxe para a brench develope

O Voice Input resolve isso enviesando o reconhecedor com um glossário técnico
antes de decodificar, e passando o resultado por um dicionário de correções.
Medido neste projeto, isso leva a preservação de termos técnicos de **69,7% para
93,9%**, ao custo de cerca de 11 milissegundos.

Nenhum áudio, nenhuma transcrição e nenhum texto sai da máquina.

---

## Instalar

### Opção 1: baixar o app pronto

Baixe o `.zip` mais recente em
[Releases](https://github.com/kaique-oliveira/voice-input/releases),
descompacte e arraste `Voice Input.app` para a pasta Aplicativos.

Como o app não é notarizado pela Apple, a primeira abertura precisa ser com
**clique direito no app, depois Abrir**.

Na primeira execução, abra as Configurações pelo menu do ícone e faça três coisas:

1. Baixe o modelo de transcrição (575 MB, uma vez só).
2. Conceda a permissão de Microfone.
3. Conceda a permissão de Acessibilidade, necessária para colar sozinho.

### Opção 2: compilar do código

```bash
git clone https://github.com/kaique-oliveira/voice-input.git
cd voice-input
npm install
npm run setup     # compila o whisper.cpp, o helper Swift e baixa o modelo
npm run package   # monta o Voice Input.app
cp -R "dist-app/Voice Input.app" /Applications/
```

Requisitos: macOS com Apple Silicon, Node 20 ou superior, CMake e as Command
Line Tools do Xcode.

---

## Usar

| Ação | Como |
|---|---|
| Gravar e parar | `⌃⌥Espaço`, ou clique esquerdo no ícone da barra |
| Menu | Clique direito no ícone |
| Parar ou cancelar | Botões do painel flutuante que aparece ao gravar |

Enquanto você fala, um painel flutuante mostra o tempo decorrido, um botão para
transcrever e outro para descartar.

O atalho é configurável. O padrão evita `⌥Espaço` de propósito, porque apps como
Raycast e Alfred capturam teclas por event tap e engolem essa combinação sem que
o registro do atalho falhe.

---

## Como funciona

```
atalho ─┬─► grava o microfone ────────────────► [você fala]
        ├─► guarda qual app está em foco
        └─► sobe o modelo em paralelo            (esquenta enquanto você fala)

atalho ─► para ─► transcreve ─► corrige ─► cola no app de origem ─► ocioso
```

Quatro peças, cada uma com um trabalho:

| Peça | Função | Quando existe |
|---|---|---|
| Electron e TypeScript | atalho, menu, máquina de estados | sempre |
| `vox-helper` (Swift) | grava, cola, lê o app em foco | milissegundos por comando |
| `whisper-server` (C++ com Metal) | transcrição | sob demanda, morre após 5 min ocioso |
| Correção | glossário e dicionário | é código puro, não é processo |

### Decisões de arquitetura

**whisper.cpp, e não Parakeet ou MLX.** O whisper.cpp aceita `initial_prompt`,
que condiciona o decoder com um glossário técnico. É o mecanismo mais eficaz
contra o abrasileiramento de termos em inglês, e os outros runtimes não têm
equivalente. De quebra, é binário estático: nenhum Python no projeto.

**Nenhum LLM na correção.** Os números medidos:

| Pipeline | Termos técnicos corretos | Custo |
|---|---|---|
| Whisper puro | 69,7% | 682 ms |
| Mais glossário no prompt | 87,9% | 698 ms |
| Mais dicionário determinístico | **93,9%** | 693 ms |

Um LLM custaria mais 2 GB de RAM, mais 2 segundos de latência e o risco de
reescrever o que você falou, para disputar os 6% restantes. A interface está
pronta em `corrector.ts` caso um dia valha a pena.

**Helper em Swift.** Gravar pelo renderer do Electron custaria ou 80 MB
permanentes de memória, ou 300 ms de latência no início da fala, o que corta a
primeira palavra. O helper é um arquivo só, sem projeto Xcode, e resolve também
o `⌘V` sintético e a detecção do app em foco.

**A transcrição sempre passa pela área de transferência.** Ela é escrita lá
antes de qualquer tentativa de colar. Colar tem várias formas de falhar que não
dependem do app: campo protegido por Secure Input, aplicativo que ignora `⌘V`,
permissão revogada. Em todas elas o texto continua a um `⌘V` manual de
distância, em vez de sumir.

**Colar por `⌘V`, e não pela Accessibility API.** Escrever direto via
`AXUIElement` funciona em apps AppKit nativos e falha em Electron, web views e
terminais, ou seja, exatamente no Cursor, no ChatGPT e no WhatsApp. O clipboard
funciona em todo lugar.

**O app nunca rouba o foco.** Ele é *accessory*, sem ícone na Dock, e o atalho
global usa `RegisterEventHotKey`. O app onde você digita continua sendo o
frontmost o tempo todo, e o cursor de texto não se move. É isso que faz o texto
cair no lugar certo.

---

## Desempenho

Medido em MacBook Pro M5 com 24 GB.

| | |
|---|---|
| RAM em repouso | cerca de 210 MB, sem nada de IA carregado |
| CPU em repouso | 0% |
| RAM transcrevendo | mais 830 MB, liberados após 5 min ocioso |
| Carregar o modelo, a frio | 6,6 s, escondido atrás da gravação |
| Carregar o modelo, a quente | 0,2 s |
| Transcrever 12 s de fala | 570 ms |
| Do fim da fala ao texto colado | **menos de 1 s** com o modelo quente |

Os 210 MB em repouso são o piso do Electron, não do código deste projeto.

---

## Modos

O modo decide o prompt enviado ao reconhecedor e se o dicionário técnico é
aplicado.

**Developer.** Glossário técnico no prompt, dicionário ligado. Para Cursor,
terminais, VS Code, ChatGPT, Claude Code, Antigravity.

**Normal.** Prompt neutro, dicionário desligado, apenas a maiúscula inicial
garantida. Para WhatsApp, Mail, Slack, Notas.

Em **Automático**, que é o padrão, o app resolve pelo bundle id do app em foco,
com regras por nome como rede de segurança. O mapa está em
[`src/main/context.ts`](src/main/context.ts).

Em nenhum modo o texto é reescrito, resumido ou melhorado.

---

## Dicionário pessoal

Fica em `~/Library/Application Support/VoiceInput/dictionary.json`, editável
pela janela de Configurações ou direto no arquivo.

```json
{
  "brench": "branch",
  "comite": "commit",
  "dá paz": "dá push",
  "next js": "Next.js"
}
```

A chave é o que o reconhecedor erra, o valor é o certo. A comparação ignora
maiúsculas e respeita fronteira de palavra com acentuação.

Chaves com espaço viram frases. **Prefira frases quando a palavra sozinha existe
em português**: `puxe` e `paz` são palavras legítimas, mas `dá puxe` e `dá paz`,
num contexto de código, quase sempre são `dá push`.

Os valores do dicionário viram automaticamente termos do prompt. Ensinar uma
correção uma vez melhora as duas etapas do pipeline.

Para descobrir o que adicionar, rode o benchmark com a sua voz:

```bash
npm run bench -- --record
```

Ele lê 10 frases técnicas, mede quantos termos sobrevivem em cada etapa e lista
os que faltaram.

---

## Configuração

| Chave | Padrão | O que faz |
|---|---|---|
| `shortcut` | `Control+Alt+Space` | atalho global |
| `model` | `ggml-large-v3-turbo-q5_0.bin` | modelo de transcrição |
| `beamSize` | `5` | qualidade do decoder; 1 é guloso e 45 ms mais rápido |
| `threads` | `6` | threads do whisper |
| `keepModelWarmMs` | `300000` | quanto o modelo fica em RAM sem uso |
| `mode` | `auto` | `auto`, `developer` ou `normal` |
| `insertMode` | `paste` | `paste` cola com ⌘V, `clipboard` só copia |
| `restoreClipboard` | `false` | ligado devolve o clipboard anterior, desligado deixa a transcrição como reserva |
| `minPeak` | `0.004` | abaixo disso considera silêncio |
| `maxRecordingSec` | `300` | corta sozinho se você esquecer de parar |

---

## Privacidade

O áudio existe apenas entre a fala e a transcrição, num arquivo temporário
apagado logo em seguida. O log registra durações e tamanhos, nunca o texto.

A rede é usada em exatamente um lugar: o download do modelo, no Hugging Face,
quando você clica no botão. Depois disso o app funciona sem internet.

---

## Diagnóstico

Se algo não funcionar, nesta ordem:

1. **Testar colagem**, no menu do ícone. Cola um texto fixo sem passar por
   microfone nem modelo. Se falhar, o problema é a permissão de Acessibilidade.
2. **Abrir log**, no mesmo menu. Registra cada passo com tempos, o app de
   destino e a origem do disparo.
3. `npm run doctor`, se você compilou do código.

---

## Limitações do macOS

Reais, não contornáveis por código:

1. Campos de senha, sob Secure Input, bloqueiam colagem sintética. É por design.
2. Gerenciadores de clipboard como Raycast e Maccy capturam cada transcrição no
   histórico, mesmo com a restauração ligada.
3. Só aplicativos de bundle aparecem no painel de Acessibilidade, por isso o app
   precisa ser empacotado. Rodar via `npm start` nunca consegue colar.
4. A assinatura é ad-hoc, então reinstalar gera um selo novo e o macOS pede as
   permissões de novo.
5. O atalho é toggle, não push-to-talk. O `globalShortcut` do Electron não
   reporta a soltura da tecla.

---

## Estrutura

```
native/VoxHelper.swift      todo o código nativo
src/main/
  index.ts                  boot, atalho global, ciclo de vida
  session.ts                a máquina de estados
  whisper.ts                whisper-server sob demanda
  model.ts                  catálogo e download do modelo
  corrector.ts              limpeza e dicionário, sem LLM
  glossary.ts               prompts de viés técnico
  context.ts                app em foco para modo
  tray.ts overlay.ts        barra de menu e painel flutuante
  glyph.ts icons.ts         ícones desenhados em código
src/renderer/               HTML e JS puros, sem framework
scripts/                    setup, empacotamento, benchmark, diagnóstico
```

---

## Roadmap

- [ ] LLM local opcional na correção, se o benchmark justificar
- [ ] Assinatura estável para não perder permissões a cada atualização
- [ ] Push-to-talk
- [ ] Histórico de transcrições

---

## Créditos

Construído sobre [whisper.cpp](https://github.com/ggml-org/whisper.cpp), de
Georgi Gerganov, e sobre o modelo [Whisper](https://github.com/openai/whisper),
da OpenAI.

Licença [MIT](LICENSE).
