// Generates build/icon.png (512x512) and resources/icon.png without external deps.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 512;
const px = new Uint8Array(SIZE * SIZE * 4);

function put(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const da = px[i + 3] / 255;
  const sa = a / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
  px[i + 3] = Math.round(oa * 255);
}

function roundedRect(x0, y0, w, h, radius, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = Math.max(x0 + radius - x, x - (x0 + w - 1 - radius), 0);
      const dy = Math.max(y0 + radius - y, y - (y0 + h - 1 - radius), 0);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= radius - 1) put(x, y, ...color, 255);
      else if (d < radius) put(x, y, ...color, Math.round((radius - d) * 255));
    }
  }
}

function circle(cx, cy, r, color) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r - 1) put(x, y, ...color, 255);
      else if (d < r) put(x, y, ...color, Math.round((r - d) * 255));
    }
  }
}

function line(x0, y0, x1, y1, width, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, color);
  }
}

// Background: dark slate with subtle gradient
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const t = y / SIZE;
    const r = Math.round(20 + 10 * t);
    const g = Math.round(28 + 14 * t);
    const b = Math.round(46 + 26 * t);
    const dx = Math.max(56 - x, x - (SIZE - 57), 0);
    const dy = Math.max(56 - y, y - (SIZE - 57), 0);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= 55) put(x, y, r, g, b, 255);
    else if (d < 56) put(x, y, r, g, b, Math.round((56 - d) * 255));
  }
}

// Branch graph: main line, a branch that merges back, plus an AI spark.
const green = [63, 185, 80];
const blue = [88, 166, 255];
const purple = [163, 113, 247];
const white = [240, 246, 252];
line(170, 120, 170, 400, 26, blue);
line(170, 190, 340, 260, 26, green);
line(340, 260, 340, 330, 26, green);
line(340, 330, 170, 400, 26, green);
circle(170, 120, 34, white);
circle(170, 120, 22, blue);
circle(340, 260, 34, white);
circle(340, 260, 22, green);
circle(170, 400, 34, white);
circle(170, 400, 22, purple);
// spark
line(400, 120, 400, 190, 12, white);
line(365, 155, 435, 155, 12, white);
line(376, 131, 424, 179, 10, white);
line(424, 131, 376, 179, 10, white);
circle(400, 155, 16, purple);

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
fs.mkdirSync(path.join(__dirname, '..', 'resources'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), png);
fs.writeFileSync(path.join(__dirname, '..', 'resources', 'icon.png'), png);
console.log('wrote build/icon.png', png.length, 'bytes');
