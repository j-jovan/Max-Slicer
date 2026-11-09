// Automatic drain-hole placement: vertical holes from the outer skin up into every
// cavity pocket that would otherwise seal (suction) or trap resin.
import { BVH } from './bvh.js';
import { frustum, concatTris } from './mesh.js';
import { analyzeStack } from './analysis.js';

/**
 * model, cavity: world-space tris of ONE model; others: {supports, holes} context.
 * Returns [{p:[x,y,z] skin point, dir:[x,y,z] into the model, depth}].
 */
export function autoDrainHoles({ model, cavity, existingHoles, supports }, { diameter = 3, maxHoles = 6, onProgress } = {}) {
  const out = [];
  if (!cavity || !cavity.length) return out;
  const bvhM = new BVH(model), bvhC = new BVH(cavity);
  const holeTris = [];
  if (existingHoles && existingHoles.length) holeTris.push(existingHoles);
  // Hole from inside the cavity to the nearest outer skin. Prefer straight down (best
  // drainage toward the vat); if that exits on a face resting on the plate (sealed by
  // the plate), go sideways through the closest wall instead.
  const add = (x, y, z) => {
    let best = null;
    const down = bvhM.raycast(x, y, z, 0, 0, -1);
    if (down && z - down.t > 0.3) best = { dir: [0, 0, 1], dist: down.t, skin: [x, y, z - down.t] };
    if (!best) {
      const zz = Math.max(z, diameter / 2 + 0.6);
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2, dx = Math.cos(ang), dy = Math.sin(ang);
        const hit = bvhM.raycast(x, y, zz, dx, dy, 0);
        if (hit && (!best || hit.t < best.dist)) best = { dir: [-dx, -dy, 0], dist: hit.t, skin: [x + dx * hit.t, y + dy * hit.t, zz] };
      }
    }
    if (!best) return false;
    const [sx, sy, sz] = best.skin;
    if (out.some((h) => Math.hypot(h.p[0] - sx, h.p[1] - sy, h.p[2] - sz) < diameter * 1.5)) return false;
    const depth = best.dist + 1.5;
    const d = best.dir;
    out.push({ p: [sx, sy, sz], dir: d, depth });
    holeTris.push(Float32Array.from(frustum(sx - d[0], sy - d[1], sz - d[2], sx + d[0] * (depth - 1), sy + d[1] * (depth - 1), sz + d[2] * (depth - 1), diameter / 2, diameter / 2, 24)));
    return true;
  };
  // 1) the lowest cavity point (unless an existing hole already vents it)
  if (!existingHoles || !existingHoles.length) {
    let low = null;
    for (let i = 0; i < cavity.length; i += 3) if (!low || cavity[i + 2] < low[2]) low = [cavity[i], cavity[i + 1], cavity[i + 2]];
    add(low[0], low[1], low[2] + 0.3);
  }
  // 2) iterate: every pocket that still seals inside the cavity gets a hole at its bottom
  for (let round = 0; round < 5 && out.length < maxHoles; round++) {
    onProgress?.(round / 5, 'drain holes');
    const an = analyzeStack({ model, supports, cavity, holes: concatTris(holeTris) }, { pixel: 0.25, layerHeight: 0.1, islands: false });
    const pockets = [...an.suction, ...an.trapped.filter((t) => t.bottom)]
      .filter((e) => e.bottom && bvhC.isInside(e.bottom[0], e.bottom[1], e.bottom[2]))
      .sort((a, b) => a.bottom[2] - b.bottom[2]);
    let added = 0;
    for (const e of pockets) {
      if (out.length >= maxHoles) break;
      if (add(e.bottom[0], e.bottom[1], e.bottom[2] + 0.05)) added++;
    }
    if (!added) break;
  }
  return out;
}
