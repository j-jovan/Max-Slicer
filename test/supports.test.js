import assert from 'node:assert/strict';
import { sphere, frustum, box, signedVolume } from '../src/core/mesh.js';
import { generateSupports, buildSupportGeometry, DEFAULT_SUPPORT_SETTINGS } from '../src/core/supports.js';
import { analyzeStack } from '../src/core/analysis.js';

function check(name, model) {
  const S = { ...DEFAULT_SUPPORT_SETTINGS };
  const t0 = Date.now();
  const { plans, raftTop, points } = generateSupports(model, S);
  const geo = buildSupportGeometry(plans, S, raftTop);
  const onModel = plans.filter((p) => p.onModel).length;
  console.log(`${name}: ${points.length} points -> ${plans.length} supports (${onModel} on model), ${geo.tris.length / 9} tris, ${Date.now() - t0} ms`);
  assert.ok(plans.length > 0);
  // every part closed + outward
  for (const part of geo.parts) {
    const v = signedVolume(geo.tris.subarray(part.start * 9, (part.start + part.count) * 9));
    assert.ok(v > 0, 'support part volume positive');
  }
  assert.ok(signedVolume(geo.tris.subarray(geo.raft.start * 9, (geo.raft.start + geo.raft.count) * 9)) > 0, 'raft volume positive');
  // after supports: no island may remain above the first layer
  const an = analyzeStack({ model, supports: geo.tris }, { pixel: 0.15, layerHeight: 0.1, voids: false });
  console.log(`  remaining islands: ${an.islands.length}`, an.islands.slice(0, 5).map((i) => `z${i.z.toFixed(2)} (${i.x.toFixed(1)},${i.y.toFixed(1)}) a=${i.area.toFixed(2)}`));
  assert.equal(an.islands.length, 0, `${name}: fully supported`);
  return { plans, geo };
}
// sphere floating 5 mm above a 1 mm raft
check('sphere', Float32Array.from(sphere(0, 0, 16, 10, 40)));
// mushroom: stem + wide cap (cap underside is an overhang/island ring)
check('mushroom', Float32Array.from([...frustum(0, 0, 6, 0, 0, 20, 3, 3, 32), ...frustum(0, 0, 20, 0, 0, 24, 14, 6, 48)]));
// table: top slab on four legs, legs floating; underside of the top must get model-resting or plate supports
check('table', Float32Array.from([...box(-15, -10, 20, 15, 10, 22), ...box(-14, -9, 6, -12, -7, 20), ...box(12, -9, 6, 14, -7, 20), ...box(-14, 7, 6, -12, 9, 20), ...box(12, 7, 6, 14, 9, 20)]));
console.log('supports OK');
