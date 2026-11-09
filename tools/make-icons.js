'use strict';
// Generates the extension icons (a shield with a check mark) as PNGs with no
// dependencies. Run: node tools/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.resolve(__dirname, '..', 'extension', 'icons');
const SHIELD = [26, 86, 219]; // #1a56db
const MARK = [255, 255, 255];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
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

function insideShield(x, y) {
  // Unit square coords: x,y in [0,1]. Flat top, straight sides, curved point.
  if (y < 0.08 || y > 0.95) return false;
  const half = y < 0.55 ? 0.4 : 0.4 * Math.sqrt(Math.max(0, 1 - ((y - 0.55) / 0.4) ** 2));
  return Math.abs(x - 0.5) <= half;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function onCheck(x, y) {
  const w = 0.075;
  return distToSegment(x, y, 0.3, 0.5, 0.45, 0.65) < w || distToSegment(x, y, 0.45, 0.65, 0.72, 0.36) < w;
}

function render(size) {
  const ss = 4; // supersampling for anti-aliasing
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let shield = 0;
      let mark = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          if (insideShield(u, v)) {
            if (onCheck(u, v)) mark++;
            else shield++;
          }
        }
      }
      const total = ss * ss;
      const a = (shield + mark) / total;
      const color = a === 0 ? [0, 0, 0] : SHIELD.map((c, i) => Math.round((c * shield + MARK[i] * mark) / (shield + mark)));
      row.set([...color, Math.round(a * 255)], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(OUT, `icon${size}.png`), render(size));
}
console.log(`icons written to ${OUT}`);
