'use strict';
// Génère les icônes de l'application iPhone à partir de public/brand/icon.png, sans dépendance.
// iOS remplit la transparence en noir puis applique son propre arrondi : les icônes sont donc carrées et opaques.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const brand = path.resolve(__dirname, '..', 'public', 'brand');
const BACKGROUND = [0x0a, 0x0a, 0x0a];
const SIZES = { 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };

function chunks(buffer) {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Fichier PNG invalide.');
  const out = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at), type = buffer.toString('latin1', at + 4, at + 8);
    out.push({ type, data: buffer.subarray(at + 8, at + 8 + length) }); at += 12 + length;
  }
  return out;
}
function decode(buffer) {
  const list = chunks(buffer), header = list.find(c => c.type === 'IHDR').data;
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), depth = header[8], colorType = header[9], interlace = header[12];
  const channels = { 2: 3, 6: 4 }[colorType];
  if (depth !== 8 || !channels || interlace) throw new Error('PNG non pris en charge (RVB ou RVBA 8 bits, non entrelacé).');
  const raw = zlib.inflateSync(Buffer.concat(list.filter(c => c.type === 'IDAT').map(c => c.data)));
  const stride = width * channels, pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0, up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) { const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner); value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner; }
      pixels[y * stride + x] = value & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { pixels.copy(rgba, i * 4, i * channels, i * channels + 3); rgba[i * 4 + 3] = channels === 4 ? pixels[i * 4 + 3] : 255; }
  return { width, height, rgba };
}
// Aplatit sur le fond de la marque puis réduit par moyenne de surface : rendu net à toutes les tailles.
function opaqueSquare(image, size) {
  const { width, height, rgba } = image, out = Buffer.alloc(size * size * 3), scale = width / size;
  if (width !== height) throw new Error('L’icône source doit être carrée.');
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sum = [0, 0, 0]; let weight = 0;
    for (let sy = Math.floor(y * scale); sy < Math.ceil((y + 1) * scale); sy++) for (let sx = Math.floor(x * scale); sx < Math.ceil((x + 1) * scale); sx++) {
      const w = (Math.min(sx + 1, (x + 1) * scale) - Math.max(sx, x * scale)) * (Math.min(sy + 1, (y + 1) * scale) - Math.max(sy, y * scale));
      const at = (sy * width + sx) * 4, alpha = rgba[at + 3] / 255;
      for (let c = 0; c < 3; c++) sum[c] += w * (rgba[at + c] * alpha + BACKGROUND[c] * (1 - alpha));
      weight += w;
    }
    for (let c = 0; c < 3; c++) out[(y * size + x) * 3 + c] = Math.round(sum[c] / weight);
  }
  return out;
}
const CRC = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function encodeRGB(rgb, size) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function buildIcons(target = brand) {
  const source = decode(fs.readFileSync(path.join(brand, 'icon.png')));
  return Object.entries(SIZES).map(([name, size]) => { const file = path.join(target, name); fs.writeFileSync(file, encodeRGB(opaqueSquare(source, size), size)); return file; });
}
if (require.main === module) for (const file of buildIcons()) console.log('Icône créée : ' + path.relative(process.cwd(), file));
module.exports = { decode, buildIcons, SIZES };
