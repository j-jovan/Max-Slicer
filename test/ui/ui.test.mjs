// Drives the real Electron app through the full workflow and captures screenshots.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.SHOTS || '/tmp/claude-0/-home-claude/f01b2700-2867-5fb7-ab33-8e813716c5e8/scratchpad/shots';
fs.mkdirSync(OUT, { recursive: true });
const model = process.argv[2] || '/home/claude/models/bunny.stl';
const exportPath = process.argv[3] || '/home/claude/m7slicer/test/out/ui-export.pm7m';
const lang = process.env.LANG_UI || 'en';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const app = await electron.launch({
  executablePath: process.env.APP_EXE || path.resolve('node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.APP_EXE ? [] : ['.'])],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
// stub native dialogs in the main process
await app.evaluate(({ dialog }, p) => {
  dialog.showSaveDialog = async (_w, opts) => ({ canceled: false, filePath: (opts.defaultPath || '').endsWith('.pm7m') ? p : `/tmp/${opts.defaultPath}` });
  dialog.showMessageBox = async () => ({ response: 0 });
}, exportPath);
const win = await app.firstWindow();
const errors = [];
win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await win.setViewportSize?.({ width: 1600, height: 960 }).catch(() => {});
await win.waitForSelector('#steps button');
await win.waitForTimeout(800);
const shot = async (name) => { await win.waitForTimeout(400); await win.screenshot({ path: `${OUT}/${name}.png` }); log('shot', name); };
const idle = async (timeout = 600000) => {
  const t0 = Date.now();
  await win.waitForTimeout(200);
  while (await win.evaluate(() => !!window.__app.state.busy)) {
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for idle');
    await win.waitForTimeout(250);
  }
};
if (lang === 'sr') await win.click('.seg button:has-text("SR")');
await shot('01-empty');

// load model as if dropped
const data = fs.readFileSync(model).toString('base64');
await win.evaluate(async ({ name, b64 }) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__app.openFiles([{ name, data: bin.buffer }]);
}, { name: path.basename(model), b64: data });
await idle();
await shot('02-loaded');
log('status DOM:', await win.evaluate(() => document.getElementById('status').innerHTML));

const click = async (text) => { await win.click(`button:has-text("${text}")`); };
// Prepare: auto-orient
await win.evaluate(() => window.__app.autoOrientSel());
await idle();
await shot('03-oriented');

// Hollow step
await win.click('#steps button:nth-child(2)');
await win.click('#panel .sect .btns .btn.primary');
await idle();
await shot('04-hollowed');

// Supports step
await win.click('#steps button:nth-child(3)');
await win.click('#panel .sect .btns .btn.primary');
await idle();
await win.click('.vtools .group:nth-child(3) button >> nth=0');
await shot('05-supported');

// back to hollow: auto drain holes + suction check
await win.click('#steps button:nth-child(2)');
await win.click('#panel .sect:nth-of-type(2) .btns .btn >> nth=1');
await idle();
await win.click('#panel .sect:nth-of-type(3) .btn.wide');
await idle();
await shot('06-holes-suction');

// islands
await win.click('#steps button:nth-child(3)');
await win.click('#panel .sect >> nth=0 >> .btn.wide');
await idle();
await win.click('.vtools .group:nth-child(3) button >> nth=0');
await shot('07-islands');

// slice
await win.click('#steps button:nth-child(4)');
if (process.env.AA) { await win.selectOption('#panel select >> nth=1', process.env.AA); }
await shot('08-slice-panel');
await win.click('#panel > .btns .btn.primary');
await idle(1800000);
await win.waitForTimeout(1500);
await shot('09-layer-view');
const st = await win.evaluate(() => { const s = window.__app.state; return { layers: s.slice?.layerCount, time: s.slice?.time, ml: s.slice?.volumeMl, islands: s.analysis?.islands?.length, suction: s.analysis?.suction?.length, trapped: s.analysis?.trapped?.length, holes: s.models.map((m) => m.holes.length), supports: s.models.map((m) => m.supportPoints.length) }; });
log('state', JSON.stringify(st));
// move through layers
await win.evaluate(() => window.__app.showLayer(Math.floor(window.__app.state.slice.layerCount * 0.45)));
await win.waitForTimeout(1500);
await win.click('canvas.layer', { position: { x: 400, y: 260 } }).catch(() => {});
await win.waitForTimeout(1200);
await shot('10-layer-mid');

// export
await win.click('.topright .btn.primary');
await idle();
await win.waitForTimeout(1000);
await shot('11-exported');
log('exported', fs.existsSync(exportPath) ? fs.statSync(exportPath).size : 'MISSING');

// undo/redo sanity
await win.keyboard.press('Escape');
await win.evaluate(() => { window.__app.undo(); window.__app.redo(); });
await idle();
log('console errors:', errors.length ? errors.join('\n') : 'none');
await app.close();
