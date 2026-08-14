import { nativeImage, nativeTheme, type NativeImage } from 'electron';
import { encodePng, rasterizeMic } from './glyph';

/**
 * Ícones da barra de menu desenhados em código (ver glyph.ts).
 *
 * Poderiam ser PNGs no disco, mas gerá-los aqui evita assets binários no
 * repositório e garante @1x/@2x sempre coerentes. Custa ~2 ms no boot.
 */

const BASE_SIZE = 18;

function buildImage(rgb: [number, number, number], opacity: number, template: boolean): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const size = BASE_SIZE * scaleFactor;
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: encodePng(size, size, rasterizeMic(size, rgb, opacity)),
    });
  }
  // Imagem "template" é recolorida pelo macOS conforme o tema e o destaque
  // da barra de menu, por isso o ícone parado é preto puro.
  image.setTemplateImage(template);
  return image;
}

export interface TrayIcons {
  idle: NativeImage;
  recording: NativeImage;
  busy: NativeImage;
}

const cache = new Map<string, TrayIcons>();

/**
 * No macOS a imagem "template" resolve o tema sozinha. Windows e Linux não têm
 * esse conceito: um ícone preto na bandeja escura do Windows é invisível, e é
 * exatamente a bandeja padrão. Fora do macOS a cor vem do tema do sistema, e o
 * chamador re-renderiza quando o nativeTheme muda.
 */
export function trayIcons(): TrayIcons {
  const isMac = process.platform === 'darwin';
  const dark = !isMac && nativeTheme.shouldUseDarkColors;
  const key = isMac ? 'mac' : dark ? 'dark' : 'light';

  const cached = cache.get(key);
  if (cached) return cached;

  // Bandeja escura pede ícone claro; bandeja clara, ícone escuro.
  const ink: [number, number, number] = isMac ? [0, 0, 0] : dark ? [235, 235, 235] : [25, 25, 25];
  const icons: TrayIcons = {
    idle: buildImage(ink, 1, isMac),
    // Vermelho da marca, fixo (não-template) para sobreviver ao tema.
    recording: buildImage([228, 27, 34], 1, false),
    busy: buildImage(ink, 0.4, isMac),
  };
  cache.set(key, icons);
  return icons;
}
