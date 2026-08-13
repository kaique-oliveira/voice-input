#!/usr/bin/env bash
#
# Setup único do Voice Input.
#   1. compila o whisper.cpp (estático, Metal) em resources/bin
#   2. compila o vox-helper (Swift)
#   3. baixa os modelos em uso para ~/Library/Application Support/VoiceInput/models
#   4. injeta NSMicrophoneUsageDescription no Electron.app de desenvolvimento
#
# Esta é a ÚNICA parte do projeto que usa a rede.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/.build"
BIN_DIR="$ROOT/resources/bin"
MODELS_DIR="$HOME/Library/Application Support/VoiceInput/models"

# Commit fixado para builds reproduzíveis. Atualize conscientemente.
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"
WHISPER_REF="${WHISPER_REF:-master}"

MODEL_FILE="${MODEL_FILE:-ggml-large-v3-turbo-q5_0.bin}"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"

# Segundo estágio: pontua e capitaliza. Sem ele o app funciona, só não põe
# maiúscula em nome próprio.
POLISH_FILE="${POLISH_FILE:-Qwen3-1.7B-Q4_K_M.gguf}"
POLISH_URL="https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/$POLISH_FILE"

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- pré-requisitos
say "Verificando pré-requisitos"
command -v cmake >/dev/null || die "cmake não encontrado. Instale com: brew install cmake"
command -v git >/dev/null || die "git não encontrado."
command -v swiftc >/dev/null || die "swiftc não encontrado. Instale as Command Line Tools do Xcode."
[ "$(uname -m)" = "arm64" ] || warn "Este projeto foi pensado para Apple Silicon."

mkdir -p "$BUILD_DIR" "$BIN_DIR" "$MODELS_DIR"

# ---------------------------------------------------------------- whisper.cpp
if [ ! -d "$BUILD_DIR/whisper.cpp/.git" ]; then
  say "Clonando whisper.cpp"
  git clone --depth 1 --branch "$WHISPER_REF" "$WHISPER_REPO" "$BUILD_DIR/whisper.cpp"
else
  say "whisper.cpp já clonado"
fi

if [ ! -x "$BIN_DIR/whisper-server" ] || [ "${FORCE_BUILD:-0}" = "1" ]; then
  say "Compilando whisper.cpp (Metal, binários estáticos), pode levar alguns minutos"
  cmake -S "$BUILD_DIR/whisper.cpp" -B "$BUILD_DIR/whisper.cpp/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DGGML_ACCELERATE=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    >/dev/null

  cmake --build "$BUILD_DIR/whisper.cpp/build" --config Release \
        --target whisper-server whisper-cli -j "$(sysctl -n hw.ncpu)"

  find "$BUILD_DIR/whisper.cpp/build" -name 'whisper-server' -type f -perm -u+x \
    -exec cp {} "$BIN_DIR/whisper-server" \; -quit
  find "$BUILD_DIR/whisper.cpp/build" -name 'whisper-cli' -type f -perm -u+x \
    -exec cp {} "$BIN_DIR/whisper-cli" \; -quit

  [ -x "$BIN_DIR/whisper-server" ] || die "whisper-server não foi produzido pelo build."
  say "Binários em resources/bin"
else
  say "whisper-server já compilado (use FORCE_BUILD=1 para recompilar)"
fi

# Confere que os binários são realmente estáticos (sem dylibs do build dir)
if otool -L "$BIN_DIR/whisper-server" | grep -q "$BUILD_DIR"; then
  warn "whisper-server ainda referencia dylibs do diretório de build:"
  otool -L "$BIN_DIR/whisper-server" | grep "$BUILD_DIR" || true
fi

# ---------------------------------------------------------------- llama.cpp
# Runtime do segundo estágio, que desembaraça a estrutura da fala.
if [ ! -d "$BUILD_DIR/llama.cpp/.git" ]; then
  say "Clonando llama.cpp"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$BUILD_DIR/llama.cpp"
fi

if [ ! -x "$BIN_DIR/llama-server" ] || [ "${FORCE_BUILD:-0}" = "1" ]; then
  say "Compilando llama.cpp (Metal), pode levar alguns minutos"
  cmake -S "$BUILD_DIR/llama.cpp" -B "$BUILD_DIR/llama.cpp/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_METAL=ON \
    -DGGML_METAL_EMBED_LIBRARY=ON \
    -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_TOOLS=ON \
    -DLLAMA_BUILD_SERVER=ON \
    >/dev/null

  cmake --build "$BUILD_DIR/llama.cpp/build" --config Release \
        --target llama-server -j "$(sysctl -n hw.ncpu)"

  find "$BUILD_DIR/llama.cpp/build" -name 'llama-server' -type f -perm -u+x \
    -exec cp {} "$BIN_DIR/llama-server" \; -quit
  [ -x "$BIN_DIR/llama-server" ] || die "llama-server não foi produzido pelo build."
else
  say "llama-server já compilado"
fi

# ---------------------------------------------------------------- vox-helper
say "Compilando vox-helper (Swift)"
bash "$ROOT/scripts/build-helper.sh"

# ---------------------------------------------------------------- modelo
if [ ! -f "$MODELS_DIR/$MODEL_FILE" ]; then
  say "Baixando modelo $MODEL_FILE (~575 MB), única transferência de rede do app"
  curl -fL --progress-bar -o "$MODELS_DIR/$MODEL_FILE.part" "$MODEL_URL"
  mv "$MODELS_DIR/$MODEL_FILE.part" "$MODELS_DIR/$MODEL_FILE"
else
  say "Modelo já presente: $MODEL_FILE"
fi

if [ ! -f "$MODELS_DIR/$POLISH_FILE" ]; then
  say "Baixando modelo do segundo estágio $POLISH_FILE (~1,2 GB)"
  curl -fL --progress-bar -o "$MODELS_DIR/$POLISH_FILE.part" "$POLISH_URL"
  mv "$MODELS_DIR/$POLISH_FILE.part" "$MODELS_DIR/$POLISH_FILE"
else
  say "Modelo do segundo estágio já presente: $POLISH_FILE"
fi

# ---------------------------------------------------------------- Info.plist do Electron (dev)
ELECTRON_PLIST="$ROOT/node_modules/electron/dist/Electron.app/Contents/Info.plist"
if [ -f "$ELECTRON_PLIST" ]; then
  say "Injetando NSMicrophoneUsageDescription no Electron de desenvolvimento"
  /usr/libexec/PlistBuddy -c \
    "Add :NSMicrophoneUsageDescription string 'O Voice Input precisa do microfone para transcrever sua fala localmente.'" \
    "$ELECTRON_PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c \
    "Set :NSMicrophoneUsageDescription 'O Voice Input precisa do microfone para transcrever sua fala localmente.'" \
    "$ELECTRON_PLIST"
else
  warn "Electron ainda não instalado, rode 'npm install' e depois 'npm run setup' de novo."
fi

say "Setup concluído."
echo
echo "  Próximo passo:  npm start"
echo
