// Saturn 4 Ultra 16K: primitives -> slice -> .goo; pixel-exact geometry with 14 x 19 µm pixels.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { box } from '../src/core/mesh.js';
import { createLayerContext, renderLayer, finishLayer } from '../src/core/layerjob.js';
import { buildGOO, readGOO } from '../src/core/goo.js';
import { SATURN4U16K as P, SATURN_PROFILE } from '../src/core/printer.js';
import { printTime } from '../src/core/estimate.js';

const model = Float32Array.from([...box(-10, -10, 0, 10, 10, 20), ...box(40, 30, 0, 46, 36, 6)]);
const profile = { ...SATURN_PROFILE, currencyCode: 'EUR' };
const n = Math.ceil(20 / profile.layerHeight);
const ctx = createLayerContext({ model, layerHeight: profile.layerHeight, aa: 1 }, P);
const layers = [], stats = [];
let L5;
for (let k = 0; k < n; k++) {
  const img = renderLayer(ctx, k);
  if (k === 5) L5 = img.slice();
  const r = finishLayer(ctx, img);
  layers.push(r.packed.data); stats.push(r.stat);
}
const span = (a, b) => [Math.ceil(a - 0.5), Math.ceil(b - 0.5)];
const hw = P.displayW / 2, hh = P.displayH / 2;
// u = (hw + x)/pixelX, v = (hh + y)/pixelY  (top view mirrored vertically)
const [u0, u1] = span((hw - 10) / P.pixelX, (hw + 10) / P.pixelX);
const [v0, v1] = span((hh - 10) / P.pixelY, (hh + 10) / P.pixelY);
const cnt = (r0, r1, c0, c1) => { let s = 0; for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) s += L5[r * P.resX + c] ? 1 : 0; return s; };
assert.equal(cnt(v0, v1, u0, u1), (u1 - u0) * (v1 - v0), 'cube fully filled');
assert.equal(cnt(v0 - 2, v0, u0, u1) + cnt(v1, v1 + 2, u0, u1) + cnt(v0, v1, u0 - 2, u0) + cnt(v0, v1, u1, u1 + 2), 0, 'nothing outside cube edges');
console.log(`cube: ${u1 - u0} x ${v1 - v0} px (expect ~${(20 / P.pixelX).toFixed(1)} x ${(20 / P.pixelY).toFixed(1)})`);
// marker at +X +Y lands at larger column and larger row
const [m0, m1] = span((hw + 40) / P.pixelX, (hw + 46) / P.pixelX), [r0, r1] = span((hh + 30) / P.pixelY, (hh + 36) / P.pixelY);
assert.equal(cnt(r0, r1, m0, m1), (m1 - m0) * (r1 - r0), 'marker at mirrored location');
const vol = stats.reduce((s, x) => s + x.area, 0) * profile.layerHeight / 1000;
console.log(`volume ${vol.toFixed(3)} ml (analytic 8.216)`);
assert.ok(Math.abs(vol - 8.216) / 8.216 < 0.01);
const prev = (w) => ({ rgba: new Uint8Array(w * w * 4).fill(200), w, h: w });
const chunks = buildGOO({ printer: P, profile, aa: 1, layers, previews: [prev(116), prev(290)], printTime: printTime(profile, n, 0, P.layerOverhead), volumeMl: vol });
fs.mkdirSync('test/out', { recursive: true });
const fd = fs.openSync('test/out/basic.goo', 'w'); for (const c of chunks) fs.writeSync(fd, c); fs.closeSync(fd);
const g = readGOO(new Uint8Array(fs.readFileSync('test/out/basic.goo')));
assert.equal(g.layerCount, n);
assert.deepEqual(g.layerImage(5), L5, 'round trip layer 5');
console.log('slice-goo OK');
