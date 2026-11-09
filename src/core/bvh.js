// Bounding volume hierarchy over a triangle soup for fast ray queries.
export class BVH {
  constructor(tris, leafSize = 6) {
    this.tris = tris;
    const n = tris.length / 9;
    this.n = n;
    const cent = new Float32Array(n * 3);
    const bmin = new Float32Array(n * 3), bmax = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) {
      for (let d = 0; d < 3; d++) {
        const a = tris[t * 9 + d], b = tris[t * 9 + 3 + d], c = tris[t * 9 + 6 + d];
        bmin[t * 3 + d] = Math.min(a, b, c);
        bmax[t * 3 + d] = Math.max(a, b, c);
        cent[t * 3 + d] = (a + b + c) / 3;
      }
    }
    this.index = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.index[i] = i;
    const maxNodes = Math.max(1, 2 * Math.ceil(n / Math.max(1, leafSize / 2)) + 1);
    this.nb = new Float32Array(maxNodes * 6);
    this.child = new Int32Array(maxNodes);   // left child index, or -1 for leaf
    this.start = new Int32Array(maxNodes);
    this.count = new Int32Array(maxNodes);
    this.nodes = 0;
    if (n === 0) { this.nodes = 1; this.child[0] = -1; this.count[0] = 0; return; }
    const stack = [[0, n, this.alloc()]];
    while (stack.length) {
      const [s, e, node] = stack.pop();
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      let cmnx = Infinity, cmny = Infinity, cmnz = Infinity, cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
      for (let i = s; i < e; i++) {
        const t = this.index[i];
        mnx = Math.min(mnx, bmin[t * 3]); mny = Math.min(mny, bmin[t * 3 + 1]); mnz = Math.min(mnz, bmin[t * 3 + 2]);
        mxx = Math.max(mxx, bmax[t * 3]); mxy = Math.max(mxy, bmax[t * 3 + 1]); mxz = Math.max(mxz, bmax[t * 3 + 2]);
        cmnx = Math.min(cmnx, cent[t * 3]); cmny = Math.min(cmny, cent[t * 3 + 1]); cmnz = Math.min(cmnz, cent[t * 3 + 2]);
        cmxx = Math.max(cmxx, cent[t * 3]); cmxy = Math.max(cmxy, cent[t * 3 + 1]); cmxz = Math.max(cmxz, cent[t * 3 + 2]);
      }
      const nb = this.nb;
      nb[node * 6] = mnx; nb[node * 6 + 1] = mny; nb[node * 6 + 2] = mnz;
      nb[node * 6 + 3] = mxx; nb[node * 6 + 4] = mxy; nb[node * 6 + 5] = mxz;
      if (e - s <= leafSize) { this.child[node] = -1; this.start[node] = s; this.count[node] = e - s; continue; }
      const ex = cmxx - cmnx, ey = cmxy - cmny, ez = cmxz - cmnz;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const split = axis === 0 ? (cmnx + cmxx) / 2 : axis === 1 ? (cmny + cmxy) / 2 : (cmnz + cmxz) / 2;
      let i = s, j = e - 1;
      while (i <= j) {
        if (cent[this.index[i] * 3 + axis] < split) i++;
        else { const t = this.index[i]; this.index[i] = this.index[j]; this.index[j] = t; j--; }
      }
      let mid = i;
      if (mid === s || mid === e) mid = (s + e) >> 1; // degenerate split
      const l = this.alloc(), r = this.alloc();
      this.child[node] = l;
      stack.push([s, mid, l], [mid, e, r]);
    }
  }
  alloc() {
    if (this.nodes >= this.child.length) {
      const grow = (a, T) => { const b = new T(a.length * 2); b.set(a); return b; };
      this.nb = grow(this.nb, Float32Array); this.child = grow(this.child, Int32Array);
      this.start = grow(this.start, Int32Array); this.count = grow(this.count, Int32Array);
    }
    return this.nodes++;
  }

  // Closest hit along ray o + t d, t in (tmin, tmax). Returns {t, tri} or null.
  raycast(ox, oy, oz, dx, dy, dz, tmax = Infinity, tmin = 1e-6) {
    if (this.n === 0) return null;
    const ix = 1 / (dx !== 0 ? dx : 1e-30), iy = 1 / (dy !== 0 ? dy : 1e-30), iz = 1 / (dz !== 0 ? dz : 1e-30);
    const stack = [0];
    let best = tmax, bestTri = -1;
    const nb = this.nb, tris = this.tris;
    while (stack.length) {
      const node = stack.pop();
      // slab test
      let t0 = (nb[node * 6] - ox) * ix, t1 = (nb[node * 6 + 3] - ox) * ix;
      let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
      t0 = (nb[node * 6 + 1] - oy) * iy; t1 = (nb[node * 6 + 4] - oy) * iy;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      t0 = (nb[node * 6 + 2] - oz) * iz; t1 = (nb[node * 6 + 5] - oz) * iz;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      if (!(hi >= lo) || hi < tmin || lo > best) continue;
      const c = this.child[node];
      if (c < 0) {
        for (let i = this.start[node], e = i + this.count[node]; i < e; i++) {
          const t = this.index[i] * 9;
          const h = rayTri(ox, oy, oz, dx, dy, dz, tris, t);
          if (h > tmin && h < best) { best = h; bestTri = t / 9; }
        }
      } else stack.push(c, c + 1);
    }
    return bestTri < 0 ? null : { t: best, tri: bestTri };
  }

  // Count signed crossings along a ray (for inside tests). Returns winding number.
  winding(ox, oy, oz, dx, dy, dz) {
    if (this.n === 0) return 0;
    const ix = 1 / (dx !== 0 ? dx : 1e-30), iy = 1 / (dy !== 0 ? dy : 1e-30), iz = 1 / (dz !== 0 ? dz : 1e-30);
    const stack = [0];
    let w = 0;
    const nb = this.nb, tris = this.tris;
    while (stack.length) {
      const node = stack.pop();
      let t0 = (nb[node * 6] - ox) * ix, t1 = (nb[node * 6 + 3] - ox) * ix;
      let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
      t0 = (nb[node * 6 + 1] - oy) * iy; t1 = (nb[node * 6 + 4] - oy) * iy;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      t0 = (nb[node * 6 + 2] - oz) * iz; t1 = (nb[node * 6 + 5] - oz) * iz;
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      if (!(hi >= lo) || hi < 0) continue;
      const c = this.child[node];
      if (c < 0) {
        for (let i = this.start[node], e = i + this.count[node]; i < e; i++) {
          const t = this.index[i] * 9;
          if (rayTri(ox, oy, oz, dx, dy, dz, tris, t) > 0) {
            // sign from normal vs ray direction
            const ux = tris[t + 3] - tris[t], uy = tris[t + 4] - tris[t + 1], uz = tris[t + 5] - tris[t + 2];
            const vx = tris[t + 6] - tris[t], vy = tris[t + 7] - tris[t + 1], vz = tris[t + 8] - tris[t + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            w += nx * dx + ny * dy + nz * dz > 0 ? 1 : -1;
          }
        }
      } else stack.push(c, c + 1);
    }
    return w;
  }

  isInside(x, y, z) {
    // irrational-ish direction avoids edge/vertex degeneracies
    return this.winding(x, y, z, 0.5773, 0.5774, 0.5772) !== 0;
  }
}

// Möller–Trumbore; returns t or -1
export function rayTri(ox, oy, oz, dx, dy, dz, tr, o) {
  const ax = tr[o], ay = tr[o + 1], az = tr[o + 2];
  const e1x = tr[o + 3] - ax, e1y = tr[o + 4] - ay, e1z = tr[o + 5] - az;
  const e2x = tr[o + 6] - ax, e2y = tr[o + 7] - ay, e2z = tr[o + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}
