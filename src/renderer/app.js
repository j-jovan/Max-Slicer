// Application controller: state, actions, panels.
import * as THREE from 'three';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { Viewer, COLORS } from './viewer.js';
import { ComputeWorker } from './pool.js';
import { h, num, row, select, check, btn, icon, fmt } from './dom.js';
import { t, setLang, getLang } from './i18n.js';
import { M7MAX, DEFAULT_PROFILE } from '../core/printer.js';
import { transformTris, bounds, frustum, toBinarySTL, concatTris } from '../core/mesh.js';
import { DEFAULT_SUPPORT_SETTINGS, SUPPORT_PRESETS } from '../core/supports.js';
import { buildPM7M } from '../core/pm7m.js';
import { printTime, formatDuration } from '../core/estimate.js';
import { heightmapPreview } from '../core/png.js';

// ---------------------------------------------------------------- host bridge (Electron or browser fallback)
const host = window.host || {
  async openFiles(filters, multi = true) {
    return new Promise((res) => {
      const i = document.createElement('input');
      i.type = 'file'; i.multiple = multi;
      i.accept = filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
      i.onchange = async () => res(await Promise.all([...i.files].map(async (f) => ({ name: f.name, path: f.name, data: await f.arrayBuffer() }))));
      i.click();
    });
  },
  async readPath() { throw new Error('Not available'); },
  async saveDialog(name) { return name; },
  async writeChunks(name, chunks) {
    const blob = new Blob(chunks);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name.split(/[\\/]/).pop(); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { bytes: blob.size };
  },
  async loadSettings() { try { return JSON.parse(localStorage.getItem('m7settings')); } catch { return null; } },
  async saveSettings(o) { try { localStorage.setItem('m7settings', JSON.stringify(o)); } catch { /* storage unavailable */ } return true; },
  async sysInfo() { return { cpus: navigator.hardwareConcurrency || 4 }; },
  async confirm(message, detail, buttons) { return window.confirm(`${message}\n${detail || ''}`) ? 0 : (buttons || ['OK', 'Cancel']).length - 1; },
  async closeNow() {},
  async showInFolder() {},
  onOpenPath() {},
  onRequestClose() {},
};

// ---------------------------------------------------------------- state
const state = {
  models: [],
  selected: null,
  step: 'prepare',
  tool: null,               // 'addSupport' | 'removeSupport' | 'addHole' | 'layFlat'
  transformMode: 'translate',
  profile: { ...DEFAULT_PROFILE, currencyCode: 'EUR' },
  profiles: [],
  support: { ...DEFAULT_SUPPORT_SETTINGS },
  hollow: { wall: 2.0, infill: { type: 'none', spacing: 6, thickness: 1.2 }, holeDiameter: 3.0, holeDepth: 0 },
  orientGoal: 'balanced',
  slice: null,              // {packed, stats, layerCount, time, volumeMl}
  opened: null,             // opened .pm7m summary
  analysis: null,           // {islands, suction, trapped}
  xray: false,
  layerView: false,
  layerIndex: 0,
  clipZ: null,
  busy: null,
  dirty: false,
  applyAll: false,
};
let nextId = 1;
const history = { undo: [], redo: [] };
let viewer;
let compute;
let cpuCount = 4;

const $ = (id) => document.getElementById(id);
// replaceChildren() would turn null into the text "null"; drop empty slots first
function put(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); }

// ---------------------------------------------------------------- geometry helpers
const _m = new THREE.Matrix4();
function matrixOf(m, withScale = true) {
  return _m.compose(new THREE.Vector3(...m.position), new THREE.Quaternion(...m.quaternion), withScale ? new THREE.Vector3(...m.scale) : new THREE.Vector3(1, 1, 1)).elements.slice();
}
function scaleMatrix(m) { return new THREE.Matrix4().makeScale(...m.scale).elements.slice(); }
function rotKey(m) { return `${m.quaternion.map((x) => x.toFixed(9))}|${m.scale.map((x) => x.toFixed(9))}`; }
function fullKey(m) { return `${rotKey(m)}|${m.position.map((x) => x.toFixed(6))}`; }

// world-space triangles (cached by full transform)
function worldTris(m) {
  const k = fullKey(m);
  if (m.__wk !== k) { m.__w = transformTris(m.tris, matrixOf(m)); m.__wk = k; m.__wb = bounds(m.__w); }
  return m.__w;
}
function worldBounds(m) { worldTris(m); return m.__wb; }
// rotated+scaled (no translation) bounds to place quickly
function rsBounds(m) {
  const k = rotKey(m);
  if (m.__rk !== k) {
    const mm = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion(...m.quaternion), new THREE.Vector3(...m.scale)).elements;
    const b = bounds(transformTris(m.tris, mm));
    m.__rb = b; m.__rk = k;
  }
  return m.__rb;
}
function scaledLocal(m) { return transformTris(m.tris, scaleMatrix(m)); }

function raftTop() { return state.support.raft === 'slab' ? state.support.raftHeight : 0; }
function hasSupports(m) { return m.supportPoints && m.supportPoints.length > 0; }
function restZ(m) { return hasSupports(m) ? raftTop() + (m.elevation ?? state.support.elevation) : 0; }

function dropToPlate(m) {
  const b = rsBounds(m);
  m.position[2] = restZ(m) - b.min[2];
}
function liftForSupports(m) {
  const b = rsBounds(m);
  m.position[2] = raftTop() + (m.elevation ?? state.support.elevation) - b.min[2];
}

// supports world triangles (geometry built at position `builtAt`; translate by the difference)
function supportTris(m) {
  const g = m.supportGeo;
  if (!g || !g.tris.length) return null;
  const d = [m.position[0] - g.builtAt[0], m.position[1] - g.builtAt[1], m.position[2] - g.builtAt[2]];
  if (!d[0] && !d[1] && !d[2]) return g.tris;
  const o = new Float32Array(g.tris.length);
  for (let i = 0; i < o.length; i += 3) { o[i] = g.tris[i] + d[0]; o[i + 1] = g.tris[i + 1] + d[1]; o[i + 2] = g.tris[i + 2] + d[2]; }
  return o;
}

function cavityWorld(m) {
  if (!m.hollow?.enabled || !m.cavity || !m.cavity.length) return null;
  return transformTris(m.cavity, matrixOf(m, false));
}

function holesWorld(m) {
  if (!m.holes?.length) return null;
  const M = new THREE.Matrix4().fromArray(matrixOf(m, false));
  const R = new THREE.Matrix4().extractRotation(M);
  const out = [];
  for (const hl of m.holes) {
    const p = new THREE.Vector3(...hl.p).applyMatrix4(M);
    const d = new THREE.Vector3(...hl.dir).applyMatrix4(R).normalize();
    const a = p.clone().addScaledVector(d, -1), b = p.clone().addScaledVector(d, hl.depth - 1);
    frustum(a.x, a.y, a.z, b.x, b.y, b.z, hl.diameter / 2, hl.diameter / 2, 24, out);
  }
  return Float32Array.from(out);
}

// ---------------------------------------------------------------- history
function snapshot() {
  return state.models.map((m) => ({
    ...m,
    position: [...m.position], quaternion: [...m.quaternion], scale: [...m.scale],
    supportPoints: (m.supportPoints || []).map((p) => ({ ...p })),
    holes: (m.holes || []).map((x) => ({ ...x })),
    hollow: { ...(m.hollow || {}) },
  }));
}
function pushHistory() {
  history.undo.push({ models: snapshot(), selected: state.selected });
  if (history.undo.length > 60) history.undo.shift();
  history.redo.length = 0;
  state.dirty = true;
  invalidateSlice();
}
function restore(snap) {
  const keep = new Set(snap.models.map((m) => m.id));
  for (const m of state.models) if (!keep.has(m.id)) viewer.removeModel(m.id);
  const had = new Set(state.models.map((m) => m.id));
  state.models = snap.models.map((m) => ({ ...m }));
  for (const m of state.models) {
    if (!had.has(m.id)) viewer.addModel(m);
    viewer.setSupports(m.id, m.supportGeo?.tris);
  }
  state.selected = snap.selected && keep.has(snap.selected) ? snap.selected : null;
  invalidateSlice();
  syncAll();
  render();
}
function undo() { const s = history.undo.pop(); if (!s) return; history.redo.push({ models: snapshot(), selected: state.selected }); restore(s); }
function redo() { const s = history.redo.pop(); if (!s) return; history.undo.push({ models: snapshot(), selected: state.selected }); restore(s); }

// geometry changes clear the slice and the analysis; resin/profile changes only the slice
function invalidateSlice(geometry = true) {
  if (state.slice) { state.slice = null; state.layerView = false; viewer?.setClip(state.clipZ); }
  if (geometry) { state.analysis = null; viewer?.setMarkers([]); }
}

// ---------------------------------------------------------------- UI feedback
let toastTimer;
function toast(msg, { error = false, action = null, ms = 3800 } = {}) {
  const el = $('toast');
  el.className = `toast show${error ? ' err' : ''}`;
  put(el, msg);
  if (action) el.append(h('a', { onclick: action.fn }, action.label));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), ms);
}
function setBusy(msg, p = null) { state.busy = msg ? { msg, p } : null; renderStatus(); }
async function task(msg, fn) {
  if (state.busy) { toast(t('Working…')); return; }
  setBusy(msg, 0);
  try { return await fn((p, m) => setBusy(m || msg, p)); }
  catch (e) { console.error(e); toast(String(e.message || e).split('\n')[0], { error: true, ms: 7000 }); }
  finally { setBusy(null); render(); }
}

// ---------------------------------------------------------------- model management
function sel() { return state.models.find((m) => m.id === state.selected) || null; }
function targets() { return state.applyAll ? state.models.filter((m) => m.visible !== false) : sel() ? [sel()] : []; }

async function addMeshes(parts) {
  pushHistory();
  for (const p of parts) {
    const b = bounds(p.tris);
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const tris = p.tris;
    for (let i = 0; i < tris.length; i += 3) { tris[i] -= c[0]; tris[i + 1] -= c[1]; tris[i + 2] -= c[2]; }
    const m = {
      id: nextId++, name: p.name, tris, report: p.report, visible: true,
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
      supportPoints: [], supportGeo: null, holes: [], hollow: { enabled: false }, cavity: null,
    };
    dropToPlate(m);
    state.models.push(m);
    viewer.addModel(m);
    state.selected = m.id;
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    if (Math.max(...size) < 2) toast(`${p.name}: very small (${size.map((s) => s.toFixed(2)).join(' × ')} mm). If it was exported in metres or inches, scale it up.`, { ms: 9000 });
  }
  arrange(false);
  syncAll();
  fitView();
  render();
}

async function openFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext === 'pm7m') { await openPrintFile(f); continue; }
    if (ext === 'm7proj') { await loadProject(f); continue; }
    await task(`${t('Working…')} ${f.name}`, async () => {
      const parts = await compute.run('load', { name: f.name, buffer: f.data }, [f.data]);
      const rep = parts.reduce((a, p) => a + p.report.flippedFaces + p.report.invertedShells + p.report.degenerate, 0);
      await addMeshes(parts);
      if (rep > 0) toast(`${f.name}: ${t('Repaired')} (${rep})`);
    });
  }
}

function removeSelected() {
  const m = sel();
  if (!m) return;
  pushHistory();
  viewer.removeModel(m.id);
  state.models = state.models.filter((x) => x !== m);
  state.selected = null;
  render();
}

function duplicate(m = sel(), copies = 1) {
  if (!m) return;
  pushHistory();
  for (let i = 0; i < copies; i++) {
    const c = {
      ...m, id: nextId++, name: `${m.name} (${state.models.length + 1})`,
      position: [m.position[0] + 10, m.position[1] + 10, m.position[2]], quaternion: [...m.quaternion], scale: [...m.scale],
      supportPoints: m.supportPoints.map((p) => ({ ...p })), holes: m.holes.map((x) => ({ ...x })), hollow: { ...m.hollow },
      supportGeo: m.supportGeo ? { ...m.supportGeo, builtAt: [...m.supportGeo.builtAt] } : null,
      __wk: null, __rk: null,
    };
    // support geometry offsets follow the copy
    if (c.supportGeo) { c.supportGeo.builtAt = [m.supportGeo.builtAt[0] + 10, m.supportGeo.builtAt[1] + 10, m.supportGeo.builtAt[2]]; }
    state.models.push(c);
    viewer.addModel(c);
    if (c.supportGeo) viewer.setSupports(c.id, c.supportGeo.tris);
    state.selected = c.id;
  }
  arrange(false);
  syncAll();
  render();
}

// footprint including supports/raft
function footprint(m) {
  const b = worldBounds(m);
  let x0 = b.min[0], y0 = b.min[1], x1 = b.max[0], y1 = b.max[1];
  const st = supportTris(m);
  if (st) { const s = bounds(st); x0 = Math.min(x0, s.min[0]); y0 = Math.min(y0, s.min[1]); x1 = Math.max(x1, s.max[0]); y1 = Math.max(y1, s.max[1]); }
  return { x0, y0, x1, y1 };
}

function arrange(push = true) {
  const ms = state.models.filter((m) => m.visible !== false);
  if (!ms.length) return;
  if (push) pushHistory();
  const gap = 4;
  const W = M7MAX.printW - 4, H = M7MAX.printH - 4;
  const items = ms.map((m) => ({ m, f: footprint(m) })).map((it) => ({ ...it, w: it.f.x1 - it.f.x0, d: it.f.y1 - it.f.y0 }));
  items.sort((a, b) => b.d - a.d || b.w - a.w);
  let x = 0, y = 0, rowH = 0;
  const placed = [];
  for (const it of items) {
    if (x > 0 && x + it.w > W) { x = 0; y += rowH + gap; rowH = 0; }
    placed.push({ it, x, y });
    x += it.w + gap;
    rowH = Math.max(rowH, it.d);
  }
  const totalH = y + rowH;
  const rowsW = new Map();
  for (const p of placed) rowsW.set(p.y, Math.max(rowsW.get(p.y) || 0, p.x + p.it.w));
  for (const p of placed) {
    const rw = rowsW.get(p.y);
    const tx = -rw / 2 + p.x, ty = totalH / 2 - p.y - p.it.d; // first row at the back
    const dx = tx - p.it.f.x0, dy = ty - p.it.f.y0;
    p.it.m.position[0] += dx; p.it.m.position[1] += dy;
  }
  if (totalH > H || Math.max(...rowsW.values()) > W) toast(t('Outside the build area'), { error: true });
  syncAll();
  render();
}

function syncAll() {
  for (const m of state.models) {
    m.__selected = m.id === state.selected;
    viewer.syncModel(m, m.__selected);
    const o = viewer.objects.get(m.id);
    if (o && m.supportGeo) o.supports.position.set(m.position[0] - m.supportGeo.builtAt[0], m.position[1] - m.supportGeo.builtAt[1], m.position[2] - m.supportGeo.builtAt[2]);
  }
  viewer.select(state.tool ? null : state.selected);
}

function fitView() {
  const box = new THREE.Box3();
  for (const m of state.models) if (m.visible !== false) { const b = worldBounds(m); box.expandByPoint(new THREE.Vector3(...b.min)); box.expandByPoint(new THREE.Vector3(...b.max)); }
  if (box.isEmpty()) box.set(new THREE.Vector3(-60, -40, 0), new THREE.Vector3(60, 40, 60));
  viewer.focus(box);
}

// rotation / scale changes invalidate supports (they are vertical by construction)
function afterOrientationChange(m) {
  if (hasSupports(m)) {
    m.supportPoints = []; m.supportGeo = null; viewer.setSupports(m.id, null);
    toast(t('Supports will be removed because the model was rotated or scaled.'), { action: { label: t('Undo'), fn: undo } });
  }
  dropToPlate(m);
}

function setRotationDeg(m, euler) {
  pushHistory();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler.map((d) => (d * Math.PI) / 180), 'XYZ'));
  m.quaternion = q.toArray();
  afterScaleOrRotate(m);
}
function afterScaleOrRotate(m, scaleChanged = false) {
  if (scaleChanged && (m.hollow?.enabled || m.holes.length)) {
    m.cavity = null; m.hollow = { enabled: false }; m.holes = [];
    toast(t('Scaling removed the hollowing and drain holes; hollow the model again.'), { action: { label: t('Undo'), fn: undo } });
  }
  afterOrientationChange(m);
  syncAll(); render();
}

function layFlat(hit) {
  const m = state.models.find((x) => x.id === hit.modelId);
  if (!m) return;
  pushHistory();
  const n = hit.normal.clone().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1));
  const cur = new THREE.Quaternion(...m.quaternion);
  m.quaternion = q.multiply(cur).toArray();
  afterOrientationChange(m);
  setTool(null);
  syncAll(); render();
}

// ---------------------------------------------------------------- orientation
async function autoOrientSel() {
  const ms = targets();
  if (!ms.length) return toast(t('Select a model first.'));
  await task(t('Auto-orient'), async () => {
    pushHistory();
    for (const m of ms) {
      const rs = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion(...m.quaternion), new THREE.Vector3(...m.scale)).elements;
      const tris = transformTris(m.tris, rs);
      const r = await compute.run('orient', { tris, goal: state.orientGoal, angle: state.support.angle }, [tris.buffer]);
      const q = new THREE.Quaternion(...r.quaternion).multiply(new THREE.Quaternion(...m.quaternion));
      m.quaternion = q.toArray();
      afterOrientationChange(m);
    }
    arrange(false);
    syncAll();
  });
}

// ---------------------------------------------------------------- supports
async function autoSupport() {
  const ms = targets();
  if (!ms.length) return toast(t('Select a model first.'));
  await task(t('Auto-support'), async () => {
    pushHistory();
    for (const m of ms) {
      m.elevation = state.support.elevation;
      liftForSupports(m);
      const tris = worldTris(m).slice();
      const r = await compute.run('autosupport', { tris, settings: state.support }, [tris.buffer]);
      m.supportPoints = r.points.map((p) => ({ p: [p.p[0] - m.position[0], p.p[1] - m.position[1], p.p[2] - m.position[2]], n: p.n, src: p.src }));
      await rebuildSupports(m);
    }
    arrange(false);
    syncAll();
  });
}

async function rebuildSupports(m) {
  if (!m.supportPoints.length) { m.supportGeo = null; viewer.setSupports(m.id, null); return; }
  const tris = worldTris(m).slice();
  const points = m.supportPoints.map((s) => ({ p: [s.p[0] + m.position[0], s.p[1] + m.position[1], s.p[2] + m.position[2]], n: s.n, src: s.src, tipD: s.tipD, trunkD: s.trunkD }));
  const r = await compute.run('buildsupports', { tris, points, settings: state.support }, [tris.buffer]);
  m.supportGeo = { tris: r.tris, parts: r.parts, builtAt: [...m.position], failed: r.failed, plans: r.plans };
  viewer.setSupports(m.id, r.tris);
  const o = viewer.objects.get(m.id);
  if (o) o.supports.position.set(0, 0, 0);
  if (r.failed) toast(`${t('Supports: ')}${r.failed} ${t('failed to route')}`);
}

async function rebuildAllSupports() {
  await task(t('Supports'), async () => {
    for (const m of state.models) if (hasSupports(m)) { dropToPlate(m); await rebuildSupports(m); }
    syncAll();
  });
}

function clearSupports() {
  const ms = targets();
  if (!ms.length) return;
  pushHistory();
  for (const m of ms) { m.supportPoints = []; m.supportGeo = null; viewer.setSupports(m.id, null); dropToPlate(m); }
  syncAll(); render();
}

async function addSupportAt(hit) {
  const m = state.models.find((x) => x.id === hit.modelId);
  if (!m) return;
  pushHistory();
  if (!hasSupports(m)) { m.elevation = state.support.elevation; const before = m.position[2]; liftForSupports(m); hit.point.z += m.position[2] - before; }
  m.supportPoints.push({ p: [hit.point.x - m.position[0], hit.point.y - m.position[1], hit.point.z - m.position[2]], n: hit.normal.toArray(), src: 'manual' });
  await task(t('Add supports'), async () => { await rebuildSupports(m); syncAll(); });
}

async function removeSupportAt(hit) {
  const m = state.models.find((x) => x.id === hit.modelId);
  if (!m || !m.supportGeo) return;
  const part = m.supportGeo.parts.find((p) => hit.faceIndex >= p.start && hit.faceIndex < p.start + p.count);
  if (!part) return; // braces / raft
  pushHistory();
  m.supportPoints.splice(part.point, 1);
  if (!m.supportPoints.length) { m.supportGeo = null; viewer.setSupports(m.id, null); dropToPlate(m); syncAll(); render(); return; }
  await task(t('Remove supports'), async () => { await rebuildSupports(m); syncAll(); });
}

// ---------------------------------------------------------------- hollowing
async function hollowSel() {
  const ms = targets();
  if (!ms.length) return toast(t('Select a model first.'));
  await task(t('Hollow model'), async () => {
    pushHistory();
    for (const m of ms) {
      const tris = scaledLocal(m);
      const r = await compute.run('hollow', { tris, wall: state.hollow.wall }, [tris.buffer]);
      if (!r.cavity.length) { toast(`${m.name}: ${t('Model too thin to hollow at this wall thickness.')}`, { error: true }); continue; }
      m.cavity = r.cavity;
      m.hollow = { enabled: true, wall: state.hollow.wall, cavityVolume: r.cavityVolume, modelVolume: r.modelVolume };
      if (!m.holes.length) toast(t('Hollowing removes resin from inside the model. Add at least one drain hole near the plate side.'), { ms: 8000 });
    }
    state.xray = true; viewer.setXray(true, state.models);
    syncAll();
  });
}
function unhollowSel() {
  const ms = targets();
  pushHistory();
  for (const m of ms) { m.hollow = { enabled: false }; m.cavity = null; }
  syncAll(); render();
}

function addHoleAt(hit, forcedDepth = 0) {
  const m = state.models.find((x) => x.id === hit.modelId);
  if (!m) return;
  pushHistory();
  const inv = new THREE.Matrix4().fromArray(matrixOf(m, false)).invert();
  const p = hit.point.clone().applyMatrix4(inv);
  const R = new THREE.Matrix4().extractRotation(inv);
  const d = hit.normal.clone().negate().applyMatrix4(R).normalize();
  const wall = m.hollow?.wall ?? state.hollow.wall;
  const depth = forcedDepth > 0 ? Math.max(forcedDepth, wall + 1) : state.hollow.holeDepth > 0 ? state.hollow.holeDepth : wall + 2.5;
  m.holes.push({ p: p.toArray(), dir: d.toArray(), diameter: state.hollow.holeDiameter, depth });
  syncAll(); render();
}

async function autoHoles() {
  const ms = targets().filter((m) => m.hollow?.enabled && m.cavity);
  if (!ms.length) return toast(`${t('Hollow model')}: ${t('Select a model first.')}`);
  await task(t('Auto-place drain holes'), async (prog) => {
    pushHistory();
    let total = 0;
    for (const m of ms) {
      const r = await compute.run('autoholes', { model: worldTris(m), cavity: cavityWorld(m), existingHoles: holesWorld(m), diameter: state.hollow.holeDiameter }, [], (p) => prog(p));
      for (const hl of r) {
        addHoleAt({ modelId: m.id, point: new THREE.Vector3(...hl.p), normal: new THREE.Vector3(...hl.dir).negate() }, hl.depth);
        history.undo.pop(); // keep one undo step for the whole operation
        total++;
      }
    }
    toast(`${t('Drain holes')}: +${total}`);
    syncAll();
  });
}

// ---------------------------------------------------------------- analysis
function sceneGroups() {
  const vis = state.models.filter((m) => m.visible !== false);
  return {
    model: concatTris(vis.map((m) => worldTris(m))),
    supports: concatTris(vis.map((m) => supportTris(m)).filter(Boolean)),
    cavity: concatTris(vis.map((m) => cavityWorld(m)).filter(Boolean)),
    holes: concatTris(vis.map((m) => holesWorld(m)).filter(Boolean)),
    infill: state.hollow.infill,
  };
}

async function checkIslands() {
  if (!state.models.length) return;
  await task(t('Check islands'), async (prog) => {
    const g = sceneGroups();
    const r = await compute.run('analyze', { groups: { model: g.model, supports: g.supports }, opts: { pixel: 0.15, layerHeight: 0.1, voids: false } }, [], (p) => prog(p));
    state.analysis = { ...(state.analysis || {}), islands: r.islands.map(({ pixels, ...i }) => i) };
    showMarkers();
  });
}
async function checkSuction() {
  if (!state.models.length) return;
  await task(t('Check suction & trapped resin'), async () => {
    const g = sceneGroups();
    // supports are left out: pockets between support bases on the raft are not worth reporting
    const r = await compute.run('analyze', { groups: { model: g.model, cavity: g.cavity, holes: g.holes, infill: g.infill }, opts: { pixel: 0.25, layerHeight: 0.1, islands: false } });
    state.analysis = { ...(state.analysis || {}), suction: r.suction, trapped: r.trapped };
    showMarkers();
  });
}
function showMarkers() {
  const a = state.analysis || {};
  const mk = [];
  for (const i of a.islands || []) mk.push({ x: i.x, y: i.y, z: i.z, color: COLORS.island, r: 0.9 });
  for (const s of a.suction || []) mk.push({ x: s.x, y: s.y, z: s.z, color: COLORS.suction, r: 1.6 });
  for (const s of a.trapped || []) mk.push({ x: s.x, y: s.y, z: s.z, color: COLORS.trapped, r: 2 });
  viewer.setMarkers(mk);
}

// ---------------------------------------------------------------- slicing & export
function plateProblems() {
  const out = [];
  const w = M7MAX.printW / 2, hh = M7MAX.printH / 2;
  for (const m of state.models) {
    if (m.visible === false) continue;
    const f = footprint(m);
    const b = worldBounds(m);
    if (f.x0 < -w - 0.01 || f.x1 > w + 0.01 || f.y0 < -hh - 0.01 || f.y1 > hh + 0.01) out.push({ m, msg: t('Outside the build area') });
    if (b.max[2] > M7MAX.maxZ) out.push({ m, msg: t('Too tall for the printer') });
    if (b.min[2] < -0.01) out.push({ m, msg: t('Model sits below the plate') });
  }
  return out;
}

let sliceWorkers = [];
let sliceCancel = false;
async function slicePlate() {
  const vis = state.models.filter((m) => m.visible !== false);
  if (!vis.length) return toast(t('Nothing to slice: the plate is empty.'));
  const probs = plateProblems();
  if (probs.length) return toast(`${probs[0].m.name}: ${probs[0].msg}`, { error: true, ms: 7000 });
  const p = state.profile;
  await task(t('Slicing…'), async (prog) => {
    const g = sceneGroups();
    let zmax = 0;
    for (const m of vis) zmax = Math.max(zmax, worldBounds(m).max[2]);
    if (g.supports.length) zmax = Math.max(zmax, bounds(g.supports).max[2]);
    const layerCount = Math.ceil(zmax / p.layerHeight - 1e-6);
    const job = { model: g.model, supports: g.supports, cavity: g.cavity, holes: g.holes, infill: g.infill, layerHeight: p.layerHeight, aa: p.antiAliasing, blur: p.blur };
    const n = Math.max(1, Math.min(8, cpuCount - 1));
    sliceWorkers = Array.from({ length: n }, () => new ComputeWorker('worker.js'));
    sliceCancel = false;
    const packed = new Array(layerCount), stats = new Array(layerCount);
    await Promise.all(sliceWorkers.map((w) => w.run('sliceInit', { job })));
    let next = 0, done = 0;
    const CH = 24;
    const t0 = performance.now();
    const runWorker = async (w) => {
      while (next < layerCount && !sliceCancel) {
        const k0 = next, k1 = Math.min(layerCount, next + CH);
        next = k1;
        const res = await w.run('sliceChunk', { k0, k1 });
        for (const r of res) { packed[r.k] = r.packed; stats[r.k] = r.stat; }
        done += res.length;
        const el = (performance.now() - t0) / 1000;
        prog(done / layerCount, `${t('Slicing…')} ${done} / ${layerCount}  (${Math.round(el)} s)`);
      }
    };
    try {
      await Promise.all(sliceWorkers.map(runWorker));
    } finally {
      sliceWorkers.forEach((w) => w.terminate());
      sliceWorkers = [];
    }
    if (sliceCancel) throw new Error(t('Cancel'));
    const volumeMl = stats.reduce((s, x) => s + x.area, 0) * p.layerHeight / 1000;
    const time = printTime(p, layerCount);
    state.slice = { packed, stats, layerCount, time, volumeMl, profile: { ...p }, aa: p.antiAliasing };
    state.layerIndex = Math.min(state.layerIndex, layerCount - 1);
    state.step = 'slice';
    state.layerView = true;
    toast(`${t('Done')}. ${t('Layers')}: ${layerCount}, ${t('Print time').toLowerCase()}: ${formatDuration(time)}`);
  });
  if (state.slice) showLayer(state.layerIndex);
}

async function exportPM7M() {
  if (!state.slice) { await slicePlate(); if (!state.slice) return; }
  const s = state.slice;
  const base = (state.models.find((m) => m.visible !== false)?.name || 'print').replace(/[^\w\-. ]+/g, '_');
  const path = await host.saveDialog(`${base}.pm7m`, [{ name: 'Anycubic Photon Mono M7 Max', extensions: ['pm7m'] }]);
  if (!path) return;
  await task(t('Export .pm7m'), async () => {
    let previews;
    try {
      previews = [];
      for (const [w, hh] of M7MAX.previewSizes) previews.push(await viewer.renderPreview(w, hh));
    } catch (e) {
      console.warn('3D preview failed, using height map', e);
      const g = sceneGroups();
      previews = M7MAX.previewSizes.map(([w, hh]) => heightmapPreview(concatTris([g.model, g.supports]), w, hh));
    }
    const chunks = buildPM7M({ profile: s.profile, aa: s.aa, layers: s.packed, stats: s.stats, previews, printTime: s.time, volumeMl: s.volumeMl });
    const r = await host.writeChunks(path, chunks);
    state.lastExport = path;
    toast(`${t('Exported')}: ${path.split(/[\\/]/).pop()} (${(r.bytes / 1048576).toFixed(1)} MB)`, { action: window.host ? { label: t('Show in folder'), fn: () => host.showInFolder(path) } : null, ms: 9000 });
  });
}

async function exportSTL() {
  const g = sceneGroups();
  if (!g.model.length) return;
  const path = await host.saveDialog('plate.stl', [{ name: 'STL', extensions: ['stl'] }]);
  if (!path) return;
  await task(t('Export STL'), async () => {
    await host.writeChunks(path, [toBinarySTL(concatTris([g.model, g.supports]))]);
    toast(`${t('Exported')}: ${path.split(/[\\/]/).pop()}`);
  });
}

// ---------------------------------------------------------------- open .pm7m for inspection
async function openPrintFile(f) {
  await task(t('Open print file'), async () => {
    const r = await compute.run('openPM7M', { buffer: f.data }, [f.data]);
    state.opened = { name: f.name, ...r };
    state.slice = null;
    state.step = 'slice';
    state.layerView = true;
    state.layerIndex = 0;
  });
  if (state.opened) showLayer(0);
}

// ---------------------------------------------------------------- layer view
let layerReq = 0;
async function showLayer(k) {
  const src = state.slice || state.opened;
  if (!src) return;
  const count = state.slice ? state.slice.layerCount : state.opened.layerCount;
  k = Math.max(0, Math.min(count - 1, k | 0));
  state.layerIndex = k;
  renderLayerView();
  const req = ++layerReq;
  const res = state.slice
    ? await compute.run('layerPreview', { packed: state.slice.packed[k], scale: 4 })
    : await compute.run('openedLayer', { k, scale: 4 });
  if (req !== layerReq) return;
  const c = document.querySelector('canvas.layer');
  if (!c) return;
  c.width = res.w; c.height = res.h;
  c.getContext('2d').putImageData(new ImageData(res.rgba, res.w, res.h), 0, 0);
  const lh = state.slice ? state.slice.profile.layerHeight : state.opened.layers[k]?.layer_thickness || 0.05;
  viewer.setClip((k + 1) * lh);
}

async function zoomLayer(ev) {
  if (!state.slice) return;
  const c = ev.currentTarget;
  const r = c.getBoundingClientRect();
  const x = Math.round(((ev.clientX - r.left) / r.width) * M7MAX.resX), y = Math.round(((ev.clientY - r.top) / r.height) * M7MAX.resY);
  const w = 300, hh = 200;
  const res = await compute.run('layerCrop', { packed: state.slice.packed[state.layerIndex], x0: x - w / 2, y0: y - hh / 2, w, h: hh });
  let z = document.querySelector('canvas.zoom');
  if (!z) { z = h('canvas', { class: 'zoom', title: '1:1 pixels (click to close)', onclick: () => z.remove() }); c.parentElement.append(z); }
  z.width = w; z.height = hh; z.style.width = `${w}px`; z.style.height = `${hh}px`;
  z.getContext('2d').putImageData(new ImageData(res.rgba, w, hh), 0, 0);
}

// ---------------------------------------------------------------- projects
async function saveProject() {
  if (!state.models.length) return;
  const path = await host.saveDialog('plate.m7proj', [{ name: 'Max Slicer project', extensions: ['m7proj'] }]);
  if (!path) return;
  await task(t('Save project'), async () => {
    const files = {};
    const models = state.models.map((m) => {
      files[`meshes/${m.id}.bin`] = new Uint8Array(m.tris.buffer.slice(m.tris.byteOffset, m.tris.byteOffset + m.tris.byteLength));
      if (m.cavity) files[`cavities/${m.id}.bin`] = new Uint8Array(m.cavity.buffer.slice(m.cavity.byteOffset, m.cavity.byteOffset + m.cavity.byteLength));
      return { id: m.id, name: m.name, visible: m.visible, position: m.position, quaternion: m.quaternion, scale: m.scale, elevation: m.elevation, supportPoints: m.supportPoints, holes: m.holes, hollow: m.hollow, hasCavity: !!m.cavity };
    });
    files['project.json'] = strToU8(JSON.stringify({ format: 'm7proj', version: 1, profile: state.profile, support: state.support, hollow: state.hollow, models }, null, 1));
    const zip = zipSync(files, { level: 6 });
    await host.writeChunks(path, [zip]);
    state.dirty = false;
    toast(t('Saved'));
  });
}

async function loadProject(f) {
  await task(t('Open project'), async () => {
    const z = unzipSync(new Uint8Array(f.data));
    const pj = JSON.parse(strFromU8(z['project.json']));
    if (pj.format !== 'm7proj') throw new Error('Not an Max Slicer project');
    pushHistory();
    for (const m of state.models) viewer.removeModel(m.id);
    state.models = [];
    Object.assign(state.profile, pj.profile); Object.assign(state.support, pj.support); Object.assign(state.hollow, pj.hollow);
    for (const pm of pj.models) {
      const bin = z[`meshes/${pm.id}.bin`];
      const m = { ...pm, id: nextId++, tris: new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)), supportGeo: null, cavity: null };
      if (pm.hasCavity) { const c = z[`cavities/${pm.id}.bin`]; m.cavity = new Float32Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength)); }
      state.models.push(m);
      viewer.addModel(m);
    }
    for (const m of state.models) if (hasSupports(m)) await rebuildSupports(m);
    syncAll(); fitView();
    state.dirty = false;
  });
}

// In-app text prompt (Electron has no window.prompt)
function askText(title, value) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, maxlength: 40, style: { width: '100%', height: '30px', background: 'var(--steel-1)', border: '1px solid var(--line)', borderRadius: '4px', padding: '0 8px' } });
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', zIndex: 100 } },
      h('div', { style: { background: 'var(--steel-2)', border: '1px solid var(--line)', borderRadius: '8px', padding: '16px', width: '320px' } },
        h('h3', { style: { marginTop: 0 } }, title), input,
        h('div', { class: 'btns', style: { marginTop: '12px' } }, btn(t('Cancel'), () => close(null)), btn('OK', () => close(input.value.trim()), { cls: 'primary' }))));
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') close(input.value.trim()); if (e.key === 'Escape') close(null); });
    document.body.append(overlay);
    input.focus(); input.select();
  });
}

// ---------------------------------------------------------------- tools & input
function setTool(tool) {
  state.tool = state.tool === tool ? null : tool;
  const hints = { addSupport: t('Click the model to add a support.'), removeSupport: t('Click a support to remove it.'), addHole: t('Click the model where the hole should go.'), layFlat: t('Click a face of the model to place it on the plate.') };
  const el = $('toolhint');
  el.hidden = !state.tool;
  el.textContent = state.tool ? `${hints[state.tool]}  (Esc)` : '';
  viewer.select(state.tool ? null : state.selected);
  render();
}

function onViewportClick(ev) {
  if (state.layerView) return;
  if (state.tool === 'removeSupport') { const hit = viewer.pick(ev, 'support'); if (hit) removeSupportAt(hit); return; }
  const hit = viewer.pick(ev, 'model');
  if (state.tool === 'addSupport') { if (hit) addSupportAt(hit); return; }
  if (state.tool === 'addHole') { if (hit) addHoleAt(hit); return; }
  if (state.tool === 'layFlat') { if (hit) layFlat(hit); return; }
  state.selected = hit ? hit.modelId : null;
  syncAll(); render();
}

function onKey(e) {
  if (e.target.closest('input, select, textarea')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); }
  else if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); doOpen(); }
  else if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); }
  else if (e.key === 'Delete') removeSelected();
  else if (e.key === 'Escape') { if (state.tool) setTool(null); else if (state.layerView) { state.layerView = false; viewer.setClip(state.clipZ); render(); } }
  else if (e.key.toLowerCase() === 't') setTransform('translate');
  else if (e.key.toLowerCase() === 'r') setTransform('rotate');
  else if (e.key.toLowerCase() === 's') setTransform('scale');
  else if (e.key.toLowerCase() === 'f') fitView();
  else if (e.key.toLowerCase() === 'x') toggleXray();
  else if (state.layerView && (e.key === 'ArrowUp' || e.key === 'ArrowRight')) showLayer(state.layerIndex + 1);
  else if (state.layerView && (e.key === 'ArrowDown' || e.key === 'ArrowLeft')) showLayer(state.layerIndex - 1);
}

function setTransform(mode) {
  state.transformMode = state.transformMode === mode ? null : mode;
  viewer.setTransformMode(state.transformMode);
  viewer.select(state.tool ? null : state.selected);
  renderVtools();
}
function toggleXray() { state.xray = !state.xray; viewer.setXray(state.xray, state.models); renderVtools(); }

async function doOpen() {
  const files = await host.openFiles([{ name: '3D models and print files', extensions: ['stl', 'obj', '3mf', 'pm7m', 'm7proj'] }]);
  if (files?.length) await openFiles(files);
}

// ---------------------------------------------------------------- rendering: top bar
function renderTop() {
  put($('filebar'), 
    btn(t('Open'), doOpen, { cls: 'ghost', ico: 'open', title: 'Ctrl+O' }),
    btn(t('Save project'), saveProject, { cls: 'ghost', ico: 'save', title: 'Ctrl+S', disabled: !state.models.length }),
    btn(t('Export STL'), exportSTL, { cls: 'ghost', ico: 'file', disabled: !state.models.length }),
  );
  const steps = [['prepare', t('Prepare')], ['hollow', t('Hollow')], ['supports', t('Supports')], ['slice', t('Slice')]];
  put($('steps'), ...steps.map(([k, l], i) => h('button', { 'aria-current': state.step === k ? 'step' : null, onclick: () => { state.step = k; if (k !== 'slice') { state.layerView = false; viewer.setClip(state.clipZ); } setTool(null); render(); } }, h('span', { class: 'n' }, i + 1), l)));
  const lang = h('div', { class: 'seg', role: 'group', 'aria-label': t('Language') },
    h('button', { 'aria-pressed': String(getLang() === 'en'), onclick: () => switchLang('en') }, 'EN'),
    h('button', { 'aria-pressed': String(getLang() === 'sr'), onclick: () => switchLang('sr') }, 'SR'));
  put($('topright'), 
    btn('', undo, { cls: 'ghost', ico: 'undo', title: `${t('Undo')} (Ctrl+Z)`, disabled: !history.undo.length }),
    btn('', redo, { cls: 'ghost', ico: 'redo', title: `${t('Redo')} (Ctrl+Y)`, disabled: !history.redo.length }),
    lang,
    btn(t('Export .pm7m'), exportPM7M, { cls: 'primary', ico: 'export', disabled: !state.models.length || !!state.busy }),
  );
}
function switchLang(l) { setLang(l); saveSettings(); render(); }

// ---------------------------------------------------------------- viewport tools
function renderVtools() {
  const b = (ico, title, on, fn, label) => h('button', { title, 'aria-pressed': on == null ? null : String(!!on), onclick: fn }, icon(ico), label || null);
  const vb = (name, label) => h('button', { onclick: () => viewer.view(name) }, label);
  put($('vtools'), 
    h('div', { class: 'group' },
      b('move', `${t('Move')} (T)`, state.transformMode === 'translate', () => setTransform('translate')),
      b('rotate', `${t('Rotate')} (R)`, state.transformMode === 'rotate', () => setTransform('rotate')),
      b('scale', `${t('Scale')} (S)`, state.transformMode === 'scale', () => setTransform('scale'))),
    h('div', { class: 'group' }, vb('iso', '3D'), vb('top', t('Top')), vb('front', t('Front')), vb('right', t('Side')), vb('bottom', t('Under')), b('fit', `${t('Fit view')} (F)`, null, fitView)),
    h('div', { class: 'group' },
      b('xray', `${t('X-ray')} (X)`, state.xray, toggleXray, t('X-ray')),
      (state.slice || state.opened) ? b('layers', t('Layer view'), state.layerView, () => { state.layerView = !state.layerView; if (state.layerView) showLayer(state.layerIndex); else viewer.setClip(state.clipZ); render(); }, t('Layer view')) : null),
  );
}

function renderClipbar() {
  const zmax = Math.max(1, ...state.models.map((m) => worldBounds(m).max[2]));
  const r = h('input', { type: 'range', min: 0, max: Math.ceil(zmax * 10), value: state.clipZ == null ? Math.ceil(zmax * 10) : Math.round(state.clipZ * 10), 'aria-label': 'Section height', step: 1 });
  const lbl = h('div', { class: 'z' }, state.clipZ == null ? t('all') : `${state.clipZ.toFixed(1)}`);
  r.addEventListener('input', () => {
    const v = +r.value / 10;
    state.clipZ = v >= zmax ? null : v;
    lbl.textContent = state.clipZ == null ? t('all') : state.clipZ.toFixed(1);
    viewer.setClip(state.clipZ);
  });
  put($('clipbar'), lbl, r, h('div', { class: 'z' }, 'mm'));
}

function renderLayerView() {
  const lv = $('layerview');
  lv.hidden = !state.layerView || !(state.slice || state.opened);
  if (lv.hidden) return;
  const src = state.slice || state.opened;
  const count = src.layerCount;
  const k = state.layerIndex;
  let info = '';
  if (state.slice) {
    const s = state.slice.stats[k], p = state.slice.profile;
    info = `${t('Layer')} ${k + 1} / ${count}  z ${((k + 1) * p.layerHeight).toFixed(2)} mm  ${t('Exposure')} ${(k < p.bottomLayers ? p.bottomExposure : p.exposure)} s  ${s.area.toFixed(1)} mm²  ${s.objects} obj`;
  } else {
    const L = state.opened.layers[k] || {};
    info = `${t('Layer')} ${k + 1} / ${count}  z ${((L.layer_minheight || 0) + (L.layer_thickness || 0)).toFixed(2)} mm  ${t('Exposure')} ${L.exposure_time} s`;
  }
  let canvas = lv.querySelector('canvas.layer');
  if (!canvas) {
    canvas = h('canvas', { class: 'layer', width: 1620, height: 900, onclick: zoomLayer, title: 'Click to inspect at 1:1' });
    const slider = h('input', { type: 'range', min: 0, max: count - 1, value: k, 'aria-label': t('Layer') });
    slider.addEventListener('input', () => showLayer(+slider.value));
    put(lv, 
      h('div', { class: 'canvaswrap' }, h('div', { class: 'lbl' }, `${state.slice ? '' : state.opened.name + ' — '}LCD 6480 × 3600, mirrored as the printer shows it`), canvas),
      h('div', { class: 'bar' }, btn('−', () => showLayer(state.layerIndex - 1), { cls: 'ghost' }), slider, btn('+', () => showLayer(state.layerIndex + 1), { cls: 'ghost' }), h('span', { class: 'info' }, info)),
    );
  } else {
    const slider = lv.querySelector('input[type=range]');
    slider.max = count - 1; slider.value = k;
    lv.querySelector('.info').textContent = info;
  }
}

// ---------------------------------------------------------------- side panel
function renderSide() {
  const side = $('side');
  const kids = [h('h2', {}, t('Models'))];
  if (!state.models.length) kids.push(h('p', { class: 'empty' }, t('Open an STL, OBJ or 3MF file, or drop it on the plate.')), btn(t('Open'), doOpen, { cls: 'primary wide', ico: 'open' }));
  else {
    kids.push(h('ul', { class: 'models', role: 'listbox' }, state.models.map((m) => {
      const b = worldBounds(m);
      return h('li', { 'aria-selected': String(m.id === state.selected), onclick: () => { state.selected = m.id; syncAll(); render(); } },
        h('span', { class: 'nm', title: m.name }, m.name),
        h('span', { class: 'meta' }, `${(b.max[2] - b.min[2]).toFixed(0)} mm`),
        h('button', { class: 'eye', title: m.visible === false ? t('Show') : t('Hide'), onclick: (e) => { e.stopPropagation(); pushHistory(); m.visible = m.visible === false; syncAll(); render(); } }, icon(m.visible === false ? 'eyeoff' : 'eye')));
    })));
    kids.push(check(t('Apply to') + ' ' + t('All models').toLowerCase(), state.applyAll, (v) => { state.applyAll = v; }));
  }
  const m = sel();
  if (m) {
    const b = worldBounds(m);
    kids.push(h('h3', {}, m.name), h('dl', { class: 'kv' },
      h('dt', {}, t('Size')), h('dd', {}, `${(b.max[0] - b.min[0]).toFixed(1)} × ${(b.max[1] - b.min[1]).toFixed(1)} × ${(b.max[2] - b.min[2]).toFixed(1)} mm`),
      h('dt', {}, t('Triangles')), h('dd', {}, (m.tris.length / 9).toLocaleString()),
      h('dt', {}, t('Supports')), h('dd', {}, String(m.supportPoints.length)),
      m.hollow?.enabled ? [h('dt', {}, t('Hollow')), h('dd', {}, `${m.hollow.wall} mm, −${(m.hollow.cavityVolume / 1000).toFixed(1)} ml`)] : null,
      m.report && m.report.holesFilled ? [h('dt', {}, t('Holes closed')), h('dd', {}, String(m.report.holesFilled))] : null,
    ));
  }
  // warnings
  const warns = plateProblems().map((p) => h('div', { class: 'warn' }, `${p.m.name}: ${p.msg}`));
  for (const m2 of state.models) if (m2.hollow?.enabled && !m2.holes.length) warns.push(h('div', { class: 'warn amber' }, `${m2.name}: ${t('Drain holes')} — 0`));
  const a = state.analysis;
  if (a?.islands) warns.push(a.islands.length ? h('div', { class: 'warn' }, `${t('Unsupported islands')}: ${a.islands.length}`) : h('div', { class: 'warn info' }, t('No unsupported islands.')));
  if (a?.suction) {
    if (!a.suction.length && !a.trapped.length) warns.push(h('div', { class: 'warn info' }, t('No suction cups or trapped resin found.')));
    for (const s of a.suction) warns.push(h('div', { class: 'warn amber click', onclick: () => focusPoint(s) }, `${t('Suction cup')}: ${s.maxArea.toFixed(0)} mm², z ${s.z0.toFixed(1)}–${s.z1.toFixed(1)} mm`));
    for (const s of a.trapped) warns.push(h('div', { class: 'warn click', onclick: () => focusPoint(s) }, `${t('Trapped resin')}: ${(s.volume / 1000).toFixed(2)} ml`));
  }
  if (a?.islands?.length) warns.push(h('ul', { class: 'list' }, a.islands.slice(0, 200).map((i) => h('li', { onclick: () => focusPoint(i) }, h('span', {}, `z ${i.z.toFixed(2)} mm`), h('span', {}, `${i.area.toFixed(2)} mm²`)))));
  if (warns.length) kids.push(h('h3', {}, t('Warnings')), ...warns);
  // estimate
  if (state.slice) {
    const s = state.slice;
    kids.push(h('h3', {}, t('Print file')),
      h('div', { class: 'big' }, formatDuration(s.time)),
      h('dl', { class: 'kv' },
        h('dt', {}, t('Layers')), h('dd', {}, String(s.layerCount)),
        h('dt', {}, t('Resin')), h('dd', {}, `${s.volumeMl.toFixed(1)} ml, ${(s.volumeMl * s.profile.density).toFixed(1)} g`),
        h('dt', {}, t('Cost')), h('dd', {}, `${((s.volumeMl / 1000) * s.profile.pricePerLitre).toFixed(2)} ${s.profile.currencyCode}`)),
      btn(t('Export .pm7m'), exportPM7M, { cls: 'primary wide', ico: 'export' }));
  }
  if (state.opened) {
    const o = state.opened;
    const sp = o.settings.machine_extern.user_resins?.[0]?.slicepara || {};
    kids.push(h('h3', {}, o.name), h('dl', { class: 'kv' },
      h('dt', {}, t('Layers')), h('dd', {}, String(o.layerCount)),
      h('dt', {}, t('Layer height')), h('dd', {}, `${sp.zthick} mm`),
      h('dt', {}, t('Exposure')), h('dd', {}, `${sp.exposure_time} s / ${sp.bott_time} s`),
      o.printInfo ? [h('dt', {}, t('Print time')), h('dd', {}, formatDuration(o.printInfo.print_time)), h('dt', {}, t('Resin')), h('dd', {}, `${o.printInfo.volume} ml`)] : null,
      o.software ? [h('dt', {}, 'Slicer'), h('dd', {}, `${o.software.mark} ${o.software.version}`)] : null));
  }
  put(side, ...kids);
}
function focusPoint(p) {
  const c = new THREE.Vector3(p.x, p.y, p.z);
  viewer.focus(new THREE.Box3(c.clone().subScalar(12), c.clone().addScalar(12)));
}

// ---------------------------------------------------------------- left panel
function sect(title, ...kids) { return h('div', { class: 'sect' }, title ? h('h3', {}, title) : null, ...kids); }

function renderPanel() {
  const P = $('panel');
  const fn = { prepare: panelPrepare, hollow: panelHollow, supports: panelSupports, slice: panelSlice }[state.step];
  const scroll = P.scrollTop;
  put(P, ...fn());
  P.scrollTop = scroll;
}

function panelPrepare() {
  const m = sel();
  const out = [h('h2', {}, t('Prepare'))];
  if (!m) {
    out.push(h('p', { class: 'note' }, state.models.length ? t('Select a model first.') : t('Open an STL, OBJ or 3MF file, or drop it on the plate.')));
    if (state.models.length) out.push(btn(t('Arrange'), () => arrange(), { cls: 'wide' }));
    return out;
  }
  const upd = (fn) => (v) => { pushHistory(); fn(v); syncAll(); render(); };
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...m.quaternion), 'XYZ');
  const deg = [e.x, e.y, e.z].map((r) => (r * 180) / Math.PI);
  const b = worldBounds(m);
  const size = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
  out.push(
    sect(`${t('Position')} (mm)`,
      h('div', { class: 'row three' }, ['X', 'Y', 'Z'].map((a, i) => num(m.position[i], { axis: a, step: 1, digits: 2, title: `${t('Position')} ${a}`, onChange: upd((v) => { m.position[i] = v; }) }))),
      h('div', { class: 'btns' }, btn(t('Center'), upd(() => { const f = footprint(m); m.position[0] -= (f.x0 + f.x1) / 2; m.position[1] -= (f.y0 + f.y1) / 2; })), btn(t('Drop to plate'), upd(() => dropToPlate(m))), btn(t('Arrange'), () => arrange()))),
    sect(`${t('Rotation')} (°)`,
      h('div', { class: 'row three' }, ['X', 'Y', 'Z'].map((a, i) => num(deg[i], { axis: a, step: 5, digits: 1, title: `${t('Rotation')} ${a}`, onChange: (v) => { const d = [...deg]; d[i] = v; setRotationDeg(m, d); } }))),
      h('div', { class: 'btns' },
        ...[['X', [90, 0, 0]], ['Y', [0, 90, 0]], ['Z', [0, 0, 90]]].map(([a, r]) => btn(`${a} +90°`, () => { pushHistory(); const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...r.map((d) => (d * Math.PI) / 180))); m.quaternion = q.multiply(new THREE.Quaternion(...m.quaternion)).toArray(); afterScaleOrRotate(m); })),
        btn(t('Lay flat on face'), () => setTool('layFlat'), { cls: state.tool === 'layFlat' ? 'on' : '' }))),
    sect(`${t('Size')} (mm)`,
      h('div', { class: 'row three' }, ['X', 'Y', 'Z'].map((a, i) => num(size[i], { axis: a, step: 1, digits: 2, title: `${t('Size')} ${a}`, onChange: (v) => { pushHistory(); const f = v / size[i]; const uni = state.uniform !== false; for (let k = 0; k < 3; k++) if (uni || k === i) m.scale[k] *= f; afterScaleOrRotate(m, true); } }))),
      h('div', { class: 'row' }, h('label', {}, t('Scale')), num(Math.abs(m.scale[0]) * 100, { unit: '%', step: 5, digits: 1, min: 1, max: 10000, onChange: (v) => { pushHistory(); const f = v / 100 / Math.abs(m.scale[0]); for (let k = 0; k < 3; k++) m.scale[k] *= f; afterScaleOrRotate(m, true); } })),
      check(t('Uniform'), state.uniform !== false, (v) => { state.uniform = v; }),
      h('div', { class: 'btns' }, ['X', 'Y', 'Z'].map((a, i) => btn(t(`Mirror ${a}`), () => { pushHistory(); m.scale[i] *= -1; afterScaleOrRotate(m, true); })))),
    sect(t('Auto-orient'),
      row(t('Goal'), select([['balanced', t('Balanced')], ['supports', t('Fewer supports')], ['height', t('Lower height (faster)')], ['peel', t('Less peel force')]], state.orientGoal, (v) => (state.orientGoal = v))),
      btn(t('Auto-orient'), autoOrientSel, { cls: 'wide' })),
    sect(t('Copies'),
      h('div', { class: 'btns' }, btn(t('Duplicate'), () => duplicate(m, 1), { title: 'Ctrl+D' }), btn('× 4', () => duplicate(m, 3)), btn(t('Delete'), removeSelected, { cls: 'danger', ico: 'trash', title: 'Delete' }))),
  );
  if (m.report) {
    const r = m.report;
    const fixes = [];
    if (r.degenerate) fixes.push(`${r.degenerate} degenerate triangles removed`);
    if (r.flippedFaces) fixes.push(`${r.flippedFaces} faces re-oriented`);
    if (r.invertedShells) fixes.push(`${r.invertedShells} inside-out shells flipped`);
    if (r.holesFilled) fixes.push(`${r.holesFilled} holes closed (${r.openEdges} open edges)`);
    if (r.nonManifoldEdges) fixes.push(`${r.nonManifoldEdges} non-manifold edges left as they are; check them in layer view`);
    out.push(sect(t('Mesh'), h('p', { class: 'note' }, `${r.shells} shell${r.shells === 1 ? '' : 's'}. ` + (fixes.length ? `${t('Repaired')}: ${fixes.join(', ')}.` : 'No problems found.'))));
  }
  return out;
}

function panelHollow() {
  const H = state.hollow;
  const m = sel();
  const out = [h('h2', {}, t('Hollow')), h('p', { class: 'note' }, 'Hollowing saves resin on solid parts. The cavity is shown in X-ray view; drain holes let resin escape.')];
  out.push(sect(null,
    row(t('Wall thickness'), num(H.wall, { unit: 'mm', min: 0.6, max: 20, step: 0.1, onChange: (v) => (H.wall = v) })),
    row(t('Infill'), select([['none', t('None')], ['cubic', t('Cubic lattice')], ['gyroid', t('Gyroid')]], H.infill.type, (v) => { H.infill.type = v; invalidateSlice(); render(); })),
    H.infill.type !== 'none' ? [row(t('Spacing'), num(H.infill.spacing, { unit: 'mm', min: 2, max: 40, step: 0.5, onChange: (v) => { H.infill.spacing = v; invalidateSlice(); } })), row(t('Thickness'), num(H.infill.thickness, { unit: 'mm', min: 0.4, max: 5, step: 0.1, onChange: (v) => { H.infill.thickness = v; invalidateSlice(); } }))] : null,
    h('div', { class: 'btns' }, btn(t('Hollow model'), hollowSel, { cls: 'primary', disabled: !m && !state.applyAll }), btn(t('Remove hollowing'), unhollowSel, { disabled: !(m?.hollow?.enabled) })),
  ));
  out.push(sect(t('Drain holes'),
    row(t('Diameter'), num(H.holeDiameter, { unit: 'mm', min: 0.5, max: 20, step: 0.5, onChange: (v) => (H.holeDiameter = v) })),
    row(t('Depth'), num(H.holeDepth, { unit: H.holeDepth > 0 ? 'mm' : 'auto', min: 0, max: 50, step: 0.5, onChange: (v) => (H.holeDepth = v) })),
    h('div', { class: 'btns' }, btn(t('Add drain hole'), () => setTool('addHole'), { cls: state.tool === 'addHole' ? 'on' : '', disabled: !state.models.length }), btn(t('Auto-place drain holes'), autoHoles, { disabled: !m?.hollow?.enabled && !state.applyAll })),
    m && m.holes.length ? h('ul', { class: 'list' }, m.holes.map((hl, i) => h('li', {}, h('span', {}, `Ø ${hl.diameter} mm, ${hl.depth.toFixed(1)} mm`), h('button', { class: 'btn ghost', onclick: () => { pushHistory(); m.holes.splice(i, 1); syncAll(); render(); } }, icon('trash'))))) : null,
  ));
  out.push(sect(t('Check suction & trapped resin'),
    h('p', { class: 'note' }, 'Finds cups that seal against the FEP while printing, and closed cavities that would trap liquid resin.'),
    btn(t('Check suction & trapped resin'), checkSuction, { cls: 'wide', disabled: !state.models.length })));
  return out;
}

function panelSupports() {
  const S = state.support;
  const m = sel();
  const set = (k) => (v) => { S[k] = v; saveSettings(); };
  const out = [h('h2', {}, t('Supports'))];
  out.push(sect(null,
    row(t('Preset'), select([['light', t('Light')], ['medium', t('Medium')], ['heavy', t('Heavy')]], S.preset, (v) => { Object.assign(S, SUPPORT_PRESETS[v], { preset: v }); saveSettings(); render(); })),
    h('div', { class: 'btns' }, btn(t('Auto-support'), autoSupport, { cls: 'primary', disabled: !m && !state.applyAll }), btn(t('Clear supports'), clearSupports, { disabled: !m && !state.applyAll })),
    h('div', { class: 'btns' },
      btn(t('Add supports'), () => setTool('addSupport'), { cls: state.tool === 'addSupport' ? 'on' : '', disabled: !state.models.length }),
      btn(t('Remove supports'), () => setTool('removeSupport'), { cls: state.tool === 'removeSupport' ? 'on' : '', disabled: !state.models.some(hasSupports) })),
    btn(t('Check islands'), checkIslands, { cls: 'wide', disabled: !state.models.length }),
  ));
  out.push(sect(t('Tips and trunks'),
    row(t('Tip diameter'), num(S.tipD, { unit: 'mm', min: 0.1, max: 2, step: 0.05, onChange: set('tipD') })),
    row(t('Tip length'), num(S.tipLen, { unit: 'mm', min: 0.5, max: 6, step: 0.1, onChange: set('tipLen') })),
    row(t('Contact depth'), num(S.contactDepth, { unit: 'mm', min: 0, max: 1, step: 0.05, onChange: set('contactDepth') })),
    row(t('Trunk diameter'), num(S.trunkD, { unit: 'mm', min: 0.4, max: 5, step: 0.1, onChange: set('trunkD') })),
    row(t('Base diameter'), num(S.baseD, { unit: 'mm', min: 1, max: 12, step: 0.5, onChange: set('baseD') })),
  ));
  out.push(sect(t('Placement'),
    row(t('Overhang angle'), num(S.angle, { unit: '°', min: 10, max: 80, step: 1, onChange: set('angle') })),
    row(t('Spacing'), num(S.spacing, { unit: 'mm', min: 0.8, max: 10, step: 0.1, onChange: set('spacing') })),
    row(t('Density'), num(S.density * 100, { unit: '%', min: 20, max: 400, step: 10, digits: 0, onChange: (v) => set('density')(v / 100) })),
    row(t('Elevation'), num(S.elevation, { unit: 'mm', min: 1, max: 30, step: 0.5, onChange: set('elevation') })),
    check(t('Model resting supports'), S.modelResting, set('modelResting')),
  ));
  out.push(sect(t('Raft'),
    row(t('Raft'), select([['slab', t('Slab')], ['none', t('None')]], S.raft, (v) => { S.raft = v; saveSettings(); render(); })),
    S.raft === 'slab' ? [row(t('Raft height'), num(S.raftHeight, { unit: 'mm', min: 0.3, max: 4, step: 0.1, onChange: set('raftHeight') })), row(t('Margin'), num(S.raftMargin, { unit: 'mm', min: 0, max: 10, step: 0.5, onChange: set('raftMargin') })), row(t('Chamfer'), num(S.raftChamfer, { unit: 'mm', min: 0, max: 3, step: 0.1, onChange: set('raftChamfer') }))] : null,
  ));
  out.push(sect(t('Braces'),
    check(t('Braces'), S.braces, set('braces')),
    row(t('Brace diameter'), num(S.braceD, { unit: 'mm', min: 0.3, max: 3, step: 0.1, onChange: set('braceD') })),
    btn(t('Rebuild supports'), rebuildAllSupports, { cls: 'wide', title: 'Rebuild existing supports with the settings above', disabled: !state.models.some(hasSupports) }),
  ));
  return out;
}

const PF = (label, key, unit, min, max, step, digits = 2) => ({ label, key, unit, min, max, step, digits });
function panelSlice() {
  const p = state.profile;
  const set = (k) => (v) => { p[k] = v; invalidateSlice(false); saveSettings(); renderSide(); renderTop(); renderLayerView(); };
  const nrow = (f) => row(t(f.label), num(p[f.key], { unit: f.unit, min: f.min, max: f.max, step: f.step, digits: f.digits, onChange: set(f.key) }));
  const out = [h('h2', {}, t('Slice'))];
  const names = state.profiles.map((x) => x.name);
  out.push(sect(t('Resin profile'),
    select(names.map((n) => [n, n]), p.name, (v) => { const pr = state.profiles.find((x) => x.name === v); if (pr) { Object.assign(p, pr); invalidateSlice(false); saveSettings(); render(); } }),
    h('div', { class: 'btns' },
      btn(t('Save profile'), () => { const i = state.profiles.findIndex((x) => x.name === p.name); const copy = { ...p }; if (i >= 0) state.profiles[i] = copy; else state.profiles.push(copy); saveSettings(); toast(t('Saved')); }),
      btn(t('New profile'), async () => { const nm = await askText(t('Profile name'), `${p.name} copy`); if (!nm) return; const clean = nm.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40) || 'resin'; p.name = clean; state.profiles.push({ ...p }); saveSettings(); render(); }),
      btn(t('Delete profile'), () => { if (state.profiles.length <= 1) return; state.profiles = state.profiles.filter((x) => x.name !== p.name); Object.assign(p, state.profiles[0]); saveSettings(); render(); }, { cls: 'danger' })),
  ));
  out.push(sect(t('Exposure'),
    nrow(PF('Layer height', 'layerHeight', 'mm', 0.01, 0.2, 0.01, 3)),
    nrow(PF('Bottom layers', 'bottomLayers', '', 1, 100, 1, 0)),
    nrow(PF('Bottom exposure', 'bottomExposure', 's', 0.5, 300, 1, 2)),
    nrow(PF('Exposure', 'exposure', 's', 0.1, 60, 0.1, 2)),
    nrow(PF('Transition layers', 'transitionLayers', '', 0, 50, 1, 0)),
  ));
  // Bottom / normal tables
  const cell = (key, unit, min, max, step, title) => num(p[key], { unit, min, max, step, title, onChange: set(key) });
  const grid3 = (label, a, b) => h('div', { class: 'row grid3' }, h('label', {}, label), a, b);
  const head = () => h('div', { class: 'row grid3 head' }, h('span'), h('span', {}, t('Bottom layers')), h('span', {}, t('Normal layers')));
  out.push(sect(`${t('Waits')} (s)`,
    head(),
    grid3(t('Before cure'), cell('bottomWaitBeforeCure', '', 0, 60, 0.5, t('Before cure')), cell('waitBeforeCure', '', 0, 60, 0.5, t('Before cure'))),
    grid3(t('After cure'), cell('bottomWaitAfterCure', '', 0, 60, 0.5, t('After cure')), cell('waitAfterCure', '', 0, 60, 0.5, t('After cure'))),
    grid3(t('After lift'), cell('bottomWaitAfterLift', '', 0, 60, 0.5, t('After lift')), cell('waitAfterLift', '', 0, 60, 0.5, t('After lift'))),
  ));
  out.push(sect(t('Lift'),
    head(),
    grid3(`${t('Lift height')} (mm)`, cell('bottomLiftHeight', '', 0.5, 30, 0.5, t('Lift height')), cell('liftHeight', '', 0.5, 30, 0.5, t('Lift height'))),
    grid3(`${t('Lift speed')} (mm/s)`, cell('bottomLiftSpeed', '', 0.1, 20, 0.1, t('Lift speed')), cell('liftSpeed', '', 0.1, 20, 0.1, t('Lift speed'))),
    grid3(`${t('Retract speed')} (mm/s)`, cell('bottomRetractSpeed', '', 0.1, 20, 0.1, t('Retract speed')), cell('retractSpeed', '', 0.1, 20, 0.1, t('Retract speed'))),
    check(t('Two-stage motion'), p.twoStage, (v) => { p.twoStage = v; invalidateSlice(false); saveSettings(); render(); }),
    p.twoStage ? [h('p', { class: 'note' }, t('Second stage, after the first lift distance:')), head(),
      grid3(`${t('Lift height')} (mm)`, cell('bottomLiftHeight2', '', 0.5, 30, 0.5), cell('liftHeight2', '', 0.5, 30, 0.5)),
      grid3(`${t('Lift speed')} (mm/s)`, cell('bottomLiftSpeed2', '', 0.1, 20, 0.1), cell('liftSpeed2', '', 0.1, 20, 0.1)),
      grid3(`${t('Retract speed')} (mm/s)`, cell('bottomRetractSpeed2', '', 0.1, 20, 0.1), cell('retractSpeed2', '', 0.1, 20, 0.1))] : null,
  ));
  out.push(sect(t('Image'),
    row(t('Anti-aliasing'), select([[1, t('Off')], [2, '2×'], [4, '4×'], [8, '8×']], p.antiAliasing, (v) => set('antiAliasing')(+v))),
    row(t('Blur'), select([[0, t('Off')], [1, '1 px'], [2, '2 px'], [3, '3 px']], p.blur, (v) => set('blur')(+v))),
  ));
  out.push(sect(t('Material'),
    nrow(PF('Density g/ml', 'density', 'g/ml', 0.5, 3, 0.01)),
    nrow(PF('Price per litre', 'pricePerLitre', p.currencyCode, 0, 100000, 1)),
    row(t('Currency'), select([['EUR', 'EUR'], ['RSD', 'RSD'], ['USD', 'USD'], ['GBP', 'GBP']], p.currencyCode, (v) => { p.currencyCode = v; saveSettings(); render(); })),
  ));
  out.push(h('div', { class: 'btns' },
    state.busy && sliceWorkers.length ? btn(t('Cancel'), () => { sliceCancel = true; }, { cls: 'wide' }) : btn(t('Slice plate'), slicePlate, { cls: 'primary wide', disabled: !state.models.length || !!state.busy }),
    btn(t('Open print file'), async () => { const f = await host.openFiles([{ name: 'pm7m', extensions: ['pm7m'] }], false); if (f?.length) await openPrintFile(f[0]); }, { cls: 'wide' })));
  return out;
}

// ---------------------------------------------------------------- status bar
function renderStatus() {
  const st = $('status');
  const b = state.busy;
  put(st, 
    h('span', { class: 'msg' }, b ? b.msg : `${t('Ready')}.  ${t('Models')}: ${state.models.length},  ${t('Supports')}: ${state.models.reduce((a, m) => a + m.supportPoints.length, 0)}`),
    b && b.p != null ? h('div', { class: 'prog' }, h('i', { style: { width: `${Math.round(b.p * 100)}%` } })) : null,
    h('span', {}, `${state.profile.name}, ${state.profile.layerHeight} mm, ${state.profile.exposure} s`),
  );
  renderTop();
}

function render() {
  renderTop(); renderPanel(); renderSide(); renderVtools(); renderClipbar(); renderLayerView(); renderStatus();
}

// ---------------------------------------------------------------- settings
function saveSettings() {
  host.saveSettings({ lang: getLang(), profile: state.profile, profiles: state.profiles, support: state.support, hollow: state.hollow, orientGoal: state.orientGoal });
}

// ---------------------------------------------------------------- boot
async function boot() {
  const s = await host.loadSettings();
  if (s) {
    if (s.lang) setLang(s.lang);
    if (s.profile) Object.assign(state.profile, s.profile);
    if (Array.isArray(s.profiles) && s.profiles.length) state.profiles = s.profiles;
    if (s.support) Object.assign(state.support, s.support);
    if (s.hollow) Object.assign(state.hollow, s.hollow, { infill: { ...state.hollow.infill, ...(s.hollow.infill || {}) } });
    if (s.orientGoal) state.orientGoal = s.orientGoal;
  }
  if (!state.profiles.length) state.profiles = [{ ...state.profile }];
  cpuCount = (await host.sysInfo()).cpus || 4;
  compute = new ComputeWorker('worker.js');
  viewer = new Viewer($('viewport'));
  viewer.setTransformMode(state.transformMode);
  let dragStart = null;
  viewer.onDragging = (on) => {
    const m = sel();
    if (!m) return;
    if (on) { pushHistory(); dragStart = { q: [...m.quaternion], s: [...m.scale], z: m.position[2] }; return; }
    const rotated = dragStart && (m.quaternion.some((x, i) => Math.abs(x - dragStart.q[i]) > 1e-9) || m.scale.some((x, i) => x !== dragStart.s[i]));
    if (rotated) afterScaleOrRotate(m, m.scale.some((x, i) => x !== dragStart.s[i]));
    else if (hasSupports(m) && Math.abs(m.position[2] - dragStart.z) > 1e-6) {
      m.elevation = Math.max(1, worldBounds(m).min[2] - raftTop());
      liftForSupports(m);
      task(t('Supports'), async () => { await rebuildSupports(m); syncAll(); });
    }
    syncAll(); render();
  };
  viewer.onTransformChange = () => {
    const m = sel();
    if (!m) return;
    const o = viewer.objects.get(m.id);
    m.position = o.group.position.toArray(); m.quaternion = o.group.quaternion.toArray(); m.scale = o.group.scale.toArray();
    syncAll();
  };
  // click vs drag
  const cvs = viewer.renderer.domElement;
  let down = null;
  cvs.addEventListener('pointerdown', (e) => { if (e.button === 0) down = [e.clientX, e.clientY]; });
  cvs.addEventListener('pointerup', (e) => {
    if (e.button === 0 && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4 && !viewer.transform.dragging) onViewportClick(e);
    down = null;
  });
  window.addEventListener('keydown', onKey);
  // drag & drop
  const vp = $('viewport');
  vp.addEventListener('dragover', (e) => { e.preventDefault(); $('dropzone').hidden = false; });
  vp.addEventListener('dragleave', (e) => { if (!vp.contains(e.relatedTarget)) $('dropzone').hidden = true; });
  vp.addEventListener('drop', async (e) => {
    e.preventDefault();
    $('dropzone').hidden = true;
    const files = await Promise.all([...e.dataTransfer.files].map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
    await openFiles(files);
  });
  host.onOpenPath(async (p) => { const f = await host.readPath(p); await openFiles([f]); });
  host.onRequestClose(async () => {
    if (!state.dirty || !state.models.length) return host.closeNow();
    const r = await host.confirm(t('Unsaved changes'), t('Quit without saving?'), [t('Quit'), t('Cancel')]);
    if (r === 0) host.closeNow();
  });
  render();
  window.__app = { state, openFiles, slicePlate, exportPM7M, autoSupport, hollowSel, autoOrientSel, checkIslands, checkSuction, arrange, duplicate, viewer, addHoleAt, sceneGroups, showLayer, undo, redo };
}

boot();
