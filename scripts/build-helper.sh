#!/usr/bin/env bash
#
# Compila o vox-helper: um único binário Swift que grava áudio, cola texto
# e informa o app em foco. Sem projeto Xcode, sem dependências.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/resources/bin/vox-helper"
SRC="$ROOT/native/VoxHelper.swift"
PLIST="$ROOT/native/Helper-Info.plist"

mkdir -p "$ROOT/resources/bin"

# O Info.plist é embutido na seção __TEXT,__info_plist do binário. Sem isso o
# macOS mata o processo ao pedir o microfone (usage description obrigatória).
swiftc -O -whole-module-optimization \
  -target arm64-apple-macos13.0 \
  -framework AVFoundation \
  -framework AppKit \
  -framework CoreGraphics \
  -framework ApplicationServices \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
  -o "$OUT" "$SRC"

# Assinatura ad-hoc com identificador estável: mantém a permissão de
# Acessibilidade válida enquanto o binário não mudar.
codesign --force --sign - --identifier com.voiceinput.voxhelper "$OUT"

echo "vox-helper compilado em resources/bin/vox-helper"
