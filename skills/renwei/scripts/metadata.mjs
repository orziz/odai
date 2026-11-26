// Dependency-free, lossless container metadata inspector and stripper for PNG, JPEG and WebP (Node built-ins only).
// Keeps compressed pixel data, animation frames and colour profiles intact byte for byte; drops EXIF, XMP, IPTC,
// comments, C2PA / JUMBF boxes and trailing bytes. Does not touch pixel-domain watermarks (such as SynthID).
import { pngChunks, stripMetadata as stripPngMetadata, PIXEL_CHUNKS } from "./png.mjs";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_PIXEL_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
const FORMAT_EXTENSIONS = Object.freeze({
  png: [".png"],
  jpeg: [".jpg", ".jpeg"],
  webp: [".webp"],
});

export function formatExtensions(format) {
  return FORMAT_EXTENSIONS[format] ?? [];
}

export function detectImageFormat(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  throw new Error("不支持的图片格式（meta 仅支持 PNG、JPEG、WebP）");
}

/** Read TIFF IFD0 Orientation tag (0x0112) from an EXIF payload (with or without the leading "Exif\0\0"). */
export function readExifOrientation(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let base = 0;
  if (buf.length >= 6 && buf.toString("latin1", 0, 6) === "Exif\0\0") base = 6;
  if (base + 8 > buf.length) return null;
  const order = buf.toString("latin1", base, base + 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = off => (le ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
  const u32 = off => (le ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
  if (u16(base + 2) !== 42) return null;
  const ifd0 = u32(base + 4);
  const pos = base + ifd0;
  if (pos + 2 > buf.length) return null;
  const count = u16(pos);
  for (let k = 0; k < count; k++) {
    const entry = pos + 2 + k * 12;
    if (entry + 12 > buf.length) break;
    if (u16(entry) === 0x0112) {
      const type = u16(entry + 2), num = u32(entry + 4);
      if (type === 3 && num >= 1) {
        const value = u16(entry + 8);
        if (value >= 1 && value <= 8) return value;
      }
      return null;
    }
  }
  return null;
}

// ---------- JPEG ----------

function isSofMarker(m) {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function classifyJpegSegment(marker, data) {
  if (marker === 0xd8) return { type: "SOI", metadata: false };
  if (marker === 0xd9) return { type: "EOI", metadata: false };
  if (marker === 0xda) return { type: "SOS", metadata: false };
  if (marker === 0xdb) return { type: "DQT", metadata: false };
  if (marker === 0xc4) return { type: "DHT", metadata: false };
  if (marker === 0xdd) return { type: "DRI", metadata: false };
  if (marker === 0xcc) return { type: "DAC", metadata: false };
  if (marker === 0xdc) return { type: "DNL", metadata: false };
  if (isSofMarker(marker)) return { type: `SOF${marker - 0xc0}`, metadata: false };
  if (marker === 0xfe) return { type: "COM", metadata: true };
  if (marker >= 0xe0 && marker <= 0xef) {
    const n = marker - 0xe0;
    if (marker === 0xe0 && data.length >= 5 && data.toString("latin1", 0, 5) === "JFIF\0") return { type: "APP0(JFIF)", metadata: false };
    if (marker === 0xe2 && data.length >= 12 && data.toString("latin1", 0, 12) === "ICC_PROFILE\0") return { type: "APP2(ICC)", metadata: false };
    if (marker === 0xee && data.length >= 5 && data.toString("latin1", 0, 5) === "Adobe") return { type: "APP14(Adobe)", metadata: false };
    if (marker === 0xe1) {
      if (data.length >= 6 && data.toString("latin1", 0, 6) === "Exif\0\0") return { type: "APP1(EXIF)", metadata: true, exif: true };
      const prefix = data.toString("latin1", 0, Math.min(data.length, 36));
      if (prefix.startsWith("http://ns.adobe.com/xap/1.0/\0") || prefix.startsWith("http://ns.adobe.com/xmp/extension/\0")) {
        return { type: "APP1(XMP)", metadata: true };
      }
      return { type: "APP1", metadata: true };
    }
    if (marker === 0xeb) {
      const isJumbf = data.length >= 2 && data.toString("latin1", 0, 2) === "JP" && data.includes(Buffer.from("jumb"));
      return { type: isJumbf ? "APP11(C2PA/JUMBF)" : "APP11", metadata: true };
    }
    if (marker === 0xed && data.length >= 14 && data.toString("latin1", 0, 14) === "Photoshop 3.0\0") {
      return { type: "APP13(IPTC/Photoshop)", metadata: true };
    }
    return { type: `APP${n}`, metadata: true };
  }
  return { type: `0xFF${marker.toString(16).toUpperCase().padStart(2, "0")}`, metadata: false };
}

function parseJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("不是有效的 JPEG 文件");
  const segments = [{ type: "SOI", bytes: buf.subarray(0, 2), dataLength: 0, metadata: false }];
  let offset = 2;
  let orientation = null;
  let sawEoi = false;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new Error("JPEG 段标记无效");
    const segStart = offset;
    while (offset < buf.length && buf[offset] === 0xff) offset++;
    if (offset >= buf.length) throw new Error("JPEG 标记被截断");
    const marker = buf[offset++];
    if (marker === 0xd9) {
      segments.push({ type: "EOI", bytes: buf.subarray(segStart, offset), dataLength: 0, metadata: false });
      sawEoi = true;
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      segments.push({ type: `0xFF${marker.toString(16).toUpperCase()}`, bytes: buf.subarray(segStart, offset), dataLength: 0, metadata: false });
      continue;
    }
    if (offset + 2 > buf.length) throw new Error("JPEG 段长度被截断");
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) throw new Error("JPEG 段内容被截断");
    if (marker === 0xda) {
      let pos = offset + length;
      while (pos < buf.length) {
        if (buf[pos] !== 0xff) { pos++; continue; }
        let next = pos + 1;
        while (next < buf.length && buf[next] === 0xff) next++;
        if (next >= buf.length) throw new Error("JPEG 扫描数据被截断");
        const m = buf[next];
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { pos = next + 1; continue; }
        break;
      }
      if (pos >= buf.length) throw new Error("JPEG 缺少 EOI 结束标记");
      segments.push({ type: "SOS", bytes: buf.subarray(segStart, pos), dataLength: pos - (offset + 2), metadata: false });
      offset = pos;
      continue;
    }
    const data = buf.subarray(offset + 2, offset + length);
    const info = classifyJpegSegment(marker, data);
    if (info.exif && orientation === null) orientation = readExifOrientation(data);
    segments.push({ type: info.type, bytes: buf.subarray(segStart, offset + length), dataLength: data.length, metadata: info.metadata });
    offset += length;
  }
  if (!sawEoi) throw new Error("JPEG 缺少 EOI 结束标记");
  if (offset < buf.length) {
    segments.push({ type: "trailing", bytes: buf.subarray(offset), dataLength: buf.length - offset, metadata: true });
  }
  return { segments, orientation };
}

// ---------- WebP ----------

function parseWebp(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") {
    throw new Error("不是有效的 WebP 文件");
  }
  const riffSize = buf.readUInt32LE(4);
  const riffEnd = 8 + riffSize;
  if (riffSize < 4 || riffEnd > buf.length) throw new Error("WebP RIFF 长度被截断");
  const chunks = [];
  let offset = 12;
  let orientation = null;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) throw new Error("WebP 块头被截断");
    const type = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8, dataEnd = dataStart + size;
    if (dataEnd > riffEnd) throw new Error("WebP 块内容被截断");
    const paddedEnd = Math.min(riffEnd, dataEnd + (size & 1));
    const data = buf.subarray(dataStart, dataEnd);
    const metadata = !WEBP_PIXEL_CHUNKS.has(type);
    if (type === "EXIF" && orientation === null) orientation = readExifOrientation(data);
    chunks.push({ type, data, metadata });
    offset = paddedEnd;
  }
  if (riffEnd < buf.length) {
    chunks.push({ type: "trailing", data: buf.subarray(riffEnd), metadata: true });
  }
  return { chunks, orientation };
}

function encodeWebpChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return data.length & 1 ? Buffer.concat([head, data, Buffer.from([0])]) : Buffer.concat([head, data]);
}

function rebuildWebp(chunks) {
  const kept = chunks.filter(chunk => !chunk.metadata);
  const hasIccp = kept.some(chunk => chunk.type === "ICCP");
  const hasAnim = kept.some(chunk => chunk.type === "ANIM" || chunk.type === "ANMF");
  const hasAlph = kept.some(chunk => chunk.type === "ALPH");
  const vp8xIndex = kept.findIndex(chunk => chunk.type === "VP8X");
  let outputChunks = kept;
  if (vp8xIndex >= 0 && kept[vp8xIndex].data.length >= 10) {
    const vp8x = Buffer.from(kept[vp8xIndex].data);
    // Clear EXIF (0x08) and XMP (0x04) bits; preserve ICCP (0x20), Alpha (0x10), Animation (0x02).
    vp8x[0] &= ~(0x08 | 0x04);
    if (!hasIccp) vp8x[0] &= ~0x20;
    if (!hasAnim) vp8x[0] &= ~0x02;
    const onlySimpleBitstream = (vp8x[0] & 0x3e) === 0 && !hasAlph && kept.length === 2
      && (kept[1 - vp8xIndex].type === "VP8 " || kept[1 - vp8xIndex].type === "VP8L");
    outputChunks = onlySimpleBitstream
      ? kept.filter((_, i) => i !== vp8xIndex)
      : kept.map((chunk, i) => (i === vp8xIndex ? { type: "VP8X", data: vp8x } : chunk));
  }
  const body = Buffer.concat(outputChunks.map(chunk => encodeWebpChunk(chunk.type, chunk.data)));
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}

// ---------- unified API ----------

export function inspectMetadata(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const format = detectImageFormat(buf);
  if (format === "png") {
    const raw = pngChunks(buf);
    const endOffset = raw.reduce((sum, chunk) => sum + chunk.bytes.length, 8);
    const chunks = raw.map(chunk => ({ type: chunk.type, bytes: chunk.data.length, metadata: !PIXEL_CHUNKS.has(chunk.type) }));
    if (buf.length > endOffset) chunks.push({ type: "trailing", bytes: buf.length - endOffset, metadata: true });
    return { format, chunks, orientation: null };
  }
  if (format === "jpeg") {
    const { segments, orientation } = parseJpeg(buf);
    return {
      format,
      chunks: segments.map(seg => ({ type: seg.type, bytes: seg.dataLength, metadata: seg.metadata })),
      orientation,
    };
  }
  const { chunks, orientation } = parseWebp(buf);
  return {
    format,
    chunks: chunks.map(chunk => ({ type: chunk.type, bytes: chunk.data.length, metadata: chunk.metadata })),
    orientation,
  };
}

export function stripImageMetadata(bytes, { dropOrientation = false } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const format = detectImageFormat(buf);
  if (format === "png") {
    const { bytes: out, removed } = stripPngMetadata(buf);
    return { format, bytes: out, removed, orientation: null };
  }
  if (format === "jpeg") {
    const { segments, orientation } = parseJpeg(buf);
    if (orientation && orientation !== 1 && !dropOrientation) {
      throw new Error(`JPEG 的 EXIF 包含方向标记 Orientation=${orientation}；直接剥离 EXIF 会导致画面旋转或翻转。请先按方向重存像素，或确认后加 --drop-orientation。`);
    }
    const removed = segments.filter(seg => seg.metadata).map(seg => seg.type);
    const out = removed.length ? Buffer.concat(segments.filter(seg => !seg.metadata).map(seg => seg.bytes)) : buf;
    return { format, bytes: out, removed, orientation };
  }
  const { chunks, orientation } = parseWebp(buf);
  if (orientation && orientation !== 1 && !dropOrientation) {
    throw new Error(`WebP 的 EXIF 包含方向标记 Orientation=${orientation}；直接剥离 EXIF 会导致画面旋转或翻转。请先按方向重存像素，或确认后加 --drop-orientation。`);
  }
  const removed = chunks.filter(chunk => chunk.metadata).map(chunk => chunk.type);
  const out = removed.length ? rebuildWebp(chunks) : buf;
  return { format, bytes: out, removed, orientation };
}
