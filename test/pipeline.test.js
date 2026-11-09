// Realistic end-to-end run on a scanned mesh, mirroring what the app does.
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { loadMeshFile, repairMesh, bounds, transformTris, frustum, concatTris, signedVolume } from '../src/core/mesh.js';
import { autoOrient } from '../src/core/orient.js';
import { generateSupports, buildSupportGeometry, DEFAULT_SUPPORT_SETTINGS } from '../src/core/supports.js';
import { computeCavity } from '../src/core/hollow.js';
import { analyzeStack } from '../src/core/analysis.js';
import { createLayerContext, renderLayer, finishLayer } from '../src/core/layerjob.js';
import { buildPM7M } from '../src/core/pm7m.js';
import { DEFAULT_PROFILE, M7MAX } from '../src/core/printer.js';
import { heightmapPreview } from '../src/core/png.js';
import { printTime, formatDuration } from '../src/core/estimate.js';
import { BVH } from '../src/core/bvh.js';

if (!isMainThread) {
  const ctx = createLayerContext(workerData.job);
  const out = [];
  for (let k = workerData.k0; k < workerData.k1; k++) { const r = finishLayer(ctx, renderLayer(ctx, k)); out.push({ k, stat: r.stat, packed: r.packed }); }
  parentPort.postMessage(out);
} else {
  const T = Date.now();
  const lap = (m) => console.log(`[${((Date.now() - T) / 1000).toFixed(1)}s] ${m}`);
  const file = process.argv[2] || '/home/claude/models/armadillo.obj';
  const raw = loadMeshFile(file, fs.readFileSync(file).buffer);
  const rep = repairMesh(raw[0].tris);
  lap(`loaded ${rep.report.output} tris, shells ${rep.report.shells}, open edges ${rep.report.openEdges}, flipped ${rep.report.flippedFaces}`);
  let tris = rep.tris;
  // scale to 80 mm tall (Y-up OBJ -> Z-up)
  let b = bounds(tris);
  const s = 80 / (b.max[1] - b.min[1]);
  const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
  // rotate +90 about X (Y up -> Z up), scale, centre
  const M = [s, 0, 0, 0, 0, 0, s, 0, 0, -s, 0, 0, -c[0] * s, c[2] * s, -c[1] * s, 1];
  tris = transformTris(tris, M);
  assert.ok(signedVolume(tris) > 0, 'outward after transform');
  b = bounds(tris);
  lap(`scaled: ${(b.max[0] - b.min[0]).toFixed(1)} x ${(b.max[1] - b.min[1]).toFixed(1)} x ${(b.max[2] - b.min[2]).toFixed(1)} mm, volume ${(signedVolume(tris) / 1000).toFixed(1)} ml`);
  const o = autoOrient(tris, { goal: 'balanced' });
  lap(`auto-orient up=[${o.up.map((x) => x.toFixed(2))}] details ${JSON.stringify(o.details)}`);
  // apply orientation quaternion
  const [qx, qy, qz, qw] = o.quaternion;
  const R = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw), 0, 2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw), 0, 2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy), 0, 0, 0, 0, 1];
  tris = transformTris(tris, R);
  // hollow in this frame
  const hol = computeCavity(tris, { wall: 2 });
  lap(`hollow: cavity ${(hol.cavityVolume / 1000).toFixed(1)} ml of ${(hol.modelVolume / 1000).toFixed(1)} ml (voxel ${hol.voxelSize.toFixed(2)} mm, ${hol.cavity.length / 9} tris)`);
  // lift for supports
  b = bounds(tris);
  const S = { ...DEFAULT_SUPPORT_SETTINGS };
  const dz = S.raftHeight + S.elevation - b.min[2];
  const lift = (t) => { const o2 = t.slice(); for (let i = 2; i < o2.length; i += 3) o2[i] += dz; return o2; };
  tris = lift(tris);
  const cavity = lift(hol.cavity);
  // drain hole at the lowest cavity point straight down to the skin
  const cb = bounds(cavity);
  let low = null;
  for (let i = 0; i < cavity.length; i += 3) if (!low || cavity[i + 2] < low[2]) low = [cavity[i], cavity[i + 1], cavity[i + 2]];
  const bvh = new BVH(tris);
  const hit = bvh.raycast(low[0], low[1], low[2], 0, 0, -1);
  const skin = low[2] - hit.t;
  const holes = Float32Array.from(frustum(low[0], low[1], skin - 1, low[0], low[1], low[2] + 1, 1.5, 1.5, 24));
  lap(`drain hole at (${low[0].toFixed(1)}, ${low[1].toFixed(1)}) through ${(low[2] - skin).toFixed(1)} mm of wall; cavity z ${cb.min[2].toFixed(1)}..${cb.max[2].toFixed(1)}`);
  const sup = generateSupports(tris, S);
  const geo = buildSupportGeometry(sup.plans, S, sup.raftTop);
  lap(`supports: ${sup.points.length} points, ${sup.plans.length} placed, ${sup.plans.filter((p) => p.onModel).length} on model, ${geo.tris.length / 9} tris`);
  const isl = analyzeStack({ model: tris, supports: geo.tris }, { pixel: 0.15, layerHeight: 0.1, voids: false });
  lap(`islands remaining after supports: ${isl.islands.length} ${isl.islands.slice(0, 6).map((i) => `z${i.z.toFixed(1)} a${i.area.toFixed(2)}`).join(', ')}`);
  const an = analyzeStack({ model: tris, supports: geo.tris, cavity, holes }, { pixel: 0.25, layerHeight: 0.1, islands: false });
  lap(`suction cups: ${an.suction.length} ${an.suction.map((x) => `${x.maxArea.toFixed(0)}mm² z${x.z0.toFixed(1)}-${x.z1.toFixed(1)}`).join(', ')}; trapped: ${an.trapped.map((x) => (x.volume / 1000).toFixed(2) + 'ml').join(', ') || 'none'}`);
  // slice in parallel
  const profile = { ...DEFAULT_PROFILE, antiAliasing: Number(process.env.AA || 1) };
  const zmax = Math.max(bounds(tris).max[2], bounds(geo.tris).max[2]);
  const layerCount = Math.ceil(zmax / profile.layerHeight - 1e-6);
  const job = { model: tris, supports: geo.tris, cavity, holes, infill: { type: process.env.INFILL || 'none', spacing: 6, thickness: 1.2 }, layerHeight: profile.layerHeight, aa: profile.antiAliasing, blur: 0 };
  const N = Math.max(1, os.cpus().length);
  const per = Math.ceil(layerCount / N);
  const parts = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { job, k0: i * per, k1: Math.min(layerCount, (i + 1) * per) } });
    w.on('message', res); w.on('error', rej);
  })));
  const packed = new Array(layerCount), stats = new Array(layerCount);
  for (const p of parts) for (const r of p) { packed[r.k] = r.packed; stats[r.k] = r.stat; }
  lap(`sliced ${layerCount} layers (AA ${profile.antiAliasing})`);
  const volumeMl = stats.reduce((a, x) => a + x.area, 0) * profile.layerHeight / 1000;
  const time = printTime(profile, layerCount);
  const all = concatTris([tris, geo.tris]);
  const chunks = buildPM7M({ profile, aa: profile.antiAliasing, layers: packed, stats, previews: M7MAX.previewSizes.map(([w, h]) => heightmapPreview(all, w, h)), printTime: time, volumeMl });
  const out = process.env.OUT || 'test/out/armadillo.pm7m';
  const fd = fs.openSync(out, 'w');
  for (const ch of chunks) fs.writeSync(fd, ch);
  fs.closeSync(fd);
  lap(`wrote ${out}: ${(fs.statSync(out).size / 1048576).toFixed(1)} MB, ${volumeMl.toFixed(1)} ml resin, ${formatDuration(time)}`);
  assert.equal(isl.islands.length, 0, 'no unsupported islands');
  assert.equal(an.trapped.length, 0, 'drain hole vents cavity');
}
