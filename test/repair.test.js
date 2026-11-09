import assert from 'node:assert/strict';
import { box, sphere, repairMesh, signedVolume, flipAll } from '../src/core/mesh.js';
// cube with two faces' triangles removed (two square holes), plus random flipped faces
const c = box(0, 0, 0, 10, 10, 10);
// faces: bottom(0,1) top(2,3) front back sides; drop bottom and top -> two separate holes
const t = Float32Array.from(c.slice(9 * 4));
for (const k of [1, 4]) { const tri = t.subarray(k * 9, k * 9 + 9); flipAll(tri); }
const r = repairMesh(t);
console.log(r.report);
assert.equal(r.report.holesFilled, 2);
assert.ok(Math.abs(signedVolume(r.tris) - 1000) < 1e-6, 'closed cube volume');
// closed sphere untouched
const s = repairMesh(Float32Array.from(sphere(0, 0, 0, 5, 16)));
assert.equal(s.report.holesFilled, 0); assert.equal(s.report.openEdges, 0);
// inside-out mesh fixed
const inv = flipAll(Float32Array.from(box(0, 0, 0, 2, 2, 2)));
assert.ok(signedVolume(repairMesh(inv).tris) > 7.99);
console.log('repair OK');
