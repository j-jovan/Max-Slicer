import assert from 'node:assert/strict';
import { sphere, box, signedVolume } from '../src/core/mesh.js';
import { voxelize } from '../src/core/voxel.js';
import { computeCavity } from '../src/core/hollow.js';
import { BVH } from '../src/core/bvh.js';

// voxelisation volume of a 20 mm cube
{
  const v = voxelize(Float32Array.from(box(0, 0, 0, 20, 20, 20)), 0.5);
  let n = 0;
  for (const s of v.solid) n += s;
  assert.equal(n * 0.125, 8000, 'cube voxel volume exact');
}
// sphere r=20, wall 2 -> cavity ~ sphere r=18
{
  const s = Float32Array.from(sphere(0, 0, 30, 20, 48));
  const t0 = Date.now();
  const r = computeCavity(s, { wall: 2 });
  const ideal = (4 / 3) * Math.PI * 18 ** 3;
  console.log(`cavity ${r.cavity.length / 9} tris, vol ${r.cavityVolume.toFixed(0)} vs ideal ${ideal.toFixed(0)} (voxel ${r.voxelSize} mm) in ${Date.now() - t0} ms`);
  assert.ok(r.cavityVolume > 0, 'cavity outward oriented');
  assert.ok(Math.abs(r.cavityVolume - ideal) / ideal < 0.06, 'cavity volume within 6%');
  // every cavity vertex must be >= ~wall from the outer surface: radius <= 18 + tolerance
  let maxR = 0, minR = Infinity;
  for (let i = 0; i < r.cavity.length; i += 3) {
    const d = Math.hypot(r.cavity[i], r.cavity[i + 1], r.cavity[i + 2] - 30);
    maxR = Math.max(maxR, d); minR = Math.min(minR, d);
  }
  console.log(`cavity radius range ${minR.toFixed(2)}..${maxR.toFixed(2)} (target 18)`);
  assert.ok(maxR < 18 + 0.35 && minR > 18 - 0.8, 'wall thickness respected');
  // closedness: a point at the centre is inside the cavity mesh, a point in the wall is not
  const bvh = new BVH(r.cavity);
  assert.ok(bvh.isInside(0, 0, 30), 'centre inside cavity');
  assert.ok(!bvh.isInside(19, 0, 30), 'wall not in cavity');
}
// thin plate (1 mm) with wall 2 -> no cavity
{
  const r = computeCavity(Float32Array.from(box(0, 0, 0, 30, 30, 1)), { wall: 2 });
  assert.equal(r.cavity.length, 0, 'thin part not hollowed');
}
console.log('hollow OK');
void signedVolume;
