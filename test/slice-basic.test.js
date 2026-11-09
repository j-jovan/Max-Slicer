// End-to-end: primitives -> slice -> .pm7m on disk; checks pixel-exact geometry.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { box, sphere, frustum, signedVolume, concatTris } from '../src/core/mesh.js';
import { createLayerContext, renderLayer, finishLayer } from '../src/core/layerjob.js';
import { buildPM7M, readPM7M } from '../src/core/pm7m.js';
import { DEFAULT_PROFILE, M7MAX } from '../src/core/printer.js';
import { heightmapPreview } from '../src/core/png.js';
import { printTime } from '../src/core/estimate.js';
import { concatChunks } from '../src/core/zip.js';

// Orientation sanity of primitives
assert.ok(signedVolume(Float32Array.from(box(0, 0, 0, 1, 1, 1))) > 0.999, 'box outward');
assert.ok(signedVolume(Float32Array.from(frustum(0, 0, 0, 0, 0, 5, 1, 1, 32))) > 0, 'frustum outward');
assert.ok(signedVolume(Float32Array.from(frustum(0, 0, 0, 3, 1, 0.5, 1, 0.4, 12))) > 0, 'tilted frustum outward');
assert.ok(signedVolume(Float32Array.from(sphere(0, 0, 0, 2, 12))) > 0, 'sphere outward');

// Scene: 20 mm cube centred, a 6 mm marker cube at +X/+Y (back-right), a sphere overlapping the cube
const cube = box(-10, -10, 0, 10, 10, 20);
const marker = box(40, 30, 0, 46, 36, 6);
const ball = sphere(10, 0, 10, 4, 16); // overlaps cube face: union must stay solid
const model = Float32Array.from([...cube, ...marker, ...ball]);
const profile = { ...DEFAULT_PROFILE, layerHeight: 0.05 };
const layers = Math.ceil(20 / profile.layerHeight);
const job = { model, supports: new Float32Array(0), layerHeight: profile.layerHeight, aa: 1, blur: 0 };
const ctx = createLayerContext(job);
const packed = [], stats = [];
let pixelsL10 = null;
const t0 = Date.now();
for (let k = 0; k < layers; k++) {
  const img = renderLayer(ctx, k);
  if (k === 10) pixelsL10 = img.slice();
  const r = finishLayer(ctx, img);
  packed.push(r.packed); stats.push(r.stat);
}
console.log(`sliced ${layers} layers in ${Date.now() - t0} ms`);

// Expected pixel extents (pixel-centre sampling)
const P = M7MAX.pixelMm, hw = M7MAX.displayW / 2, hh = M7MAX.displayH / 2;
const span = (a, b) => [Math.ceil(a - 0.5), Math.ceil(b - 0.5)]; // [c0, c1)
const [cu0, cu1] = span((hw - 10) / P, (hw + 10) / P);
const [cv0, cv1] = span((hh - 10) / P, (hh + 10) / P);
// Cube interior at layer 10 (z=0.525), check a row through the cube centre, away from sphere
{
  const r = Math.floor((cv0 + cv1) / 2) - 150; // sphere spans y in [-4,4]; row offset 150 px = 6.9 mm
  const row = pixelsL10.subarray(r * M7MAX.resX, (r + 1) * M7MAX.resX);
  let first = -1, last = -1;
  for (let c = 2900; c < 3500; c++) if (row[c]) { if (first < 0) first = c; last = c; }
  assert.equal(first, cu0, 'cube left edge column');
  assert.equal(last + 1, cu1, 'cube right edge column');
}
// Marker at +X +Y must appear at SMALLER column (mirrored X) and SMALLER row (back = image top)
{
  const [mu0, mu1] = span((hw - 46) / P, (hw - 40) / P);
  const [mv0, mv1] = span((hh - 36) / P, (hh - 30) / P);
  let cnt = 0;
  for (let r = mv0; r < mv1; r++) for (let c = mu0; c < mu1; c++) cnt += pixelsL10[r * M7MAX.resX + c] ? 1 : 0;
  assert.equal(cnt, (mu1 - mu0) * (mv1 - mv0), 'marker fully filled at mirrored location');
  console.log(`marker block ${mu1 - mu0}x${mv1 - mv0}px at col ${mu0}, row ${mv0}`);
}
// Layer 10 has 2 objects (cube+ball union, marker); layer 150 (z=7.5) has 1 (marker ends at 6)
assert.equal(stats[10].objects, 2, 'two objects at layer 10');
assert.equal(stats[150].objects, 1, 'one object at layer 150');
// Union check: sphere overlaps cube -> inside overlap must be solid (no cancellation)
{
  const k = 200; // z = 10.025, sphere centre plane
  const ctx2 = createLayerContext(job);
  let img;
  for (let i = 0; i <= k; i++) img = renderLayer(ctx2, i);
  const r = Math.round(hh / P);
  const c = Math.round((hw - 9) / P); // x=9mm inside both cube and ball
  assert.equal(img[r * M7MAX.resX + c], 255, 'overlap stays solid');
  const cOut = Math.round((hw - 13.5) / P); // x=13.5 inside ball only
  assert.equal(img[r * M7MAX.resX + cOut], 255, 'ball outside cube solid');
}

const volumeMl = stats.reduce((s, x) => s + x.area, 0) * profile.layerHeight / 1000;
const expectVol = (20 * 20 * 20 + 6 * 6 * 6 + (4 / 3) * Math.PI * 64 - overlapCap(4, 4 - 0)) / 1000;
console.log(`volume ${volumeMl.toFixed(3)} ml (analytic ~${expectVol.toFixed(3)})`);
assert.ok(Math.abs(volumeMl - expectVol) / expectVol < 0.01, 'volume within 1%');

const previews = M7MAX.previewSizes.map(([w, h]) => heightmapPreview(model, w, h));
const chunks = buildPM7M({ profile, aa: 1, layers: packed, stats, previews, printTime: printTime(profile, layers), volumeMl });
fs.mkdirSync('test/out', { recursive: true });
const file = concatChunks(chunks);
fs.writeFileSync('test/out/basic.pm7m', file);

// Read back with our reader
const rd = readPM7M(file);
assert.equal(rd.layerCount, layers);
const back = rd.layerImage(10);
assert.deepEqual(Buffer.from(back), Buffer.from(pixelsL10), 'round-trip layer 10');
console.log('slice-basic OK', file.length, 'bytes');

// volume of the sphere cap that lies inside the cube (sphere centre on cube face x=10)
function overlapCap(r) { return (2 / 3) * Math.PI * r * r * r; }
