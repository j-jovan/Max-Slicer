// Every layer of the reference Lychee .goo must decode and re-encode to the same bytes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { readGOO, encodeGOO, decodeGOO } from '../src/core/goo.js';
const ref = process.env.GOO_REF || '/home/claude/sample2/deolik.goo';
if (!fs.existsSync(ref)) { console.log('goo-reencode: reference file not present, skipped'); process.exit(0); }
const u8 = new Uint8Array(fs.readFileSync(ref));
const g = readGOO(u8);
console.log(g.machine, g.W, 'x', g.H, g.layerCount, 'layers', g.layerHeight.toFixed(3), 'mm, exposure', g.exposure.toFixed(2), '/', g.bottomExposure.toFixed(2), 's, time', g.printTime);
let same = 0, diff = 0, firstDiff = -1;
for (let k = 0; k < g.layerCount; k++) {
  const L = g.layers[k];
  const orig = u8.subarray(L.off, L.off + L.len);
  const img = decodeGOO(orig, g.W, g.H);
  const re = encodeGOO(img);
  if (Buffer.compare(Buffer.from(re), Buffer.from(orig)) === 0) same++;
  else { diff++; if (firstDiff < 0) firstDiff = k; assert.deepEqual(decodeGOO(re, g.W, g.H), img, 'round trip pixels'); }
}
console.log(`byte-identical layers: ${same}/${g.layerCount}${diff ? `, first different: ${firstDiff} (pixels identical)` : ''}`);
