// Manual editing by real clicks: add/remove supports, drain hole, lay flat, undo/redo,
// project save + reopen, STL export, opening an existing .pm7m.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const OUT = '/tmp/claude-0/-home-claude/f01b2700-2867-5fb7-ab33-8e813716c5e8/scratchpad/shots';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const app = await electron.launch({
  executablePath: process.env.APP_EXE || path.resolve('node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.APP_EXE ? [] : ['.'])],
});
await app.evaluate(({ dialog }) => {
  dialog.showSaveDialog = async (_w, opts) => ({ canceled: false, filePath: `/tmp/m7test-${opts.defaultPath}` });
  dialog.showMessageBox = async () => ({ response: 0 });
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await win.waitForSelector('#steps button');
const idle = async () => { await win.waitForTimeout(200); while (await win.evaluate(() => !!window.__app.state.busy)) await win.waitForTimeout(200); };
const S = () => win.evaluate(() => { const m = window.__app.state.models[0]; return m ? { supports: m.supportPoints.length, holes: m.holes.length, q: m.quaternion, n: window.__app.state.models.length, z: m.position[2] } : null; });
// screen position of a world point
const screenOf = (p) => win.evaluate((p) => {
  const v = window.__app.viewer;
  const c = v.renderer.domElement.getBoundingClientRect();
  const w = { x: p[0], y: p[1], z: p[2] };
  const vec = new v.camera.position.constructor(w.x, w.y, w.z).project(v.camera);
  return { x: c.left + ((vec.x + 1) / 2) * c.width, y: c.top + ((1 - vec.y) / 2) * c.height };
}, p);

// 3MF import (built in the page from a tiny cube model)
await win.evaluate(async () => {
  const xml = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="cube3mf"><mesh><vertices>
<vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="2" y="2" z="0"/><vertex x="0" y="2" z="0"/><vertex x="0" y="0" z="2"/><vertex x="2" y="0" z="2"/><vertex x="2" y="2" z="2"/><vertex x="0" y="2" z="2"/></vertices><triangles>
<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="3" v3="2"/><triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="6" v3="7"/><triangle v1="0" v2="1" v3="5"/><triangle v1="0" v2="5" v3="4"/><triangle v1="1" v2="2" v3="6"/><triangle v1="1" v2="6" v3="5"/><triangle v1="2" v2="3" v3="7"/><triangle v1="2" v2="7" v3="6"/><triangle v1="3" v2="0" v3="4"/><triangle v1="3" v2="4" v3="7"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>`;
  // minimal stored ZIP built by hand
  const enc = new TextEncoder();
  const files = [['3D/3dmodel.model', enc.encode(xml)], ['[Content_Types].xml', enc.encode('<Types/>')]];
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (u) => { let c = ~0 >>> 0; for (const b of u) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const parts = [], cd = []; let off = 0;
  for (const [name, data] of files) {
    const nm = enc.encode(name); const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc(data), true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(lh.buffer), nm, data);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(6, 20, true); c.setUint32(16, crc(data), true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cd.push(new Uint8Array(c.buffer), nm); off += 30 + nm.length + data.length;
  }
  let cds = 0; for (const c of cd) cds += c.length;
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cds, true); e.setUint32(16, off, true);
  const blob = new Blob([...parts, ...cd, new Uint8Array(e.buffer)]);
  await window.__app.openFiles([{ name: 'test.3mf', data: await blob.arrayBuffer() }]);
});
await idle();
const cube = await win.evaluate(() => { const m = window.__app.state.models[0]; const b = window.__app.sceneGroups(); return { name: m.name, n: b.model.length / 9 }; });
const size = await win.evaluate(() => document.querySelector('#side .kv dd').textContent);
log('3MF:', cube, 'size', size);
assert.equal(cube.name, 'cube3mf');
assert.equal(size, '20.0 × 20.0 × 20.0 mm', '3MF centimetre units converted');

// manual supports by clicking the cube's underside region from below
await win.click('#steps button:nth-child(3)');
await win.click('#panel .btns .btn >> nth=2'); // Add supports tool
await win.evaluate(() => window.__app.viewer.view('bottom'));
await win.waitForTimeout(400);
for (const [dx, dy] of [[-5, -5], [5, -5], [5, 5], [-5, 5]]) {
  const sc = await screenOf([dx, dy, 0.5]);
  await win.mouse.click(sc.x, sc.y);
  await idle();
}
let st = await S();
log('after 4 clicks', st);
assert.equal(st.supports, 4, 'four manual supports');
assert.ok(st.z > 5, 'model lifted onto supports');
await win.keyboard.press('Escape');
await win.evaluate(() => window.__app.viewer.view('iso'));
await win.waitForTimeout(300);
await win.screenshot({ path: `${OUT}/20-manual-supports.png` });
// remove one support by clicking its trunk
await win.click('#panel .btns .btn >> nth=3'); // Remove supports tool
const trunk = await win.evaluate(() => { const m = window.__app.state.models[0]; const p = m.supportGeo.plans[0]; return [p.T[0], p.T[1], (p.T[2] + p.bottom[2]) / 2]; });
const tsc = await screenOf(trunk);
await win.mouse.click(tsc.x, tsc.y);
await idle();
st = await S();
log('after remove click', st);
assert.equal(st.supports, 3, 'support removed by click');
await win.keyboard.press('Escape');
// undo / redo
await win.keyboard.press('Control+z'); await idle();
assert.equal((await S()).supports, 4, 'undo restores support');
await win.keyboard.press('Control+y'); await idle();
assert.equal((await S()).supports, 3, 'redo removes again');

// manual drain hole on the side
await win.click('#steps button:nth-child(2)');
await win.click('#panel .sect:nth-of-type(2) .btns .btn >> nth=0');
await win.evaluate(() => window.__app.viewer.view('front'));
await win.waitForTimeout(400);
const z = await win.evaluate(() => window.__app.state.models[0].position[2]);
const hs = await screenOf([0, -10, z]);
await win.mouse.click(hs.x, hs.y);
await idle();
st = await S();
log('hole', st);
assert.equal(st.holes, 1, 'drain hole added by click');
await win.keyboard.press('Escape');

// project save and reopen
await win.click('#filebar .btn >> nth=1');
await idle();
assert.ok(fs.existsSync('/tmp/m7test-plate.m7proj'), 'project saved');
await win.evaluate(async () => { const f = await window.host.readPath('/tmp/m7test-plate.m7proj'); await window.__app.openFiles([f]); });
await idle();
st = await S();
log('reopened project', st);
assert.equal(st.n, 1); assert.equal(st.supports, 3); assert.equal(st.holes, 1);

// STL export
await win.click('#filebar .btn >> nth=2');
await idle();
const stl = fs.statSync('/tmp/m7test-plate.stl').size;
log('STL bytes', stl);
assert.ok(stl > 84 && (stl - 84) % 50 === 0, 'valid binary STL');

// open an existing print file (the Lychee reference) for inspection
const ref = process.env.REF || '/home/claude/sample/Miki_za_resin3.pm7m';
await win.evaluate(async (p) => { const f = await window.host.readPath(p); await window.__app.openFiles([f]); }, ref);
await idle();
await win.waitForTimeout(1500);
await win.screenshot({ path: `${OUT}/21-open-pm7m.png` });
const opened = await win.evaluate(() => ({ n: window.__app.state.opened?.layerCount, name: window.__app.state.opened?.name }));
log('opened print file', opened);
assert.equal(opened.n, 2131);
log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await app.close();
console.log('UI edit test OK');
