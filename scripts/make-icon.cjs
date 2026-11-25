// Generates build/icon.png (512x512) without any image libraries.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const SS = 4; // supersampling

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// ---------------------------------------------------------------- shapes (unit coords 0..1)
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
function rotRect(x, y, cx, cy, w, h, ang) {
  const c = Math.cos(-ang), s = Math.sin(-ang);
  const dx = x - cx, dy = y - cy;
  const u = dx * c - dy * s, v = dx * s + dy * c;
  return Math.abs(u) <= w / 2 && Math.abs(v) <= h / 2;
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function shade(x, y) {
  // background tile
  if (!roundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.2)) return null;
  let col = mix([34, 46, 64], [14, 18, 26], y);
  // floor line
  if (y > 0.8 && y < 0.82 && x > 0.14 && x < 0.86) col = [70, 84, 104];
  // slab (tungsten): metallic gradient
  if (roundRect(x, y, 0.16, 0.26, 0.84, 0.42, 0.03)) {
    const t = (y - 0.26) / 0.16;
    col = mix([168, 178, 192], [78, 86, 98], t);
    if (y < 0.285) col = [205, 214, 226];
  }
  // left leg: intact (pine)
  if (rotRect(x, y, 0.27, 0.61, 0.075, 0.38, 0)) col = mix([236, 196, 132], [196, 150, 88], (x - 0.23) / 0.075);
  // right leg: snapped, upper stub + kicked-out lower piece
  if (rotRect(x, y, 0.73, 0.475, 0.075, 0.11, 0)) col = mix([236, 196, 132], [196, 150, 88], (x - 0.69) / 0.075);
  if (rotRect(x, y, 0.78, 0.68, 0.075, 0.26, 0.42)) col = mix([236, 196, 132], [196, 150, 88], 0.4);
  // stress glow at the break
  const d = Math.hypot(x - 0.735, y - 0.545);
  if (d < 0.11) {
    const k = Math.pow(1 - d / 0.11, 2) * 0.85;
    col = mix(col, [255, 92, 60], k);
  }
  // spark dots
  for (const [sx, sy, r] of [[0.66, 0.6, 0.012], [0.86, 0.55, 0.01], [0.62, 0.53, 0.008]]) if (Math.hypot(x - sx, y - sy) < r) col = [255, 190, 90];
  return col;
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let j = 0; j < S; j++) {
  raw[j * (S * 4 + 1)] = 0;
  for (let i = 0; i < S; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sj = 0; sj < SS; sj++)
      for (let si = 0; si < SS; si++) {
        const c = shade((i + (si + 0.5) / SS) / S, (j + (sj + 0.5) / SS) / S);
        if (!c) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        a += 255;
      }
    const n = SS * SS;
    const cov = a / n;
    const o = j * (S * 4 + 1) + 1 + i * 4;
    const div = a > 0 ? a / 255 : 1;
    raw[o] = Math.round(r / div);
    raw[o + 1] = Math.round(g / div);
    raw[o + 2] = Math.round(b / div);
    raw[o + 3] = Math.round(cov);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
