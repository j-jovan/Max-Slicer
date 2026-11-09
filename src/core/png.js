// Tiny RGBA PNG encoder (used for fallback previews and in tests).
import { zlibSync } from 'fflate';
import { crc32 } from './zip.js';

export function encodePNG(rgba, w, h) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = zlibSync(raw, { level: 6 });
  const chunks = [];
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
    chunks.push(c);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk('IHDR', ihdr);
  chunk('IDAT', idat);
  chunk('IEND', new Uint8Array(0));
  let n = sig.length;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  out.set(sig);
  let o = sig.length;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Simple shaded top-down preview from a height map (fallback when no 3D render is available).
export function heightmapPreview(tris, w, h, bg = [5, 72, 100, 255]) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    minx = Math.min(minx, tris[i]); maxx = Math.max(maxx, tris[i]);
    miny = Math.min(miny, tris[i + 1]); maxy = Math.max(maxy, tris[i + 1]);
    minz = Math.min(minz, tris[i + 2]); maxz = Math.max(maxz, tris[i + 2]);
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(bg, i * 4);
  if (!isFinite(minx)) return encodePNG(rgba, w, h);
  const sx = (w * 0.9) / Math.max(1e-6, maxx - minx), sy = (h * 0.9) / Math.max(1e-6, maxy - miny);
  const s = Math.min(sx, sy);
  const ox = (w - (maxx - minx) * s) / 2, oy = (h - (maxy - miny) * s) / 2;
  const zb = new Float32Array(w * h).fill(-Infinity);
  for (let t = 0; t < tris.length; t += 9) {
    const P = [0, 3, 6].map((k) => [ox + (tris[t + k] - minx) * s, h - (oy + (tris[t + k + 1] - miny) * s), tris[t + k + 2]]);
    const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))), x1 = Math.min(w - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))), y1 = Math.min(h - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
    const den = (P[1][1] - P[2][1]) * (P[0][0] - P[2][0]) + (P[2][0] - P[1][0]) * (P[0][1] - P[2][1]);
    if (Math.abs(den) < 1e-12) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const a = ((P[1][1] - P[2][1]) * (px - P[2][0]) + (P[2][0] - P[1][0]) * (py - P[2][1])) / den;
      const b = ((P[2][1] - P[0][1]) * (px - P[2][0]) + (P[0][0] - P[2][0]) * (py - P[2][1])) / den;
      const c = 1 - a - b;
      if (a < 0 || b < 0 || c < 0) continue;
      const z = a * P[0][2] + b * P[1][2] + c * P[2][2];
      if (z > zb[y * w + x]) zb[y * w + x] = z;
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (zb[i] === -Infinity) continue;
    const g = 90 + Math.round(150 * (zb[i] - minz) / Math.max(1e-6, maxz - minz));
    rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
  }
  return encodePNG(rgba, w, h);
}
