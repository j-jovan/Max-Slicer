// Mesh utilities. Meshes are triangle soups: Float32Array of 9 floats per triangle
// (ax,ay,az,bx,by,bz,cx,cy,cz), counter-clockwise winding = outward normal.
import { unzipSync, strFromU8 } from 'fflate';

// ---------------------------------------------------------------- loading

export function loadMeshFile(fileName, arrayBuffer) {
  const ext = fileName.split('.').pop().toLowerCase();
  const u8 = new Uint8Array(arrayBuffer);
  if (ext === 'stl') return [{ name: baseName(fileName), tris: parseSTL(u8) }];
  if (ext === 'obj') return [{ name: baseName(fileName), tris: parseOBJ(strFromU8(u8)) }];
  if (ext === '3mf') return parse3MF(u8, baseName(fileName));
  throw new Error(`Unsupported file type: .${ext}`);
}

function baseName(p) {
  const n = p.split(/[\\/]/).pop();
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(0, i) : n;
}

export function parseSTL(u8) {
  if (u8.length >= 84) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === u8.length) return parseBinarySTL(dv, n);
  }
  const head = strFromU8(u8.subarray(0, Math.min(u8.length, 512))).trimStart().toLowerCase();
  if (head.startsWith('solid')) {
    const tris = parseAsciiSTL(strFromU8(u8));
    if (tris.length > 0) return tris;
  }
  // Some exporters write a wrong count in the header; fall back to length-derived count.
  if (u8.length >= 84) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = Math.floor((u8.length - 84) / 50);
    if (n > 0) return parseBinarySTL(dv, n);
  }
  throw new Error('Could not read STL file (empty or corrupt).');
}

function parseBinarySTL(dv, n) {
  const out = new Float32Array(n * 9);
  let o = 0;
  for (let i = 0; i < n; i++) {
    let p = 84 + i * 50 + 12; // skip normal (recomputed from winding)
    for (let k = 0; k < 9; k++) { out[o++] = dv.getFloat32(p, true); p += 4; }
  }
  return out;
}

function parseAsciiSTL(text) {
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const vals = [];
  let m;
  while ((m = re.exec(text)) !== null) vals.push(+m[1], +m[2], +m[3]);
  const n = Math.floor(vals.length / 9) * 9;
  return Float32Array.from(vals.slice(0, n));
}

export function parseOBJ(text) {
  const v = [];
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      v.push([+p[1], +p[2], +p[3]]);
    } else if (line.startsWith('f ')) {
      const p = line.split(/\s+/).slice(1).filter(Boolean).map((t) => {
        let i = parseInt(t.split('/')[0], 10);
        return i < 0 ? v.length + i : i - 1;
      });
      for (let k = 1; k + 1 < p.length; k++) {
        const a = v[p[0]], b = v[p[k]], c = v[p[k + 1]];
        if (!a || !b || !c) continue;
        out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      }
    }
  }
  return Float32Array.from(out);
}

const UNIT_SCALE = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export function parse3MF(u8, fallbackName = 'model') {
  const files = unzipSync(u8);
  const modelPaths = Object.keys(files).filter((k) => /\.model$/i.test(k));
  if (modelPaths.length === 0) throw new Error('3MF contains no .model file.');
  // Parse every model part (production extension may split objects across files).
  const objects = new Map(); // key "path#id" -> {name, tris|components}
  let rootPath = modelPaths.find((p) => /^3D\/3dmodel\.model$/i.test(p)) || modelPaths[0];
  let unitScale = 1;
  for (const path of modelPaths) {
    const xml = strFromU8(files[path]);
    if (path === rootPath) {
      const um = /<model[^>]*\sunit="([a-z]+)"/i.exec(xml);
      if (um && UNIT_SCALE[um[1]]) unitScale = UNIT_SCALE[um[1]];
    }
    const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let om;
    while ((om = objRe.exec(xml)) !== null) {
      const attrs = om[1];
      const body = om[2];
      const id = attr(attrs, 'id');
      const name = attr(attrs, 'name') || `${fallbackName}_${id}`;
      const meshM = /<mesh>([\s\S]*?)<\/mesh>/.exec(body);
      if (meshM) {
        const verts = [];
        const vre = /<vertex\b([^>]*)\/?>/g;
        let vm;
        while ((vm = vre.exec(meshM[1])) !== null) verts.push(+attr(vm[1], 'x'), +attr(vm[1], 'y'), +attr(vm[1], 'z'));
        const tri = [];
        const tre = /<triangle\b([^>]*)\/?>/g;
        let tm;
        while ((tm = tre.exec(meshM[1])) !== null) {
          const a = +attr(tm[1], 'v1'), b = +attr(tm[1], 'v2'), c = +attr(tm[1], 'v3');
          tri.push(verts[a * 3], verts[a * 3 + 1], verts[a * 3 + 2], verts[b * 3], verts[b * 3 + 1], verts[b * 3 + 2], verts[c * 3], verts[c * 3 + 1], verts[c * 3 + 2]);
        }
        objects.set(`${path}#${id}`, { name, tris: Float32Array.from(tri) });
      } else {
        const comps = [];
        const cre = /<component\b([^>]*)\/?>/g;
        let cm;
        while ((cm = cre.exec(body)) !== null) {
          const p = attr(cm[1], 'p:path');
          comps.push({ ref: `${p ? p.replace(/^\//, '') : path}#${attr(cm[1], 'objectid')}`, m: parseMatrix(attr(cm[1], 'transform')) });
        }
        objects.set(`${path}#${id}`, { name, components: comps });
      }
    }
  }
  const resolve = (key, m, depth = 0) => {
    const o = objects.get(key);
    if (!o || depth > 16) return [];
    if (o.tris) return [applyAffine(o.tris, m)];
    const parts = [];
    for (const c of o.components) parts.push(...resolve(c.ref, mulAffine(m, c.m), depth + 1));
    return parts;
  };
  const rootXml = strFromU8(files[rootPath]);
  const result = [];
  const items = [...rootXml.matchAll(/<item\b([^>]*)\/?>/g)];
  for (const it of items) {
    const p = attr(it[1], 'p:path');
    const key = `${p ? p.replace(/^\//, '') : rootPath}#${attr(it[1], 'objectid')}`;
    const parts = resolve(key, parseMatrix(attr(it[1], 'transform')));
    if (!parts.length) continue;
    const tris = concatTris(parts);
    if (unitScale !== 1) for (let i = 0; i < tris.length; i++) tris[i] *= unitScale;
    result.push({ name: objects.get(key)?.name || fallbackName, tris });
  }
  if (!result.length) throw new Error('3MF build contains no printable objects.');
  return result;
}

function attr(s, name) {
  const re = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`);
  const m = re.exec(s);
  return m ? m[1] : null;
}

// 3MF affine: "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32", p' = p * M (row vector).
function parseMatrix(s) {
  if (!s) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 ? v : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
}
function mulAffine(a, b) {
  // apply b first then a  =>  p * B * A
  const r = new Array(12);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    r[i * 3 + j] = b[i * 3] * a[j] + b[i * 3 + 1] * a[3 + j] + b[i * 3 + 2] * a[6 + j];
  for (let j = 0; j < 3; j++) r[9 + j] = b[9] * a[j] + b[10] * a[3 + j] + b[11] * a[6 + j] + a[9 + j];
  return r;
}
function applyAffine(tris, m) {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    out[i] = x * m[0] + y * m[3] + z * m[6] + m[9];
    out[i + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
    out[i + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
  }
  return out;
}

// ---------------------------------------------------------------- basic ops

export function concatTris(list) {
  let n = 0;
  for (const t of list) n += t.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const t of list) { out.set(t, o); o += t.length; }
  return out;
}

export function bounds(tris) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

// m = 4x4 column-major (three.js Matrix4.elements)
export function transformTris(tris, m) {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  // A mirroring transform flips orientation; restore CCW-outward winding.
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (det < 0) flipAll(out);
  return out;
}

export function flipAll(tris) {
  for (let i = 0; i < tris.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const t = tris[i + 3 + k]; tris[i + 3 + k] = tris[i + 6 + k]; tris[i + 6 + k] = t;
    }
  }
  return tris;
}

export function signedVolume(tris) {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function surfaceArea(tris) {
  let a = 0;
  for (let i = 0; i < tris.length; i += 9) a += triArea(tris, i);
  return a;
}

export function triArea(t, i) {
  const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
  const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

export function triNormal(t, i, out = [0, 0, 0]) {
  const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
  const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
  let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const l = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
  out[0] = cx / l; out[1] = cy / l; out[2] = cz / l;
  return out;
}

// ---------------------------------------------------------------- welding / topology

export function weld(tris, eps = 1e-5) {
  const n = tris.length / 3;
  const map = new Map();
  const verts = [];
  const idx = new Uint32Array(n);
  const inv = 1 / eps;
  for (let i = 0; i < n; i++) {
    const x = tris[i * 3], y = tris[i * 3 + 1], z = tris[i * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = map.get(key);
    if (id === undefined) { id = verts.length / 3; verts.push(x, y, z); map.set(key, id); }
    idx[i] = id;
  }
  return { verts: Float32Array.from(verts), idx };
}

// Repair: drop degenerate triangles, make orientation consistent per connected shell,
// make every closed shell face outward. Returns repaired tris and a report.
export function repairMesh(tris) {
  const report = { input: tris.length / 9, degenerate: 0, flippedFaces: 0, invertedShells: 0, shells: 0, openEdges: 0, nonManifoldEdges: 0 };
  // 1. remove degenerates (after welding, two identical vertices or zero area)
  const w0 = weld(tris);
  const keep = [];
  for (let t = 0; t < w0.idx.length / 3; t++) {
    const a = w0.idx[t * 3], b = w0.idx[t * 3 + 1], c = w0.idx[t * 3 + 2];
    if (a === b || b === c || a === c || triArea(tris, t * 9) < 1e-12) { report.degenerate++; continue; }
    keep.push(t);
  }
  const T = keep.length;
  const I = new Uint32Array(T * 3);
  for (let k = 0; k < T; k++) { const t = keep[k]; I[k * 3] = w0.idx[t * 3]; I[k * 3 + 1] = w0.idx[t * 3 + 1]; I[k * 3 + 2] = w0.idx[t * 3 + 2]; }
  const V = w0.verts;
  // 2. edge map: undirected edge -> list of (tri, directed a->b)
  const edges = new Map();
  const ekey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = I[t * 3 + e], b = I[t * 3 + ((e + 1) % 3)];
      const k = ekey(a, b);
      let l = edges.get(k);
      if (!l) { l = []; edges.set(k, l); }
      l.push(t, a);
    }
  }
  for (const l of edges.values()) {
    if (l.length === 2) report.openEdges++;
    else if (l.length > 4) report.nonManifoldEdges++;
  }
  // 3. BFS orientation propagation
  const flip = new Uint8Array(T);
  const comp = new Int32Array(T).fill(-1);
  let nc = 0;
  const queue = new Int32Array(T);
  for (let s = 0; s < T; s++) {
    if (comp[s] !== -1) continue;
    let qh = 0, qt = 0;
    queue[qt++] = s; comp[s] = nc;
    while (qh < qt) {
      const t = queue[qh++];
      for (let e = 0; e < 3; e++) {
        let a = I[t * 3 + e], b = I[t * 3 + ((e + 1) % 3)];
        if (flip[t]) { const x = a; a = b; b = x; }
        const l = edges.get(ekey(a, b));
        if (l.length !== 4) continue; // only propagate across manifold edges
        const o = l[0] === t ? 2 : 0;
        const u = l[o], ua = l[o + 1];
        if (comp[u] !== -1) continue;
        comp[u] = nc;
        // neighbour's directed edge starts at ua; consistent iff it runs b->a
        const uStartsAtA = ua === a;
        flip[u] = uStartsAtA ? 1 : 0;
        queue[qt++] = u;
      }
    }
    nc++;
  }
  report.shells = nc;
  // 4. close holes: chain boundary half-edges into loops and fill each with a fan
  //    (orientation opposite to the boundary edges so the shell stays consistent)
  const tri = [];      // oriented triangle list (vertex indices), original + fill
  const triComp = [];
  for (let t = 0; t < T; t++) {
    let a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    if (flip[t]) { const x = b; b = c; c = x; }
    tri.push(a, b, c); triComp.push(comp[t]);
  }
  const Vlist = Array.from(V);
  report.holesFilled = 0;
  if (report.openEdges > 0) {
    const out = new Map(); // start vertex -> [{to, comp}]
    for (const l of edges.values()) {
      if (l.length !== 2) continue;
      const t = l[0];
      // directed boundary edge as it runs in the ORIENTED triangle
      let a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      if (flip[t]) { const x = b; b = c; c = x; }
      const ring = [a, b, c];
      // the edge of the oriented triangle that is this boundary edge
      let s0 = -1, s1 = -1;
      for (let e = 0; e < 3; e++) {
        const u = ring[e], w = ring[(e + 1) % 3];
        if (edges.get(ekey(u, w)) === l) { s0 = u; s1 = w; break; }
      }
      if (s0 < 0) continue;
      let lst = out.get(s0);
      if (!lst) { lst = []; out.set(s0, lst); }
      lst.push({ to: s1, comp: comp[t], used: false });
    }
    for (const [start, lst] of out) {
      for (const first of lst) {
        if (first.used) continue;
        const loop = [start];
        let cur = first, guard = 0;
        cur.used = true;
        let v = cur.to;
        while (v !== start && guard++ < 1e6) {
          loop.push(v);
          const nxt = (out.get(v) || []).find((x) => !x.used);
          if (!nxt) break;
          nxt.used = true;
          v = nxt.to;
        }
        if (v !== start || loop.length < 3) continue;
        // centroid fan; reversed winding (c, v[i+1], v[i])
        let cx = 0, cy = 0, cz = 0;
        for (const q of loop) { cx += V[q * 3]; cy += V[q * 3 + 1]; cz += V[q * 3 + 2]; }
        const ci = Vlist.length / 3;
        Vlist.push(cx / loop.length, cy / loop.length, cz / loop.length);
        for (let i = 0; i < loop.length; i++) {
          tri.push(ci, loop[(i + 1) % loop.length], loop[i]);
          triComp.push(first.comp);
        }
        report.holesFilled++;
      }
    }
  }
  const VV = Float64Array.from(Vlist);
  const TT = tri.length / 3;
  // 5. per-shell signed volume
  const vol = new Float64Array(nc);
  for (let t = 0; t < TT; t++) {
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    const ax = VV[a * 3], ay = VV[a * 3 + 1], az = VV[a * 3 + 2];
    const bx = VV[b * 3], by = VV[b * 3 + 1], bz = VV[b * 3 + 2];
    const cx = VV[c * 3], cy = VV[c * 3 + 1], cz = VV[c * 3 + 2];
    vol[triComp[t]] += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  // Inner shells (cavities) legitimately have negative volume; only invert a shell
  // when it is not enclosed by another shell. We approximate: a negative shell is
  // flipped unless its bounding box lies inside a positive shell's bounding box.
  const sb = [];
  for (let c = 0; c < nc; c++) sb.push({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  for (let t = 0; t < TT; t++) {
    const b = sb[triComp[t]];
    for (let k = 0; k < 3; k++) {
      const v = tri[t * 3 + k];
      for (let d = 0; d < 3; d++) { const x = VV[v * 3 + d]; if (x < b.min[d]) b.min[d] = x; if (x > b.max[d]) b.max[d] = x; }
    }
  }
  const invert = new Uint8Array(nc);
  for (let c = 0; c < nc; c++) {
    if (vol[c] >= 0) continue;
    let enclosed = false;
    for (let o = 0; o < nc && !enclosed; o++) {
      if (o === c || vol[o] <= 0) continue;
      enclosed = sb[o].min[0] <= sb[c].min[0] && sb[o].min[1] <= sb[c].min[1] && sb[o].min[2] <= sb[c].min[2] && sb[o].max[0] >= sb[c].max[0] && sb[o].max[1] >= sb[c].max[1] && sb[o].max[2] >= sb[c].max[2];
    }
    if (!enclosed) { invert[c] = 1; report.invertedShells++; }
  }
  for (let t = 0; t < T; t++) if (flip[t]) report.flippedFaces++;
  const out = new Float32Array(TT * 9);
  for (let t = 0; t < TT; t++) {
    let a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    if (invert[triComp[t]]) { const x = b; b = c; c = x; }
    out[t * 9] = VV[a * 3]; out[t * 9 + 1] = VV[a * 3 + 1]; out[t * 9 + 2] = VV[a * 3 + 2];
    out[t * 9 + 3] = VV[b * 3]; out[t * 9 + 4] = VV[b * 3 + 1]; out[t * 9 + 5] = VV[b * 3 + 2];
    out[t * 9 + 6] = VV[c * 3]; out[t * 9 + 7] = VV[c * 3 + 1]; out[t * 9 + 8] = VV[c * 3 + 2];
  }
  report.output = TT;
  return { tris: out, report };
}

// ---------------------------------------------------------------- export

export function toBinarySTL(tris, header = 'Max Slicer export') {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, n, true);
  const nrm = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    triNormal(tris, t * 9, nrm);
    dv.setFloat32(o, nrm[0], true); dv.setFloat32(o + 4, nrm[1], true); dv.setFloat32(o + 8, nrm[2], true);
    for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, tris[t * 9 + k], true);
  }
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------- primitives (used by supports, holes, tests)

// Frustum between two points (ra at a, rb at b), sides segments, closed caps. Outward CCW.
export function frustum(ax, ay, az, bx, by, bz, ra, rb, sides = 10, out = []) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return out;
  dx /= len; dy /= len; dz /= len;
  // orthonormal basis
  let ux, uy, uz;
  if (Math.abs(dz) < 0.9) { ux = -dy; uy = dx; uz = 0; } else { ux = 0; uy = -dz; uz = dy; }
  let l = Math.hypot(ux, uy, uz); ux /= l; uy /= l; uz /= l;
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
  const ringA = [], ringB = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    const ox = ux * c + vx * s, oy = uy * c + vy * s, oz = uz * c + vz * s;
    ringA.push([ax + ox * ra, ay + oy * ra, az + oz * ra]);
    ringB.push([bx + ox * rb, by + oy * rb, bz + oz * rb]);
  }
  const push = (p, q, r) => out.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    // side quad (outward): a_i, a_j, b_j and a_i, b_j, b_i  (basis u,v,d is right-handed)
    push(ringA[i], ringA[j], ringB[j]);
    push(ringA[i], ringB[j], ringB[i]);
    // caps
    push([ax, ay, az], ringA[j], ringA[i]);
    push([bx, by, bz], ringB[i], ringB[j]);
  }
  return out;
}

export function sphere(cx, cy, cz, r, seg = 8, out = []) {
  const rings = seg, slices = seg * 2;
  const pt = (i, j) => {
    const th = (i / rings) * Math.PI, ph = (j / slices) * Math.PI * 2;
    return [cx + r * Math.sin(th) * Math.cos(ph), cy + r * Math.sin(th) * Math.sin(ph), cz + r * Math.cos(th)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < slices; j++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
      if (i !== 0) out.push(...a, ...b, ...d);
      if (i !== rings - 1) out.push(...b, ...c, ...d);
    }
  }
  return out;
}

export function box(x0, y0, z0, x1, y1, z1, out = []) {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  for (const [a, b, c] of f) out.push(...p[a], ...p[b], ...p[c]);
  return out;
}
