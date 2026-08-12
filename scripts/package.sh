#!/usr/bin/env bash
#
# Monta o "Voice Input.app" de verdade, sem electron-builder.
#
# Por que isso importa e não é firula: o macOS só lista aplicativos de bundle
# no painel de Acessibilidade. Rodando em desenvolvimento, quem pede a
# permissão é um binário solto que nunca aparece na lista, e sem essa
# permissão o ⌘V sintético não funciona. Empacotado, o app aparece pelo nome,
# e o vox-helper (que fica dentro do bundle) herda a identidade dele no TCC.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Voice Input"
OUT_DIR="$ROOT/dist-app"
APP="$OUT_DIR/$APP_NAME.app"
CONTENTS="$APP/Contents"
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"
BUNDLE_ID="com.voiceinput.app"

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }

[ -d "$ELECTRON_APP" ] || { echo "Rode 'npm install' primeiro."; exit 1; }

say "Compilando"
npm run build:ts --silent
npm run build:static --silent
bash "$ROOT/scripts/build-helper.sh" >/dev/null

say "Gerando ícone"
node "$ROOT/scripts/gen-icon.mjs" "$ROOT/.build/AppIcon.icns" >/dev/null

say "Montando $APP_NAME.app"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$ELECTRON_APP" "$APP"

# O executável precisa ter o nome do app para o macOS mostrar "Voice Input"
# no menu e nos painéis de permissão.
mv "$CONTENTS/MacOS/Electron" "$CONTENTS/MacOS/$APP_NAME"

# O app padrão do Electron (a tela de boas-vindas) não vai junto.
rm -f "$CONTENTS/Resources/default_app.asar"
rm -rf "$CONTENTS/Resources/"*.lproj

cp "$ROOT/.build/AppIcon.icns" "$CONTENTS/Resources/electron.icns"

say "Copiando a aplicação"
APP_ROOT="$CONTENTS/Resources/app"
mkdir -p "$APP_ROOT"
cp -R "$ROOT/dist" "$APP_ROOT/dist"
# resources/bin vai para Contents/Resources/bin, é onde paths.ts procura
# quando app.isPackaged é verdadeiro.
cp -R "$ROOT/resources/bin" "$CONTENTS/Resources/bin"

# O commit vai embutido para o menu poder dizer exatamente qual código está
# rodando. Sem isso, "é este build mesmo?" só se responde comparando datas de
# arquivo. O sufixo + marca build com alterações não commitadas.
BUILD_REF="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo desconhecido)"
git -C "$ROOT" diff --quiet 2>/dev/null || BUILD_REF="$BUILD_REF+"

cat > "$APP_ROOT/package.json" <<JSON
{
  "name": "voice-input",
  "version": "0.1.0",
  "buildRef": "$BUILD_REF",
  "main": "dist/main/index.js"
}
JSON

say "Escrevendo Info.plist"
PLIST="$CONTENTS/Info.plist"
set_plist() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $3 $2" "$PLIST"; }

set_plist CFBundleName            "$APP_NAME"            string
set_plist CFBundleDisplayName     "$APP_NAME"            string
set_plist CFBundleExecutable      "$APP_NAME"            string
set_plist CFBundleIdentifier      "$BUNDLE_ID"           string
set_plist CFBundleShortVersionString "0.1.0"             string
set_plist CFBundleVersion         "1"                    string
set_plist NSMicrophoneUsageDescription \
  "O Voice Input precisa do microfone para transcrever sua fala localmente."   string
set_plist NSHumanReadableCopyright "Ferramenta pessoal, 100% local."           string
# LSUIElement: app de barra de menu, sem ícone na Dock, sem alternador de apps.
set_plist LSUIElement             "true"                 bool

say "Assinando"
# Assinatura ad-hoc com identificador estável. Os binários internos são
# assinados primeiro (de dentro para fora), senão o selo do bundle não fecha.
codesign --force --sign - "$CONTENTS/Resources/bin/vox-helper" 2>/dev/null || true
codesign --force --sign - "$CONTENTS/Resources/bin/whisper-server" 2>/dev/null || true
codesign --force --sign - "$CONTENTS/Resources/bin/whisper-cli" 2>/dev/null || true
codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$APP" 2>/dev/null

if codesign --verify --deep "$APP" 2>/dev/null; then
  say "Assinatura válida"
else
  printf "\033[1;33m!!\033[0m Assinatura não verificou, o app roda, mas o macOS pode reclamar.\n"
fi

SIZE=$(du -sh "$APP" | cut -f1)
say "Pronto: $APP ($SIZE)"
echo
echo "  Instalar:  cp -R \"$APP\" /Applications/"
echo "  Abrir:     open -a \"$APP_NAME\""
echo
