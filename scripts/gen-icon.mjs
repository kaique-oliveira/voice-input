#!/usr/bin/env node
/**
 * Gera o AppIcon.icns a partir de public/logo.png.
 *
 * O logo vem como PNG RGB opaco sobre fundo claro. Um ícone de macOS precisa
 * de fundo transparente, então o trabalho aqui é: decodificar, isolar o fundo
 * por preenchimento a partir das bordas, recortar o conteúdo e reamostrar para
 * cada tamanho do iconset.
 *
 * O preenchimento parte das bordas de propósito. Um simples "branco vira
 * transparente" apagaria também o desenho branco de dentro do quadrado.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { encodePng } = require(path.join(root, 'dist', 'main', 'glyph.js'));

const source = process.argv[3] ?? path.join(root, 'public', 'logo.png');
const out = process.argv[2] ?? path.join(root, '.build', 'AppIcon.icns');
const iconset = path.join(root, '.build', 'AppIcon.iconset');

// ---------------------------------------------------------------- decodificar

/** Decodificador de PNG sem entrelaçamento, canais de 8 bits. */
function decodePng(buffer) {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const depth = buffer[24];
  const colorType = buffer[25];
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`PNG não suportado: bit depth ${depth}, color type ${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;

  const parts = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));

    // Desfaz os filtros por linha definidos na especificação do PNG.
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
        default: break;
      }
    }

    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      pixels[to] = line[from];
      pixels[to + 1] = line[from + 1];
      pixels[to + 2] = line[from + 2];
      pixels[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    previous = line;
  }

  return { width, height, pixels };
}

// ---------------------------------------------------------------- recortar fundo

/**
 * Marca como fundo tudo que for claro e alcançável a partir das bordas.
 * O desenho branco dentro do quadrado vermelho fica cercado, então nunca é
 * alcançado.
 */
function removeBackground({ width, height, pixels }) {
  const isLight = (i) => pixels[i] > 205 && pixels[i + 1] > 205 && pixels[i + 2] > 205;
  const background = new Uint8Array(width * height);
  const queue = [];

  for (let x = 0; x < width; x++) {
    queue.push(x, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    queue.push(y * width, y * width + width - 1);
  }

  while (queue.length > 0) {
    const index = queue.pop();
    if (background[index]) continue;
    if (!isLight(index * 4)) continue;
    background[index] = 1;
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) queue.push(index - 1);
    if (x < width - 1) queue.push(index + 1);
    if (y > 0) queue.push(index - width);
    if (y < height - 1) queue.push(index + width);
  }

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (background[index]) {
        pixels[index * 4 + 3] = 0;
        continue;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) throw new Error('Nenhum conteúdo encontrado no logo.');
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------- reamostrar

/**
 * Reamostragem por média de área. Como a origem é bem maior que o destino, a
 * média já produz bordas suaves sem precisar de outro passo de suavização.
 */
function resample(image, box, size, contentRatio) {
  const target = Buffer.alloc(size * size * 4);
  const content = Math.round(size * contentRatio);
  const margin = (size - content) / 2;
  const boxW = box.maxX - box.minX + 1;
  const boxH = box.maxY - box.minY + 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Retângulo da origem que corresponde a este pixel do destino.
      const sx0 = box.minX + ((x - margin) / content) * boxW;
      const sx1 = box.minX + ((x + 1 - margin) / content) * boxW;
      const sy0 = box.minY + ((y - margin) / content) * boxH;
      const sy1 = box.minY + ((y + 1 - margin) / content) * boxH;

      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        if (sy < 0 || sy >= image.height) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          if (sx < 0 || sx >= image.width) continue;
          const i = (sy * image.width + sx) * 4;
          const alpha = image.pixels[i + 3] / 255;
          // Cor pré-multiplicada: sem isso as bordas puxam para o preto.
          r += image.pixels[i] * alpha;
          g += image.pixels[i + 1] * alpha;
          b += image.pixels[i + 2] * alpha;
          a += alpha;
          count++;
        }
      }
      if (count === 0 || a === 0) continue;

      const to = (y * size + x) * 4;
      target[to] = Math.round(r / a);
      target[to + 1] = Math.round(g / a);
      target[to + 2] = Math.round(b / a);
      target[to + 3] = Math.round((a / count) * 255);
    }
  }
  return target;
}

// ---------------------------------------------------------------- geração

const image = decodePng(fs.readFileSync(source));
const box = removeBackground(image);

// O logo já é um quadrado arredondado, então ele ocupa a área que a Apple
// reserva para o corpo do ícone: 824 de 1024.
const CONTENT_RATIO = 0.824;

const VARIANTS = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];

fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
for (const [size, name] of VARIANTS) {
  fs.writeFileSync(
    path.join(iconset, name),
    encodePng(size, size, resample(image, box, size, CONTENT_RATIO))
  );
}

fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out]);
console.log(`ícone gerado a partir de ${path.relative(root, source)}: ${path.relative(root, out)}`);
