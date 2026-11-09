// Elegoo GOO V3 (Saturn 4 Ultra 16K). Big-endian binary: header with two RGB565
// previews, then per layer a definition + RLE image + "\r\n", then a footer.
// Layout reproduced from a Lychee Slicer 8 export for this printer and checked
// against UVtools' GooFile implementation.
import { APP_VERSION, effectiveExposure as gooExposure } from './pm7m.js';

const MAGIC = [0x07, 0x00, 0x00, 0x00, 0x44, 0x4c, 0x50, 0x00]; // "....DLP\0"
const LAYER_MAGIC = 0x55;
const te = new TextEncoder();

// ---------------------------------------------------------------- layer RLE

// Chunk = [type:2][len-bytes:2][len low nibble:4] (+ grey byte) (+ len bytes, MSB first)
// type 00 = black, 11 = white, 01 = grey value in the next byte.
export function encodeGOO(img, W = 0, dirty = null) {
  const n = img.length;
  let out = new Uint8Array(Math.max(4096, n >> 6));
  let o = 0;
  out[o++] = LAYER_MAGIC;
  const u32 = img.byteOffset % 4 === 0 && n % 4 === 0 ? new Uint32Array(img.buffer, img.byteOffset, n >> 2) : null;
  let i = 0;
  while (i < n) {
    const c = img[i];
    let j = i + 1;
    if (c === 0 || c === 255) {
      const word = c === 0 ? 0 : 0xffffffff;
      while (j < n) {
        if (c === 0 && dirty !== null && j % W === 0 && dirty[j / W] === 0) { j += W; continue; }
        if ((j & 3) === 0 && u32 !== null && j + 4 <= n && u32[j >> 2] === word) { j += 4; continue; }
        if (img[j] === c) { j++; continue; }
        break;
      }
    } else {
      while (j < n && img[j] === c) j++;
    }
    const run = j - i;
    if (o + 6 > out.length) { const b = new Uint8Array(out.length * 2); b.set(out); out = b; }
    const L = run <= 0xf ? 0 : run <= 0xfff ? 1 : run <= 0xfffff ? 2 : 3;
    const type = c === 0 ? 0 : c === 255 ? 3 : 1;
    out[o++] = (type << 6) | (L << 4) | (run & 0xf);
    if (type === 1) out[o++] = c;
    if (L >= 3) out[o++] = (run >>> 20) & 0xff;
    if (L >= 2) out[o++] = (run >>> 12) & 0xff;
    if (L >= 1) out[o++] = (run >>> 4) & 0xff;
    i = j;
  }
  let sum = 0;
  for (let k = 1; k < o; k++) sum = (sum + out[k]) & 0xff;
  if (o + 1 > out.length) { const b = new Uint8Array(o + 1); b.set(out); out = b; }
  out[o++] = ~sum & 0xff;
  return out.slice(0, o);
}

// Full decoder (all four chunk types, including the difference chunks Elegoo's own
// slicers emit), with magic and checksum verification.
export function decodeGOO(rle, W, H) {
  const n = W * H;
  const img = new Uint8Array(n);
  if (rle.length <= 3) return img;
  if (rle[0] !== LAYER_MAGIC) throw new Error('GOO layer is corrupt (bad magic)');
  const last = rle.length - 1;
  let sum = 0;
  for (let k = 1; k < last; k++) sum = (sum + rle[k]) & 0xff;
  if ((~sum & 0xff) !== rle[last]) throw new Error('GOO layer checksum mismatch');
  let p = 0, color = 0;
  for (let i = 1; i < last; i++) {
    const b = rle[i];
    const t = b >> 6;
    let run;
    if (t === 2) {
      const dt = (b >> 4) & 3, dv = b & 15;
      color = dt < 2 ? color + dv : color - dv;
      run = dt === 1 || dt === 3 ? rle[++i] : 1;
    } else {
      if (t === 0) color = 0;
      else if (t === 3) color = 255;
      else color = rle[++i];
      const L = (b >> 4) & 3;
      run = b & 15;
      for (let k = 0; k < L; k++) run += rle[++i] << (4 + 8 * (L - 1 - k));
    }
    if (run <= 0 || p + run > n) throw new Error('GOO layer overruns the image');
    if (color) img.fill(color, p, p + run);
    p += run;
  }
  if (p !== n) throw new Error(`GOO pixel count mismatch: ${p} != ${n}`);
  return img;
}

// ---------------------------------------------------------------- file

class BE {
  constructor(size) { this.u8 = new Uint8Array(size); this.dv = new DataView(this.u8.buffer); this.o = 0; }
  str(s, len) { const b = te.encode(s).subarray(0, len); this.u8.set(b, this.o); this.o += len; }
  bytes(b) { this.u8.set(b, this.o); this.o += b.length; }
  u8v(v) { this.dv.setUint8(this.o, v); this.o += 1; }
  u16(v) { this.dv.setUint16(this.o, v); this.o += 2; }
  u32(v) { this.dv.setUint32(this.o, v >>> 0); this.o += 4; }
  f32(v) { this.dv.setFloat32(this.o, v); this.o += 4; }
}

export function rgb565BE(rgba, w, h) {
  const out = new Uint8Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    const r = rgba[i * 4] * a, g = rgba[i * 4 + 1] * a, b = rgba[i * 4 + 2] * a; // over black
    const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    out[i * 2] = v >> 8; out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

const HEADER_SIZE = 195477; // as in the reference file (with 116² and 290² previews)

/**
 * previews: [{rgba, w:116, h:116}, {rgba, w:290, h:290}]
 * layers: Uint8Array RLE per layer (from encodeGOO)
 * Returns array of Uint8Array chunks.
 */
export function buildGOO({ printer, profile: p, aa, layers, previews, printTime, volumeMl, when = new Date() }) {
  if (!layers.length) throw new Error('Nothing to print: no layers');
  const [small, big] = previews;
  if (small.w !== 116 || small.h !== 116 || big.w !== 290 || big.h !== 290) throw new Error('GOO previews must be 116x116 and 290x290');
  const h = new BE(HEADER_SIZE);
  h.str('V3.0', 4);
  h.bytes(MAGIC);
  h.str('Max Slicer', 32);
  h.str(APP_VERSION, 24);
  h.str(when.toISOString(), 24);
  h.str(printer.name, 32);
  h.str(printer.name, 32);            // machine type: Lychee writes the model name here
  h.str(p.name, 32);
  h.u16(aa || 1);                     // anti-aliasing level
  h.u16(1);                           // grey level
  h.u16(p.blur | 0);                  // blur level
  h.bytes(rgb565BE(small.rgba, 116, 116)); h.bytes([0x0d, 0x0a]);
  h.bytes(rgb565BE(big.rgba, 290, 290)); h.bytes([0x0d, 0x0a]);
  h.u32(layers.length);
  h.u16(printer.resX); h.u16(printer.resY);
  h.u8v(0); h.u8v(1);                 // mirror X / mirror Y flags as in the reference
  h.f32(printer.displayW); h.f32(printer.displayH); h.f32(printer.maxZ);
  h.f32(p.layerHeight);
  h.f32(p.exposure);
  h.u8v(1);                           // delay mode: wait time
  h.f32(0);                           // light-off delay (unused in wait-time mode)
  h.f32(p.bottomWaitAfterCure); h.f32(p.bottomWaitAfterLift); h.f32(p.bottomWaitBeforeCure);
  h.f32(p.waitAfterCure); h.f32(p.waitAfterLift); h.f32(p.waitBeforeCure);
  h.f32(p.bottomExposure);
  h.u32(p.bottomLayers);
  h.f32(p.bottomLiftHeight); h.f32(p.bottomLiftSpeed);
  h.f32(p.liftHeight); h.f32(p.liftSpeed);
  h.f32(p.bottomLiftHeight); h.f32(p.bottomRetractSpeed);   // retract height = lift height
  h.f32(p.liftHeight); h.f32(p.retractSpeed);
  const two = !!p.twoStage;
  h.f32(two ? p.bottomLiftHeight2 : 0); h.f32(two ? p.bottomLiftSpeed2 : 0);
  h.f32(two ? p.liftHeight2 : 0); h.f32(two ? p.liftSpeed2 : 0);
  h.f32(two ? p.bottomLiftHeight2 : 0); h.f32(two ? p.bottomRetractSpeed2 : 0);
  h.f32(two ? p.liftHeight2 : 0); h.f32(two ? p.retractSpeed2 : 0);
  h.u16(255); h.u16(255);             // bottom / normal light PWM
  h.u8v(0);                           // per-layer settings flag (as Lychee)
  h.u32(Math.round(printTime));
  h.f32(volumeMl * 1000);             // Lychee writes the volume in mm³
  h.f32(volumeMl * p.density);
  h.f32((volumeMl / 1000) * p.pricePerLitre);
  h.str(p.currencyCode || 'EUR', 8);
  h.u32(HEADER_SIZE);                 // layer definitions start right after the header
  h.u8v(1);                           // grey scale level
  h.u16(p.transitionLayers | 0);
  if (h.o !== HEADER_SIZE) throw new Error(`GOO header size ${h.o} != ${HEADER_SIZE}`);
  const chunks = [h.u8];
  for (let k = 0; k < layers.length; k++) {
    const bottom = k < p.bottomLayers;
    const d = new BE(70);
    d.u16(0); d.f32(0);                                   // pause, pause Z
    d.f32(Math.round((k + 1) * p.layerHeight * 1e4) / 1e4);
    d.f32(gooExposure(p, k));
    d.f32(0);                                             // light-off delay
    d.f32(bottom ? p.bottomWaitAfterCure : p.waitAfterCure);
    d.f32(bottom ? p.bottomWaitAfterLift : p.waitAfterLift);
    d.f32(bottom ? p.bottomWaitBeforeCure : p.waitBeforeCure);
    const lh = bottom ? p.bottomLiftHeight : p.liftHeight;
    d.f32(lh); d.f32(bottom ? p.bottomLiftSpeed : p.liftSpeed);
    const lh2 = two ? (bottom ? p.bottomLiftHeight2 : p.liftHeight2) : 0;
    d.f32(lh2); d.f32(two ? (bottom ? p.bottomLiftSpeed2 : p.liftSpeed2) : 0);
    d.f32(lh); d.f32(bottom ? p.bottomRetractSpeed : p.retractSpeed);
    d.f32(lh2); d.f32(two ? (bottom ? p.bottomRetractSpeed2 : p.retractSpeed2) : 0);
    d.u16(255);
    d.bytes([0x0d, 0x0a]);
    d.u32(layers[k].length);
    chunks.push(d.u8.subarray(0, d.o), layers[k], new Uint8Array([0x0d, 0x0a]));
  }
  chunks.push(new Uint8Array([0, 0, 0, ...MAGIC]));
  return chunks;
}

// ---------------------------------------------------------------- reader (inspection)

const td = new TextDecoder();
export function readGOO(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const s = (o, l) => td.decode(u8.subarray(o, o + l)).replace(/\0[\s\S]*$/, '');
  if (s(0, 4) !== 'V3.0') throw new Error(`Unsupported GOO version "${s(0, 4)}" (only V3.0 can be opened)`);
  const P = 195310; // first field after the two previews
  const layerCount = dv.getUint32(P), W = dv.getUint16(P + 4), H = dv.getUint16(P + 6);
  const info = {
    software: { mark: s(12, 32), version: s(44, 24) }, machine: s(92, 32), profile: s(156, 32), W, H, layerCount,
    layerHeight: dv.getFloat32(P + 22), exposure: dv.getFloat32(P + 26), bottomExposure: dv.getFloat32(P + 59),
    printTime: dv.getUint32(HEADER_SIZE - 31),
  };
  let o = dv.getUint32(HEADER_SIZE - 7);
  const layers = [];
  for (let k = 0; k < layerCount; k++) {
    const len = dv.getUint32(o + 66);
    layers.push({ z: dv.getFloat32(o + 6), exposure: dv.getFloat32(o + 10), off: o + 70, len });
    o += 70 + len + 2;
  }
  return { ...info, layers, layerImage: (k) => decodeGOO(u8.subarray(layers[k].off, layers[k].off + layers[k].len), W, H) };
}
