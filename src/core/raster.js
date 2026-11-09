// Layer rasterisation: triangle soup -> plane intersection segments -> scanline fill
// using the nonzero winding rule (overlapping shells such as supports touching the
// model are unioned, never cancelled). Optional anti-aliasing with S sub-scanlines
// and exact horizontal coverage.
import { M7MAX } from './printer.js';

// Pre-sort triangles by zmin so layers can be swept with an active list.
export function prepareMesh(tris) {
  const n = tris.length / 9;
  const zmin = new Float32Array(n), zmax = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const a = tris[t * 9 + 2], b = tris[t * 9 + 5], c = tris[t * 9 + 8];
    zmin[t] = Math.min(a, b, c);
    zmax[t] = Math.max(a, b, c);
  }
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((i, j) => zmin[i] - zmin[j]);
  return { tris, n, zmin, zmax, order };
}

// Sweeps layers in increasing z. Call next(z) with non-decreasing z values.
export class LayerSweeper {
  constructor(prep, printer = M7MAX) {
    this.p = prep;
    this.ptr = 0;
    this.active = [];
    this.pr = printer;
    this.segs = new Float64Array(4096);
  }
  // Returns {segs: Float64Array [u0,v0,u1,v1]*, count}
  next(z) {
    const { tris, zmin, zmax, order, n } = this.p;
    while (this.ptr < n && zmin[order[this.ptr]] <= z) this.active.push(order[this.ptr++]);
    // compact active list
    let w = 0;
    const act = this.active;
    for (let i = 0; i < act.length; i++) if (zmax[act[i]] >= z) act[w++] = act[i];
    act.length = w;
    const halfW = this.pr.displayW / 2, halfH = this.pr.displayH / 2, ip = 1 / this.pr.pixelMm;
    let segs = this.segs;
    let count = 0;
    for (let i = 0; i < act.length; i++) {
      const o = act[i] * 9;
      const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
      const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
      const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
      const A = az > z, B = bz > z, C = cz > z;
      if (A === B && B === C) continue;
      // Two crossing edges; interpolate each from its lower-z endpoint (canonical
      // ordering => bit-identical points on edges shared by neighbouring triangles).
      let p0x, p0y, p1x, p1y, k = 0;
      const edge = (x0, y0, z0, x1, y1, z1) => {
        let X, Y;
        if (z0 < z1) { const t = (z - z0) / (z1 - z0); X = x0 + (x1 - x0) * t; Y = y0 + (y1 - y0) * t; }
        else { const t = (z - z1) / (z0 - z1); X = x1 + (x0 - x1) * t; Y = y1 + (y0 - y1) * t; }
        if (k === 0) { p0x = X; p0y = Y; } else { p1x = X; p1y = Y; }
        k++;
      };
      if (A !== B) edge(ax, ay, az, bx, by, bz);
      if (B !== C) edge(bx, by, bz, cx, cy, cz);
      if (C !== A) edge(cx, cy, cz, ax, ay, az);
      // Orient so the solid lies to the left (CCW seen from +Z): dir · (ez × n) > 0
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
      const d = -ny * (p1x - p0x) + nx * (p1y - p0y);
      if (d < 0) { let t = p0x; p0x = p1x; p1x = t; t = p0y; p0y = p1y; p1y = t; }
      if (count * 4 + 4 > segs.length) { const s2 = new Float64Array(segs.length * 2); s2.set(segs); segs = this.segs = s2; }
      // mm -> pixel (mirrored X, rows toward front)
      segs[count * 4] = (halfW - p0x) * ip;
      segs[count * 4 + 1] = (halfH - p0y) * ip;
      segs[count * 4 + 2] = (halfW - p1x) * ip;
      segs[count * 4 + 3] = (halfH - p1y) * ip;
      count++;
    }
    return { segs, count };
  }
}

// Reusable rasteriser with internal scratch buffers.
export class Rasterizer {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.cnt = null;
    this.xs = new Float64Array(1 << 16);
    this.ws = new Int8Array(1 << 16);
    this.acc = new Float32Array(W + 2);
  }

  // Fill `out` (Uint8Array W*H, assumed zeroed) with the shape. aa: 1,2,4,8,16
  rasterize(segs, count, out, aa = 1, dirty = null) {
    const W = this.W, H = this.H, S = aa;
    const L = H * S;
    if (!this.cnt || this.cnt.length < L + 1) this.cnt = new Int32Array(L + 1);
    const cnt = this.cnt;
    cnt.fill(0, 0, L + 1);
    // pass 1: count crossings per sub-scanline
    for (let i = 0; i < count; i++) {
      const v0 = segs[i * 4 + 1], v1 = segs[i * 4 + 3];
      if (v0 === v1) continue;
      const vmin = v0 < v1 ? v0 : v1, vmax = v0 < v1 ? v1 : v0;
      let g0 = Math.ceil(vmin * S - 0.5), g1 = Math.ceil(vmax * S - 0.5) - 1;
      if (g0 < 0) g0 = 0;
      if (g1 > L - 1) g1 = L - 1;
      for (let g = g0; g <= g1; g++) cnt[g + 1]++;
    }
    for (let g = 0; g < L; g++) cnt[g + 1] += cnt[g];
    const total = cnt[L];
    if (this.xs.length < total) { this.xs = new Float64Array(total * 1.5 | 0); this.ws = new Int8Array(total * 1.5 | 0); }
    const xs = this.xs, ws = this.ws;
    const fillPos = new Int32Array(cnt.subarray(0, L));
    // pass 2: crossing positions
    for (let i = 0; i < count; i++) {
      const u0 = segs[i * 4], v0 = segs[i * 4 + 1], u1 = segs[i * 4 + 2], v1 = segs[i * 4 + 3];
      if (v0 === v1) continue;
      const w = v1 > v0 ? 1 : -1;
      const vmin = v0 < v1 ? v0 : v1, vmax = v0 < v1 ? v1 : v0;
      let g0 = Math.ceil(vmin * S - 0.5), g1 = Math.ceil(vmax * S - 0.5) - 1;
      if (g0 < 0) g0 = 0;
      if (g1 > L - 1) g1 = L - 1;
      const slope = (u1 - u0) / (v1 - v0);
      for (let g = g0; g <= g1; g++) {
        const v = (g + 0.5) / S;
        const p = fillPos[g]++;
        xs[p] = u0 + (v - v0) * slope;
        ws[p] = w;
      }
    }
    // pass 3: per scanline sort + fill
    const acc = this.acc;
    for (let r = 0; r < H; r++) {
      if (S === 1) {
        const a = cnt[r], b = cnt[r + 1];
        if (b - a < 2) continue;
        sortPairs(xs, ws, a, b - 1);
        let wind = 0, start = 0;
        const row = r * W;
        for (let k = a; k < b; k++) {
          const prev = wind;
          wind += ws[k];
          if (prev === 0 && wind !== 0) start = xs[k];
          else if (prev !== 0 && wind === 0) {
            let c0 = Math.ceil(start - 0.5), c1 = Math.ceil(xs[k] - 0.5);
            if (c0 < 0) c0 = 0;
            if (c1 > W) c1 = W;
            if (c1 > c0) { out.fill(255, row + c0, row + c1); if (dirty) dirty[r] = 1; }
          }
        }
      } else {
        let any = false;
        for (let s = 0; s < S; s++) {
          const g = r * S + s;
          const a = cnt[g], b = cnt[g + 1];
          if (b - a < 2) continue;
          if (!any) { acc.fill(0); any = true; }
          sortPairs(xs, ws, a, b - 1);
          let wind = 0, start = 0;
          for (let k = a; k < b; k++) {
            const prev = wind;
            wind += ws[k];
            if (prev === 0 && wind !== 0) start = xs[k];
            else if (prev !== 0 && wind === 0) addCoverage(acc, start, xs[k], W);
          }
        }
        if (!any) continue;
        if (dirty) dirty[r] = 1;
        const row = r * W;
        const inv = 15 / S;
        for (let c = 0; c < W; c++) {
          const v = acc[c];
          if (v > 0) {
            let lvl = Math.round(v * inv);
            if (lvl > 15) lvl = 15;
            if (lvl > 0) out[row + c] = lvl * 17;
          }
        }
      }
    }
    return out;
  }
}

function addCoverage(acc, x0, x1, W) {
  if (x0 < 0) x0 = 0;
  if (x1 > W) x1 = W;
  if (x1 <= x0) return;
  const c0 = Math.floor(x0), c1 = Math.floor(x1);
  if (c0 === c1) { acc[c0] += x1 - x0; return; }
  acc[c0] += c0 + 1 - x0;
  for (let c = c0 + 1; c < c1; c++) acc[c] += 1;
  if (c1 < W) acc[c1] += x1 - c1;
}

// In-place sort of parallel arrays (keys xs, payload ws) over [lo, hi].
function sortPairs(xs, ws, lo, hi) {
  while (hi - lo > 16) {
    const mid = (lo + hi) >> 1;
    // median of three
    if (xs[mid] < xs[lo]) swap(xs, ws, mid, lo);
    if (xs[hi] < xs[lo]) swap(xs, ws, hi, lo);
    if (xs[hi] < xs[mid]) swap(xs, ws, hi, mid);
    const pivot = xs[mid];
    let i = lo, j = hi;
    while (i <= j) {
      while (xs[i] < pivot) i++;
      while (xs[j] > pivot) j--;
      if (i <= j) { swap(xs, ws, i, j); i++; j--; }
    }
    if (j - lo < hi - i) { sortPairs(xs, ws, lo, j); lo = i; }
    else { sortPairs(xs, ws, i, hi); hi = j; }
  }
  for (let i = lo + 1; i <= hi; i++) {
    const x = xs[i], w = ws[i];
    let j = i - 1;
    while (j >= lo && xs[j] > x) { xs[j + 1] = xs[j]; ws[j + 1] = ws[j]; j--; }
    xs[j + 1] = x; ws[j + 1] = w;
  }
}
function swap(xs, ws, i, j) {
  const t = xs[i]; xs[i] = xs[j]; xs[j] = t;
  const u = ws[i]; ws[i] = ws[j]; ws[j] = u;
}

// Separable box blur, radius r px, in place (uses scratch).
export function boxBlur(img, W, H, r) {
  if (r <= 0) return img;
  const tmp = new Uint8Array(W * H);
  const d = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let s = 0;
    for (let x = -r; x <= r; x++) s += img[o + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[o + x] = (s / d + 0.5) | 0;
      s += img[o + Math.min(W - 1, x + r + 1)] - img[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      img[y * W + x] = (s / d + 0.5) | 0;
      s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return img;
}
