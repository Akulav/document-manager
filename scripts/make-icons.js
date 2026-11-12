'use strict';
// Generează pictogramele aplicației (fără dependențe externe):
//   public/favicon.svg         – pentru browserele moderne
//   public/favicon.ico         – 16, 32, 48 și 256 px (browsere vechi, Windows, scurtături)
//   public/apple-touch-icon.png – 180 px (ecranul principal pe telefoane/tablete)
//   assets/icon.png            – 256 px (README)
// Rulare: node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'public');

// Desenul, într-un spațiu de 64×64: pătrat rotunjit albastru, o filă albă cu colțul îndoit și trei rânduri de text.
const BG_FROM = [0x16, 0x3c, 0x6a];
const BG_TO = [0x2a, 0x6d, 0xb3];
const PAGE = [0xff, 0xff, 0xff];
const FOLD = [0xc6, 0xd7, 0xee];
const INK = [0x1d, 0x4e, 0x89];
const SHEET = [[17, 10], [37, 10], [47, 20], [47, 54], [17, 54]];
const FOLD_TRI = [[37, 10], [37, 20], [47, 20]];
const LINES = [[22, 27, 42, 31], [22, 34.5, 42, 38.5], [22, 42, 35, 46]];

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// Culoarea (RGBA) a unui punct din desen.
function sample(x, y) {
  if (!inRoundRect(x, y, 0, 0, 64, 64, 14)) return null;
  if (LINES.some(([a, b, c, d]) => inRoundRect(x, y, a, b, c, d, 1.6))) return INK;
  if (inPoly(x, y, FOLD_TRI)) return FOLD;
  if (inPoly(x, y, SHEET)) return PAGE;
  const t = Math.min(1, Math.max(0, (x + y) / 128));
  return BG_FROM.map((c, i) => Math.round(c + (BG_TO[i] - c) * t));
}

// Rasterizare cu 6×6 eșantioane pe pixel, pentru margini netede și la 16 px.
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const N = 6;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = sample(((pxl + (sx + 0.5) / N) * 64) / size, ((py + (sy + 0.5) / N) * 64) / size);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      }
      const o = (py * size + pxl) * 4;
      if (a) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round((a / (N * N)) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size) {
  const px = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // biți pe canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Fișier ICO cu imagini PNG în interior (acceptat de Windows Vista+ și de toate browserele actuale).
function ico(sizes) {
  const images = sizes.map(png);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4); // planuri
    head.writeUInt16LE(32, e + 6); // biți pe pixel
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const pts = (p) => p.map(([x, y]) => x + ',' + y).join(' ');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hex(BG_FROM)}"/><stop offset="1" stop-color="${hex(BG_TO)}"/></linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <polygon points="${pts(SHEET)}" fill="${hex(PAGE)}"/>
  <polygon points="${pts(FOLD_TRI)}" fill="${hex(FOLD)}"/>
  ${LINES.map(([a, b, c, d]) => `<rect x="${a}" y="${b}" width="${c - a}" height="${d - b}" rx="1.6" fill="${hex(INK)}"/>`).join('\n  ')}
</svg>
`;

fs.writeFileSync(path.join(OUT, 'favicon.svg'), svg);
fs.writeFileSync(path.join(OUT, 'favicon.ico'), ico([16, 32, 48, 256]));
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), png(180));
console.log('Pictogramele au fost generate în', OUT);

// Pictograma din README (256 px).
const ASSETS = path.join(__dirname, '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });
fs.writeFileSync(path.join(ASSETS, 'icon.png'), png(256));
