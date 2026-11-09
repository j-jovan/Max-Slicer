// Voxel tools: solid voxelisation (nonzero winding along Z columns), exact Euclidean
// distance transform (Felzenszwalb-Huttenlocher) and naive surface-nets isosurfaces.
import { bounds } from './mesh.js';

/**
 * Voxelise a closed triangle soup.
 * Returns {nx, ny, nz, vs, ox, oy, oz, solid: Uint8Array} where voxel (i,j,k) has its
 * centre at (ox + (i+0.5)vs, oy + (j+0.5)vs, oz + (k+0.5)vs). A one-voxel empty border
 * is always included.
 */
export function voxelize(tris, vs, pad = 1) {
  const b = bounds(tris);
  const ox = b.min[0] - pad * vs, oy = b.min[1] - pad * vs, oz = b.min[2] - pad * vs;
  const nx = Math.ceil((b.max[0] - ox) / vs) + pad, ny = Math.ceil((b.max[1] - oy) / vs) + pad, nz = Math.ceil((b.max[2] - oz) / vs) + pad;
  const ncol = nx * ny;
  const nT = tris.length / 9;
  // tiny offsets keep column centres off exact edges/vertices
  const ex = 1.2345e-6 * vs, ey = 2.3456e-6 * vs;
  const colX = (i) => ox + (i + 0.5) * vs + ex, colY = (j) => oy + (j + 0.5) * vs + ey;
  const count = new Int32Array(ncol + 1);
  const visit = (cb) => {
    for (let t = 0; t < nT; t++) {
      const o = t * 9;
      const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
      const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
      const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
      const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); // 2x signed XY area = nz direction
      if (area2 === 0) continue;
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - ox) / vs - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - ox) / vs - 0.5));
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - oy) / vs - 0.5));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - oy) / vs - 0.5));
      for (let j = j0; j <= j1; j++) {
        const py = colY(j);
        for (let i = i0; i <= i1; i++) {
          const px = colX(i);
          const w0 = (bx - px) * (cy - py) - (by - py) * (cx - px);
          const w1 = (cx - px) * (ay - py) - (cy - py) * (ax - px);
          const w2 = (ax - px) * (by - py) - (ay - py) * (bx - px);
          if (area2 > 0 ? (w0 < 0 || w1 < 0 || w2 < 0) : (w0 > 0 || w1 > 0 || w2 > 0)) continue;
          cb(j * nx + i, (w0 * az + w1 * bz + w2 * cz) / area2, area2 > 0 ? -1 : 1);
        }
      }
    }
  };
  visit((c) => count[c + 1]++);
  for (let c = 0; c < ncol; c++) count[c + 1] += count[c];
  const zs = new Float32Array(count[ncol]);
  const sg = new Int8Array(count[ncol]);
  const pos = new Int32Array(count.subarray(0, ncol));
  // upward ray: entering through a downward-facing face (nz < 0) => +1
  visit((c, z, s) => { const p = pos[c]++; zs[p] = z; sg[p] = s; });
  const solid = new Uint8Array(nx * ny * nz);
  const sliceXY = nx * ny;
  const tmpZ = [];
  for (let c = 0; c < ncol; c++) {
    const a = count[c], e = count[c + 1];
    if (e - a < 2) continue;
    tmpZ.length = 0;
    for (let p = a; p < e; p++) tmpZ.push(p);
    tmpZ.sort((p, q) => zs[p] - zs[q]);
    let w = 0;
    for (let q = 0; q < tmpZ.length; q++) {
      const p = tmpZ[q];
      const prev = w;
      w += sg[p];
      if (prev !== 0 && q > 0) {
        // fill voxels with centre in [z(q-1), z(q))
        const zA = zs[tmpZ[q - 1]], zB = zs[p];
        let k0 = Math.ceil((zA - oz) / vs - 0.5), k1 = Math.ceil((zB - oz) / vs - 0.5);
        if (k0 < 0) k0 = 0;
        if (k1 > nz) k1 = nz;
        for (let k = k0; k < k1; k++) solid[k * sliceXY + c] = 1;
      }
    }
  }
  return { nx, ny, nz, vs, ox, oy, oz, solid };
}

// 1D squared EDT (Felzenszwalb & Huttenlocher) on f (length n) -> d.
// Infinity is represented by BIG (finite) so parabola intersections never produce NaN.
const BIG = 1e12;
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Squared distance (in voxel units) from every voxel to the nearest voxel where mask==0. */
export function distanceToOutside(vox) {
  const { nx, ny, nz, solid } = vox;
  const N = nx * ny * nz;
  const D = new Float32Array(N);
  for (let i = 0; i < N; i++) D[i] = solid[i] ? BIG : 0;
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const sxy = nx * ny;
  // X lines
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const base = k * sxy + j * nx;
    for (let q = 0; q < nx; q++) f[q] = D[base + q];
    edt1d(f, nx, d, v, z);
    for (let q = 0; q < nx; q++) D[base + q] = d[q];
  }
  // Y lines
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const base = k * sxy + i;
    for (let q = 0; q < ny; q++) f[q] = D[base + q * nx];
    edt1d(f, ny, d, v, z);
    for (let q = 0; q < ny; q++) D[base + q * nx] = d[q];
  }
  // Z lines
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const base = j * nx + i;
    for (let q = 0; q < nz; q++) f[q] = D[base + q * sxy];
    edt1d(f, nz, d, v, z);
    for (let q = 0; q < nz; q++) D[base + q * sxy] = d[q];
  }
  return D;
}

/**
 * Naive surface nets on a scalar field sampled at voxel centres. Region where
 * field > 0 is treated as solid; output is a closed, outward-oriented triangle soup.
 */
export function surfaceNets(field, vox, smoothIters = 2) {
  const { nx, ny, nz, vs, ox, oy, oz } = vox;
  const sxy = nx * ny;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const verts = [];
  const at = (i, j, k) => field[k * sxy + j * nx + i];
  // vertices
  const corner = new Float64Array(8);
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const co = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let inside = 0;
    for (let c = 0; c < 8; c++) { corner[c] = at(i + co[c][0], j + co[c][1], k + co[c][2]); if (corner[c] > 0) inside++; }
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of E) {
      const fa = corner[a], fb = corner[b];
      if ((fa > 0) === (fb > 0)) continue;
      const t = fa / (fa - fb);
      sx += co[a][0] + (co[b][0] - co[a][0]) * t;
      sy += co[a][1] + (co[b][1] - co[a][1]) * t;
      sz += co[a][2] + (co[b][2] - co[a][2]) * t;
      n++;
    }
    cellVert[(k * cy + j) * cx + i] = verts.length / 3;
    verts.push(i + sx / n, j + sy / n, k + sz / n);
  }
  const V = Float64Array.from(verts);
  const quads = [];
  const cv = (i, j, k) => cellVert[(k * cy + j) * cx + i];
  for (let k = 1; k < cz; k++) for (let j = 1; j < cy; j++) for (let i = 0; i < cx; i++) {
    // edge along X from (i,j,k) to (i+1,j,k)
    const a = at(i, j, k) > 0, b = at(i + 1, j, k) > 0;
    if (a === b) continue;
    const q = [cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k)];
    quads.push(q, a ? 1 : -1, 0);
  }
  for (let k = 1; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 1; i < cx; i++) {
    const a = at(i, j, k) > 0, b = at(i, j + 1, k) > 0;
    if (a === b) continue;
    const q = [cv(i - 1, j, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i - 1, j, k)];
    quads.push(q, a ? 1 : -1, 1);
  }
  for (let k = 0; k < cz; k++) for (let j = 1; j < cy; j++) for (let i = 1; i < cx; i++) {
    const a = at(i, j, k) > 0, b = at(i, j, k + 1) > 0;
    if (a === b) continue;
    const q = [cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k)];
    quads.push(q, a ? 1 : -1, 2);
  }
  // Laplacian smoothing over the quad graph (keeps topology, removes voxel stair-steps)
  if (smoothIters > 0) {
    const nv = V.length / 3;
    const adjStart = new Int32Array(nv + 1);
    for (let p = 0; p < quads.length; p += 3) for (const v of quads[p]) adjStart[v + 1] += 2;
    for (let i = 0; i < nv; i++) adjStart[i + 1] += adjStart[i];
    const adj = new Int32Array(adjStart[nv]);
    const fill = adjStart.slice(0, nv);
    for (let p = 0; p < quads.length; p += 3) {
      const q = quads[p];
      for (let e = 0; e < 4; e++) { const u = q[e], w = q[(e + 1) % 4]; adj[fill[u]++] = w; adj[fill[w]++] = u; }
    }
    const tmp = new Float64Array(V.length);
    for (let it = 0; it < smoothIters; it++) {
      for (let v = 0; v < nv; v++) {
        let sx = 0, sy = 0, sz = 0;
        const s = adjStart[v], e = adjStart[v + 1];
        for (let a = s; a < e; a++) { const u = adj[a]; sx += V[u * 3]; sy += V[u * 3 + 1]; sz += V[u * 3 + 2]; }
        const n = e - s || 1;
        tmp[v * 3] = 0.5 * V[v * 3] + 0.5 * sx / n;
        tmp[v * 3 + 1] = 0.5 * V[v * 3 + 1] + 0.5 * sy / n;
        tmp[v * 3 + 2] = 0.5 * V[v * 3 + 2] + 0.5 * sz / n;
      }
      V.set(tmp);
    }
  }
  const out = new Float32Array((quads.length / 3) * 18);
  let o = 0;
  const P = (v, d) => (d === 0 ? ox : d === 1 ? oy : oz) + (V[v * 3 + d] + 0.5) * vs;
  for (let p = 0; p < quads.length; p += 3) {
    let q = quads[p];
    const solidAtStart = quads[p + 1] === 1, axis = quads[p + 2];
    // outward normal points from solid to empty: +axis when the solid voxel is the lower one
    const want = solidAtStart ? 1 : -1;
    // flip the quad if its (diagonal cross product) normal disagrees
    const a = q[0], b = q[1], c = q[2], d4 = q[3];
    const n = cross3(V, a, c, b, d4, axis);
    if (Math.sign(n) !== want) q = [q[0], q[3], q[2], q[1]];
    for (const tri of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) for (const v of tri) for (let dd = 0; dd < 3; dd++) out[o++] = P(v, dd);
  }
  return out;
}

// axis component of (V[c]-V[a]) x (V[d]-V[b]) for quad a,b,c,d
function cross3(V, a, c, b, d, axis) {
  const ux = V[c * 3] - V[a * 3], uy = V[c * 3 + 1] - V[a * 3 + 1], uz = V[c * 3 + 2] - V[a * 3 + 2];
  const vx = V[d * 3] - V[b * 3], vy = V[d * 3 + 1] - V[b * 3 + 1], vz = V[d * 3 + 2] - V[b * 3 + 2];
  return axis === 0 ? uy * vz - uz * vy : axis === 1 ? uz * vx - ux * vz : ux * vy - uy * vx;
}
