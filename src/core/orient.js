// Automatic orientation: evaluates candidate "up" directions and scores support area,
// peel (largest cross-section), print height and flat down-facing areas.
import { voxelize } from './voxel.js';
import { bounds } from './mesh.js';

export const ORIENT_GOALS = {
  balanced: { sup: 1.0, peel: 1.0, height: 0.35, flat: 1.5 },
  supports: { sup: 3.0, peel: 0.5, height: 0.1, flat: 1.0 },
  height: { sup: 0.6, peel: 0.5, height: 3.0, flat: 1.0 },
  peel: { sup: 0.6, peel: 3.0, height: 0.2, flat: 2.0 },
};

function fib(n) {
  const out = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out.push([Math.cos(g * i) * r, Math.sin(g * i) * r, y]);
  }
  return out;
}

/**
 * tris: model in its current orientation (any position).
 * Returns {up:[x,y,z], quaternion:[x,y,z,w] rotating `up` onto +Z, score, details}
 */
export function autoOrient(tris, opts = {}) {
  const W = ORIENT_GOALS[opts.goal || 'balanced'];
  const angle = ((opts.angle ?? 45) * Math.PI) / 180;
  const cosT = Math.cos(angle);
  const cosRamp = Math.cos(Math.min(Math.PI / 2 - 0.05, angle + (15 * Math.PI) / 180));
  // 1) area-weighted normals, binned
  const nT = tris.length / 9;
  const BINS = 3000;
  const dirs = fib(BINS);
  const binArea = new Float64Array(BINS), binN = new Float64Array(BINS * 3);
  let totalArea = 0;
  // bin lookup via coarse lat/long table
  const LUT_A = 64, LUT_B = 128;
  const lut = new Int32Array(LUT_A * LUT_B);
  for (let a = 0; a < LUT_A; a++) for (let b = 0; b < LUT_B; b++) {
    const th = ((a + 0.5) / LUT_A) * Math.PI, ph = ((b + 0.5) / LUT_B) * 2 * Math.PI;
    const v = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
    let best = 0, bd = -2;
    for (let i = 0; i < BINS; i++) { const d = v[0] * dirs[i][0] + v[1] * dirs[i][1] + v[2] * dirs[i][2]; if (d > bd) { bd = d; best = i; } }
    lut[a * LUT_B + b] = best;
  }
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l === 0) continue;
    const area = l / 2;
    const th = Math.acos(Math.max(-1, Math.min(1, nz / l))), ph = Math.atan2(ny, nx) + (ny < 0 ? 2 * Math.PI : 0);
    const a = Math.min(LUT_A - 1, Math.floor((th / Math.PI) * LUT_A)), b = Math.min(LUT_B - 1, Math.floor((ph / (2 * Math.PI)) * LUT_B));
    const bin = lut[a * LUT_B + b];
    binArea[bin] += area;
    binN[bin * 3] += (nx / l) * area; binN[bin * 3 + 1] += (ny / l) * area; binN[bin * 3 + 2] += (nz / l) * area;
    totalArea += area;
  }
  const bins = [];
  for (let i = 0; i < BINS; i++) if (binArea[i] > 0) {
    const l = Math.hypot(binN[i * 3], binN[i * 3 + 1], binN[i * 3 + 2]) || 1;
    bins.push([binN[i * 3] / l, binN[i * 3 + 1] / l, binN[i * 3 + 2] / l, binArea[i]]);
  }
  // 2) interior sample points for cross-section estimation
  const b = bounds(tris);
  const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const vol = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
  const vs = Math.max(ext / 200, Math.cbrt(vol / 250000));
  const vox = voxelize(tris, vs, 1);
  const P = [];
  const { nx, ny, nz, solid } = vox;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (solid[(k * ny + j) * nx + i]) P.push(vox.ox + (i + 0.5) * vs, vox.oy + (j + 0.5) * vs, vox.oz + (k + 0.5) * vs);
  }
  const pts = Float64Array.from(P);
  const nP = pts.length / 3;
  const cellVol = vs * vs * vs;
  // hull-ish vertex sample for height
  const vstep = Math.max(1, Math.floor(nT / 20000));
  const evalUp = (u) => {
    let sup = 0, flat = 0;
    for (const [x, y, z, a] of bins) {
      const d = x * u[0] + y * u[1] + z * u[2];
      // support need ramps from 0 (15° steeper than the overhang angle) to 1 (horizontal)
      if (d < -cosRamp) sup += a * -d * Math.min(1, (-d - cosRamp) / (cosT - cosRamp + 1e-9) * 0.5 + Math.max(0, (-d - cosT) / (1 - cosT + 1e-9)) * 0.5);
      if (d < -0.985) flat += a;
    }
    let hmin = Infinity, hmax = -Infinity;
    for (let t = 0; t < nT; t += vstep) {
      const o = t * 9;
      for (let c = 0; c < 9; c += 3) { const h = tris[o + c] * u[0] + tris[o + c + 1] * u[1] + tris[o + c + 2] * u[2]; if (h < hmin) hmin = h; if (h > hmax) hmax = h; }
    }
    // cross-section histogram (0.5 mm slabs)
    const slab = Math.max(0.5, vs);
    const nb = Math.ceil((hmax - hmin) / slab) + 2;
    const hist = new Float64Array(nb);
    for (let i = 0; i < nP; i++) {
      const h = pts[i * 3] * u[0] + pts[i * 3 + 1] * u[1] + pts[i * 3 + 2] * u[2];
      const k = Math.floor((h - hmin) / slab);
      if (k >= 0 && k < nb) hist[k]++;
    }
    let peak = 0;
    for (let k = 0; k < nb; k++) if (hist[k] > peak) peak = hist[k];
    const peel = (peak * cellVol) / slab;
    return { sup, flat, peel, height: hmax - hmin };
  };
  const cands = fib(opts.samples || 500);
  for (const c of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) cands.push(c);
  const evals = cands.map((u) => ({ u, ...evalUp(u) }));
  const maxPeel = Math.max(...evals.map((e) => e.peel)) || 1;
  const maxH = Math.max(...evals.map((e) => e.height)) || 1;
  const score = (e) => W.sup * (e.sup / (totalArea || 1)) * 4 + W.peel * (e.peel / maxPeel) + W.height * (e.height / maxH) + W.flat * (e.flat / (totalArea || 1)) * 4;
  // printable height limit
  const maxZ = opts.maxHeight ?? 290;
  let best = null;
  for (const e of evals) { e.score = score(e) + (e.height > maxZ ? 100 : 0); if (!best || e.score < best.score) best = e; }
  // 3) local refinement around the best candidate
  let step = 0.12;
  for (let it = 0; it < 30 && step > 0.004; it++) {
    let improved = false;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const u = normalize([best.u[0] + dx * step, best.u[1] + dy * step, best.u[2] + dz * step]);
      const e = { u, ...evalUp(u) };
      e.score = score(e) + (e.height > maxZ ? 100 : 0);
      if (e.score < best.score - 1e-9) { best = e; improved = true; }
    }
    if (!improved) step *= 0.5;
  }
  return { up: best.u, quaternion: quatFromTo(best.u, [0, 0, 1]), score: best.score, details: { supportArea: best.sup, peelArea: best.peel, height: best.height } };
}

function normalize(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

// quaternion rotating unit vector a onto unit vector b
export function quatFromTo(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    // 180°: any orthogonal axis
    let ax = [1, 0, 0];
    if (Math.abs(a[0]) > 0.9) ax = [0, 1, 0];
    const c = normalize([a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]]);
    return [c[0], c[1], c[2], 0];
  }
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const q = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(...q);
  return q.map((x) => x / l);
}
