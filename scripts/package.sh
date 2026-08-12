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
  "version": "0.1.1",
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
set_plist CFBundleShortVersionString "0.1.1"             string
set_plist CFBundleVersion         "1"                    string
set_plist NSMicrophoneUsageDescription \
  "O Voice Input precisa do microfone para transcrever sua fala localmente."   string
set_plist NSHumanReadableCopyright "Ferramenta pessoal, 100% local."           string
# LSUIElement: app de barra de menu, sem ícone na Dock, sem alternador de apps.
set_plist LSUIElement             "true"                 bool

# ---------------------------------------------------------------- assinatura
#
# Por que a identidade importa muito aqui: o macOS guarda, junto com a
# permissão de Acessibilidade, a assinatura do app que foi autorizado. Com
# assinatura ad-hoc o selo muda a cada build, e o sistema passa a negar a
# permissão mesmo com o interruptor ligado no painel. Uma identidade estável
# faz a autorização sobreviver a qualquer rebuild.
#
# Ordem: variável SIGN_IDENTITY, depois o arquivo .signing-identity (fora do
# versionamento), e por último ad-hoc.
IDENTITY="${SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ] && [ -f "$ROOT/.signing-identity" ]; then
  IDENTITY="$(tr -d '\n' < "$ROOT/.signing-identity")"
fi

if [ -n "$IDENTITY" ]; then
  say "Assinando com: $IDENTITY"
else
  say "Assinando ad-hoc (as permissões do sistema vão resetar a cada build)"
  echo "     Para uma identidade estável, veja 'security find-identity -p codesigning -v'"
  echo "     e grave o nome escolhido em .signing-identity"
  IDENTITY="-"
fi

# De dentro para fora: se os binários internos forem assinados depois, o selo
# do bundle não fecha.
for BIN in vox-helper whisper-server whisper-cli; do
  codesign --force --timestamp=none --sign "$IDENTITY" "$CONTENTS/Resources/bin/$BIN"
done
codesign --force --deep --timestamp=none --sign "$IDENTITY" \
  --identifier "$BUNDLE_ID" "$APP"

if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  say "Assinatura válida"
  codesign -dvvv "$APP" 2>&1 | grep -E "^Authority|^TeamIdentifier" | head -2 | sed 's/^/     /'
else
  printf "\033[1;33m!!\033[0m Assinatura não verificou, o app roda, mas o macOS pode reclamar.\n"
fi

SIZE=$(du -sh "$APP" | cut -f1)
say "Pronto: $APP ($SIZE)"
echo
echo "  Instalar:  cp -R \"$APP\" /Applications/"
echo "  Abrir:     open -a \"$APP_NAME\""
echo
