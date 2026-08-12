import zlib from 'node:zlib';

/**
 * Desenho vetorial puro: encoder de PNG e o glifo do microfone da barra
 * de menu.
 *
 * Sem dependência do Electron de propósito: o script que gera o .icns roda
 * fora do runtime da aplicação.
 */

// ---------------------------------------------------------------- PNG mínimo

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  // Uma linha por scanline, cada uma prefixada pelo byte de filtro 0 (nenhum).
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- geometria

/** Distância com sinal até uma cápsula (segmento de reta engrossado). */
function sdCapsule(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  radius: number
): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom));
  return Math.hypot(pax - bax * h, pay - bay * h) - radius;
}


/**
 * Silhueta do microfone num sistema de coordenadas 22x22, a mesma métrica dos
 * ícones de sistema do macOS.
 */
export function insideMic(x: number, y: number): boolean {
  if (sdCapsule(x, y, 11, 5.6, 11, 9.1, 3.0) <= 0) return true;
  if (y >= 10.1) {
    const ring = Math.abs(Math.hypot(x - 11, y - 10.1) - 5.6) - 0.85;
    if (ring <= 0) return true;
  }
  if (sdCapsule(x, y, 11, 15.7, 11, 17.7, 0.8) <= 0) return true;
  if (sdCapsule(x, y, 7.8, 18.6, 14.2, 18.6, 0.85) <= 0) return true;
  return false;
}

const SUPERSAMPLE = 4;

/** Ícone da barra de menu: só o microfone, com alfa antisserrilhado. */
export function rasterizeMic(
  size: number,
  rgb: [number, number, number],
  opacity: number
): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = 22 / size;
  const step = 1 / SUPERSAMPLE;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          if (insideMic((x + (sx + 0.5) * step) * scale, (y + (sy + 0.5) * step) * scale)) hits++;
        }
      }
      if (hits === 0) continue;
      const offset = (y * size + x) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = Math.round((hits / (SUPERSAMPLE * SUPERSAMPLE)) * 255 * opacity);
    }
  }
  return pixels;
}

