<div align="center">

<img src="public/logo.png" width="120" alt="Voice Input">

# Voice Input

**Ditado por voz 100% local.** macOS pronto para uso, Windows e Linux experimentais.

Aperte o atalho, fale, aperte de novo. O texto aparece onde o cursor estava.

[![macOS](https://img.shields.io/badge/macOS-pronto-2ea44f)](https://github.com/kaique-oliveira/voice-input/releases)
[![Windows e Linux](https://img.shields.io/badge/Windows%20e%20Linux-experimental-e8a33d)](#windows-e-linux)
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

Na primeira execução ele baixa sozinho os modelos que usa, em segundo plano,
e avisa quando termina. São 1,7 GB no total, uma vez só. Restam duas coisas
para você, nas Configurações pelo menu do ícone:

1. Conceda a permissão de Microfone.
2. Conceda a permissão de Acessibilidade, necessária para colar sozinho.

A pasta de modelos é por usuário do macOS. Se você usa mais de uma conta, cada
uma baixa a sua na primeira abertura.

### Opção 2: compilar do código

```bash
git clone https://github.com/kaique-oliveira/voice-input.git
cd voice-input
npm install
npm run setup     # compila whisper.cpp e llama.cpp, o helper Swift e baixa os modelos
npm run package   # monta o Voice Input.app
cp -R "dist-app/Voice Input.app" /Applications/
```

Requisitos: macOS com Apple Silicon, Node 20 ou superior, CMake e as Command
Line Tools do Xcode.

**Assine com uma identidade estável.** O macOS autoriza Microfone e
Acessibilidade pela assinatura, não pelo caminho do app: com assinatura ad-hoc
o selo muda a cada build e o sistema passa a negar a permissão mesmo com o
interruptor ligado no painel, sem dizer por quê. Veja o que você tem com
`security find-identity -p codesigning -v` e grave o nome escolhido em
`.signing-identity`, na raiz do projeto (o arquivo é ignorado pelo git). A
partir daí a permissão sobrevive a qualquer rebuild.

---

## Usar

| Ação | Como |
|---|---|
| Gravar e parar | `⌃⌥Espaço`, ou clique esquerdo no ícone da barra |
| Menu | Clique direito no ícone |
| Parar ou cancelar | Botões do painel flutuante que aparece ao gravar |

Enquanto você fala, um painel flutuante mostra o tempo decorrido, um botão para
transcrever e outro para descartar.

**O som para sozinho.** Se você estiver ouvindo música ou assistindo a alguma
coisa, o app pausa e silencia ao começar a gravar, e devolve tudo quando você
para. Não precisa ir até o player.

Sobre o "silencia junto": o macOS não expõe de forma confiável se há algo
tocando, o Chrome aparece como "emitindo som" mesmo em silêncio. Como a tecla de
mídia é um alternador, mandá-la às cegas poderia ligar música do nada. Silenciar
resolve isso: se a tecla ligar algo por engano, aquilo toca mudo e a restauração
pausa de volta. Você nunca ouve o engano.

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
| `llama-server` (C++ com Metal) | pontuação e maiúscula | sob demanda, morre após 5 min ocioso |
| Correção | glossário e dicionário | é código puro, não é processo |

### Decisões de arquitetura

**whisper.cpp, e não Parakeet ou MLX.** O whisper.cpp aceita `initial_prompt`,
que condiciona o decoder com um glossário técnico. É o mecanismo mais eficaz
contra o abrasileiramento de termos em inglês, e os outros runtimes não têm
equivalente. De quebra, é binário estático: nenhum Python no projeto.

**Correção em camadas, da mais barata para a mais cara.** Os números medidos:

| Pipeline | Termos técnicos corretos | Custo |
|---|---|---|
| Whisper puro | 69,7% | 682 ms |
| Mais glossário no prompt | 87,9% | 698 ms |
| Mais dicionário determinístico | **93,9%** | 693 ms |

Grafia de termo técnico se resolve com glossário e dicionário, que custam
milissegundos. O modelo de linguagem só entra no que sobra, que é pontuação e
maiúscula de nome próprio, e por isso é a última camada e não a primeira.

**O segundo estágio faz uma coisa só: pontuação e maiúscula.** Já fez mais, e
o histórico vale como decisão de projeto. A versão anterior pedia a um Gemma 3
de 4B que desembaraçasse frase reformulada no meio, o que é interpretar
intenção. Medido em uso real, aquilo custava de 6 a 15 segundos por ditado e
devolveu saída vazia em **toda** tentativa registrada no log: cobrava caro e
não entregava nada.

Escopo reduzido, modelo reduzido. Três candidatos foram medidos no pipeline
real:

| Modelo | Carga | Resposta | Trocou palavra? |
|---|---|---|---|
| **Qwen3 1.7B** | 524 ms | **267 ms** | não, em nenhum caso |
| Gemma 3 1B | 627 ms | 191 ms | sim: `commita`→`commite`, `eu`→`você` |
| Gemma 3 4B | 716 ms | 12.101 ms | devolvia vazio |

O que ele ganha é o que regex nenhuma alcança, nome próprio:

```
- fala pro gustavo que a gente vai subir isso na sexta e que o joão já revisou
+ Fala pro Gustavo que a gente vai subir isso na sexta e que o João já revisou

- o relatório pro pedro antes da reunião com o pessoal de são paulo
+ o relatório pro Pedro antes da reunião com o pessoal de São Paulo
```

**A conferência é uma pergunta só: as palavras são as mesmas, na mesma ordem?**
Antes eram três, com limiar: 18% de palavras novas, 72% de conteúdo preservado,
70% do último terço. Aqueles limiares existiam porque o modelo tinha licença
para apagar hesitação. Sem essa licença, limiar vira brecha — trocar "eu" por
"você" num texto de 17 palavras dá 6% de palavras novas e passava batido. Foi
exatamente o que o Gemma 1B fez no teste, e passou.

Agora a sequência inteira é comparada, ignorando acento, maiúscula e
pontuação, que é justamente o que o modelo tem permissão de mudar. Qualquer
diferença descarta o polimento e devolve o texto da etapa anterior. O pior caso
desta camada é não melhorar; nunca é virar outra coisa.

**Pontuação de conversa.** O Whisper pontua fala como prosa de livro: cada
respiro vira ponto final, e a palavra seguinte vem com maiúscula. Só que o
texto vai parar no WhatsApp ou num prompt, onde ninguém escreve assim. Então
ponto final no meio do texto vira vírgula, a maiúscula que existia só por causa
dele cai, e o texto não termina em ponto. "de agosto. De setembro" não era duas
frases, era uma pausa. Interrogação e exclamação ficam: essas carregam tom.
Termo com grafia própria nunca é rebaixado, então "Claude" e "GitHub"
continuam como estão.

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
| Segundo estágio (pontuação e maiúscula) | 267 ms de mediana |
| Do fim da fala ao texto colado | **menos de 1 s** com os modelos quentes |

Os 210 MB em repouso são o piso do Electron, não do código deste projeto.

### Requisitos mínimos e escolha do modelo

Tudo abaixo foi medido, não estimado. Os tempos são para **12 segundos de fala**
e as porcentagens são de termos técnicos preservados no pipeline completo.

| Modelo | Termos corretos | Com GPU | Só CPU | RAM enquanto transcreve |
|---|---|---|---|---|
| `large-v3-turbo` | **93,9%** | 0,73 s | 3,1 s | 830 MB |
| `small` | **90,9%** | 0,36 s | 1,2 s | 500 MB |
| `base` | 72,7% | 0,18 s | 0,42 s | 245 MB |
| `tiny` | 48,5% | 0,16 s | 0,31 s | 185 MB |

O número que mais importa aqui: **`small` com o pipeline ligado (90,9%) fica
acima do `large-v3-turbo` sem pipeline (69,7%)**. O glossário e o dicionário
valem mais que o tamanho do modelo, então máquina modesta não significa
transcrição ruim.

**Mínimo realista:** 4 GB de RAM livre, qualquer processador de 64 bits com
quatro núcleos, 2 GB de disco para os dois modelos. O app inteiro parado ocupa cerca de 210 MB e não
usa CPU nenhuma.

**Use o `large-v3-turbo` em qualquer máquina.** Ele é o padrão e não há motivo
para abrir mão da melhor transcrição. Num i3 com 8 GB ele ocupa 1,2 GB e leva
algo entre 6 e 9 segundos para 12 segundos de fala, contando que os núcleos de
um i3 são duas a três vezes mais lentos que os do M5. Continua acima do tempo
real: processar demora menos do que se levou falando, e o carregamento acontece
enquanto você ainda fala.

Troque para o `small` só se essa espera incomodar no uso contínuo. Ele custa
3 pontos percentuais de precisão e devolve três vezes a velocidade.

**Com placa NVIDIA** em Windows ou Linux, compile o whisper.cpp com CUDA e o
`large-v3-turbo` volta a ser confortável.

A escolha do modelo fica na tela de Configurações, com o download e o consumo de
cada um. Trocar não exige reinstalar nada.

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
| `polish` | `true` | segundo estágio, que pontua e capitaliza; ~280 ms |
| `polishModel` | `Qwen3-1.7B-Q4_K_M.gguf` | modelo do segundo estágio |
| `conversationalPunctuation` | `true` | ponto final vira vírgula e o texto não termina em ponto |
| `insertMode` | `paste` | `paste` cola com ⌘V, `clipboard` só copia |
| `audioWhileRecording` | `pause` | `pause` pausa e silencia, `mute` só silencia, `off` não mexe |
| `restoreClipboard` | `false` | ligado devolve o clipboard anterior, desligado deixa a transcrição como reserva |
| `minPeak` | `0.004` | abaixo disso considera silêncio |
| `maxRecordingSec` | `300` | corta sozinho se você esquecer de parar |
| `soundStart` | `Tink` | som ao começar a gravar |
| `soundPasted` | `Glass` | som quando colou no app |
| `soundClipboard` | `Pop` | som quando o texto ficou na área de transferência |
| `soundError` | `Basso` | som quando não saiu texto nenhum |

Qualquer nome de `/System/Library/Sounds` serve nos quatro sons, e as
Configurações tocam o som ao trocar o seletor: escolher pelo nome é
adivinhação.

---

## Privacidade

O áudio existe apenas entre a fala e a transcrição, num arquivo temporário
apagado logo em seguida. O log registra durações e tamanhos, nunca o texto.

A rede é usada em exatamente um lugar: o download dos modelos, no Hugging Face,
na primeira abertura. Depois disso o app funciona sem internet, e nada mais é
enviado ou consultado. Se preferir controlar a hora, desligue o segundo estágio
antes de abrir, ou rode o `setup.sh`, que baixa os mesmos arquivos.

Modelo baixado não é apagado ao trocar de modelo, então as Configurações
mostram o que sobrou em disco, com o total, e um botão para apagar. O que está
em uso nunca entra nessa lista.

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

## Windows e Linux

> **Experimental.** Os instaladores são gerados automaticamente pelos runners do
> GitHub, então compilam e empacotam de verdade, mas nunca foram executados em
> Windows nem em Linux pelo autor. Relatos de teste são muito bem-vindos.

Baixe em [Releases](https://github.com/kaique-oliveira/voice-input/releases):

| Sistema | Arquivo |
|---|---|
| Windows | `Voice.Input.Setup.x.y.z.exe` para instalar, `Voice.Input.x.y.z.exe` para rodar sem instalar |
| Linux | `.AppImage` para rodar direto, `.deb` para Debian e Ubuntu |

**No Windows, a primeira abertura esbarra no SmartScreen**, porque o
instalador não é assinado: clique em "Mais informações" e depois em "Executar
assim mesmo". Ao abrir, o app mostra as Configurações uma vez e depois vive na
bandeja, perto do relógio, possivelmente atrás da setinha de ícones ocultos.
Os modelos baixam sozinhos na primeira execução. Clicar no `.exe` de novo não
abre outra instância: traz as Configurações da que já está rodando.

Se a colagem automática não funcionar no seu ambiente, troque para "só copiar"
no menu do ícone.

No Linux, para a colagem automática funcionar em X11: `sudo apt install
xdotool`. No Wayland a colagem sintética não é permitida; use "só copiar". Em
GNOME sem extensão de bandeja, o ícone pode não aparecer: a janela de
Configurações da primeira execução continua acessível reabrindo o app.

Os dados ficam em `%APPDATA%\VoiceInput` no Windows e `~/.config/VoiceInput`
no Linux.

O que muda fora do macOS:

| Função | macOS | Windows e Linux |
|---|---|---|
| Gravar | helper em Swift | captura pelo Chromium, sem dependência externa |
| Colar | `⌘V` sintético | `SendKeys` no Windows, `xdotool` no X11 |
| Detectar o app em foco | NSWorkspace | não implementado, usa o modo padrão |
| Permissões | Microfone e Acessibilidade | só o pedido de microfone do navegador |

No **Wayland** a colagem automática não funciona, e isso não é bug: o protocolo
proíbe um programa qualquer de sintetizar teclas. Use o modo "só copiar", no
menu do ícone, e cole com `Ctrl+V`.

### Gerar o build você mesmo

Só é necessário se quiser compilar com CUDA, que deixa a transcrição bem mais
rápida em placa NVIDIA. Os builds da release são sem GPU, porque os runners do
GitHub não têm uma.

Os três passos são iguais nas duas plataformas: dependências, whisper.cpp,
empacotamento.

**1. Dependências**

```bash
git clone https://github.com/kaique-oliveira/voice-input.git
cd voice-input
npm install
```

Requisitos: Node 20 ou superior, CMake e um compilador C++ (Build Tools do
Visual Studio no Windows, `build-essential` no Linux).

No Linux, para a colagem automática funcionar em X11:

```bash
sudo apt install xdotool     # ou o equivalente na sua distribuição
```

**2. Compilar o whisper.cpp**

O binário do reconhecedor não vem pronto no repositório, porque depende da sua
máquina. Compile em `resources/bin`:

```bash
git clone https://github.com/ggml-org/whisper.cpp .build/whisper.cpp
cmake -S .build/whisper.cpp -B .build/whisper.cpp/build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF
cmake --build .build/whisper.cpp/build --config Release --target whisper-server whisper-cli
```

Copie `whisper-server` e `whisper-cli` (com `.exe` no Windows) do diretório de
build para `resources/bin`.

Com placa NVIDIA, acrescente `-DGGML_CUDA=ON` ao primeiro comando. Faz muita
diferença: o modelo recomendado sai de alguns segundos para menos de um.

**3. Empacotar**

```bash
npm run dist:win      # gera instalador NSIS e versão portátil
npm run dist:linux    # gera AppImage e .deb
```

O resultado sai em `dist-app/`. Para só rodar sem empacotar, use `npm start`.

### Se quiser ajudar a completar

Falta detectar o app em foco, que é o que faz o modo Developer e o modo Normal
alternarem sozinhos. As APIs são `GetForegroundWindow` no Windows e
`xdotool getactivewindow getwindowclassname` no X11. O ponto de extensão é
`frontApp` em [`src/main/platform.ts`](src/main/platform.ts).

Outro detalhe: `src/main/paths.ts` fixa o caminho de dados do macOS. Trocar por
`app.getPath('userData')` resolve nas três plataformas, mas move a pasta de quem
já usa, então precisa de migração.

---

## Estrutura

```
native/VoxHelper.swift      todo o código nativo
src/main/
  index.ts                  boot, atalho global, ciclo de vida
  session.ts                a máquina de estados
  whisper.ts                whisper-server sob demanda
  llm.ts                    llama-server sob demanda
  polish.ts                 prompt e conferência do segundo estágio
  model.ts                  catálogo, download automático e limpeza
  corrector.ts              limpeza, dicionário e pontuação, sem LLM
  glossary.ts               prompts de viés técnico
  context.ts                app em foco para modo
  tray.ts overlay.ts        barra de menu e painel flutuante
  glyph.ts icons.ts         ícones desenhados em código
src/renderer/               HTML e JS puros, sem framework
scripts/                    setup, empacotamento, benchmark, diagnóstico
```

---

## Roadmap

- [x] Assinatura estável para não perder permissões a cada atualização
- [x] Download automático dos modelos na primeira abertura
- [ ] Push-to-talk
- [ ] Histórico de transcrições

---

## Créditos

Construído sobre [whisper.cpp](https://github.com/ggml-org/whisper.cpp), de
Georgi Gerganov, e sobre o modelo [Whisper](https://github.com/openai/whisper),
da OpenAI.

Licença [MIT](LICENSE).
