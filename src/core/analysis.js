// Layer-stack analysis at reduced resolution:
//  - islands: solid regions with nothing beneath them in the previous layer
//  - suction cups: empty regions that, at the moment they are printed, are sealed
//    laterally and toward the build plate (vacuum against the FEP during peel)
//  - trapped volumes: enclosed empty regions that never connect to the vat
import { bounds } from './mesh.js';
import { createLayerContext, renderLayer } from './layerjob.js';

function makeGrid(allTris, pixel) {
  const b = bounds(allTris);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const W = Math.ceil((b.max[0] - b.min[0]) / pixel) + 8, H = Math.ceil((b.max[1] - b.min[1]) / pixel) + 8;
  const W4 = (W + 3) & ~3;
  return { cx, cy, zmax: b.max[2], printer: { resX: W4, resY: H, pixelMm: pixel, displayW: W4 * pixel, displayH: H * pixel } };
}

function shift(tris, dx, dy) {
  if (!tris || !tris.length) return tris;
  const o = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) { o[i] = tris[i] - dx; o[i + 1] = tris[i + 1] - dy; o[i + 2] = tris[i + 2]; }
  return o;
}

function concatAll(list) {
  let n = 0;
  for (const t of list) if (t) n += t.length;
  const o = new Float32Array(n);
  let p = 0;
  for (const t of list) if (t) { o.set(t, p); p += t.length; }
  return o;
}

class UF {
  constructor() { this.p = new Int32Array(1 << 16); this.n = 0; this.flag = new Uint8Array(1 << 16); this.cnt = new Int32Array(1 << 16); }
  make(f, cnt = 0) {
    if (this.n >= this.p.length) {
      const p = new Int32Array(this.p.length * 2); p.set(this.p); this.p = p;
      const g = new Uint8Array(this.flag.length * 2); g.set(this.flag); this.flag = g;
      const c = new Int32Array(this.cnt.length * 2); c.set(this.cnt); this.cnt = c;
    }
    this.p[this.n] = this.n; this.flag[this.n] = f; this.cnt[this.n] = cnt;
    return this.n++;
  }
  find(a) { const p = this.p; while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; }
  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a === b) return a;
    this.p[a] = b; this.flag[b] |= this.flag[a];
    return b;
  }
}

/**
 * groups: {model, supports, cavity, holes, infill} world-space triangle soups.
 * opts: {pixel=0.2, layerHeight=0.1, minIslandArea=0.02, minSuctionArea=1}
 */
export function analyzeStack(groups, opts = {}) {
  const pixel = opts.pixel ?? 0.2;
  const lh = opts.layerHeight ?? 0.1;
  const all = concatAll([groups.model, groups.supports]);
  if (!all.length) return { islands: [], suction: [], trapped: [] };
  const g = makeGrid(all, pixel);
  const job = {
    model: shift(groups.model, g.cx, g.cy), supports: shift(groups.supports, g.cx, g.cy),
    cavity: shift(groups.cavity, g.cx, g.cy), holes: shift(groups.holes, g.cx, g.cy),
    infill: groups.infill, layerHeight: lh, aa: 1, blur: 0,
  };
  const ctx = createLayerContext(job, g.printer);
  const { resX: W, resY: H } = g.printer;
  const hw = g.printer.displayW / 2, hh = g.printer.displayH / 2;
  const toWorld = (c, r) => [g.cx + hw - (c + 0.5) * pixel, g.cy + hh - (r + 0.5) * pixel];
  // one extra (empty) layer above the model: the open vat vents anything reaching the top
  const layers = Math.ceil(g.zmax / lh) + 1;
  const px2 = pixel * pixel;
  let prev = new Uint8Array(W * H);
  const islands = [];
  // void tracking
  const uf = new UF();
  let prevVoidRuns = [];                 // runs of previous layer: [r, s, e, id] flattened
  let active = new Map();                // sealed-void events in progress: root -> event
  const finished = [];
  const doIslands = opts.islands !== false, doVoids = opts.voids !== false;
  for (let k = 0; k < layers; k++) {
    const img = renderLayer(ctx, k);
    const z = (k + 0.5) * lh;
    if (doIslands) findIslands(img, prev, W, H, k, z, toWorld, px2, islands, opts.minIslandArea ?? 0.02);
    if (doVoids) {
      const runs = [];
      for (let r = 0; r < H; r++) {
        const row = r * W;
        let c = 0;
        while (c < W) {
          if (img[row + c]) { c++; continue; }
          const s = c;
          while (c < W && !img[row + c]) c++;
          const border = r === 0 || r === H - 1 || s === 0 || c === W;
          runs.push(r, s, c, uf.make(border ? 1 : 0, c - s));
        }
      }
      // lateral 4-connectivity with previous row
      let a = 0;
      for (let i = 0; i < runs.length; i += 4) {
        const r = runs[i], s = runs[i + 1], e = runs[i + 2];
        while (a < i && runs[a] < r - 1) a += 4;
        for (let j = a; j < i && runs[j] === r - 1; j += 4) {
          if (runs[j + 1] < e && runs[j + 2] > s) uf.union(runs[i + 3], runs[j + 3]);
        }
      }
      // vertical connectivity with previous layer (same pixels empty)
      let b = 0;
      for (let i = 0; i < runs.length; i += 4) {
        const r = runs[i], s = runs[i + 1], e = runs[i + 2];
        while (b < prevVoidRuns.length && (prevVoidRuns[b] < r || (prevVoidRuns[b] === r && prevVoidRuns[b + 2] <= s))) b += 4;
        for (let j = b; j < prevVoidRuns.length && prevVoidRuns[j] === r && prevVoidRuns[j + 1] < e; j += 4) {
          if (prevVoidRuns[j + 2] > s) uf.union(runs[i + 3], prevVoidRuns[j + 3]);
        }
      }
      // carry open events forward: close the ones that vented, merge ones that joined
      const remapped = new Map();
      for (const ev of active.values()) {
        const r = uf.find(ev.root);
        if (uf.flag[r]) { finished.push(ev); continue; }
        const ex = remapped.get(r);
        if (ex) mergeEvent(ex, ev); else { ev.root = r; remapped.set(r, ev); }
      }
      active = remapped;
      // sealed voids at this layer = suction
      const layerSealed = new Map();
      for (let i = 0; i < runs.length; i += 4) {
        const root = uf.find(runs[i + 3]);
        if (uf.flag[root]) continue;
        const n = runs[i + 2] - runs[i + 1];
        let sl = layerSealed.get(root);
        if (!sl) { sl = { n: 0, sx: 0, sy: 0, runs: [] }; layerSealed.set(root, sl); }
        sl.n += n; sl.sx += ((runs[i + 1] + runs[i + 2]) / 2) * n; sl.sy += runs[i] * n;
        sl.runs.push(runs[i], runs[i + 1], runs[i + 2]);
      }
      for (const [root, sl] of layerSealed) {
        const area = sl.n * px2;
        let ev = active.get(root);
        if (!ev) {
          // representative point of the first sealed layer (the bottom of the pocket)
          const mc = sl.sx / sl.n, mr = sl.sy / sl.n;
          let best = null, bd = Infinity;
          for (let q = 0; q < sl.runs.length; q += 3) {
            const rr = sl.runs[q], cc = Math.min(Math.max(mc, sl.runs[q + 1]), sl.runs[q + 2] - 1);
            const d = (rr - mr) ** 2 + (cc - mc) ** 2;
            if (d < bd) { bd = d; best = [cc, rr]; }
          }
          const [bx, by] = toWorld(best[0], best[1]);
          ev = { root, k0: k, k1: k, maxArea: 0, x: 0, y: 0, z, bx, by, bz: z };
          active.set(root, ev);
        }
        ev.k1 = k;
        if (area > ev.maxArea) {
          ev.maxArea = area;
          const [x, y] = toWorld(sl.sx / sl.n, sl.sy / sl.n);
          ev.x = x; ev.y = y; ev.z = z;
        }
      }
      // sealed regions with no empty pixels left in this layer have been capped (trapped)
      for (const [root, ev] of active) if (!layerSealed.has(root)) { finished.push(ev); active.delete(root); }
      prevVoidRuns = runs;
    }
    prev.set(img);
  }
  finished.push(...active.values());
  const minS = opts.minSuctionArea ?? 3;
  const suction = finished.filter((e) => e.maxArea >= minS).map((e) => ({
    x: e.x, y: e.y, z: e.z, z0: e.k0 * lh, z1: (e.k1 + 1) * lh, maxArea: e.maxArea, vented: !!uf.flag[uf.find(e.root)], bottom: [e.bx, e.by, e.bz],
  }));
  // trapped volumes: void components never vented
  const trappedVol = new Map();
  for (let id = 0; id < uf.n; id++) {
    const n = uf.cnt[id];
    const r = uf.find(id);
    if (uf.flag[r]) continue;
    trappedVol.set(r, (trappedVol.get(r) || 0) + n * px2 * lh);
  }
  const trapped = [];
  const evByRoot = new Map(finished.map((e) => [uf.find(e.root), e]));
  for (const [r, vol] of trappedVol) {
    const ev = evByRoot.get(r);
    if (vol >= (opts.minTrappedVolume ?? 1)) trapped.push({ volume: vol, x: ev?.x ?? 0, y: ev?.y ?? 0, z: ev?.z ?? 0, bottom: ev ? [ev.bx, ev.by, ev.bz] : null });
  }
  return { islands, suction, trapped, layers, pixel, layerHeight: lh };
}

function mergeEvent(a, b) {
  a.k0 = Math.min(a.k0, b.k0); a.k1 = Math.max(a.k1, b.k1);
  if (b.maxArea > a.maxArea) { a.maxArea = b.maxArea; a.x = b.x; a.y = b.y; a.z = b.z; }
}

function findIslands(img, prev, W, H, k, z, toWorld, px2, out, minArea) {
  // label solid components (8-connectivity) via runs, check support from previous layer
  const runs = [];
  const parent = [];
  for (let r = 0; r < H; r++) {
    const row = r * W;
    let c = 0;
    while (c < W) {
      if (!img[row + c]) { c++; continue; }
      const s = c;
      while (c < W && img[row + c]) c++;
      const id = parent.length;
      parent.push(id);
      runs.push(r, s, c, id);
    }
  }
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let a = 0;
  for (let i = 0; i < runs.length; i += 4) {
    const r = runs[i], s = runs[i + 1], e = runs[i + 2];
    while (a < i && runs[a] < r - 1) a += 4;
    for (let j = a; j < i && runs[j] === r - 1; j += 4) {
      if (runs[j + 1] <= e && runs[j + 2] >= s) { const x = find(runs[i + 3]), y = find(runs[j + 3]); if (x !== y) parent[x] = y; }
    }
  }
  if (k === 0) return; // first layer sits on the plate
  const comp = new Map();
  for (let i = 0; i < runs.length; i += 4) {
    const r = runs[i], s = runs[i + 1], e = runs[i + 2];
    const root = find(runs[i + 3]);
    let cpt = comp.get(root);
    if (!cpt) { cpt = { n: 0, sx: 0, sy: 0, supported: false, runs: [] }; comp.set(root, cpt); }
    cpt.n += e - s; cpt.sx += ((s + e) / 2) * (e - s); cpt.sy += r * (e - s);
    cpt.runs.push(r, s, e);
    if (!cpt.supported) {
      // supported if any pixel of this run (or its 1-px neighbourhood) was solid below
      for (let rr = Math.max(0, r - 1); rr <= Math.min(H - 1, r + 1) && !cpt.supported; rr++) {
        const row = rr * W;
        for (let c = Math.max(0, s - 1); c < Math.min(W, e + 1); c++) if (prev[row + c]) { cpt.supported = true; break; }
      }
    }
  }
  for (const cpt of comp.values()) {
    if (cpt.supported) continue;
    const area = cpt.n * px2;
    if (area < minArea) continue;
    // representative point: run pixel closest to the centroid
    const mc = cpt.sx / cpt.n, mr = cpt.sy / cpt.n;
    let best = null, bd = Infinity;
    for (let i = 0; i < cpt.runs.length; i += 3) {
      const r = cpt.runs[i], c = Math.min(Math.max(mc, cpt.runs[i + 1]), cpt.runs[i + 2] - 1);
      const d = (r - mr) ** 2 + (c - mc) ** 2;
      if (d < bd) { bd = d; best = [c, r]; }
    }
    const [x, y] = toWorld(best[0], best[1]);
    // pixel samples for multi-point support on big islands
    const pts = [];
    for (let i = 0; i < cpt.runs.length; i += 3) for (let c = cpt.runs[i + 1]; c < cpt.runs[i + 2]; c++) pts.push(toWorld(c, cpt.runs[i]));
    out.push({ k, z, x, y, area, pixels: pts.length > 4000 ? subsample(pts, 4000) : pts });
  }
}

function subsample(a, n) {
  const out = [];
  const step = a.length / n;
  for (let i = 0; i < n; i++) out.push(a[Math.floor(i * step)]);
  return out;
}
