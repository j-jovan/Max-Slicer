// Anycubic PW0 run-length codec (headerless, row-major, 4-bit colour = value >> 4).
// Colour 0x0 / 0xF: 2 bytes  [cccc LLLL][LLLLLLLL]  run up to 4095
// Colour 0x1..0xE: 1 byte    [cccc LLLL]            run up to 15
// Verified bit-exact against layer images in a Lychee-exported .pm7m.

export function encodePW0(img, W = 0, dirty = null) {
  const n = img.length;
  const u32 = img.byteOffset % 4 === 0 && n % 4 === 0 ? new Uint32Array(img.buffer, img.byteOffset, n >> 2) : null;
  const wn = n >> 2;
  let out = new Uint8Array(Math.max(1024, n >> 6));
  let o = 0;
  const ensure = (k) => {
    if (o + k > out.length) { const b = new Uint8Array(out.length * 2 + k); b.set(out); out = b; }
  };
  let i = 0;
  while (i < n) {
    const c = img[i] >> 4;
    let j = i + 1;
    if (c === 0 && dirty !== null) {
      // colour-0 run: skip clean rows whole, zero words 4 px at a time, else per pixel
      while (j < n) {
        if (j % W === 0 && dirty[j / W] === 0) { j += W; continue; }
        if ((j & 3) === 0 && u32 !== null && u32[j >> 2] === 0) { j += 4; continue; }
        if (img[j] < 16) { j++; continue; }
        break;
      }
    } else if (u32 !== null && (c === 0 || c === 15)) {
      // byte-step to alignment, then skip whole uniform words (all 0 or all 255)
      while (j < n && (j & 3) !== 0 && img[j] >> 4 === c) j++;
      if (j < n && (j & 3) === 0) {
        const word = c === 0 ? 0 : 0xffffffff;
        let w = j >> 2;
        while (w < wn && u32[w] === word) w++;
        j = w << 2;
        while (j < n && img[j] >> 4 === c) j++;
      }
    } else {
      while (j < n && img[j] >> 4 === c) j++;
    }
    let reps = j - i;
    if (c === 0 || c === 15) {
      ensure(((reps / 4095) | 0) * 2 + 2);
      while (reps > 0) {
        const done = reps > 4095 ? 4095 : reps;
        out[o++] = (c << 4) | (done >> 8);
        out[o++] = done & 0xff;
        reps -= done;
      }
    } else {
      ensure(((reps / 15) | 0) + 1);
      while (reps > 0) {
        const done = reps > 15 ? 15 : reps;
        out[o++] = (c << 4) | done;
        reps -= done;
      }
    }
    i = j;
  }
  return out.slice(0, o);
}

export function decodePW0(data, W, H) {
  const n = W * H;
  const img = new Uint8Array(n);
  let p = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    const c = b >> 4;
    let reps;
    if (c === 0 || c === 15) { reps = ((b & 0xf) << 8) | data[++i]; }
    else reps = b & 0xf;
    if (p + reps > n) throw new Error('PW0 data overruns image');
    if (c !== 0) img.fill(c * 17, p, p + reps);
    p += reps;
  }
  if (p !== n) throw new Error(`PW0 pixel count mismatch: ${p} != ${n}`);
  return img;
}
