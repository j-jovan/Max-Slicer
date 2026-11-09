import assert from 'node:assert/strict';
import { box, frustum } from '../src/core/mesh.js';
import { autoOrient, quatFromTo } from '../src/core/orient.js';

// quaternion sanity: rotate a onto b
const rot = (q, v) => {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
for (const a of [[1, 0, 0], [0, 0, -1], [0.3, -0.5, 0.8]]) {
  const l = Math.hypot(...a); const u = a.map((x) => x / l);
  const r = rot(quatFromTo(u, [0, 0, 1]), u);
  assert.ok(Math.abs(r[2] - 1) < 1e-9, 'quat maps to +Z');
}
// flat plate 60x40x2: printing it flat (huge cross-section) is worst for peel; expect a tilt
const plate = Float32Array.from(box(-30, -20, 0, 30, 20, 2));
const r = autoOrient(plate, { goal: 'balanced' });
const tilt = Math.acos(Math.abs(r.up[2])) * 180 / Math.PI;
console.log('plate up', r.up.map((x) => x.toFixed(2)), 'tilt from flat', tilt.toFixed(1), r.details);
assert.ok(tilt > 20, 'plate is tilted, not printed flat');
// cone with tip at top: should keep wide base down? (base flat => flat penalty) -> any non-flat; just ensure it runs
const cone = Float32Array.from(frustum(0, 0, 0, 0, 0, 30, 10, 0.5, 32));
const rc = autoOrient(cone, { goal: 'supports' });
console.log('cone (min supports) up', rc.up.map((x) => x.toFixed(2)), rc.details);
console.log('orient OK');
