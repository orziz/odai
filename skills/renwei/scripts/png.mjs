// Dependency-free PNG codec for renwei's image tools (Node built-ins only).
// Decodes every standard colour type and bit depth, including Adam7 interlacing, to 8-bit RGBA;
// encodes 8-bit RGB / RGBA; lists or strips chunks without touching the compressed pixel data.
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks that carry pixels, animation frames or colour/display geometry; everything else (text, EXIF, C2PA `caBX`, time…) is metadata. */
export const PIXEL_CHUNKS = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS",
  "sRGB", "gAMA", "cHRM", "iCCP", "cICP", "mDCv", "cLLi", "sBIT", "pHYs",
  "acTL", "fcTL", "fdAT",
]);
/** Colour and density chunks copied onto re-encoded output (sBIT is dropped: the bit depth changes). */
const CARRIED_CHUNKS = new Set(["iCCP", "sRGB", "gAMA", "cHRM", "cICP", "mDCv", "cLLi", "pHYs"]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Split a PNG file into chunks; each entry keeps its full byte range so files can be re-assembled unchanged. */
export function pngChunks(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("不是 PNG 文件（签名不符）");
  const chunks = [];
  let offset = 8;
  while (offset < buf.length) {
    if (offset + 12 > buf.length) throw new Error("PNG 块被截断");
    const length = buf.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buf.length) throw new Error("PNG 块内容被截断");
    const type = buf.toString("latin1", offset + 4, offset + 8);
    chunks.push({ type, data: buf.subarray(offset + 8, offset + 8 + length), bytes: buf.subarray(offset, end) });
    offset = end;
    if (type === "IEND") break;
  }
  if (chunks.at(-1)?.type !== "IEND") throw new Error("PNG 缺少 IEND 结束块");
  if (chunks[0].type !== "IHDR") throw new Error("PNG 第一个块不是 IHDR");
  return chunks;
}

/** Copy of a PNG keeping only pixel, animation and colour chunks; compressed image data is copied byte for byte. */
export function stripMetadata(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const chunks = pngChunks(buf);
  const endOffset = chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 8);
  const trailing = buf.length - endOffset;
  const removed = chunks.filter(chunk => !PIXEL_CHUNKS.has(chunk.type)).map(chunk => chunk.type);
  if (trailing > 0) removed.push("trailing");
  const output = removed.length
    ? Buffer.concat([SIGNATURE, ...chunks.filter(chunk => PIXEL_CHUNKS.has(chunk.type)).map(chunk => chunk.bytes)])
    : buf;
  return { bytes: output, removed };
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(type, line, prev, bpp) {
  const n = line.length;
  if (type === 0) return;
  if (type === 1) for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 255;
  else if (type === 2) for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 255;
  else if (type === 3) for (let i = 0; i < n; i++) line[i] = (line[i] + ((i >= bpp ? line[i - bpp] : 0) + prev[i] >> 1)) & 255;
  else if (type === 4) for (let i = 0; i < n; i++) line[i] = (line[i] + paeth(i >= bpp ? line[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 255;
  else throw new Error(`未知的 PNG 行过滤类型 ${type}`);
}

/**
 * Decode a PNG into { width, height, data: Uint8Array RGBA, chunks, carried }.
 * `carried` holds the colour / density chunks to copy onto re-encoded output.
 */
export function decodePng(bytes) {
  const chunks = pngChunks(bytes);
  const ihdr = chunks[0].data;
  if (ihdr.length !== 13) throw new Error("IHDR 长度不对");
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const depth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  if (!width || !height) throw new Error("PNG 宽高为 0");
  if (width * height > 200e6) throw new Error("图片超过 2 亿像素，先缩小再处理");
  if (!DEPTHS[colorType]?.includes(depth)) throw new Error(`不支持的颜色类型 ${colorType} / 位深 ${depth}`);
  if (ihdr[10] !== 0 || ihdr[11] !== 0 || interlace > 1) throw new Error("PNG 压缩、过滤或隔行方式不合规范");
  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const plte = chunks.find(chunk => chunk.type === "PLTE")?.data;
  const trns = chunks.find(chunk => chunk.type === "tRNS")?.data;
  if (colorType === 3 && !plte) throw new Error("调色板 PNG 缺少 PLTE");
  const raw = inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === "IDAT").map(chunk => chunk.data)));
  const data = new Uint8Array(width * height * 4);
  const maxSample = (1 << depth) - 1;
  const to8 = depth === 16 ? v => Math.round(v / 257) : depth < 8 ? v => Math.round(v * 255 / maxSample) : v => v;
  const keyGray = colorType === 0 && trns?.length >= 2 ? trns.readUInt16BE(0) : -1;
  const keyRgb = colorType === 2 && trns?.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  let offset = 0;
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const pw = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const ph = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (!pw || !ph) continue;
    const stride = Math.ceil(pw * bitsPerPixel / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      if (offset + 1 + stride > raw.length) throw new Error("PNG 像素数据被截断");
      const line = Uint8Array.from(raw.subarray(offset + 1, offset + 1 + stride));
      unfilter(raw[offset], line, prev, bpp);
      offset += 1 + stride;
      const sample = depth === 16
        ? (x, c) => (line[(x * channels + c) * 2] << 8) | line[(x * channels + c) * 2 + 1]
        : depth === 8
          ? (x, c) => line[x * channels + c]
          : x => (line[(x * depth) >> 3] >> (8 - depth - ((x * depth) & 7))) & maxSample;
      for (let x = 0; x < pw; x++) {
        const o = ((y0 + y * dy) * width + x0 + x * dx) * 4;
        if (colorType === 0) {
          const g = sample(x, 0), v = to8(g);
          data[o] = data[o + 1] = data[o + 2] = v;
          data[o + 3] = g === keyGray ? 0 : 255;
        } else if (colorType === 2) {
          const r = sample(x, 0), g = sample(x, 1), b = sample(x, 2);
          data[o] = to8(r); data[o + 1] = to8(g); data[o + 2] = to8(b);
          data[o + 3] = keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2] ? 0 : 255;
        } else if (colorType === 3) {
          const index = sample(x, 0);
          if (index * 3 + 2 >= plte.length) throw new Error("调色板索引越界");
          data[o] = plte[index * 3]; data[o + 1] = plte[index * 3 + 1]; data[o + 2] = plte[index * 3 + 2];
          data[o + 3] = trns && index < trns.length ? trns[index] : 255;
        } else if (colorType === 4) {
          const v = to8(sample(x, 0));
          data[o] = data[o + 1] = data[o + 2] = v;
          data[o + 3] = to8(sample(x, 1));
        } else {
          data[o] = to8(sample(x, 0)); data[o + 1] = to8(sample(x, 1)); data[o + 2] = to8(sample(x, 2)); data[o + 3] = to8(sample(x, 3));
        }
      }
      prev = line;
    }
  }
  // Grayscale ICC profiles are invalid on the RGB/RGBA output written by encodePng.
  const grayscale = colorType === 0 || colorType === 4;
  const carried = chunks.filter(chunk => CARRIED_CHUNKS.has(chunk.type) && !(grayscale && chunk.type === "iCCP")).map(chunk => chunk.bytes);
  return { width, height, data, chunks: chunks.map(chunk => ({ type: chunk.type, length: chunk.data.length })), carried };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode 8-bit RGBA as PNG (RGB when every pixel is opaque); `carried` chunks are placed before the image data. */
export function encodePng({ width, height, data }, carried = []) {
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const rows = Buffer.alloc((stride + 1) * height);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride), trial = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) cur[x * channels + c] = data[(y * width + x) * 4 + c];
    // Pick the filter with the smallest sum of absolute signed residuals (the usual libpng heuristic).
    let bestType = 0, bestScore = Infinity;
    const best = Buffer.alloc(stride);
    for (let type = 0; type < 5; type++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
        const predictor = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const value = (cur[i] - predictor) & 255;
        trial[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) { bestScore = score; bestType = type; best.set(trial); }
    }
    const o = y * (stride + 1);
    rows[o] = bestType;
    best.copy(rows, o + 1);
    prev.set(cur);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    ...carried,
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
