// Background compute worker (bundled separately). All heavy geometry runs here.
import { repairMesh, loadMeshFile, bounds, signedVolume, surfaceArea } from '../core/mesh.js';
import { autoOrient } from '../core/orient.js';
import { computeCavity } from '../core/hollow.js';
import { analyzeStack } from '../core/analysis.js';
import { BVH } from '../core/bvh.js';
import { autoDrainHoles } from '../core/drain.js';
import { generateSupports, planSupport, buildSupportGeometry, DEFAULT_SUPPORT_SETTINGS } from '../core/supports.js';
import { createLayerContext, renderLayer, finishLayer } from '../core/layerjob.js';
import { readPM7M } from '../core/pm7m.js';
import { decodePW0 } from '../core/pw0.js';
import { inflateSync } from 'fflate';
import { M7MAX } from '../core/printer.js';

let sliceCtx = null;
let sliceJob = null;
let openedFile = null;

const progress = (id) => (p, msg) => self.postMessage({ id, progress: p, msg });

function transferablesOf(obj, out = []) {
  if (obj && typeof obj === 'object') {
    if (ArrayBuffer.isView(obj)) { if (!out.includes(obj.buffer)) out.push(obj.buffer); }
    else if (Array.isArray(obj)) for (const v of obj) transferablesOf(v, out);
    else for (const k in obj) transferablesOf(obj[k], out);
  }
  return out;
}

const handlers = {
  load({ name, buffer }) {
    const parts = loadMeshFile(name, buffer);
    return parts.map((p) => {
      const rep = repairMesh(p.tris);
      return { name: p.name, tris: rep.tris, report: rep.report };
    });
  },
  repair({ tris }) {
    return repairMesh(tris);
  },
  stats({ tris }) {
    return { bounds: bounds(tris), volume: Math.abs(signedVolume(tris)), area: surfaceArea(tris), triangles: tris.length / 9 };
  },
  orient({ tris, goal, angle }) {
    return autoOrient(tris, { goal, angle });
  },
  hollow({ tris, wall, voxel }) {
    return computeCavity(tris, { wall, voxel });
  },
  analyze({ groups, opts }, id) {
    return analyzeStack(groups, { ...opts, onProgress: progress(id) });
  },
  autoholes({ model, cavity, existingHoles, supports, diameter }, id) {
    return autoDrainHoles({ model, cavity, existingHoles, supports }, { diameter, onProgress: progress(id) });
  },
  // Auto supports: returns contact points (world) and plans
  autosupport({ tris, settings }, id) {
    const r = generateSupports(tris, settings, progress(id));
    return { points: r.points, raftTop: r.raftTop };
  },
  // Re-plan + rebuild geometry for a set of contact points
  buildsupports({ tris, points, settings }) {
    const S = { ...DEFAULT_SUPPORT_SETTINGS, ...settings };
    const raftTop = S.raft === 'slab' ? S.raftHeight : 0;
    const bvh = new BVH(tris);
    const plans = [];
    const owner = [];
    let failed = 0;
    points.forEach((pt, i) => {
      const pl = planSupport(pt, bvh, { ...S, tipD: pt.tipD ?? S.tipD, trunkD: pt.trunkD ?? S.trunkD }, raftTop);
      if (pl) { plans.push(pl); owner.push(i); } else failed++;
    });
    const geo = buildSupportGeometry(plans, S, raftTop);
    return { tris: geo.tris, parts: geo.parts.map((p, k) => ({ ...p, point: owner[k] })), braces: geo.braces, raft: geo.raft, failed, plans: plans.map((p) => ({ T: p.T, bottom: p.bottom, onModel: p.onModel })) };
  },
  // ---------------------------------------------------------------- slicing
  sliceInit({ job }) {
    sliceJob = job;
    sliceCtx = null;
    return true;
  },
  sliceChunk({ k0, k1 }) {
    // fresh sweeper per chunk (sweeps are monotonic in z)
    sliceCtx = createLayerContext(sliceJob, M7MAX);
    const results = [];
    for (let k = k0; k < k1; k++) {
      const img = renderLayer(sliceCtx, k);
      const r = finishLayer(sliceCtx, img);
      results.push({ k, stat: r.stat, packed: r.packed });
    }
    return results;
  },
  // Downsampled RGBA preview of an encoded (deflated PW0) layer
  layerPreview({ packed, scale }) {
    const enc = inflateSync(packed.data, { out: new Uint8Array(packed.size) });
    const img = decodePW0(enc, M7MAX.resX, M7MAX.resY);
    return downsample(img, M7MAX.resX, M7MAX.resY, scale);
  },
  layerCrop({ packed, x0, y0, w, h }) {
    const enc = inflateSync(packed.data, { out: new Uint8Array(packed.size) });
    const img = decodePW0(enc, M7MAX.resX, M7MAX.resY);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = x0 + x, sy = y0 + y;
      const v = sx >= 0 && sy >= 0 && sx < M7MAX.resX && sy < M7MAX.resY ? img[sy * M7MAX.resX + sx] : 0;
      const o = (y * w + x) * 4;
      out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
    }
    return { rgba: out, w, h };
  },
  // Open an existing .pm7m for inspection
  openPM7M({ buffer }) {
    openedFile = readPM7M(new Uint8Array(buffer));
    return { layerCount: openedFile.layerCount, settings: openedFile.settings, printInfo: openedFile.printInfo, software: openedFile.software, layers: openedFile.layersController.paras };
  },
  openedLayer({ k, scale }) {
    const img = openedFile.layerImage(k);
    return downsample(img, openedFile.W, openedFile.H, scale);
  },
};

function downsample(img, W, H, s) {
  const w = Math.ceil(W / s), h = Math.ceil(H / s);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = 0; dy < s; dy++) {
        const sy = y * s + dy;
        if (sy >= H) break;
        const row = sy * W;
        for (let dx = 0; dx < s; dx++) { const sx = x * s + dx; if (sx < W) { const v = img[row + sx]; if (v > m) m = v; } }
      }
      const o = (y * w + x) * 4;
      out[o] = m; out[o + 1] = m; out[o + 2] = m; out[o + 3] = 255;
    }
  }
  return { rgba: out, w, h };
}

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    const result = await handlers[cmd](args, id);
    self.postMessage({ id, result }, transferablesOf(result));
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack ? err.stack : err) });
  }
};
