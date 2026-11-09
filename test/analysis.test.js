import assert from 'node:assert/strict';
import { box, frustum } from '../src/core/mesh.js';
import { analyzeStack } from '../src/core/analysis.js';

const T = (a) => Float32Array.from(a);
// 1) open cup on the plate: floor 2 mm, walls 2 mm, inner 20x20, height 15, open top
{
  const cup = [...box(-12, -12, 0, 12, 12, 2), ...box(-12, -12, 0, -10, 12, 15), ...box(10, -12, 0, 12, 12, 15), ...box(-10, -12, 0, 10, -10, 15), ...box(-10, 10, 0, 10, 12, 15)];
  const r = analyzeStack({ model: T(cup) }, { pixel: 0.2, layerHeight: 0.1 });
  console.log('cup suction:', r.suction.map((s) => `z ${s.z0.toFixed(1)}-${s.z1.toFixed(1)} area ${s.maxArea.toFixed(0)} @(${s.x.toFixed(1)},${s.y.toFixed(1)})`), 'trapped', r.trapped.length);
  assert.equal(r.suction.length, 1, 'one suction cup');
  assert.ok(Math.abs(r.suction[0].maxArea - 400) < 20, 'suction area ~ 20x20');
  assert.ok(Math.abs(r.suction[0].x) < 0.5 && Math.abs(r.suction[0].y) < 0.5, 'centred');
  assert.equal(r.trapped.length, 0, 'open cup traps nothing');
  assert.equal(r.islands.length, 0, 'no islands');
}
// 2) closed hollow box -> trapped volume ~ 20*20*11
{
  const shell = [...box(-12, -12, 0, 12, 12, 2), ...box(-12, -12, 13, 12, 12, 15), ...box(-12, -12, 2, -10, 12, 13), ...box(10, -12, 2, 12, 12, 13), ...box(-10, -12, 2, 10, -10, 13), ...box(-10, 10, 2, 10, 12, 13)];
  const r = analyzeStack({ model: T(shell) }, { pixel: 0.2, layerHeight: 0.1 });
  console.log('closed box trapped:', r.trapped.map((t) => t.volume.toFixed(0)));
  assert.equal(r.trapped.length, 1);
  assert.ok(Math.abs(r.trapped[0].volume - 4400) / 4400 < 0.03, 'trapped volume');
  // same box with a drain hole through the side wall near the floor -> nothing trapped
  const hole = T(box(9, -2, 3, 13, 2, 6));
  const r2 = analyzeStack({ model: T(shell), holes: hole }, { pixel: 0.2, layerHeight: 0.1 });
  console.log('with hole trapped:', r2.trapped.length, 'suction:', r2.suction.map((s) => `${s.z0.toFixed(1)}-${s.z1.toFixed(1)}`));
  assert.equal(r2.trapped.length, 0, 'drain hole vents cavity');
}
// 3) floating block (island) above the plate
{
  const r = analyzeStack({ model: T([...box(0, 0, 0, 5, 5, 5), ...box(20, 0, 3, 25, 5, 8)]) }, { pixel: 0.2, layerHeight: 0.1, voids: false });
  console.log('islands:', r.islands.map((i) => `z ${i.z.toFixed(2)} (${i.x.toFixed(1)},${i.y.toFixed(1)}) area ${i.area.toFixed(1)}`));
  assert.equal(r.islands.length, 1);
  assert.ok(Math.abs(r.islands[0].z - 3.05) < 0.11 && Math.abs(r.islands[0].x - 22.5) < 0.3 && Math.abs(r.islands[0].y - 2.5) < 0.3);
}
console.log('analysis OK');
// 4) auto drain holes on a U-shaped hollow part with two separate lobes
{
  const { computeCavity } = await import('../src/core/hollow.js');
  const { autoDrainHoles } = await import('../src/core/drain.js');
  // two legs (separate lobes at the bottom) joined by a bridge on top
  const u = Float32Array.from([...box(-20, -6, 0, -8, 6, 30), ...box(8, -6, 0, 20, 6, 30), ...box(-20, -6, 30, 20, 6, 42)]);
  const { repairMesh } = await import('../src/core/mesh.js');
  // boxes overlap at the joints -> slice as union; cavity from the union via voxels
  const cav = computeCavity(u, { wall: 2 }).cavity;
  const fmtH = (hs) => hs.map((h) => `(${h.p.map((v) => v.toFixed(1))}) dir (${h.dir.join(',')}) depth ${h.depth.toFixed(1)}`);
  // a) elevated on supports: holes go straight down through the leg floors
  const up = u.map((v, i) => (i % 3 === 2 ? v + 6 : v));
  const cavUp = cav.map((v, i) => (i % 3 === 2 ? v + 6 : v));
  const holes = autoDrainHoles({ model: up, cavity: cavUp }, { diameter: 3 });
  console.log('elevated:', fmtH(holes));
  assert.equal(holes.length, 2, 'one hole per leg');
  assert.ok(holes.every((h) => h.dir[2] === 1), 'vertical holes');
  assert.ok(holes.some((h) => h.p[0] < 0) && holes.some((h) => h.p[0] > 0), 'holes in both legs');
  // b) sitting on the plate: bottom faces are sealed by the plate -> side holes
  const onPlate = autoDrainHoles({ model: u, cavity: cav }, { diameter: 3 });
  console.log('on plate:', fmtH(onPlate));
  assert.equal(onPlate.length, 2);
  assert.ok(onPlate.every((h) => h.dir[2] === 0 && h.p[2] > 1.5), 'side holes above the plate');
  const verify = analyzeStack({ model: u, cavity: cav, holes: Float32Array.from(onPlate.flatMap((h) => frustum(h.p[0] - h.dir[0], h.p[1] - h.dir[1], h.p[2], h.p[0] + h.dir[0] * (h.depth - 1), h.p[1] + h.dir[1] * (h.depth - 1), h.p[2], 1.5, 1.5, 24))) }, { pixel: 0.25, layerHeight: 0.1, islands: false });
  assert.equal(verify.trapped.length, 0, 'nothing trapped after auto holes');
  void repairMesh;
}
console.log('drain OK');
