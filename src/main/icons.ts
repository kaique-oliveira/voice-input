import { nativeImage, type NativeImage } from 'electron';
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

let cache: TrayIcons | null = null;

export function trayIcons(): TrayIcons {
  if (cache) return cache;
  cache = {
    idle: buildImage([0, 0, 0], 1, true),
    // Vermelho da marca, fixo (não-template) para sobreviver ao tema.
    recording: buildImage([228, 27, 34], 1, false),
    busy: buildImage([0, 0, 0], 0.4, true),
  };
  return cache;
}
