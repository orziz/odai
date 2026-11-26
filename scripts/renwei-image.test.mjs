// Behaviour checks for renwei's model-free image tools, on synthetic images only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { decodePng, encodePng, pngChunks, stripMetadata } from "../skills/renwei/scripts/png.mjs";
import { inspectMetadata, readExifOrientation, stripImageMetadata } from "../skills/renwei/scripts/metadata.mjs";
import { cleanCel, cleanPixels, detectGrid, internal, reviewSheet } from "../skills/renwei/scripts/clean-image.mjs";

const SCRIPT = fileURLToPath(new URL("../skills/renwei/scripts/clean-image.mjs", import.meta.url));

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Hand-built PNG from already packed scanlines (filter 0), for decoder coverage beyond our own encoder. */
function rawPng({ width, height, depth, colorType, interlace = 0, lines, extra = [] }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = interlace;
  const body = Buffer.concat(lines.map(line => Buffer.concat([Buffer.from([0]), Buffer.from(line)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", deflateSync(body)), chunk("IEND", Buffer.alloc(0))]);
}
/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function image(width, height, paint) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

test("decodes palette with transparency, 16-bit grey-alpha and Adam7 interlacing", () => {
  const palette = decodePng(rawPng({
    width: 3, height: 2, depth: 4, colorType: 3,
    lines: [[0x01, 0x20], [0x30, 0x10]],
    extra: [chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])), chunk("tRNS", Buffer.from([255, 128, 0]))],
  }));
  assert.deepEqual([...palette.data], [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 128]);

  const grey = decodePng(rawPng({ width: 2, height: 1, depth: 16, colorType: 4, lines: [[0x12, 0x34, 0xff, 0xff, 0xff, 0x00, 0x80, 0x00]] }));
  assert.deepEqual([...grey.data], [18, 18, 18, 255, 254, 254, 254, 128]);

  // 3x3 RGB through the seven Adam7 passes: (0,0) | — | — | (2,0) | (0,2),(2,2) | (1,0),(1,2) | row 1
  const src = image(3, 3, (x, y) => [x * 80, y * 80, 7 * (x + 3 * y), 255]);
  const at = (x, y) => [...pixel(src, x, y).slice(0, 3)];
  const lines = [[...at(0, 0)], [...at(2, 0)], [...at(0, 2), ...at(2, 2)], [...at(1, 0)], [...at(1, 2)], [...at(0, 1), ...at(1, 1), ...at(2, 1)]];
  const interlaced = decodePng(rawPng({ width: 3, height: 3, depth: 8, colorType: 2, interlace: 1, lines }));
  assert.deepEqual([...interlaced.data], [...src.data]);
});

test("encodes and decodes every RGBA value unchanged, choosing RGB when fully opaque", () => {
  const next = random(7);
  const rgba = image(37, 23, () => [next() * 256, next() * 256, next() * 256, next() < 0.2 ? 0 : next() * 256].map(Math.floor));
  assert.deepEqual([...decodePng(encodePng(rgba)).data], [...rgba.data]);
  const opaque = image(20, 9, (x, y) => [x * 12, y * 25, 99, 255]);
  const bytes = encodePng(opaque);
  assert.equal(bytes[25], 2, "colour type RGB");
  assert.deepEqual([...decodePng(bytes).data], [...opaque.data]);
});

test("strips metadata chunks such as C2PA caBX and trailing bytes while keeping pixels, APNG frames and cICP", () => {
  const plain = encodePng(image(8, 8, (x, y) => [x * 30, y * 30, 0, 255]));
  const chunks = pngChunks(plain);
  const cicp = chunk("cICP", Buffer.from([12, 13, 0, 1]));
  const actl = chunk("acTL", Buffer.alloc(8));
  const tagged = Buffer.concat([
    plain.subarray(0, 8), chunks[0].bytes, cicp, actl,
    chunk("tEXt", Buffer.from("Software\0generator")), chunk("caBX", Buffer.from("c2pa manifest")),
    ...chunks.slice(1).map(c => c.bytes),
    Buffer.from("trailing-junk"),
  ]);
  const { bytes, removed } = stripMetadata(tagged);
  assert.deepEqual(removed, ["tEXt", "caBX", "trailing"]);
  const kept = pngChunks(bytes).map(c => c.type);
  assert.ok(kept.includes("cICP") && kept.includes("acTL"));
  assert.deepEqual([...decodePng(bytes).data], [...decodePng(tagged).data]);

  // Grayscale PNG iCCP must not be copied onto RGB/RGBA re-encoded output; RGB iCCP stays.
  const iccp = chunk("iCCP", Buffer.from("profile\0\0x"));
  const grayPng = rawPng({ width: 2, height: 1, depth: 8, colorType: 0, lines: [[10, 200]], extra: [iccp] });
  const rgbPng = rawPng({ width: 2, height: 1, depth: 8, colorType: 2, lines: [[10, 20, 30, 40, 50, 60]], extra: [iccp] });
  assert.equal(decodePng(grayPng).carried.length, 0);
  assert.equal(decodePng(rgbPng).carried.length, 1);
});

function exifPayload(orientation, littleEndian = true) {
  const buf = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  buf.write("Exif\0\0", 0, "latin1");
  buf.write(littleEndian ? "II" : "MM", 6, "latin1");
  const w16 = (off, v) => (littleEndian ? buf.writeUInt16LE(v, off) : buf.writeUInt16BE(v, off));
  const w32 = (off, v) => (littleEndian ? buf.writeUInt32LE(v, off) : buf.writeUInt32BE(v, off));
  w16(8, 42);
  w32(10, 8);
  w16(14, 1);
  w16(16, 0x0112);
  w16(18, 3);
  w32(20, 1);
  w16(24, orientation);
  return buf;
}
function jpegSeg(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = marker; head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
function webpChunk(type, data) {
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1"); head.writeUInt32LE(data.length, 4);
  return data.length & 1 ? Buffer.concat([head, data, Buffer.from([0])]) : Buffer.concat([head, data]);
}

test("inspects and losslessly strips JPEG and WebP metadata while guarding non-1 EXIF orientation", () => {
  const jfif = jpegSeg(0xe0, Buffer.concat([Buffer.from("JFIF\0"), Buffer.alloc(9)]));
  const icc = jpegSeg(0xe2, Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.from([1, 1, 9, 8])]));
  const xmp = jpegSeg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<xmp/>"));
  const c2pa = jpegSeg(0xeb, Buffer.from("JP\0\x01\0\0\0\x01jumbc2pa"));
  const com = jpegSeg(0xfe, Buffer.from("ai-gen"));
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0, 0x12, 0xff, 0x00, 0xff, 0xd0, 0x34]);
  const eoi = Buffer.from([0xff, 0xd9]);
  const soi = Buffer.from([0xff, 0xd8]);

  const jpegNormal = Buffer.concat([soi, jfif, icc, jpegSeg(0xe1, exifPayload(1, true)), xmp, c2pa, com, scan, eoi, Buffer.from("tail")]);
  const info = inspectMetadata(jpegNormal);
  assert.equal(info.format, "jpeg");
  assert.equal(info.orientation, 1);
  assert.ok(info.chunks.some(c => c.type === "APP11(C2PA/JUMBF)" && c.metadata));
  const stripped = stripImageMetadata(jpegNormal);
  assert.deepEqual(stripped.removed, ["APP1(EXIF)", "APP1(XMP)", "APP11(C2PA/JUMBF)", "COM", "trailing"]);
  assert.ok(stripped.bytes.equals(Buffer.concat([soi, jfif, icc, scan, eoi])), "JFIF, ICC and scan bytes stay verbatim");

  const jpegRotated = Buffer.concat([soi, jfif, jpegSeg(0xe1, exifPayload(6, false)), scan, eoi]);
  assert.equal(readExifOrientation(exifPayload(6, false)), 6);
  assert.throws(() => stripImageMetadata(jpegRotated), /Orientation=6/u);
  const forced = stripImageMetadata(jpegRotated, { dropOrientation: true });
  assert.deepEqual(forced.removed, ["APP1(EXIF)"]);

  // Extended WebP with ICCP + EXIF + XMP + C2PA -> keeps ICCP & VP8, clears EXIF/XMP flags in VP8X, updates RIFF size.
  const vp8xData = Buffer.from([0x20 | 0x08 | 0x04, 0, 0, 0, 15, 0, 0, 15, 0, 0]);
  const vp8Payload = Buffer.from([1, 2, 3, 4, 5]);
  const iccpPayload = Buffer.from("icc-bytes");
  const webpBody = Buffer.concat([
    webpChunk("VP8X", vp8xData),
    webpChunk("ICCP", iccpPayload),
    webpChunk("VP8 ", vp8Payload),
    webpChunk("EXIF", exifPayload(1, true)),
    webpChunk("XMP ", Buffer.from("<xmp/>")),
    webpChunk("C2PA", Buffer.from("manifest")),
  ]);
  const riffHead = Buffer.alloc(12);
  riffHead.write("RIFF", 0, "latin1"); riffHead.writeUInt32LE(4 + webpBody.length, 4); riffHead.write("WEBP", 8, "latin1");
  const webpBytes = Buffer.concat([riffHead, webpBody, Buffer.from("extra")]);
  const cleanWebp = stripImageMetadata(webpBytes);
  assert.deepEqual(cleanWebp.removed, ["EXIF", "XMP ", "C2PA", "trailing"]);
  assert.equal(cleanWebp.bytes.readUInt32LE(4), cleanWebp.bytes.length - 8);
  const reinspected = inspectMetadata(cleanWebp.bytes);
  assert.deepEqual(reinspected.chunks.map(c => c.type), ["VP8X", "ICCP", "VP8 "]);
  assert.equal(cleanWebp.bytes[20], 0x20, "VP8X keeps only ICCP flag");
});

test("mixed-radix FFT matches a direct DFT and inverts exactly", () => {
  for (const [W, H] of [[30, 12], [25, 27]]) {
    const next = random(W * H), N = W * H;
    const re = Float64Array.from({ length: N }, () => next() - 0.5), im = Float64Array.from({ length: N }, () => next() - 0.5);
    const xr = Float64Array.from(re), xi = Float64Array.from(im);
    const plans = { row: internal.fftPlan(W), col: internal.fftPlan(H) };
    const scratch = { rowRe: new Float64Array(W), rowIm: new Float64Array(W), re: new Float64Array(N), im: new Float64Array(N) };
    internal.fft2(xr, xi, W, H, plans, scratch);
    for (const [u, v] of [[0, 0], [1, 0], [3, 5], [W - 1, H - 1]]) {
      let sr = 0, si = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const t = -2 * Math.PI * ((u * x) / W + (v * y) / H);
        sr += re[y * W + x] * Math.cos(t) - im[y * W + x] * Math.sin(t);
        si += re[y * W + x] * Math.sin(t) + im[y * W + x] * Math.cos(t);
      }
      assert.ok(Math.abs(sr - xr[v * W + u]) < 1e-9 && Math.abs(si - xi[v * W + u]) < 1e-9);
    }
    internal.fft2(xr, xi, W, H, plans, scratch, true);
    for (let i = 0; i < N; i++) assert.ok(Math.abs(xr[i] - re[i]) < 1e-12 && Math.abs(xi[i] - im[i]) < 1e-12);
  }
});

test("cel cleanup drops low-contrast ripple but keeps ink lines, highlights, hard shadow edges and alpha", () => {
  const next = random(11);
  const skin = [230, 190, 170], shadow = [200, 150, 135], ink = [40, 30, 30];
  const src = image(96, 96, (x, y) => {
    if (x < 4 || y < 4) return [255, 0, 255, 0]; // transparent margin holding junk colour
    if (y === 30 && x >= 10 && x < 86) return [...ink, 255];
    if (x === 20 && y === 70) return [255, 255, 255, 255];
    const base = x < 48 ? skin : shadow;
    return [...base.map(v => Math.round(v + (next() - 0.5) * 8)), 255];
  });
  const out = cleanCel(src);
  const ripple = (img, x0, x1, y0, y1) => {
    const values = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) values.push(luma(pixel(img, x, y)));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((a, v) => a + Math.abs(v - mean), 0) / values.length;
  };
  for (const box of [[10, 40, 40, 62], [56, 90, 40, 62]]) assert.ok(ripple(out, ...box) < 0.5 * ripple(src, ...box), `ripple kept in ${box}`);
  for (let x = 15; x < 80; x += 5) {
    assert.ok(luma(pixel(out, x, 30)) < luma(ink) + 6, `ink line faded at x=${x}`);
    for (const y of [29, 31]) assert.ok(luma(pixel(out, x, y)) < luma(x < 48 ? skin : shadow) + 4, `halo beside the line at ${x},${y}`);
  }
  assert.ok(luma(pixel(out, 20, 70)) > 230, "highlight lost");
  const across = img => { let d = 0; for (let y = 40; y < 62; y++) d += luma(pixel(img, 45, y)) - luma(pixel(img, 51, y)); return d; };
  assert.ok(across(out) > 0.85 * across(src), "shadow edge softened");
  for (let i = 3; i < src.data.length; i += 4) assert.equal(out.data[i], src.data[i]);
});

test("pixel cleanup restores the native grid, merges near-identical colours, keeps eyes and shares one palette across frames", () => {
  const body = [200, 60, 60], outline = [30, 20, 30], eye = [255, 255, 255];
  const sprite = drift => image(12, 12, (x, y) => {
    if (x < 2 || y < 2 || x > 9 || y > 9) return [0, 0, 0, 0];
    if (x === 2 || y === 2 || x === 9 || y === 9) return [...outline, 255];
    if (x === 4 && y === 4) return [...eye, 255];
    if ((x === 6 && y === 6) || (x === 7 && y === 4)) return [203, 58, 61, 255]; // stray near-identical shade
    return [...body.map((v, k) => v + drift[k]), 255];
  });
  const enlarge = (img, k) => image(img.width * k, img.height * k, (x, y) => pixel(img, Math.floor(x / k), Math.floor(y / k)));
  const [a, b] = cleanPixels([enlarge(sprite([0, 0, 0]), 4), enlarge(sprite([1, 1, -1]), 4)]);
  assert.equal(a.width, 48);
  assert.equal(a.info.block, 4);
  assert.deepEqual(pixel(a, 6 * 4 + 1, 6 * 4 + 1), pixel(a, 5 * 4, 5 * 4), "stray shade merged into the body");
  assert.deepEqual(pixel(a, 4 * 4, 4 * 4), [...eye, 255], "eye highlight kept");
  assert.deepEqual(pixel(b, 5 * 4, 5 * 4), pixel(a, 5 * 4, 5 * 4), "frames share the body colour");
  assert.deepEqual(pixel(a, 0, 0), [0, 0, 0, 0]);
});

test("detects the pixel size of a non-integer pseudo-pixel enlargement only when asked", () => {
  const next = random(3), colours = [[20, 20, 30], [200, 80, 60], [90, 160, 210], [240, 220, 160]];
  const native = image(24, 24, () => [...colours[Math.floor(next() * 4)], 255]);
  const pseudo = image(132, 132, (x, y) => pixel(native, Math.floor(x / 5.5), Math.floor(y / 5.5)));
  const grid = detectGrid(pseudo);
  assert.ok(Math.abs(grid.s - 5.5) < 0.1, `period ${grid.s}`);
  const [restored] = cleanPixels([pseudo], { grid: "auto" });
  assert.ok(Math.abs(restored.width - 24) <= 1 && Math.abs(restored.height - 24) <= 1);
  const [untouched] = cleanPixels([pseudo]);
  assert.equal(untouched.width, 132, "no grid detection unless requested");
});

test("keeps details drawn finer than the pseudo-pixel grid (eyes, stubble) instead of wiping them", () => {
  const next = random(5), colours = [[20, 20, 30], [200, 80, 60], [90, 160, 210], [60, 120, 60]];
  const s = 7.5, cells = Array.from({ length: 400 }, () => colours[Math.floor(next() * 4)]);
  const marked = new Set([21, 47, 88, 120, 151, 199, 230, 262, 301, 333, 365, 377]);
  const pseudo = image(150, 150, (x, y) => {
    // nearest-neighbour rendering by pixel centre, like a generator's non-integer enlargement
    const u = (x + 0.5) / s, v = (y + 0.5) / s, c = Math.floor(u), r = Math.floor(v);
    // a white quarter-cell in the top-left corner of some cells: detail drawn at half the grid size
    if (marked.has(r * 20 + c) && u - c < 0.5 && v - r < 0.5) return [250, 250, 250, 255];
    return [...cells[r * 20 + c], 255];
  });
  const whites = img => { let n = 0; for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 250 && img.data[i + 3] === 255) n++; return n; };
  const [kept] = cleanPixels([pseudo], { grid: "auto" });
  assert.ok(kept.info.refined, "detail cells re-sampled at half size");
  assert.equal(whites(kept), marked.size, "every fine detail survives as one half-size cell");
  const [uniform] = cleanPixels([pseudo], { grid: "auto", uniform: true });
  assert.equal(whites(uniform), 0);
  assert.match(uniform.info.warning, /更细的细节/u);
});

test("detects the fundamental period for integer blocks >= 7 without falling onto harmonics or adding transparent borders", () => {
  const colours = [[20, 20, 30], [200, 80, 60], [90, 160, 210], [240, 220, 160]];
  for (const s of [4, 7, 8, 10, 12, 16]) {
    const next = random(100 + s);
    const native = image(20, 20, () => [...colours[Math.floor(next() * 4)], 255]);
    const noisy = image(20 * s, 20 * s, (x, y) => pixel(native, Math.floor(x / s), Math.floor(y / s)));
    noisy.data[0] = (noisy.data[0] + 5) & 255; // breaks exactBlock like generator/compression noise
    const grid = detectGrid(noisy);
    assert.ok(Math.abs(grid.s - s) < 0.05, `true s=${s}, got ${grid.s}`);
    const [restored] = cleanPixels([noisy], { grid: "auto" });
    assert.equal(restored.width, 20, `no phantom columns for s=${s}`);
    assert.equal(restored.height, 20, `no phantom rows for s=${s}`);
    for (let i = 3; i < restored.data.length; i += 4) assert.equal(restored.data[i], 255, `no phantom alpha for s=${s}`);
  }
  // Opaque non-integer pseudo-pixel image also restores with exact dimensions and no transparent edge.
  const next = random(3);
  const native = image(24, 24, () => [...colours[Math.floor(next() * 4)], 255]);
  const pseudo = image(132, 132, (x, y) => pixel(native, Math.floor(x / 5.5), Math.floor(y / 5.5)));
  const [restored] = cleanPixels([pseudo], { grid: "auto" });
  assert.equal(restored.width, 24);
  assert.equal(restored.height, 24);
  for (let i = 3; i < restored.data.length; i += 4) assert.equal(restored.data[i], 255);
});

test("review sheet zooms into where the picture actually changed, including alpha-only changes on mid-grey", () => {
  const before = image(120, 120, () => [128, 140, 150, 255]);
  const after = image(120, 120, (x, y) => (x >= 80 && x < 92 && y >= 30 && y < 42 ? [200, 30, 30, 255] : [128, 140, 150, 255]));
  const { sheet, regions } = reviewSheet(before, after, { regions: 2, extra: [[0, 0, 20, 20]] });
  assert.equal(sheet.data.length, sheet.width * sheet.height * 4);
  assert.ok(regions[0].requested, "requested regions come first");
  const found = regions.find(r => !r.requested);
  assert.ok(found.x <= 80 && found.x + found.w >= 92 && found.y <= 30 && found.y + found.h >= 42, JSON.stringify(found));
  assert.equal(regions.filter(r => !r.requested).length, 1, "nothing else changed");

  const greyOpaque = image(64, 64, () => [128, 128, 128, 255]);
  const greyHole = image(64, 64, (x, y) => [128, 128, 128, x >= 20 && x < 40 && y >= 20 && y < 40 ? 0 : 255]);
  const alphaReview = reviewSheet(greyOpaque, greyHole, { regions: 1 });
  assert.equal(alphaReview.regions.length, 1, "alpha-only change on mid-grey is detected");
});

test("pixel --json --review reports the result and lines the restored grid up exactly with the source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renwei-image-"));
  try {
    const next = random(9), colours = [[20, 20, 30], [200, 80, 60], [90, 160, 210], [240, 220, 160]];
    const native = image(24, 24, () => [...colours[Math.floor(next() * 4)], 255]);
    const file = path.join(dir, "sprite.png");
    fs.writeFileSync(file, encodePng(image(132, 132, (x, y) => pixel(native, Math.floor((x + 0.5) / 5.5), Math.floor((y + 0.5) / 5.5)))));
    const run = spawnSync(process.execPath, [SCRIPT, "pixel", "--grid", "auto", "--json", "--review", path.join(dir, "review"), "-o", path.join(dir, "out.png"), file], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const [result] = JSON.parse(run.stdout).results;
    assert.equal(result.grid.kind, "detected");
    assert.ok(fs.existsSync(result.review));
    assert.deepEqual(result.regions, [], "an exact restoration shows no change once aligned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("command line refuses to overwrite its input and leaves it unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renwei-image-"));
  try {
    const file = path.join(dir, "art.png");
    fs.writeFileSync(file, encodePng(image(16, 16, (x, y) => [x * 16, y * 16, 128, 255])));
    const before = fs.readFileSync(file);
    for (const args of [["cel", "-o", file, file], ["pixel", "-o", dir, file], ["meta", file, "--strip", file]]) {
      const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
      assert.equal(run.status, 1, `${args[0]} should refuse`);
      assert.match(run.stderr, /拒绝覆盖输入文件/u);
      assert.ok(fs.readFileSync(file).equals(before));
    }
    const out = path.join(dir, "nested", "clean.png");
    const reviewFile = path.join(dir, "nested", "diff.png");
    const ok = spawnSync(process.execPath, [SCRIPT, "cel", "--strength", "light", "--review", reviewFile, "-o", out, file], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(decodePng(fs.readFileSync(out)).width, 16);
    assert.ok(fs.statSync(reviewFile).isFile(), "single-input --review .png writes a file instead of creating a .png directory");

    // Different-size measure reports both stats without crashing.
    const small = path.join(dir, "small.png");
    fs.writeFileSync(small, encodePng(image(8, 8, () => [100, 120, 140, 255])));
    const measured = spawnSync(process.execPath, [SCRIPT, "measure", "--json", file, small], { encoding: "utf8" });
    assert.equal(measured.status, 0, measured.stderr);
    const report = JSON.parse(measured.stdout);
    assert.equal(report.images.length, 2);
    assert.equal(report.comparison, null);
    assert.match(report.comparisonNote, /尺寸不同/u);

    // --keep-alpha with --scale warns instead of silently dropping alpha.
    const scaled = spawnSync(process.execPath, [SCRIPT, "pixel", "--keep-alpha", "--scale", "2", "--json", "-o", path.join(dir, "scaled.png"), file], { encoding: "utf8" });
    assert.equal(scaled.status, 0, scaled.stderr);
    assert.match(JSON.parse(scaled.stdout).results[0].warning, /--keep-alpha/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
