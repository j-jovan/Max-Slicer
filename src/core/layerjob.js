// Per-layer composition used by slicing workers.
//   result = ((model − (cavity − infill)) − drainHoles) ∪ supports
import { M7MAX } from './printer.js';
import { prepareMesh, LayerSweeper, Rasterizer, boxBlur } from './raster.js';
import { encodePW0 } from './pw0.js';
import { encodeGOO } from './goo.js';
import { packEntry } from './zip.js';

export function createLayerContext(job, printer = M7MAX) {
  const W = printer.resX, H = printer.resY;
  const hasSub = !!(job.cavity?.length || job.holes?.length);
  const ctx = { job, W, H, printer, ras: new Rasterizer(W, H), hasSub };
  // When nothing is subtracted, model and supports are one union pass.
  if (!hasSub) {
    ctx.solid = new LayerSweeper(prepareMesh(concat(job.model, job.supports)), printer);
  } else {
    ctx.model = new LayerSweeper(prepareMesh(job.model), printer);
    ctx.sup = job.supports?.length ? new LayerSweeper(prepareMesh(job.supports), printer) : null;
    ctx.cav = job.cavity?.length ? new LayerSweeper(prepareMesh(job.cavity), printer) : null;
    ctx.hol = job.holes?.length ? new LayerSweeper(prepareMesh(job.holes), printer) : null;
    ctx.tmp = new Uint8Array(W * H);
  }
  ctx.img = new Uint8Array(W * H);
  ctx.dirty = new Uint8Array(H);
  ctx.tdirty = new Uint8Array(H);
  return ctx;
}

function concat(a, b) {
  if (!b || !b.length) return a;
  if (!a || !a.length) return b;
  const o = new Float32Array(a.length + b.length);
  o.set(a); o.set(b, a.length);
  return o;
}

function clearRows(buf, dirty, W) {
  for (let r = 0; r < dirty.length; r++) if (dirty[r]) { buf.fill(0, r * W, (r + 1) * W); dirty[r] = 0; }
}

// Layers must be requested in increasing order per context.
// ctx.dirty[r] = 1 marks rows that may contain non-zero pixels.
export function renderLayer(ctx, k) {
  const { job, W, H, ras } = ctx;
  const aa = job.aa || 1;
  const z = (k + 0.5) * job.layerHeight;
  const img = ctx.img, dirty = ctx.dirty;
  clearRows(img, dirty, W);
  if (!ctx.hasSub) {
    const s = ctx.solid.next(z);
    ras.rasterize(s.segs, s.count, img, aa, dirty);
  } else {
    const tmp = ctx.tmp, td = ctx.tdirty;
    const m = ctx.model.next(z);
    ras.rasterize(m.segs, m.count, img, aa, dirty);
    if (ctx.cav) {
      const c = ctx.cav.next(z);
      if (c.count) {
        ras.rasterize(c.segs, c.count, tmp, aa, td);
        applyCavity(img, tmp, td, W, H, z, job.infill, ctx.printer);
        clearRows(tmp, td, W);
      }
    }
    if (ctx.hol) {
      const h = ctx.hol.next(z);
      if (h.count) {
        ras.rasterize(h.segs, h.count, tmp, aa, td);
        for (let r = 0; r < H; r++) {
          if (!td[r]) continue;
          for (let i = r * W, e = i + W; i < e; i++) { const t = tmp[i]; if (t) { const v = 255 - t; if (img[i] > v) img[i] = v; } }
        }
        clearRows(tmp, td, W);
      }
    }
    if (ctx.sup) {
      const s = ctx.sup.next(z);
      if (s.count) {
        ras.rasterize(s.segs, s.count, tmp, aa, td);
        for (let r = 0; r < H; r++) {
          if (!td[r]) continue;
          dirty[r] = 1;
          for (let i = r * W, e = i + W; i < e; i++) if (tmp[i] > img[i]) img[i] = tmp[i];
        }
        clearRows(tmp, td, W);
      }
    }
  }
  if (job.blur > 0) {
    boxBlur(img, W, H, job.blur);
    // blur spreads content vertically by the radius
    const src = dirty.slice();
    for (let r = 0; r < H; r++) if (src[r]) for (let q = Math.max(0, r - job.blur); q <= Math.min(H - 1, r + job.blur); q++) dirty[q] = 1;
  }
  return img;
}

// Remove cavity from the model, keeping infill lattice inside it.
function applyCavity(img, cav, cdirty, W, H, z, infill, pr) {
  const type = infill?.type || 'none';
  // pixel centre -> plate mm (inverse of the rasteriser mapping)
  const px = pr.pixelX ?? pr.pixelMm, py = pr.pixelY ?? pr.pixelMm, sx = pr.sx ?? -1, sy = pr.sy ?? -1;
  const hx = pr.displayW / 2, hy = pr.displayH / 2;
  const s = infill?.spacing || 6, t = infill?.thickness || 1;
  const ht = t / 2;
  const nearZ = type === 'cubic' ? distToGrid(z, s) < ht : false;
  const kz = (2 * Math.PI) / s, Zs = Math.sin(z * kz), Zc = Math.cos(z * kz);
  const gyroTau = 3.77 * t / s;
  for (let r = 0; r < H; r++) {
    if (!cdirty[r]) continue;
    const row = r * W;
    let y = 0, nearY = false, Ys = 0, Yc = 0, rowReady = false;
    for (let c = 0; c < W; c++) {
      const cv = cav[row + c];
      if (!cv) continue;
      let keep = false;
      if (type !== 'none') {
        if (!rowReady) {
          y = sy * ((r + 0.5) * py - hy);
          nearY = distToGrid(y, s) < ht;
          Ys = Math.sin(y * kz); Yc = Math.cos(y * kz);
          rowReady = true;
        }
        const x = sx * ((c + 0.5) * px - hx);
        if (type === 'cubic') {
          const nearX = distToGrid(x, s) < ht;
          keep = (nearX && nearY) || (nearX && nearZ) || (nearY && nearZ);
        } else if (type === 'gyroid') {
          const X = x * kz;
          const g = Math.sin(X) * Yc + Ys * Zc + Zs * Math.cos(X);
          keep = Math.abs(g) < gyroTau;
        }
      }
      if (!keep) { const v = 255 - cv; if (img[row + c] > v) img[row + c] = v; }
    }
  }
}

function distToGrid(a, s) {
  const m = ((a % s) + s) % s;
  return m < s - m ? m : s - m;
}

// Layer statistics + PW0 encoding + deflate. Bounding box values follow UVtools:
// millimetres in image space, offset so that the display centre is 0.
export function finishLayer(ctx, img) {
  const { W, H, printer } = ctx;
  const px = printer.pixelX ?? printer.pixelMm, py = printer.pixelY ?? printer.pixelMm;
  const u32 = new Uint32Array(img.buffer, img.byteOffset, img.length >> 2);
  const W4 = W >> 2; // W is a multiple of 4 on this printer
  // connected components over horizontal runs (8-connectivity), union-find
  let cap = 1 << 14;
  let parent = new Int32Array(cap), area = new Float64Array(cap);
  let prev = new Int32Array(3 * 4096), cur = new Int32Array(3 * 4096);
  let np = 0, ids = 0;
  let c0 = W, c1 = -1, r0 = H, r1 = -1, total = 0;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const dirty = ctx.dirty;
  for (let r = 0; r < H; r++) {
    if (!dirty[r]) { np = 0; continue; }
    const row = r * W, wrow = r * W4;
    let nc = 0, c = 0;
    while (c < W) {
      if ((c & 3) === 0 && u32[wrow + (c >> 2)] === 0) { c += 4; continue; }
      if (img[row + c] === 0) { c++; continue; }
      const s = c;
      let sum = 0;
      while (c < W) {
        if ((c & 3) === 0 && c + 4 <= W && u32[wrow + (c >> 2)] === 0xffffffff) { sum += 1020; c += 4; continue; }
        const v = img[row + c];
        if (v === 0) break;
        sum += v; c++;
      }
      if (ids >= cap) {
        cap *= 2;
        const p2 = new Int32Array(cap); p2.set(parent); parent = p2;
        const a2 = new Float64Array(cap); a2.set(area); area = a2;
      }
      parent[ids] = ids; area[ids] = sum / 255; total += sum / 255;
      if (nc * 3 + 3 > cur.length) { const c2 = new Int32Array(cur.length * 2); c2.set(cur); cur = c2; }
      cur[nc * 3] = s; cur[nc * 3 + 1] = c; cur[nc * 3 + 2] = ids++;
      nc++;
      if (s < c0) c0 = s;
      if (c - 1 > c1) c1 = c - 1;
      if (r < r0) r0 = r;
      r1 = r;
    }
    let j = 0;
    for (let i = 0; i < nc; i++) {
      const s = cur[i * 3], e = cur[i * 3 + 1];
      while (j < np && prev[j * 3 + 1] < s) j++;
      for (let q = j; q < np && prev[q * 3] <= e; q++) {
        const a = find(cur[i * 3 + 2]), b = find(prev[q * 3 + 2]);
        if (a !== b) { parent[a] = b; area[b] += area[a]; }
      }
    }
    const t = prev; prev = cur; cur = t; np = nc;
  }
  let objects = 0, maxArea = 0;
  for (let i = 0; i < ids; i++) if (parent[i] === i) { objects++; if (area[i] > maxArea) maxArea = area[i]; }
  const px2 = px * py;
  const halfW = printer.displayW / 2, halfH = printer.displayH / 2;
  const stat = objects
    ? {
        area: round4(total * px2), objects, maxArea: round4(maxArea * px2),
        x0: round4(c0 * px - halfW), y0: round4(r0 * py - halfH), x1: round4((c1 + 1) * px - halfW), y1: round4((r1 + 1) * py - halfH),
      }
    : { area: 0, objects: 0, maxArea: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
  if (printer.format === 'goo') {
    // GOO layers are stored raw (no ZIP), already run-length encoded
    const encoded = encodeGOO(img, W, dirty);
    return { stat, packed: { data: encoded, size: encoded.length, raw: true }, encoded };
  }
  const encoded = encodePW0(img, W, dirty);
  const packed = packEntry(encoded);
  return { stat, packed, encoded };
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;
