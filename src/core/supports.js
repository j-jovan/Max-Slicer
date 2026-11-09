// Support generation: contact point selection (islands + overhangs), collision-aware
// routing, tip/trunk/base geometry, model-resting supports, cross braces and raft.
import { BVH } from './bvh.js';
import { analyzeStack } from './analysis.js';
import { frustum, sphere, triArea } from './mesh.js';

export const SUPPORT_PRESETS = {
  light: { tipD: 0.3, tipLen: 1.6, contactDepth: 0.15, trunkD: 0.9, baseD: 3.0, baseH: 0.8, spacing: 3.2, angle: 40 },
  medium: { tipD: 0.4, tipLen: 2.0, contactDepth: 0.2, trunkD: 1.2, baseD: 4.0, baseH: 1.0, spacing: 2.6, angle: 45 },
  heavy: { tipD: 0.55, tipLen: 2.4, contactDepth: 0.25, trunkD: 1.6, baseD: 5.0, baseH: 1.2, spacing: 2.0, angle: 50 },
};

export const DEFAULT_SUPPORT_SETTINGS = {
  preset: 'medium',
  ...SUPPORT_PRESETS.medium,
  density: 1.0,           // multiplier on point count (spacing / sqrt(density))
  elevation: 5,           // model bottom above raft top (mm)
  raft: 'slab',           // 'slab' | 'none'
  raftHeight: 1.0,
  raftMargin: 1.5,
  raftChamfer: 0.8,
  braces: true,
  braceD: 0.7,
  braceMaxDist: 9,
  braceStep: 7,
  modelResting: true,     // allow supports to rest on the model when the plate is unreachable
  islandPixel: 0.15,
  minIslandArea: 0.01,
  sides: 10,
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Grid2 {
  constructor(cell) { this.c = cell; this.m = new Map(); }
  key(x, y) { return `${Math.floor(x / this.c)},${Math.floor(y / this.c)}`; }
  add(p) { const k = this.key(p[0], p[1]); let l = this.m.get(k); if (!l) { l = []; this.m.set(k, l); } l.push(p); }
  near(x, y, r, fn) {
    const c = this.c, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((y - r) / c), j1 = Math.floor((y + r) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const l = this.m.get(`${i},${j}`); if (l) for (const p of l) if (fn(p) === false) return; }
  }
}

/**
 * Pick support contact points on a world-space model (already elevated).
 * Returns [{p:[x,y,z], n:[x,y,z], src:'island'|'overhang'}]
 */
export function autoSupportPoints(tris, settings, bvh = new BVH(tris), onProgress) {
  const S = { ...DEFAULT_SUPPORT_SETTINGS, ...settings };
  const spacing = S.spacing / Math.sqrt(Math.max(0.1, S.density));
  const cosT = Math.cos((S.angle * Math.PI) / 180);
  const pts = [];
  const grid = new Grid2(spacing);
  const accept = (p, n, src, minD) => {
    let ok = true;
    grid.near(p[0], p[1], minD, (q) => {
      const d = Math.hypot(q.p[0] - p[0], q.p[1] - p[1], (q.p[2] - p[2]) * 0.5);
      if (d < minD) { ok = false; return false; }
      return true;
    });
    if (!ok) return false;
    const e = { p, n, src };
    grid.add(Object.assign([p[0], p[1]], e));
    pts.push(e);
    return true;
  };
  // 1) islands (mandatory): lowest points of every disconnected region
  const an = analyzeStack({ model: tris }, { pixel: S.islandPixel, layerHeight: 0.1, voids: false, minIslandArea: S.minIslandArea, onProgress });
  const islandPts = [];
  for (const isl of an.islands) {
    const cand = [[isl.x, isl.y]];
    if (isl.area > spacing * spacing * 0.6) {
      // extra points across large islands
      const r = rng(Math.round(isl.x * 1000) ^ Math.round(isl.y * 1000));
      const shuffled = isl.pixels.slice();
      for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      for (const q of shuffled) cand.push(q);
    }
    const local = [];
    for (const [x, y] of cand) {
      if (local.some((q) => Math.hypot(q[0] - x, q[1] - y) < spacing * 0.9)) continue;
      // island bottom lies between the analysis layer centre and the one below it
      const z0 = isl.z - 0.16;
      const hit = bvh.raycast(x, y, z0, 0, 0, 1, 0.3);
      if (!hit) continue;
      const z = z0 + hit.t;
      const n = triN(tris, hit.tri);
      if (n[2] > 0) continue; // must be a downward-facing surface
      local.push([x, y]);
      islandPts.push({ p: [x, y, z], n });
    }
  }
  for (const ip of islandPts) accept(ip.p, ip.n, 'island', spacing * 0.5);
  // 2) overhangs: dense random samples on down-facing triangles, Poisson-disk filtered
  const nT = tris.length / 9;
  const cand = [];
  const r = rng(12345);
  for (let t = 0; t < nT; t++) {
    const n = triN(tris, t);
    if (n[2] > -cosT) continue;
    const area = triArea(tris, t * 9);
    const proj = area * -n[2];
    let k = (proj / (spacing * spacing)) * 6;
    let count = Math.floor(k) + (r() < k - Math.floor(k) ? 1 : 0);
    for (let i = 0; i < count; i++) {
      let u = r(), v = r();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const o = t * 9;
      const p = [0, 1, 2].map((d) => tris[o + d] + (tris[o + 3 + d] - tris[o + d]) * u + (tris[o + 6 + d] - tris[o + d]) * v);
      cand.push({ p, n });
    }
  }
  cand.sort((a, b) => a.p[2] - b.p[2]); // lowest first
  for (const c of cand) {
    // steeper (closer to vertical) overhangs get wider spacing
    const steep = Math.min(1, Math.max(0, (-c.n[2] - cosT) / (1 - cosT)));
    const minD = spacing * (1.35 - 0.35 * steep);
    accept(c.p, c.n, 'overhang', minD);
  }
  return pts;
}

function triN(t, tri) {
  const o = tri * 9;
  const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
  const vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * Route one support. Returns a plan {P, S, T, bottom:[x,y,z], onModel, tipR, trunkR} or null.
 */
export function planSupport(pt, bvh, S, raftTop) {
  const P = pt.p;
  const n = norm(pt.n);
  const tipR = S.tipD / 2;
  let trunkR = S.trunkD / 2;
  // tip direction: between surface normal and straight down
  let d = norm([n[0] * 0.55, n[1] * 0.55, n[2] * 0.55 - 0.45]);
  if (d[2] > -0.55) d = norm([d[0] * 0.5, d[1] * 0.5, -0.85]);
  const clearTip = (dir, len) => !bvh.raycast(P[0] + dir[0] * 0.05, P[1] + dir[1] * 0.05, P[2] + dir[2] * 0.05, dir[0], dir[1], dir[2], len + trunkR);
  if (!clearTip(d, S.tipLen)) {
    d = [0, 0, -1];
    if (!clearTip(d, S.tipLen)) return null; // contact point is inside a pocket
  }
  let T = [P[0] + d[0] * S.tipLen, P[1] + d[1] * S.tipLen, P[2] + d[2] * S.tipLen];
  if (T[2] <= raftTop + S.baseH + 0.3) {
    // very low contact: short straight tip down to the base
    T = [P[0], P[1], Math.max(raftTop + S.baseH * 0.5, P[2] - S.tipLen)];
    if (T[2] >= P[2]) return null;
  }
  const downClear = (x, y, z) => !bvh.raycast(x, y, z, 0, 0, -1, z - raftTop + 0.01, 0.01);
  let onModel = false, bottom = [T[0], T[1], raftTop];
  if (!downClear(T[0], T[1], T[2])) {
    // try nearby positions for the knee
    let best = null;
    for (const rad of [1.0, 2.0, 3.0, 4.5]) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const K = [T[0] + Math.cos(ang) * rad, T[1] + Math.sin(ang) * rad, T[2] - rad * 0.3];
        const v = [K[0] - P[0], K[1] - P[1], K[2] - P[2]];
        const len = Math.hypot(v[0], v[1], v[2]);
        const dv = [v[0] / len, v[1] / len, v[2] / len];
        if (dv[2] > -0.45) continue;
        if (!clearTip(dv, len)) continue;
        if (!downClear(K[0], K[1], K[2])) continue;
        best = K; break;
      }
      if (best) break;
    }
    if (best) { T = best; bottom = [T[0], T[1], raftTop]; }
    else {
      if (!S.modelResting) return null;
      const hit = bvh.raycast(T[0], T[1], T[2], 0, 0, -1, Infinity, 0.01);
      const zh = T[2] - hit.t;
      onModel = true;
      bottom = [T[0], T[1], zh];
    }
  }
  const len = T[2] - bottom[2];
  trunkR *= 1 + Math.min(0.6, Math.max(0, (len - 20) / 80));
  return { P, n, d, T, bottom, onModel, tipR, trunkR, src: pt.src };
}

/**
 * Build triangle geometry for a list of plans + braces + raft.
 * Returns {tris: Float32Array, parts: [{start, count}] (one per plan, in order), baseFootprint}
 */
export function buildSupportGeometry(plans, S, raftTop) {
  const sides = S.sides || 10;
  const out = [];
  const parts = [];
  for (const pl of plans) {
    const start = out.length / 9;
    const { P, d, T, bottom, tipR, trunkR } = pl;
    // tip: from inside the model to the knee
    const sx = P[0] - d[0] * S.contactDepth, sy = P[1] - d[1] * S.contactDepth, sz = P[2] - d[2] * S.contactDepth;
    frustum(sx, sy, sz, T[0], T[1], T[2], tipR, trunkR * 0.9, sides, out);
    sphere(T[0], T[1], T[2], trunkR * 1.02, 4, out);
    if (!pl.onModel) {
      const baseTop = bottom[2] + S.baseH;
      if (T[2] > baseTop) frustum(T[0], T[1], T[2], T[0], T[1], baseTop - 0.01, trunkR, trunkR, sides, out);
      // base cone sits slightly into the raft (or the plate)
      frustum(T[0], T[1], Math.min(baseTop, T[2]), T[0], T[1], bottom[2] - 0.05, trunkR, S.baseD / 2, sides, out);
    } else {
      const footLen = Math.min(S.tipLen * 0.8, Math.max(0.3, (T[2] - bottom[2]) * 0.5));
      const footTop = bottom[2] + footLen;
      if (T[2] > footTop) frustum(T[0], T[1], T[2], T[0], T[1], footTop, trunkR, trunkR, sides, out);
      frustum(T[0], T[1], Math.min(footTop, T[2]), T[0], T[1], bottom[2] - S.contactDepth, trunkR * 0.9, tipR, sides, out);
    }
    parts.push({ start, count: out.length / 9 - start });
  }
  // braces between neighbouring plate-standing trunks
  const braceStart = out.length / 9;
  if (S.braces) {
    const standing = plans.map((p, i) => ({ p, i })).filter((x) => !x.p.onModel);
    const grid = new Grid2(S.braceMaxDist);
    for (const s of standing) grid.add(Object.assign([s.p.T[0], s.p.T[1]], s));
    const done = new Set();
    for (const a of standing) {
      const nb = [];
      grid.near(a.p.T[0], a.p.T[1], S.braceMaxDist, (b) => {
        if (b.i === a.i) return;
        const dist = Math.hypot(b.p.T[0] - a.p.T[0], b.p.T[1] - a.p.T[1]);
        if (dist > 2.5 && dist <= S.braceMaxDist) nb.push({ b, dist });
      });
      nb.sort((x, y) => x.dist - y.dist);
      for (const { b } of nb.slice(0, 2)) {
        const key = a.i < b.i ? `${a.i}-${b.i}` : `${b.i}-${a.i}`;
        if (done.has(key)) continue;
        done.add(key);
        const z0 = raftTop + S.baseH + 1.5;
        const zTop = Math.min(a.p.T[2], b.p.T[2]) - 2.5;
        let h = z0, flip = false;
        while (h + S.braceStep <= zTop) {
          const A = flip ? b.p : a.p, B = flip ? a.p : b.p;
          frustum(A.T[0], A.T[1], h, B.T[0], B.T[1], h + S.braceStep, S.braceD / 2, S.braceD / 2, 6, out);
          h += S.braceStep; flip = !flip;
        }
      }
    }
  }
  const braceCount = out.length / 9 - braceStart;
  // raft
  const raftStart = out.length / 9;
  const feet = plans.filter((p) => !p.onModel).map((p) => [p.T[0], p.T[1]]);
  if (S.raft === 'slab' && feet.length) raftMesh(feet, S.baseD / 2 + S.raftMargin, raftTop, S.raftChamfer, out);
  return { tris: Float32Array.from(out), parts, braces: { start: braceStart, count: braceCount }, raft: { start: raftStart, count: out.length / 9 - raftStart } };
}

// Convex raft: Minkowski sum of the feet hull with a disc, chamfered top edge.
export function raftMesh(points, radius, height, chamfer, out = []) {
  const hull = convexHull(points);
  const ch = Math.min(chamfer, height * 0.9, radius * 0.8);
  const ring = (rad, z) => {
    const r = [];
    const m = hull.length;
    for (let i = 0; i < m; i++) {
      const p = hull[i], prev = hull[(i + m - 1) % m], next = hull[(i + 1) % m];
      // outward edge normals of incoming and outgoing edges (hull is CCW)
      const a0 = Math.atan2(-(p[0] - prev[0]), p[1] - prev[1]);
      let a1 = Math.atan2(-(next[0] - p[0]), next[1] - p[1]);
      if (m === 1) { for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; r.push([p[0] + Math.cos(a) * rad, p[1] + Math.sin(a) * rad, z]); } return r; }
      while (a1 < a0) a1 += Math.PI * 2;
      const steps = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 12)));
      for (let k = 0; k <= steps; k++) {
        const a = a0 + ((a1 - a0) * k) / steps;
        r.push([p[0] + Math.cos(a) * rad, p[1] + Math.sin(a) * rad, z]);
      }
    }
    return r;
  };
  const bot = ring(radius, 0), mid = ring(radius, height - ch), top = ring(radius - ch, height);
  const n = bot.length;
  const push = (a, b, c) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const cb = centroid(bot), ct = centroid(top);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(cb, bot[j], bot[i]);                  // bottom face (normal -Z)
    push(bot[i], bot[j], mid[j]); push(bot[i], mid[j], mid[i]);  // side wall
    push(mid[i], mid[j], top[j]); push(mid[i], top[j], top[i]);  // chamfer
    push(ct, top[i], top[j]);                  // top face (normal +Z)
  }
  return out;
}

function centroid(r) {
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  return [x / r.length, y / r.length, r[0][2]];
}

export function convexHull(pts) {
  const p = pts.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length <= 1) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  const h = lower.concat(upper);
  // remove duplicates (all points equal)
  return h.length ? h : [p[0]];
}

/**
 * Full pipeline: pick points, route them, then verify with an island check that
 * includes the supports and add points for anything still floating (max 3 rounds).
 */
export function generateSupports(tris, settings, onProgress) {
  const S = { ...DEFAULT_SUPPORT_SETTINGS, ...settings };
  const raftTop = S.raft === 'slab' ? S.raftHeight : 0;
  const bvh = new BVH(tris);
  const points = autoSupportPoints(tris, S, bvh, onProgress);
  let plans = points.map((pt) => planSupport(pt, bvh, S, raftTop)).filter(Boolean);
  // verify against the exact geometry that will be printed (braces + raft included), and
  // always finish on a check: rounds that add supports are followed by another round
  for (let round = 0; round < 5; round++) {
    const geo = buildSupportGeometry(plans, S, raftTop);
    const an = analyzeStack({ model: tris, supports: geo.tris }, { pixel: S.islandPixel, layerHeight: 0.1, voids: false, minIslandArea: S.minIslandArea });
    if (!an.islands.length) break;
    let added = 0;
    for (const isl of an.islands) {
      // the island bottom: first surface above a point slightly below the detected layer
      for (const z0 of [isl.z - 0.16, isl.z - 0.6]) {
        const hit = bvh.raycast(isl.x, isl.y, z0, 0, 0, 1, isl.z - z0 + 0.3);
        if (!hit) continue;
        const pt = { p: [isl.x, isl.y, z0 + hit.t], n: triN(tris, hit.tri), src: 'island' };
        if (pt.n[2] > 0) pt.n = [0, 0, -1];
        const pl = planSupport(pt, bvh, S, raftTop);
        if (pl) { points.push(pt); plans.push(pl); added++; }
        break;
      }
    }
    if (!added) break;
  }
  return { points, plans, raftTop };
}
