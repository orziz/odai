#!/usr/bin/env node
// renwei image tools for agents: measure first, clean what image generators leave behind without any model, then
// look at a before/after review sheet. Node built-ins only; PNG for measure/cel/pixel/review, PNG/JPEG/WebP for meta;
// an output never overwrites an input. Every command takes --json for one machine-readable result.
//   node clean-image.mjs measure <a.png> [<b.png>]
//   node clean-image.mjs cel    [--strength light|normal|strong] [--sharpen 0|1|2] [--review <dir|file.png>] -o <out> <in.png>...
//   node clean-image.mjs pixel  [--grid auto|N] [--uniform] [--colors N] [--scale K] [--keep-alpha] [--review <dir|file.png>] -o <out> <in.png>...
//   node clean-image.mjs review [--regions N] [--region x,y,w,h]... -o <sheet.png> <before.png> <after.png>
//   node clean-image.mjs meta   [--strip <out>] [--drop-orientation] <in.png|jpg|webp>...
// `meta --strip` removes container metadata (EXIF, XMP, IPTC, comments, C2PA…); it does not and cannot remove
// watermarks hidden in the pixels (such as SynthID).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodePng, encodePng } from "./png.mjs";
import { inspectMetadata, stripImageMetadata, formatExtensions } from "./metadata.mjs";

export { inspectMetadata, stripImageMetadata };

// ---------- colour ----------

const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});
function oklab(key) {
  const R = LINEAR[(key >> 16) & 255], G = LINEAR[(key >> 8) & 255], B = LINEAR[key & 255];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
/** OKLab distance with chroma weighted 2x, so dark reds and greens are not merged into black. */
function makeDiff() {
  const cache = new Map();
  const lab = key => {
    let v = cache.get(key);
    if (!v) cache.set(key, (v = oklab(key)));
    return v;
  };
  return (a, b) => {
    const x = lab(a), y = lab(b);
    const dl = x[0] - y[0], da = 2 * (x[1] - y[1]), db = 2 * (x[2] - y[2]);
    return Math.sqrt(dl * dl + da * da + db * db);
  };
}

// ---------- planes and filters ----------

/** Mirror an index into [0, n) without repeating the edge sample (… 2 1 | 0 1 2 … n-1 | n-2 …). */
function mirror(i, n) {
  if (n === 1) return 0;
  const period = 2 * (n - 1);
  const k = ((i % period) + period) % period;
  return k < n ? k : period - k;
}
/** Separable box blur repeated `passes` times (three passes approximate a Gaussian), mirrored edges. */
function boxBlur(src, w, h, r, passes = 3) {
  const out = Float64Array.from(src);
  if (r <= 0) return out;
  const tmp = new Float64Array(src.length);
  const span = 2 * r + 1, inv = 1 / span;
  // line[i] holds sample i - r of the current row or column, mirrored at both ends
  const line = new Float64Array(Math.max(w, h) + 2 * r);
  const mx = Int32Array.from({ length: w + 2 * r }, (_, i) => mirror(i - r, w));
  const my = Int32Array.from({ length: h + 2 * r }, (_, i) => mirror(i - r, h));
  const run = (n, write) => {
    let sum = 0;
    for (let i = 0; i < span; i++) sum += line[i];
    for (let k = 0; k < n; k++) {
      write(k, sum * inv);
      if (k + 1 < n) sum += line[k + span] - line[k];
    }
  };
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let i = 0; i < w + 2 * r; i++) line[i] = out[row + mx[i]];
      run(w, (x, v) => { tmp[row + x] = v; });
    }
    for (let x = 0; x < w; x++) {
      for (let i = 0; i < h + 2 * r; i++) line[i] = tmp[my[i] * w + x];
      run(h, (y, v) => { out[y * w + x] = v; });
    }
  }
  return out;
}
function toPlanes({ width: w, height: h, data }) {
  const n = w * h;
  const planes = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    planes[0][i] = data[i * 4] / 255;
    planes[1][i] = data[i * 4 + 1] / 255;
    planes[2][i] = data[i * 4 + 2] / 255;
    alpha[i] = data[i * 4 + 3];
  }
  return { planes, alpha };
}
function fromPlanes(w, h, planes, alpha) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(planes[c][i] * 255)));
    data[i * 4 + 3] = alpha[i];
  }
  return { width: w, height: h, data };
}
/** Fully transparent pixels may hold any RGB; give them nearby visible colours so smoothing never drags that in. */
function fillTransparent(planes, alpha, w, h) {
  const n = w * h;
  const empty = [];
  for (let i = 0; i < n; i++) if (alpha[i] === 0) empty.push(i);
  if (!empty.length || empty.length === n) return;
  const weight = Float64Array.from(alpha, a => a / 255);
  let left = empty;
  for (const r of [2, 8, 32, 128, Math.max(w, h)]) {
    const total = boxBlur(weight, w, h, r, 1);
    const sums = planes.map(p => boxBlur(p.map((v, i) => v * weight[i]), w, h, r, 1));
    const still = [];
    for (const i of left) {
      if (total[i] > 1e-9) for (let c = 0; c < 3; c++) planes[c][i] = sums[c][i] / total[i];
      else still.push(i);
    }
    left = still;
    if (!left.length) break;
  }
}
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ---------- FFT (mixed radix 2/3/4/5, Stockham autosort) ----------

const S3 = Math.sqrt(3) / 2;
const C51 = Math.cos((2 * Math.PI) / 5), C52 = Math.cos((4 * Math.PI) / 5);
const S51 = Math.sin((2 * Math.PI) / 5), S52 = Math.sin((4 * Math.PI) / 5);

/** Smallest n' >= n whose only prime factors are 2, 3 and 5. */
function smoothSize(n) {
  for (let m = n; ; m++) {
    let k = m;
    for (const f of [2, 3, 5]) while (k % f === 0) k /= f;
    if (k === 1) return m;
  }
}
function fftPlan(n) {
  const radices = [];
  let rest = n;
  for (const r of [4, 2, 3, 5]) while (rest % r === 0) { radices.push(r); rest /= r; }
  if (rest !== 1) throw new Error(`FFT size ${n} must only have the factors 2, 3 and 5`);
  const stages = [];
  let current = n;
  for (const r of radices) {
    const m = current / r;
    const twr = new Float64Array(m * r), twi = new Float64Array(m * r);
    for (let p = 0; p < m; p++) for (let k = 0; k < r; k++) {
      const t = (-2 * Math.PI * p * k) / current;
      twr[p * r + k] = Math.cos(t);
      twi[p * r + k] = Math.sin(t);
    }
    stages.push({ r, m, twr, twi });
    current = m;
  }
  return { n, stages };
}
function radix2(ar, ai, br, bi, m, s, twr, twi) {
  for (let p = 0; p < m; p++) {
    const wr = twr[2 * p + 1], wi = twi[2 * p + 1];
    const i0 = s * p, i1 = s * (p + m), o0 = 2 * s * p, o1 = o0 + s;
    for (let q = 0; q < s; q++) {
      const x0r = ar[i0 + q], x0i = ai[i0 + q], x1r = ar[i1 + q], x1i = ai[i1 + q];
      br[o0 + q] = x0r + x1r; bi[o0 + q] = x0i + x1i;
      const dr = x0r - x1r, di = x0i - x1i;
      br[o1 + q] = dr * wr - di * wi; bi[o1 + q] = dr * wi + di * wr;
    }
  }
}
function radix3(ar, ai, br, bi, m, s, twr, twi) {
  for (let p = 0; p < m; p++) {
    const w1r = twr[3 * p + 1], w1i = twi[3 * p + 1], w2r = twr[3 * p + 2], w2i = twi[3 * p + 2];
    const i0 = s * p, i1 = s * (p + m), i2 = s * (p + 2 * m), o0 = 3 * s * p, o1 = o0 + s, o2 = o1 + s;
    for (let q = 0; q < s; q++) {
      const a0r = ar[i0 + q], a0i = ai[i0 + q], a1r = ar[i1 + q], a1i = ai[i1 + q], a2r = ar[i2 + q], a2i = ai[i2 + q];
      const t1r = a1r + a2r, t1i = a1i + a2i;
      const t2r = a0r - 0.5 * t1r, t2i = a0i - 0.5 * t1i;
      const t3r = S3 * (a1i - a2i), t3i = -S3 * (a1r - a2r);
      br[o0 + q] = a0r + t1r; bi[o0 + q] = a0i + t1i;
      let yr = t2r + t3r, yi = t2i + t3i;
      br[o1 + q] = yr * w1r - yi * w1i; bi[o1 + q] = yr * w1i + yi * w1r;
      yr = t2r - t3r; yi = t2i - t3i;
      br[o2 + q] = yr * w2r - yi * w2i; bi[o2 + q] = yr * w2i + yi * w2r;
    }
  }
}
function radix4(ar, ai, br, bi, m, s, twr, twi) {
  for (let p = 0; p < m; p++) {
    const w1r = twr[4 * p + 1], w1i = twi[4 * p + 1], w2r = twr[4 * p + 2], w2i = twi[4 * p + 2];
    const w3r = twr[4 * p + 3], w3i = twi[4 * p + 3];
    const i0 = s * p, i1 = s * (p + m), i2 = s * (p + 2 * m), i3 = s * (p + 3 * m);
    const o0 = 4 * s * p, o1 = o0 + s, o2 = o1 + s, o3 = o2 + s;
    for (let q = 0; q < s; q++) {
      const a0r = ar[i0 + q], a0i = ai[i0 + q], a1r = ar[i1 + q], a1i = ai[i1 + q];
      const a2r = ar[i2 + q], a2i = ai[i2 + q], a3r = ar[i3 + q], a3i = ai[i3 + q];
      const pr = a0r + a2r, pi = a0i + a2i, mr = a0r - a2r, mi = a0i - a2i;
      const qr = a1r + a3r, qi = a1i + a3i, nr = a1r - a3r, ni = a1i - a3i;
      br[o0 + q] = pr + qr; bi[o0 + q] = pi + qi;
      let yr = mr + ni, yi = mi - nr;
      br[o1 + q] = yr * w1r - yi * w1i; bi[o1 + q] = yr * w1i + yi * w1r;
      yr = pr - qr; yi = pi - qi;
      br[o2 + q] = yr * w2r - yi * w2i; bi[o2 + q] = yr * w2i + yi * w2r;
      yr = mr - ni; yi = mi + nr;
      br[o3 + q] = yr * w3r - yi * w3i; bi[o3 + q] = yr * w3i + yi * w3r;
    }
  }
}
function radix5(ar, ai, br, bi, m, s, twr, twi) {
  for (let p = 0; p < m; p++) {
    const b = 5 * p;
    const w1r = twr[b + 1], w1i = twi[b + 1], w2r = twr[b + 2], w2i = twi[b + 2];
    const w3r = twr[b + 3], w3i = twi[b + 3], w4r = twr[b + 4], w4i = twi[b + 4];
    const i0 = s * p, i1 = s * (p + m), i2 = s * (p + 2 * m), i3 = s * (p + 3 * m), i4 = s * (p + 4 * m);
    const o0 = 5 * s * p, o1 = o0 + s, o2 = o1 + s, o3 = o2 + s, o4 = o3 + s;
    for (let q = 0; q < s; q++) {
      const a0r = ar[i0 + q], a0i = ai[i0 + q];
      const a1r = ar[i1 + q], a1i = ai[i1 + q], a2r = ar[i2 + q], a2i = ai[i2 + q];
      const a3r = ar[i3 + q], a3i = ai[i3 + q], a4r = ar[i4 + q], a4i = ai[i4 + q];
      const t1r = a1r + a4r, t1i = a1i + a4i, t2r = a2r + a3r, t2i = a2i + a3i;
      const t3r = a1r - a4r, t3i = a1i - a4i, t4r = a2r - a3r, t4i = a2i - a3i;
      br[o0 + q] = a0r + t1r + t2r; bi[o0 + q] = a0i + t1i + t2i;
      const c1r = a0r + C51 * t1r + C52 * t2r, c1i = a0i + C51 * t1i + C52 * t2i;
      const c2r = a0r + C52 * t1r + C51 * t2r, c2i = a0i + C52 * t1i + C51 * t2i;
      const d1r = S51 * t3r + S52 * t4r, d1i = S51 * t3i + S52 * t4i;
      const d2r = S52 * t3r - S51 * t4r, d2i = S52 * t3i - S51 * t4i;
      let yr = c1r + d1i, yi = c1i - d1r;
      br[o1 + q] = yr * w1r - yi * w1i; bi[o1 + q] = yr * w1i + yi * w1r;
      yr = c2r + d2i; yi = c2i - d2r;
      br[o2 + q] = yr * w2r - yi * w2i; bi[o2 + q] = yr * w2i + yi * w2r;
      yr = c2r - d2i; yi = c2i + d2r;
      br[o3 + q] = yr * w3r - yi * w3i; bi[o3 + q] = yr * w3i + yi * w3r;
      yr = c1r - d1i; yi = c1i + d1r;
      br[o4 + q] = yr * w4r - yi * w4i; bi[o4 + q] = yr * w4i + yi * w4r;
    }
  }
}
const KERNELS = { 2: radix2, 3: radix3, 4: radix4, 5: radix5 };
/** Forward DFT of `s0` interleaved sequences (x[q + s0 * j]); y is scratch. Returns the pair holding the result. */
function stockham(plan, xr, xi, yr, yi, s0) {
  let ar = xr, ai = xi, br = yr, bi = yi, s = s0;
  for (const { r, m, twr, twi } of plan.stages) {
    KERNELS[r](ar, ai, br, bi, m, s, twr, twi);
    [ar, br] = [br, ar];
    [ai, bi] = [bi, ai];
    s *= r;
  }
  return [ar, ai];
}
/** In-place 2-D DFT of a W x H complex array (row-major); `inverse` includes the 1/(W*H) scale. */
function fft2(re, im, W, H, plans, scratch, inverse = false) {
  if (inverse) for (let i = 0; i < im.length; i++) im[i] = -im[i];
  for (let y = 0; y < H; y++) {
    const xr = re.subarray(y * W, (y + 1) * W), xi = im.subarray(y * W, (y + 1) * W);
    const [rr, ri] = stockham(plans.row, xr, xi, scratch.rowRe, scratch.rowIm, 1);
    if (rr !== xr) { xr.set(rr); xi.set(ri); }
  }
  const [rr, ri] = stockham(plans.col, re, im, scratch.re, scratch.im, W);
  if (rr !== re) { re.set(rr); im.set(ri); }
  if (inverse) {
    const k = 1 / (W * H);
    for (let i = 0; i < re.length; i++) { re[i] *= k; im[i] = -im[i] * k; }
  }
}

// ---------- L0 gradient minimisation (Xu et al. 2011) ----------

/**
 * Edge-keeping flattening of three [0,1] planes. Mirrored padding to an FFT-friendly size; the three channels
 * travel as two complex arrays (R + iG, B), which is exact because every per-frequency step uses real factors.
 */
function l0Smooth(planes, w, h, lambda, kappa = 2, betaMax = 1e5) {
  const pad = 8;
  const W = smoothSize(w + 2 * pad), H = smoothSize(h + 2 * pad), N = W * H;
  const S = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  for (let Y = 0; Y < H; Y++) {
    const src = mirror(Y - pad, h) * w;
    for (let X = 0; X < W; X++) {
      const j = src + mirror(X - pad, w);
      for (let c = 0; c < 3; c++) S[c][Y * W + X] = planes[c][j];
    }
  }
  const plans = { row: fftPlan(W), col: fftPlan(H) };
  const scratch = { rowRe: new Float64Array(W), rowIm: new Float64Array(W), re: new Float64Array(N), im: new Float64Array(N) };
  const n1r = Float64Array.from(S[0]), n1i = Float64Array.from(S[1]);
  const n2r = Float64Array.from(S[2]), n2i = new Float64Array(N);
  fft2(n1r, n1i, W, H, plans, scratch);
  fft2(n2r, n2i, W, H, plans, scratch);
  const otf = new Float64Array(N);
  for (let Y = 0; Y < H; Y++) {
    const cy = 2 - 2 * Math.cos((2 * Math.PI * Y) / H);
    for (let X = 0; X < W; X++) otf[Y * W + X] = cy + 2 - 2 * Math.cos((2 * Math.PI * X) / W);
  }
  const flat = new Uint8Array(N);
  const ar = new Float64Array(N), ai = new Float64Array(N), cr = new Float64Array(N), ci = new Float64Array(N);
  const [s0, s1, s2] = S;
  for (let beta = 2 * lambda; beta < betaMax; beta *= kappa) {
    const threshold = lambda / beta;
    for (let Y = 0; Y < H; Y++) {
      const row = Y * W, below = ((Y + 1) % H) * W;
      for (let X = 0; X < W; X++) {
        const i = row + X, right = row + (X + 1 === W ? 0 : X + 1), down = below + X;
        const hr = s0[right] - s0[i], hg = s1[right] - s1[i], hb = s2[right] - s2[i];
        const vr = s0[down] - s0[i], vg = s1[down] - s1[i], vb = s2[down] - s2[i];
        flat[i] = hr * hr + hg * hg + hb * hb + vr * vr + vg * vg + vb * vb < threshold ? 1 : 0;
      }
    }
    // divergence of the kept gradients, h[x-1] - h[x] + v[y-1] - v[y], where h[j] = S[right of j] - S[j] unless
    // j was flattened (so h[left of i] = S[i] - S[left]); the same for v vertically
    for (let Y = 0; Y < H; Y++) {
      const row = Y * W, above = ((Y + H - 1) % H) * W, below = ((Y + 1) % H) * W;
      for (let X = 0; X < W; X++) {
        const i = row + X, left = row + (X === 0 ? W - 1 : X - 1), up = above + X;
        const right = row + (X + 1 === W ? 0 : X + 1), down = below + X;
        let d0 = 0, d1 = 0, d2 = 0;
        if (!flat[left]) { d0 += s0[i] - s0[left]; d1 += s1[i] - s1[left]; d2 += s2[i] - s2[left]; }
        if (!flat[up]) { d0 += s0[i] - s0[up]; d1 += s1[i] - s1[up]; d2 += s2[i] - s2[up]; }
        if (!flat[i]) {
          d0 -= s0[right] - s0[i] + s0[down] - s0[i];
          d1 -= s1[right] - s1[i] + s1[down] - s1[i];
          d2 -= s2[right] - s2[i] + s2[down] - s2[i];
        }
        ar[i] = d0; ai[i] = d1; cr[i] = d2; ci[i] = 0;
      }
    }
    fft2(ar, ai, W, H, plans, scratch);
    fft2(cr, ci, W, H, plans, scratch);
    for (let i = 0; i < N; i++) {
      const d = 1 / (1 + beta * otf[i]);
      ar[i] = (n1r[i] + beta * ar[i]) * d; ai[i] = (n1i[i] + beta * ai[i]) * d;
      cr[i] = (n2r[i] + beta * cr[i]) * d; ci[i] = (n2i[i] + beta * ci[i]) * d;
    }
    fft2(ar, ai, W, H, plans, scratch, true);
    fft2(cr, ci, W, H, plans, scratch, true);
    s0.set(ar); s1.set(ai); s2.set(cr);
  }
  return S.map(plane => {
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.min(1, Math.max(0, plane[(y + pad) * W + x + pad]));
    return out;
  });
}

// ---------- cel / illustration cleanup ----------

export const CEL_PRESETS = Object.freeze({
  // scenes, painterly or semi-realistic art: only the finest ripples go; wood grain, brushwork and rain mostly stay
  light: { lambda: 0.002, fine: [0.02, 0.05], mid: null, sharpen: 0 },
  // cel / anime illustration: fine ripples and the few-pixel blotches go, soft line ramps are tightened
  normal: { lambda: 0.002, fine: [0.02, 0.05], mid: [0.012, 0.035], sharpen: 1 },
  strong: { lambda: 0.003, fine: [0.025, 0.06], mid: [0.015, 0.045], sharpen: 1 },
});

function cubicWeights(t) {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}
/** 2x Catmull-Rom upsampling of one plane (pixel centres aligned), clamped to the two nearest source samples so it never rings. */
function upsample2(src, w, h) {
  const even = cubicWeights(0.75), odd = cubicWeights(0.25);
  const clampX = i => (i < 0 ? 0 : i >= w ? w - 1 : i), clampY = i => (i < 0 ? 0 : i >= h ? h - 1 : i);
  const within = (v, a, b) => (a < b ? (v < a ? a : v > b ? b : v) : v < b ? b : v > a ? a : v);
  const tmp = new Float32Array(2 * w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const row = y * w;
    let e = 0, o = 0;
    for (let k = 0; k < 4; k++) {
      e += even[k] * src[row + clampX(x - 2 + k)];
      o += odd[k] * src[row + clampX(x - 1 + k)];
    }
    tmp[y * 2 * w + 2 * x] = within(e, src[row + clampX(x - 1)], src[row + x]);
    tmp[y * 2 * w + 2 * x + 1] = within(o, src[row + x], src[row + clampX(x + 1)]);
  }
  const W2 = 2 * w, out = new Float32Array(W2 * 2 * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < W2; x++) {
    let e = 0, o = 0;
    for (let k = 0; k < 4; k++) {
      e += even[k] * tmp[clampY(y - 2 + k) * W2 + x];
      o += odd[k] * tmp[clampY(y - 1 + k) * W2 + x];
    }
    out[2 * y * W2 + x] = within(e, tmp[clampY(y - 1) * W2 + x], tmp[y * W2 + x]);
    out[(2 * y + 1) * W2 + x] = within(o, tmp[y * W2 + x], tmp[clampY(y + 1) * W2 + x]);
  }
  return out;
}
/**
 * Toggle (Kramer–Bruckner) filter at 2x supersampling: on high-contrast neighbourhoods each sample takes the colour
 * of the darkest or brightest candidate, whichever it is closer to, then 2x2 box back down. Candidates are the 3x3
 * supersampled neighbours plus the source pixels under them, so one-pixel lines and highlights snap back to their
 * real colour instead of a diluted one. The window spans at most two source pixels per axis, so narrow shadow bands
 * between a line and a fill survive. Flat areas and gentle gradients are untouched.
 */
function toggleSharpen(planes, w, h, passes, contrast = 0.1, blend = 0.7) {
  const W2 = 2 * w, H2 = 2 * h, n2 = W2 * H2;
  let up = planes.map(p => upsample2(p, w, h));
  const L = new Float32Array(n2), L1 = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) L1[i] = luma(planes[0][i], planes[1][i], planes[2][i]);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n2; i++) L[i] = luma(up[0][i], up[1][i], up[2][i]);
    const next = up.map(p => Float32Array.from(p));
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
      const i = y * W2 + x;
      // candidate: index >= 0 is a supersampled sample, index < 0 is source pixel (-index - 1)
      let lo = L[i], hi = L[i], cLo = i, cHi = i;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H2) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W2) continue;
          const j = yy * W2 + xx, s = (yy >> 1) * w + (xx >> 1);
          if (L[j] < lo) { lo = L[j]; cLo = j; }
          if (L[j] > hi) { hi = L[j]; cHi = j; }
          if (L1[s] < lo) { lo = L1[s]; cLo = -s - 1; }
          if (L1[s] > hi) { hi = L1[s]; cHi = -s - 1; }
        }
      }
      if (hi - lo <= contrast) continue;
      const pick = L[i] - lo < hi - L[i] ? cLo : cHi;
      for (let c = 0; c < 3; c++) next[c][i] = pick >= 0 ? up[c][pick] : planes[c][-pick - 1];
    }
    up = next;
  }
  return planes.map((plane, c) => {
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = 2 * y * W2 + 2 * x, b = a + W2;
      const down = (up[c][a] + up[c][a + 1] + up[c][b] + up[c][b + 1]) / 4;
      out[y * w + x] = blend * down + (1 - blend) * plane[y * w + x];
    }
    return out;
  });
}
function localRms(bands, w, h, r) {
  const n = w * h, energy = new Float64Array(n);
  for (let i = 0; i < n; i++) energy[i] = Math.max(bands[0][i] ** 2, bands[1][i] ** 2, bands[2][i] ** 2);
  const blurred = boxBlur(energy, w, h, r, 1);
  for (let i = 0; i < n; i++) blurred[i] = Math.sqrt(blurred[i]);
  return blurred;
}

/**
 * Remove generator micro texture from an illustration. The image is split into an L0 base and a residual; the
 * residual's smooth part (gradients, blush, glow) is kept, its few-pixel and finest parts are dropped where their
 * local strength is low (ripples, blotches) and kept where it is high (lines, highlights, eyes). Alpha is untouched.
 */
export function cleanCel(image, options = {}) {
  const strength = options.strength ?? "normal";
  if (!Object.hasOwn(CEL_PRESETS, strength)) throw new Error(`未知强度 ${strength}`);
  const preset = { ...CEL_PRESETS[strength] };
  if (options.sharpen !== undefined) preset.sharpen = options.sharpen;
  const { width: w, height: h } = image;
  const { planes, alpha } = toPlanes(image);
  fillTransparent(planes, alpha, w, h);
  const base = l0Smooth(planes, w, h, preset.lambda);
  const n = w * h;
  const residual = planes.map((p, c) => p.map((v, i) => v - base[c][i]));
  const b1 = residual.map(r => boxBlur(r, w, h, 3));
  const fine = residual.map((r, c) => r.map((v, i) => v - b1[c][i]));
  const keepFine = localRms(fine, w, h, 1);
  let mid = null, keepMid = null;
  if (preset.mid) {
    const b2 = residual.map(r => boxBlur(r, w, h, 9));
    mid = b1.map((b, c) => b.map((v, i) => v - b2[c][i]));
    keepMid = localRms(mid, w, h, 3);
  }
  let out = planes.map((p, c) => {
    const o = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = p[i] - (1 - smoothstep(preset.fine[0], preset.fine[1], keepFine[i])) * fine[c][i];
      if (mid) v -= (1 - smoothstep(preset.mid[0], preset.mid[1], keepMid[i])) * mid[c][i];
      o[i] = Math.min(1, Math.max(0, v));
    }
    return o;
  });
  if (preset.sharpen > 0) out = toggleSharpen(out, w, h, preset.sharpen);
  return fromPlanes(w, h, out, alpha);
}

// ---------- pixel art ----------

const TRANSPARENT = -1;
/** Largest block size s <= 16 such that the image is an exact s-times nearest-neighbour enlargement, else 1. */
export function exactBlock({ width: w, height: h, data }) {
  const keys = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) keys[i] = data[i * 4 + 3] ? (data[i * 4] << 24 | data[i * 4 + 1] << 16 | data[i * 4 + 2] << 8 | data[i * 4 + 3]) >>> 0 : 0;
  for (let s = Math.min(16, w, h); s > 1; s--) {
    if (w % s || h % s) continue;
    let ok = true;
    for (let y = 0; y < h && ok; y++) {
      const top = (y - (y % s)) * w;
      for (let x = 0; x < w; x++) if (keys[y * w + x] !== keys[top + x - (x % s)]) { ok = false; break; }
    }
    if (ok) return s;
  }
  return 1;
}
// Fundamental period of an edge-pulse profile: the strongest Fourier magnitude over candidate periods. Anti-aliased
// transitions and uneven 6/7 scaling weaken harmonics, while exact integer blocks >= 7 tie with their harmonics s/2,
// s/3… and fine half-cell details can even give s/2 slightly higher lift. Sweeping from largest to smallest keeps the
// fundamental on ties, and promoting an integer multiple that retains >= 80% lift separates true sub-harmonics from
// genuine small grids (whose 2s lift cancels toward 0). The boundary between pixel i and i+1 sits at i+1.
function evalPeriod(at, weight, total, s) {
  const k = (2 * Math.PI) / s;
  let re = 0, im = 0;
  for (let j = 0; j < at.length; j++) { re += weight[j] * Math.cos(k * at[j]); im += weight[j] * Math.sin(k * at[j]); }
  const lift = Math.sqrt(re * re + im * im) / total;
  let phase = (Math.atan2(im, re) / k) % s;
  if (phase < 0) phase += s;
  if (phase < 1e-9 || phase > s - 1e-9) phase = 0;
  return { s, phase, lift };
}
function bestPeriod(profile, smin, smax) {
  const at = [], weight = [];
  let total = 0;
  profile.forEach((e, i) => { if (e) { at.push(i + 1); weight.push(e); total += e; } });
  let best = { s: smin, phase: 0, lift: 0 };
  if (!total) return best;
  const steps = Math.max(0, Math.round((smax - smin) * 100));
  for (let step = steps; step >= 0; step--) {
    const cand = evalPeriod(at, weight, total, smin + step * 0.01);
    if (cand.lift > best.lift + 1e-6) best = cand;
  }
  for (let m = Math.floor(smax / best.s); m >= 2; m--) {
    const lo = Math.max(smin, best.s * m * 0.99), hi = Math.min(smax, best.s * m * 1.01);
    let top = { s: best.s * m, phase: 0, lift: 0 };
    for (let s = lo; s <= hi + 1e-9; s += 0.01) {
      const cand = evalPeriod(at, weight, total, s);
      if (cand.lift > top.lift) top = cand;
    }
    if (top.lift >= best.lift * 0.8) { best = top; break; }
  }
  return best;
}
/**
 * Detect the pixel size and phase of generator "pseudo pixel art" from where colours change; `hint` limits the search
 * to ±7% around a known size. Confidence (`lift`) is only comparable within one kind of picture: measured pseudo-pixel
 * sprites scored about 0.1–0.4, smooth illustrations under 0.06, but a scene with regular planks also reached 0.13.
 */
export function detectGrid({ width: w, height: h, data }, hint) {
  const ex = new Float64Array(w), ey = new Float64Array(h);
  const edge = (i, j) => {
    const a = data[i * 4 + 3] >= 128, b = data[j * 4 + 3] >= 128;
    if (!a && !b) return false;
    if (a !== b) return true;
    const dr = data[i * 4] - data[j * 4], dg = data[i * 4 + 1] - data[j * 4 + 1], db = data[i * 4 + 2] - data[j * 4 + 2];
    return dr * dr + dg * dg + db * db > 28 * 28;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x + 1 < w && edge(i, i + 1)) ex[x]++;
    if (y + 1 < h && edge(i, i + w)) ey[y]++;
  }
  const smin = hint ? hint * 0.93 : 3.5, smax = hint ? hint * 1.07 : 16;
  const gx = bestPeriod(ex, smin, smax), gy = bestPeriod(ey, smin, smax);
  const s = gx.lift >= gy.lift ? gx.s : gy.s; // pixels are square: trust the clearer axis, then phase each axis
  return { s, phx: bestPeriod(ex, s, s).phase, phy: bestPeriod(ey, s, s).phase, lift: Math.max(gx.lift, gy.lift) };
}
/**
 * Colour of one cell (left/top edge x, y, side s): the medoid of the pixels whose centres lie in the cell's central
 * half. A real pixel is chosen, never a per-channel mix, so a sample that straddles two drawn cells cannot invent a
 * colour that exists nowhere. Mostly transparent cells stay transparent.
 */
function sampleCell({ width: w, height: h, data }, x, y, s) {
  const span = (lo, hi, n) => {
    let a = Math.ceil(lo - 0.5), b = Math.floor(hi - 0.5);
    if (b < a) a = b = Math.floor((lo + hi) / 2); // cell too small: take the pixel under its centre
    return [Math.max(0, a), Math.min(n - 1, b)];
  };
  const [x0, x1] = span(x + s * 0.25, x + s * 0.75, w), [y0, y1] = span(y + s * 0.25, y + s * 0.75, h);
  if (x1 < x0 || y1 < y0) return TRANSPARENT;
  const keys = [];
  let count = 0;
  for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
    const i = (yy * w + xx) * 4;
    count++;
    if (data[i + 3] >= 128) keys.push((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  if (keys.length * 2 <= count) return TRANSPARENT;
  let best = keys[0], bestCost = Infinity;
  for (const a of keys) {
    let cost = 0;
    for (const b of keys) {
      const dr = (a >> 16) - (b >> 16), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
      cost += Math.sqrt(dr * dr + dg * dg + db * db);
    }
    if (cost < bestCost) { bestCost = cost; best = a; }
  }
  return best;
}
/** Whether two sampled cells differ beyond anti-aliasing noise (or one is transparent and the other is not). */
function cellsDiffer(a, b) {
  if (a === TRANSPARENT || b === TRANSPARENT) return a !== b;
  const dr = (a >> 16) - (b >> 16), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
  return dr * dr + dg * dg + db * db > 48 * 48;
}
/**
 * Sample the detected grid. Generators often draw faces, stubble and thin strands finer than the body's pixels;
 * one colour per coarse cell would wipe or blow them up and change the face. Each cell is therefore also sampled
 * as four half-size cells; a half cell counts as finer detail when it differs from its own cell and from the
 * neighbours it touches (matching a neighbour only means the grid sits a little off the drawn boundary). Cells with
 * such detail are kept at half size (unless `uniform`); plain cells keep their single colour as clean 2x2 blocks.
 */
function sampleGrid(image, { s, phx, phy }, uniform = false) {
  const { width: w, height: h } = image;
  // Include only cells whose centres lie inside [0, w) x [0, h), avoiding phantom transparent border rows/columns.
  const startX = phx >= s * 0.5 ? phx - s : phx;
  const startY = phy >= s * 0.5 ? phy - s : phy;
  const cols = Math.max(1, Math.ceil((w - startX - s * 0.5) / s));
  const rows = Math.max(1, Math.ceil((h - startY - s * 0.5) / s));
  const half = s / 2, cols2 = cols * 2, rows2 = rows * 2;
  const cells = new Int32Array(cols * rows), cells2 = new Int32Array(cols2 * rows2);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells[r * cols + c] = sampleCell(image, startX + c * s, startY + r * s, s);
  const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? TRANSPARENT : cells[r * cols + c]);
  let solid = 0, fine = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const key = cells[r * cols + c];
    const quarters = [0, 1, 2, 3].map(q => {
      const qx = startX + c * s + (q & 1) * half, qy = startY + r * s + (q >> 1) * half;
      if (qx + half * 0.5 < 0 || qx + half * 0.5 >= w || qy + half * 0.5 < 0 || qy + half * 0.5 >= h) return key;
      return sampleCell(image, qx, qy, half);
    });
    const finer = quarters.some((q, k) => {
      const dx = k & 1 ? 1 : -1, dy = k >> 1 ? 1 : -1;
      return cellsDiffer(q, key) && cellsDiffer(q, at(c + dx, r)) && cellsDiffer(q, at(c, r + dy)) && cellsDiffer(q, at(c + dx, r + dy));
    });
    if (key !== TRANSPARENT) { solid++; if (finer) fine++; }
    quarters.forEach((q, k) => { cells2[(2 * r + (k >> 1)) * cols2 + 2 * c + (k & 1)] = finer ? q : key; });
  }
  const finerShare = solid ? fine / solid : 0;
  if (uniform || finerShare < 0.01) return { cols, rows, cells, startX, startY, finerShare, refined: false };
  return { cols: cols2, rows: rows2, cells: cells2, startX, startY, finerShare, refined: true };
}
function blockGrid({ width: w, height: h, data }, s = 1) {
  const cols = w / s, rows = h / s, cells = new Int32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = (r * s * w + c * s) * 4;
    cells[r * cols + c] = data[i + 3] >= 128 ? (data[i] << 16) | (data[i + 1] << 8) | data[i + 2] : TRANSPARENT;
  }
  return { cols, rows, cells };
}
/** Drop opaque islands of one or two cells (8-connected) floating outside the silhouette. */
function dropSpecks({ cols, rows, cells }) {
  const seen = new Uint8Array(cells.length);
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || cells[start] === TRANSPARENT) continue;
    const group = [start];
    seen[start] = 1;
    for (let k = 0; k < group.length && group.length <= 2; k++) {
      const x = group[k] % cols, y = (group[k] / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const j = yy * cols + xx;
        if (!seen[j] && cells[j] !== TRANSPARENT) { seen[j] = 1; group.push(j); }
      }
    }
    if (group.length <= 2) for (const j of group) cells[j] = TRANSPARENT;
  }
}
/** Map near-identical colours (shared across every frame) onto the most frequent one. */
function mergePalette(grids, diff, threshold, maxColors = Infinity) {
  const counts = new Map();
  for (const { cells } of grids) for (const key of cells) if (key !== TRANSPARENT) counts.set(key, (counts.get(key) ?? 0) + 1);
  const byCount = [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  for (let t = threshold; ; t += 0.01) {
    const centres = [], rep = new Map();
    for (const key of byCount) {
      let best = -1, bestDiff = t;
      for (const centre of centres) {
        const d = diff(key, centre);
        if (d < bestDiff) { bestDiff = d; best = centre; }
      }
      if (best < 0) { centres.push(key); best = key; }
      rep.set(key, best);
    }
    if (centres.length <= maxColors) {
      for (const grid of grids) grid.cells = grid.cells.map(key => (key === TRANSPARENT ? key : rep.get(key)));
      return centres.length;
    }
  }
}
/** Absorb low-contrast stray cells into the surrounding majority; high-contrast single cells (eyes, sparks) stay. */
function absorbStrays({ cols, rows, cells }, diff, { alone, many }) {
  for (let pass = 0; pass < 4; pass++) {
    const next = Int32Array.from(cells);
    let changed = 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const key = cells[y * cols + x];
      if (key === TRANSPARENT) continue;
      const tally = new Map();
      let isolated = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
        const other = cells[yy * cols + xx];
        if (other === TRANSPARENT) continue;
        if (other === key) isolated = false;
        else tally.set(other, (tally.get(other) ?? 0) + 1);
      }
      let best = TRANSPARENT, n = 0;
      for (const [other, count] of tally) if (count > n || (count === n && diff(key, other) < diff(key, best))) { best = other; n = count; }
      if (best === TRANSPARENT) continue;
      const d = diff(key, best);
      if ((isolated && n >= alone[0] && d < alone[1]) || (n >= many[0] && d < many[1])) { next[y * cols + x] = best; changed++; }
    }
    cells.set(next);
    if (!changed) break;
  }
}
/**
 * Clean pixel art on its native grid. Frames passed together share one palette so animation does not flicker.
 * Exact nearest-neighbour enlargements are always reduced to their blocks; other images are treated as native
 * unless `grid` says they are generator pseudo-pixels ("auto", or an approximate pixel size). Detection is opt-in
 * because regular tiles or planks can look like a grid. Returns one image per input: same size for block input,
 * native size times `scale` for detected grids.
 */
export function cleanPixels(images, options = {}) {
  const diff = makeDiff();
  const jobs = images.map(image => {
    const block = exactBlock(image);
    let grid, warning = null;
    const explicitHint = typeof options.grid === "number";
    if (!options.grid || (block > 1 && (!explicitHint || block === options.grid))) grid = blockGrid(image, block);
    else {
      const detected = detectGrid(image, options.grid === "auto" ? undefined : options.grid);
      if (detected.lift >= 0.08) {
        grid = { ...sampleGrid(image, detected, options.uniform), detected };
        if (options.uniform && grid.finerShare >= 0.01) {
          warning = `${(grid.finerShare * 100).toFixed(1)}% 的格子里画了比格子更细的细节（多半是五官、细线），统一格宽会把它们抹掉或放大，结果不能直接交付：去掉 --uniform 重跑，或先用项目的生图管线按这个格宽重画这些部位`;
        }
      }
      else {
        grid = blockGrid(image);
        warning = `没有检测到像素网格（置信 ${detected.lift.toFixed(2)}），按原生网格处理；知道大致格宽时用 --grid <像素数>`;
      }
    }
    return { image, block, grid, warning };
  });
  for (const { grid } of jobs) dropSpecks(grid);
  const grids = jobs.map(job => job.grid);
  mergePalette(grids, diff, 0.035);
  for (const grid of grids) absorbStrays(grid, diff, { alone: [3, 0.14], many: [5, 0.1] });
  let colours = mergePalette(grids, diff, 0);
  if (options.colors) {
    mergePalette(grids, diff, 0.03, options.colors);
    for (const grid of grids) absorbStrays(grid, diff, { alone: [2, 0.3], many: [5, 0.2] });
    colours = mergePalette(grids, diff, 0);
  }
  return jobs.map(({ image, block, grid, warning }) => {
    const scale = grid.detected ? options.scale ?? 1 : block * (options.scale ?? 1);
    const width = grid.cols * scale, height = grid.rows * scale;
    const data = new Uint8Array(width * height * 4);
    const keepAlpha = options.keepAlpha && !grid.detected && !options.scale;
    if (options.keepAlpha && !keepAlpha) {
      const note = "--keep-alpha 仅在保持原尺寸的原生网格上生效；使用 --grid 重采样或 --scale 缩放时透明度按两档输出";
      warning = warning ? `${warning}；${note}` : note;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const key = grid.cells[((y / scale) | 0) * grid.cols + ((x / scale) | 0)], o = (y * width + x) * 4;
      if (keepAlpha) {
        data.set(image.data.subarray(o, o + 4), o);
        if (key !== TRANSPARENT && image.data[o + 3]) { data[o] = key >> 16; data[o + 1] = (key >> 8) & 255; data[o + 2] = key & 255; }
      } else if (key !== TRANSPARENT) {
        data[o] = key >> 16; data[o + 1] = (key >> 8) & 255; data[o + 2] = key & 255; data[o + 3] = 255;
      }
    }
    // where each output pixel sits in the source: lets a review sheet line the two up exactly
    const d = grid.detected, cell = d ? d.s / (grid.refined ? 2 : 1) : block;
    const geometry = {
      originX: d ? grid.startX : 0,
      originY: d ? grid.startY : 0,
      cell: (cell * grid.cols) / width,
    };
    return {
      width, height, data,
      info: { block, detected: d ?? null, refined: grid.refined ?? false, finerShare: grid.finerShare ?? 0, cols: grid.cols, rows: grid.rows, colours, warning, geometry },
    };
  });
}

// ---------- measurement ----------

function lumaPlane({ width: w, height: h, data }) {
  const L = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  return L;
}
function gradient(L, w, h) {
  const g = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = (L[i + 1] - L[i - 1]) / 2, gy = (L[i + w] - L[i - w]) / 2;
    g[i] = Math.sqrt(gx * gx + gy * gy);
  }
  return g;
}
/** Mean deviation from a light blur over flat, opaque areas: the generator ripple left in colour fills (8-bit levels). */
function flatTexture(image) {
  const { width: w, height: h, data } = image;
  const L = lumaPlane(image);
  const g = gradient(boxBlur(L, w, h, 1, 2), w, h);
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (g[y * w + x] <= 12) continue;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
    }
  }
  const smooth = boxBlur(L, w, h, 1, 3);
  let sum = 0, n = 0;
  for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) {
    const i = y * w + x;
    if (near[i] || data[i * 4 + 3] < 255) continue;
    sum += Math.abs(L[i] - smooth[i]);
    n++;
  }
  return n ? { value: sum / n, share: n / (w * h) } : { value: null, share: 0 };
}
export function measureImage(image, bytes) {
  const { width: w, height: h, data } = image;
  const n = w * h;
  let visible = 0, partial = 0;
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    if (!a) continue;
    visible++;
    if (a < 255) partial++;
    const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let isolated = 0, solid = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (data[i * 4 + 3] < 128) continue;
    solid++;
    const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    let neighbours = 0, same = false;
    for (let dy = -1; dy <= 1 && !same; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (data[j * 4 + 3] < 128) continue;
      neighbours++;
      if (((data[j * 4] << 16) | (data[j * 4 + 1] << 8) | data[j * 4 + 2]) === key) { same = true; break; }
    }
    if (neighbours && !same) isolated++;
  }
  let nearDuplicates = null;
  if (counts.size <= 4096) {
    const diff = makeDiff(), ordered = [...counts].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    nearDuplicates = 0;
    for (let k = 1; k < ordered.length; k++) for (let j = 0; j < k; j++) if (diff(ordered[k], ordered[j]) < 0.02) { nearDuplicates++; break; }
  }
  const block = exactBlock(image);
  const grid = block > 1 ? { block } : (() => { const g = detectGrid(image); return { block: 1, period: g.s, lift: g.lift }; })();
  const metadataChunks = bytes ? inspectMetadata(bytes).chunks.filter(c => c.metadata).map(c => c.type) : [];
  return {
    width: w, height: h,
    partialAlphaShare: visible ? partial / visible : 0,
    colours: counts.size,
    nearDuplicateColours: nearDuplicates,
    isolatedShare: solid ? isolated / solid : 0,
    flatTexture: block === 1 && counts.size > 256 ? flatTexture(image) : { value: null, share: 0 },
    grid,
    metadataChunks,
  };
}
/** Before/after comparison of two same-size images: colour drift, line sharpness and how much changed. */
export function compareImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("两张图尺寸不同，无法逐像素对比");
  const { width: w, height: h } = a, n = w * h;
  let drift = 0, counted = 0, changed = 0;
  for (let c = 0; c < 3; c++) {
    const pa = boxBlur(Float64Array.from({ length: n }, (_, i) => a.data[i * 4 + c]), w, h, 8, 1);
    const pb = boxBlur(Float64Array.from({ length: n }, (_, i) => b.data[i * 4 + c]), w, h, 8, 1);
    for (let i = 0; i < n; i++) if (a.data[i * 4 + 3] === 255 && b.data[i * 4 + 3] === 255) { drift += Math.abs(pa[i] - pb[i]); counted++; }
  }
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 4; c++) if (Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]) > 2) { changed++; break; }
  }
  const ga = gradient(lumaPlane(a), w, h), gb = gradient(lumaPlane(b), w, h);
  const sorted = Float64Array.from(ga).sort();
  const cut = sorted[Math.floor(sorted.length * 0.97)];
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) if (ga[i] > cut) { sa += ga[i]; sb += gb[i]; }
  return { colourDrift: counted ? drift / counted : 0, lineSharpness: sa ? sb / sa : 1, changedShare: changed / n };
}

// ---------- review sheet ----------

// 5x7 bitmap glyphs (rows top to bottom, 5 bits each) for sheet labels; anything else prints as a space.
const GLYPHS = {
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14],
  4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 17, 31, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31], "#": [10, 10, 31, 10, 31, 10, 10], "=": [0, 0, 31, 0, 31, 0, 0],
  ",": [0, 0, 0, 0, 12, 4, 8], ":": [0, 12, 12, 0, 12, 12, 0], "-": [0, 0, 0, 31, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12],
};
function fillRect(img, x, y, w, h, [r, g, b]) {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
    const o = (yy * img.width + xx) * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
}
function drawText(img, text, x, y, colour = [235, 235, 235], scale = 2) {
  for (const ch of String(text).toUpperCase()) {
    const rows = GLYPHS[ch];
    if (rows) for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (rows[r] & (16 >> c)) fillRect(img, x + c * scale, y + r * scale, scale, scale, colour);
    x += 6 * scale;
  }
}
function strokeRect(img, x, y, w, h, colour) {
  fillRect(img, x, y, w, 1, colour); fillRect(img, x, y + h - 1, w, 1, colour);
  fillRect(img, x, y, 1, h, colour); fillRect(img, x + w - 1, y, 1, h, colour);
}
/** Composite onto mid grey for scalar RGB diffing. */
function flatten({ width, height, data }) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(data[i * 4 + c] * a + 128 * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return { width, height, data: out };
}
/** Composite onto a subtle 8px checkerboard so transparency, halos and dirty edges show on any subject colour. */
function compositeChecker({ width, height, data }) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, a = data[i + 3] / 255;
    const bg = ((x >> 3) ^ (y >> 3)) & 1 ? 140 : 116;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(data[i + c] * a + bg * (1 - a));
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}
function resizeNearest(img, W, H) {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / W));
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data: out };
}
/** Premultiplied area-average reduction for the overview panels, keeping alpha intact for checkerboard compositing. */
function shrinkRgba(img, W, H) {
  const rgb = new Float64Array(W * H * 3), alphaSum = new Float64Array(W * H), counts = new Float64Array(W * H);
  for (let y = 0; y < img.height; y++) {
    const ty = Math.min(H - 1, Math.floor((y * H) / img.height));
    for (let x = 0; x < img.width; x++) {
      const t = ty * W + Math.min(W - 1, Math.floor((x * W) / img.width)), i = (y * img.width + x) * 4;
      const a = img.data[i + 3] / 255;
      rgb[t * 3] += img.data[i] * a; rgb[t * 3 + 1] += img.data[i + 1] * a; rgb[t * 3 + 2] += img.data[i + 2] * a;
      alphaSum[t] += a; counts[t]++;
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let t = 0; t < W * H; t++) {
    const a = alphaSum[t];
    for (let c = 0; c < 3; c++) data[t * 4 + c] = a > 1e-9 ? Math.round(rgb[t * 3 + c] / a) : 0;
    data[t * 4 + 3] = Math.round((a / (counts[t] || 1)) * 255);
  }
  return { width: W, height: H, data };
}
function cropImage(img, x, y, w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy++) data.set(img.data.subarray(((y + yy) * img.width + x) * 4, ((y + yy) * img.width + x + w) * 4), yy * w * 4);
  return { width: w, height: h, data };
}
function blit(dst, src, x, y) {
  for (let yy = 0; yy < src.height; yy++) dst.data.set(src.data.subarray(yy * src.width * 4, (yy + 1) * src.width * 4), ((y + yy) * dst.width + x) * 4);
}

/** Lay `after` onto the source's pixel grid using where each output pixel sits (`cleanPixels` info.geometry). */
function alignTo(after, w, h, { originX, originY, cell }) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = Math.min(after.height - 1, Math.max(0, Math.floor((y + 0.5 - originY) / cell)));
    for (let x = 0; x < w; x++) {
      const u = Math.min(after.width - 1, Math.max(0, Math.floor((x + 0.5 - originX) / cell)));
      data.set(after.data.subarray((v * after.width + u) * 4, (v * after.width + u) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

/**
 * Contact sheet for checking a change by eye: both images whole (regions outlined), then the regions that changed
 * most plus any requested ones, before on the left and after on the right, at nearest-neighbour zoom. Output that is
 * smaller than its source (pixel art restored to its native grid) is laid back onto the source: exactly when its
 * `geometry` is given, otherwise by plain proportional scaling. Region coordinates are in source pixels.
 */
export function reviewSheet(before, after, { regions = 4, extra = [], geometry } = {}) {
  const w = before.width, h = before.height, n = w * h;
  const same = after.width === w && after.height === h;
  const Bsrc = same ? after : geometry ? alignTo(after, w, h, geometry) : resizeNearest(after, w, h);
  const A = flatten(before), B = flatten(Bsrc);
  const change = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rgb = (Math.abs(A.data[i * 4] - B.data[i * 4]) + Math.abs(A.data[i * 4 + 1] - B.data[i * 4 + 1]) + Math.abs(A.data[i * 4 + 2] - B.data[i * 4 + 2])) / 3;
    const alphaDiff = Math.abs(before.data[i * 4 + 3] - Bsrc.data[i * 4 + 3]);
    change[i] = Math.max(rgb, alphaDiff);
  }
  const side = Math.min(w, h, Math.max(24, Math.min(160, Math.round(Math.min(w, h) / 8))));
  const energy = boxBlur(change, w, h, side >> 1, 1);
  const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const picked = extra.map(([x, y, rw, rh]) => {
    const cw = Math.min(rw, w), ch = Math.min(rh, h);
    return { x: clampTo(x, 0, w - cw), y: clampTo(y, 0, h - ch), w: cw, h: ch, meanChange: null, requested: true };
  });
  const taken = new Uint8Array(n);
  for (let k = 0; k < regions; k++) {
    let best = -1, bestValue = 0.5; // ignore regions whose mean change is under half a level
    for (let i = 0; i < n; i++) if (!taken[i] && energy[i] > bestValue) { bestValue = energy[i]; best = i; }
    if (best < 0) break;
    // centre the region on where the change actually is: the change-weighted centroid around the peak
    let sx = 0, sy = 0, sw = 0;
    const bx = best % w, by = (best / w) | 0;
    for (let yy = Math.max(0, by - side); yy < Math.min(h, by + side + 1); yy++) for (let xx = Math.max(0, bx - side); xx < Math.min(w, bx + side + 1); xx++) {
      const v = change[yy * w + xx];
      sx += v * xx; sy += v * yy; sw += v;
    }
    const cx = sw ? Math.round(sx / sw) : bx, cy = sw ? Math.round(sy / sw) : by;
    const x = clampTo(cx - (side >> 1), 0, w - side), y = clampTo(cy - (side >> 1), 0, h - side);
    picked.push({ x, y, w: side, h: side, meanChange: bestValue, requested: false });
    for (let yy = Math.max(0, y - side); yy < Math.min(h, y + 2 * side); yy++) taken.fill(1, yy * w + Math.max(0, x - side), yy * w + Math.min(w, x + 2 * side));
  }
  const gap = 8, label = 22, tint = [255, 200, 40];
  const scale = Math.min(1, 560 / Math.max(w, h)), ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
  const panels = picked.map(r => ({ ...r, zoom: Math.max(1, Math.floor(280 / Math.max(r.w, r.h))) }));
  const width = 2 * gap + Math.max(2 * ow + gap, ...panels.map(r => 2 * r.w * r.zoom + gap), 360);
  const height = gap + label + oh + gap + panels.reduce((sum, r) => sum + label + r.h * r.zoom + gap, 0);
  const sheet = { width, height, data: new Uint8Array(width * height * 4) };
  fillRect(sheet, 0, 0, width, height, [40, 40, 40]);
  drawText(sheet, `BEFORE ${w}X${h}`, gap, gap + 3);
  drawText(sheet, `AFTER ${after.width}X${after.height}`, 2 * gap + ow, gap + 3);
  const top = gap + label;
  blit(sheet, compositeChecker(shrinkRgba(before, ow, oh)), gap, top);
  blit(sheet, compositeChecker(shrinkRgba(Bsrc, ow, oh)), 2 * gap + ow, top);
  panels.forEach((r, k) => {
    const tag = String(k + 1);
    for (const left of [gap, 2 * gap + ow]) {
      const rw = Math.min(ow, Math.max(3, Math.round(r.w * scale)));
      const rh = Math.min(oh, Math.max(3, Math.round(r.h * scale)));
      const rx = left + clampTo(Math.round(r.x * scale), 0, ow - rw);
      const ry = top + clampTo(Math.round(r.y * scale), 0, oh - rh);
      strokeRect(sheet, rx, ry, rw, rh, tint);
      const tx = clampTo(rx + 2, left, Math.max(left, left + ow - 6 * tag.length));
      const ty = clampTo(ry + 2, top, Math.max(top, top + oh - 8));
      drawText(sheet, tag, tx, ty, tint, 1);
    }
  });
  let y = top + oh + gap;
  panels.forEach((r, k) => {
    drawText(sheet, `#${k + 1} X=${r.x} Y=${r.y} ${r.w}X${r.h} ZOOM ${r.zoom}X${r.requested ? " REQUESTED" : ""}`, gap, y + 3);
    y += label;
    const pw = r.w * r.zoom, ph = r.h * r.zoom;
    blit(sheet, compositeChecker(resizeNearest(cropImage(before, r.x, r.y, r.w, r.h), pw, ph)), gap, y);
    blit(sheet, compositeChecker(resizeNearest(cropImage(Bsrc, r.x, r.y, r.w, r.h), pw, ph)), 2 * gap + pw, y);
    y += ph + gap;
  });
  return { sheet, regions: panels.map(({ x, y: ry, w: rw, h: rh, zoom, meanChange, requested }) => ({ x, y: ry, w: rw, h: rh, zoom, meanChange, requested })) };
}

// ---------- command line ----------

const USAGE = `用法（给代理用；加 --json 时只输出一段 JSON）：
  node clean-image.mjs measure [--json] <图.png> [<改后.png>]
  node clean-image.mjs cel [--strength light|normal|strong] [--sharpen 0|1|2] [--review <目录|对比图.png>] [--json] -o <输出> <输入.png>...
  node clean-image.mjs pixel [--grid auto|N] [--uniform] [--colors N] [--scale K] [--keep-alpha] [--review <目录|对比图.png>] [--json] -o <输出> <输入.png>...
  node clean-image.mjs review [--regions N] [--region x,y,w,h]... [--json] -o <对比图.png> <改前.png> <改后.png>
  node clean-image.mjs meta [--strip <输出>] [--drop-orientation] [--json] <图.png|jpg|webp>...
多张输入时 -o / --strip 是目录；输出不会覆盖任何输入。measure/cel/pixel/review 处理 PNG，meta 支持 PNG、JPEG、WebP。
pixel：整数倍放大的像素图自动还原到原生网格；生成器的“假像素”图要加 --grid auto 或 --grid <大致格宽>。
  画得比格子更细的五官、细线按半格取样保住；--uniform 改为统一格宽，细节会丢，结果不能直接交付。
cel、pixel 交付前都要看对比图（--review 或 review）：脸、眼睛、高光、细线、文字和有意的细纹理是否还在。`;

function parse(args, spec) {
  const options = {}, inputs = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k];
    if (arg === "-o" || arg.startsWith("--")) {
      const name = arg === "-o" ? "out" : arg.slice(2);
      if (!Object.hasOwn(spec, name)) throw new Error(`未知选项 ${arg}`);
      if (spec[name] === "flag") { options[name] = true; continue; }
      const value = args[++k];
      if (value === undefined) throw new Error(`${arg} 缺少取值`);
      if (spec[name].repeat) options[name] = [...(options[name] ?? []), spec[name].repeat(value, arg)];
      else options[name] = spec[name](value, arg);
    } else inputs.push(arg);
  }
  return { options, inputs };
}
const region = {
  repeat: (value, flag) => {
    const parts = value.split(",");
    if (parts.length !== 4 || parts.some(p => !/^\d+$/u.test(p)) || +parts[2] < 4 || +parts[3] < 4) throw new Error(`${flag} 需要 x,y,宽,高（整数，宽高至少 4）`);
    return parts.map(Number);
  },
};
const integer = (min, max) => (value, flag) => {
  if (!/^\d+$/u.test(value) || +value < min || +value > max) throw new Error(`${flag} 需要 ${min}–${max} 的整数`);
  return +value;
};
const oneOf = choices => (value, flag) => {
  if (!choices.includes(value)) throw new Error(`${flag} 只能是 ${choices.join(" / ")}`);
  return value;
};
const text = value => value;
function readImage(file) {
  if (!file.toLowerCase().endsWith(".png")) throw new Error(`${file}：只处理 PNG，请先转换（如 macOS 用 sips -s format png）`);
  const bytes = fs.readFileSync(file);
  return { bytes, image: decodePng(bytes) };
}
const realPath = file => (fs.existsSync(file) ? (fs.realpathSync.native ?? fs.realpathSync)(file) : path.resolve(file));
/** Resolve output paths: a file for one input, a directory for several; never an input path. */
function outputs(inputs, out, { flag = "-o", extensions = [".png"] } = {}) {
  if (!out) throw new Error(`缺少 ${flag} 输出位置`);
  const trailingSep = out.endsWith("/") || out.endsWith(path.sep);
  const isDir = inputs.length > 1 || trailingSep || (fs.existsSync(out) && fs.statSync(out).isDirectory());
  const targets = inputs.map(file => (isDir ? path.join(out, path.basename(file)) : out));
  if (isDir) fs.mkdirSync(out, { recursive: true });
  else if (!extensions.some(ext => out.toLowerCase().endsWith(ext))) {
    throw new Error(`${flag} 需要 ${extensions.join(" / ")} 文件名，或目录`);
  }
  const sources = new Set(inputs.map(realPath));
  if (new Set(targets.map(realPath)).size !== targets.length) throw new Error("多个输入同名，会写到同一个输出");
  for (const target of targets) if (sources.has(realPath(target))) throw new Error(`拒绝覆盖输入文件 ${target}；请写到别处，原件保留`);
  return targets;
}
function writeFile(target, bytes) {
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, bytes);
    fs.renameSync(temp, target);
  } catch (error) {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    throw error;
  }
}
const level = value => (value === null ? "—" : value.toFixed(2));
const percent = value => `${(value * 100).toFixed(2)}%`;
function describe(file, m) {
  const grid = m.grid.block > 1
    ? `整数放大 ×${m.grid.block}`
    : `最强周期≈${m.grid.period.toFixed(2)} 像素，置信 ${m.grid.lift.toFixed(2)}（实测假像素精灵约 0.1–0.4，平滑插画低于 0.06；规整木板等场景也会偏高，看图确认）`;
  return [
    `${file}：${m.width}×${m.height}`,
    `  颜色数 ${m.colours}${m.nearDuplicateColours === null ? "" : `，其中看不出差别的近似色 ${m.nearDuplicateColours}`}`,
    `  孤立像素 ${percent(m.isolatedShare)}，半透明像素 ${percent(m.partialAlphaShare)}`,
    m.flatTexture.value === null ? "  平坦区细纹：—（颜色少，按像素画看前两行）" : `  平坦区细纹 ${level(m.flatTexture.value)}（8 位色阶，覆盖 ${percent(m.flatTexture.share)} 的画面）`,
    `  像素网格：${grid}`,
    `  元数据块：${m.metadataChunks.length ? m.metadataChunks.join("、") : "无"}`,
  ].join("\n");
}

const WATERMARK_NOTE = "只处理文件元数据和像素统计；藏在像素里的水印（如 SynthID）不受影响，也不能据此宣称已去除。";
/** Review sheet path for one input inside `dest` (or directly at `dest` when single input and `.png`); never overwrites. */
function reviewTarget(dest, file, count, taken) {
  const isFile = dest.toLowerCase().endsWith(".png") && !(fs.existsSync(dest) && fs.statSync(dest).isDirectory());
  if (isFile && count > 1) throw new Error("多张输入时 --review 需要目录路径，不能是单个 .png 文件");
  const target = isFile ? dest : path.join(dest, `${path.basename(file, path.extname(file))}.review.png`);
  if (!isFile) fs.mkdirSync(dest, { recursive: true });
  if (taken.has(realPath(target))) throw new Error(`对比图 ${target} 会覆盖输入或输出，换一个 --review 位置`);
  taken.add(realPath(target));
  return target;
}
function writeReview(target, before, after, options = {}) {
  const { sheet, regions } = reviewSheet(before, after, options);
  writeFile(target, encodePng(sheet));
  return { review: target, regions };
}

function main(argv) {
  const [command, ...rest] = argv;
  const report = (json, value, lines) => console.log(json ? JSON.stringify(value, null, 2) : lines().join("\n"));
  if (command === "measure") {
    const { options, inputs } = parse(rest, { json: "flag" });
    if (inputs.length < 1 || inputs.length > 2) throw new Error(USAGE);
    const loaded = inputs.map(readImage);
    const results = loaded.map(({ bytes, image }) => measureImage(image, bytes));
    const sameSize = loaded.length === 2 && loaded[0].image.width === loaded[1].image.width && loaded[0].image.height === loaded[1].image.height;
    const comparison = sameSize ? compareImages(loaded[0].image, loaded[1].image) : null;
    const comparisonNote = loaded.length === 2 && !sameSize ? "两张图尺寸不同，跳过逐像素对比（仅列出各自统计）。" : null;
    return report(options.json, { images: inputs.map((file, k) => ({ file, ...results[k] })), comparison, ...(comparisonNote ? { comparisonNote } : {}), note: WATERMARK_NOTE }, () => [
      ...inputs.map((file, k) => describe(file, results[k])),
      ...(comparison ? [`对比：色调偏移 ${comparison.colourDrift.toFixed(2)}（8 位色阶），线条锐度 ${comparison.lineSharpness.toFixed(3)}（1 为不变），改动像素 ${percent(comparison.changedShare)}`] : []),
      ...(comparisonNote ? [`对比：${comparisonNote}`] : []),
      `说明：${WATERMARK_NOTE}`,
    ]);
  }
  if (command === "cel") {
    const { options, inputs } = parse(rest, { out: text, strength: oneOf(Object.keys(CEL_PRESETS)), sharpen: integer(0, 2), review: text, json: "flag" });
    if (!inputs.length) throw new Error(USAGE);
    const targets = outputs(inputs, options.out);
    const taken = new Set([...inputs, ...targets].map(realPath));
    const results = inputs.map((file, k) => {
      const started = Date.now();
      const { image } = readImage(file);
      const cleaned = cleanCel(image, options);
      writeFile(targets[k], encodePng(cleaned, image.carried));
      return {
        input: file, output: targets[k], strength: options.strength ?? "normal", seconds: +((Date.now() - started) / 1000).toFixed(1),
        flatTexture: { before: flatTexture(image).value, after: flatTexture(cleaned).value },
        ...(options.review ? writeReview(reviewTarget(options.review, file, inputs.length, taken), image, cleaned) : {}),
      };
    });
    return report(options.json, { results }, () => results.map(r =>
      `${r.input} → ${r.output}（${r.strength}，${r.seconds} 秒；平坦区细纹 ${level(r.flatTexture.before)} → ${level(r.flatTexture.after)}）${r.review ? `\n  对比图 ${r.review}` : ""}`,
    ).concat(options.review ? [] : ["下一步：用 review 或 --review 出对比图，看过再交付。"]));
  }
  if (command === "pixel") {
    const { options, inputs } = parse(rest, {
      out: text, colors: integer(2, 256), scale: integer(1, 16), "keep-alpha": "flag", uniform: "flag", review: text, json: "flag",
      grid: (value, flag) => {
        if (value === "auto") return value;
        if (!/^\d+(?:\.\d+)?$/u.test(value) || +value < 2 || +value > 64) throw new Error(`${flag} 只能是 auto 或 2–64 的格宽（像素，可带小数）`);
        return +value;
      },
    });
    if (!inputs.length) throw new Error(USAGE);
    const targets = outputs(inputs, options.out);
    const taken = new Set([...inputs, ...targets].map(realPath));
    const loaded = inputs.map(readImage);
    const cleaned = cleanPixels(loaded.map(({ image }) => image), {
      grid: options.grid, colors: options.colors, scale: options.scale, keepAlpha: options["keep-alpha"], uniform: options.uniform,
    });
    const results = cleaned.map((result, k) => {
      writeFile(targets[k], encodePng(result, loaded[k].image.carried));
      const { block, detected, refined, finerShare, cols, rows, colours, warning } = result.info;
      return {
        input: inputs[k], output: targets[k], width: result.width, height: result.height,
        grid: detected ? { kind: "detected", size: detected.s, confidence: detected.lift, halfSizeDetail: refined, finerDetailShare: finerShare } : { kind: block > 1 ? "exact-block" : "native", size: block },
        nativeSize: [cols, rows], sharedColours: colours, warning,
        ...(options.review ? writeReview(reviewTarget(options.review, inputs[k], inputs.length, taken), loaded[k].image, result, { geometry: result.info.geometry }) : {}),
      };
    });
    return report(options.json, { results }, () => results.flatMap(r => {
      const g = r.grid;
      const how = g.kind === "detected"
        ? `检测到假像素网格，块≈${g.size.toFixed(2)}${g.halfSizeDetail ? `；${(g.finerDetailShare * 100).toFixed(1)}% 的格子画得更细（多半是五官、细线），这些格子按≈${(g.size / 2).toFixed(2)} 取样` : ""}，还原为 ${r.nativeSize.join("×")}`
        : g.kind === "exact-block" ? `整数放大 ×${g.size}，原生 ${r.nativeSize.join("×")}` : `按原生网格 ${r.nativeSize.join("×")}`;
      return [
        ...(r.warning ? [`警告 ${r.input}：${r.warning}`] : []),
        `${r.input} → ${r.output}（${how}；共用 ${r.sharedColours} 色）${r.review ? `\n  对比图 ${r.review}` : ""}`,
      ];
    }).concat(options.review ? [] : ["下一步：用 review 或 --review 出对比图，看过再交付。"]));
  }
  if (command === "review") {
    const { options, inputs } = parse(rest, { out: text, regions: integer(0, 12), region, json: "flag" });
    if (inputs.length !== 2) throw new Error(USAGE);
    if (!options.out?.toLowerCase().endsWith(".png")) throw new Error("-o 需要 .png 文件名");
    if (inputs.map(realPath).includes(realPath(options.out))) throw new Error(`拒绝覆盖输入文件 ${options.out}`);
    const [before, after] = inputs.map(file => readImage(file).image);
    const result = writeReview(options.out, before, after, { regions: options.regions ?? 4, extra: options.region ?? [] });
    const proportional = before.width !== after.width || before.height !== after.height;
    return report(options.json, { before: inputs[0], after: inputs[1], alignment: proportional ? "proportional" : "same-size", ...result }, () => [
      `对比图 ${result.review}：上排改前、改后全图（黄框是下方放大的区域），下面每行左改前、右改后，坐标按改前图的像素。`,
      ...(proportional ? ["  两图尺寸不同，只按比例对齐，可能错开几个像素；像素图请用 pixel 的 --review，它按真实网格对齐。"] : []),
      ...result.regions.map((r, k) => `  #${k + 1} x=${r.x} y=${r.y} ${r.w}×${r.h} 放大 ${r.zoom} 倍${r.requested ? "（指定）" : `（平均改动 ${r.meanChange.toFixed(1)} 色阶）`}`),
    ]);
  }
  if (command === "meta") {
    const { options, inputs } = parse(rest, { strip: text, "drop-orientation": "flag", json: "flag" });
    if (!inputs.length) throw new Error(USAGE);
    const loaded = inputs.map(file => {
      const bytes = fs.readFileSync(file);
      return { file, bytes, info: inspectMetadata(bytes) };
    });
    const targets = options.strip
      ? outputs(inputs, options.strip, { flag: "--strip", extensions: inputs.length === 1 ? formatExtensions(loaded[0].info.format) : [".png", ".jpg", ".jpeg", ".webp"] })
      : null;
    const strippedResults = targets
      ? loaded.map(({ bytes }) => stripImageMetadata(bytes, { dropOrientation: Boolean(options["drop-orientation"]) }))
      : null;
    const entries = loaded.map(({ file, info }, k) => {
      let stripped = null;
      if (targets) {
        writeFile(targets[k], strippedResults[k].bytes);
        stripped = { output: targets[k], removed: strippedResults[k].removed };
      }
      return { input: file, format: info.format, chunks: info.chunks, ...(info.orientation !== null ? { orientation: info.orientation } : {}), stripped };
    });
    const formatEntryLines = e => [
      ...(entries.length > 1 ? [`${e.input}（${e.format.toUpperCase()}）:`] : []),
      ...e.chunks.map(c => `${c.type}\t${c.bytes} 字节${c.metadata ? "\t← 元数据" : ""}`),
      ...(e.orientation && e.orientation !== 1 ? [`注意：EXIF 包含 Orientation=${e.orientation}，直接剥离 EXIF 会改变显示方向。`] : []),
      ...(e.stripped ? [e.stripped.removed.length ? `已写出 ${e.stripped.output}，删除 ${e.stripped.removed.join("、")}；压缩图像数据逐字节未变。` : `已写出 ${e.stripped.output}，没有可删的元数据。`] : []),
    ];
    const payload = entries.length === 1 ? { ...entries[0], note: WATERMARK_NOTE } : { results: entries, note: WATERMARK_NOTE };
    return report(options.json, payload, () => [...entries.flatMap(formatEntryLines), `说明：${WATERMARK_NOTE}`]);
  }
  throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export const internal = { fft2, fftPlan, smoothSize, l0Smooth, flatTexture };
