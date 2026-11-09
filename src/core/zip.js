// Minimal ZIP writer that accepts pre-deflated entries (so layers can be compressed
// in parallel workers), plus a reader built on fflate.
import { deflateSync, inflateSync } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

// Compress one entry (deflate, level 6). Returns {data, crc, size}.
export function packEntry(u8, level = 6) {
  return { data: deflateSync(u8, { level }), crc: crc32(u8), size: u8.length, method: 8 };
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const enc = new TextEncoder();

// entries: [{name, data, crc, size, method}] -> array of Uint8Array chunks forming the zip
export function buildZip(entries, when = new Date()) {
  const { time, date } = dosDateTime(when);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);          // version needed
    lh.setUint16(6, 0, true);           // flags
    lh.setUint16(8, e.method, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, e.crc, true);
    lh.setUint32(18, e.data.length, true);
    lh.setUint32(22, e.size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, e.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 0x033f, true);      // made by: Unix, spec 6.3 (as in the reference file)
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true);
    ch.setUint16(10, e.method, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, e.crc, true);
    ch.setUint32(20, e.data.length, true);
    ch.setUint32(24, e.size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0x81b60000, true); // -rw-rw-rw- regular file (as in the reference file)
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + e.data.length;
    if (offset > 0xffffffff) throw new Error('Output exceeds 4 GB ZIP limit');
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length & 0xffff, true);
  end.setUint16(10, entries.length & 0xffff, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  if (entries.length > 0xffff) throw new Error('Too many layers for a standard ZIP (65535 entries max)');
  return [...chunks, ...central, new Uint8Array(end.buffer)];
}

export function concatChunks(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Lazy reader: returns Map name -> {get(): Uint8Array}
export function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const map = new Map();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    map.set(name, {
      size: usize,
      get() {
        const ln = dv.getUint16(lho + 26, true), lx = dv.getUint16(lho + 28, true);
        const s = lho + 30 + ln + lx;
        const raw = u8.subarray(s, s + csize);
        if (method === 0) return raw.slice();
        if (method === 8) return inflateSync(raw, { out: new Uint8Array(usize) });
        throw new Error(`Unsupported ZIP method ${method}`);
      },
    });
  }
  return map;
}
