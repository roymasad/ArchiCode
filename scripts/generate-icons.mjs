import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(root, "build");
const pngSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const icoSizes = [16, 32, 48, 256];
const icnsTypes = new Map([
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"]
]);

mkdirSync(buildDir, { recursive: true });

const pngs = new Map(pngSizes.map((size) => [size, createPngIcon(size)]));
writeFileSync(join(buildDir, "icon.png"), pngs.get(1024));
writeFileSync(join(buildDir, "icon.ico"), createIco(icoSizes.map((size) => ({ size, png: pngs.get(size) }))));
writeFileSync(join(buildDir, "icon.icns"), createIcns([...icnsTypes].map(([size, type]) => ({ type, png: pngs.get(size) }))));
rmSync(join(buildDir, "icon.iconset"), { recursive: true, force: true });

console.log("Generated build/icon.png, build/icon.ico, and build/icon.icns");

function createPngIcon(size) {
  const scale = 3;
  const width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);
  const unit = width / 1024;

  fillRoundRect(pixels, width, 64 * unit, 64 * unit, 896 * unit, 896 * unit, 196 * unit, [14, 21, 25, 255]);
  fillRoundRect(pixels, width, 92 * unit, 92 * unit, 840 * unit, 840 * unit, 166 * unit, [24, 35, 41, 255]);
  strokeRoundRect(pixels, width, 92 * unit, 92 * unit, 840 * unit, 840 * unit, 166 * unit, 12 * unit, [124, 198, 213, 135]);

  drawCubeMark(pixels, width, unit, 512, 326, 154);
  drawCubeMark(pixels, width, unit, 350, 594, 154);
  drawCubeMark(pixels, width, unit, 674, 594, 154);
  drawLine(pixels, width, 512 * unit, 480 * unit, 350 * unit, 440 * unit, 38 * unit, [238, 251, 255, 255]);
  drawLine(pixels, width, 512 * unit, 480 * unit, 674 * unit, 440 * unit, 38 * unit, [238, 251, 255, 255]);

  return encodePng(size, size, downsample(pixels, width, scale));
}

function drawCubeMark(pixels, width, unit, cx, cy, radius) {
  const center = [cx * unit, cy * unit];
  const points = Array.from({ length: 6 }, (_, index) => {
    const angle = (-90 + index * 60) * Math.PI / 180;
    return [(cx + Math.cos(angle) * radius) * unit, (cy + Math.sin(angle) * radius) * unit];
  });
  const stroke = 36 * unit;
  const shadow = [0, 8, 10, 115];
  const outer = [238, 251, 255, 255];
  const inner = [124, 198, 213, 255];

  for (const color of [shadow, outer]) {
    const widthBoost = color === shadow ? 12 * unit : 0;
    for (let index = 0; index < points.length; index += 1) {
      drawLine(pixels, width, points[index][0], points[index][1], points[(index + 1) % points.length][0], points[(index + 1) % points.length][1], stroke + widthBoost, color);
    }
  }
  for (const pointIndex of [0, 2, 4]) {
    drawLine(pixels, width, center[0], center[1], points[pointIndex][0], points[pointIndex][1], stroke * 0.82, inner);
  }
}

function fillRoundRect(pixels, width, x, y, w, h, radius, color) {
  const x1 = Math.max(0, Math.floor(x));
  const x2 = Math.min(width - 1, Math.ceil(x + w));
  const y1 = Math.max(0, Math.floor(y));
  const y2 = Math.min(width - 1, Math.ceil(y + h));
  for (let py = y1; py <= y2; py += 1) {
    for (let px = x1; px <= x2; px += 1) {
      if (insideRoundRect(px + 0.5, py + 0.5, x, y, w, h, radius)) blendPixel(pixels, width, px, py, color);
    }
  }
}

function strokeRoundRect(pixels, width, x, y, w, h, radius, strokeWidth, color) {
  fillRoundRect(pixels, width, x, y, w, h, radius, color);
  fillRoundRect(pixels, width, x + strokeWidth, y + strokeWidth, w - strokeWidth * 2, h - strokeWidth * 2, radius - strokeWidth, [24, 35, 41, 255]);
}

function insideRoundRect(px, py, x, y, w, h, radius) {
  const rx = Math.max(x + radius, Math.min(px, x + w - radius));
  const ry = Math.max(y + radius, Math.min(py, y + h - radius));
  return (px - rx) ** 2 + (py - ry) ** 2 <= radius ** 2;
}

function drawLine(pixels, width, x1, y1, x2, y2, strokeWidth, color) {
  const radius = strokeWidth / 2;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - radius - 1));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x1, x2) + radius + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - radius - 1));
  const maxY = Math.min(width - 1, Math.ceil(Math.max(y1, y2) + radius + 1));
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / lengthSquared));
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      if ((x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2 <= radius ** 2) blendPixel(pixels, width, x, y, color);
    }
  }
}

function blendPixel(pixels, width, x, y, [r, g, b, a]) {
  const offset = (y * width + x) * 4;
  const alpha = a / 255;
  const oldAlpha = pixels[offset + 3] / 255;
  const nextAlpha = alpha + oldAlpha * (1 - alpha);
  if (!nextAlpha) return;
  pixels[offset] = Math.round((r * alpha + pixels[offset] * oldAlpha * (1 - alpha)) / nextAlpha);
  pixels[offset + 1] = Math.round((g * alpha + pixels[offset + 1] * oldAlpha * (1 - alpha)) / nextAlpha);
  pixels[offset + 2] = Math.round((b * alpha + pixels[offset + 2] * oldAlpha * (1 - alpha)) / nextAlpha);
  pixels[offset + 3] = Math.round(nextAlpha * 255);
}

function downsample(source, sourceWidth, scale) {
  const width = sourceWidth / scale;
  const output = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const total = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const sourceOffset = ((y * scale + sy) * sourceWidth + x * scale + sx) * 4;
          total[0] += source[sourceOffset];
          total[1] += source[sourceOffset + 1];
          total[2] += source[sourceOffset + 2];
          total[3] += source[sourceOffset + 3];
        }
      }
      const targetOffset = (y * width + x) * 4;
      output[targetOffset] = Math.round(total[0] / (scale * scale));
      output[targetOffset + 1] = Math.round(total[1] / (scale * scale));
      output[targetOffset + 2] = Math.round(total[2] / (scale * scale));
      output[targetOffset + 3] = Math.round(total[3] / (scale * scale));
    }
  }
  return output;
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([u32(data.length), typeBuffer, data, u32(crc32(Buffer.concat([typeBuffer, data])))]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function createIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

function createIcns(images) {
  const chunks = images.map(({ type, png }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
