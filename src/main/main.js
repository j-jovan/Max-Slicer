// Electron main process.
import { app, BrowserWindow, dialog, ipcMain, protocol, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');           // app root (package.json level)
const WEB = path.join(ROOT, 'dist');                        // bundled renderer

// Serve the UI from app:// so module workers and cross-origin isolation work reliably.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

let win = null;
let pendingOpen = process.argv.slice(1).find((a) => /\.(stl|obj|3mf|pm7m|m7proj)$/i.test(a)) || null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#14171c',
    title: 'Max Slicer',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('app://local/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen) { win.webContents.send('open-path', pendingOpen); pendingOpen = null; }
  });
  win.on('close', (e) => {
    if (win.__allowClose) return;
    e.preventDefault();
    win.webContents.send('request-close');
  });
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB)) return new Response('forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(file)] || 'application/octet-stream',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('second-instance', (_e, argv) => {
  const f = argv.find((a) => /\.(stl|obj|3mf|pm7m|m7proj)$/i.test(a));
  if (f && win) win.webContents.send('open-path', f);
});
app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- IPC

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

ipcMain.handle('open-files', async (_e, { filters, multi }) => {
  const r = await dialog.showOpenDialog(win, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(readOne));
});

async function readOne(p) {
  const data = await fs.promises.readFile(p);
  return { path: p, name: path.basename(p), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}

ipcMain.handle('read-path', async (_e, p) => readOne(p));

ipcMain.handle('save-dialog', async (_e, { defaultName, filters }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  return r.canceled ? null : r.filePath;
});

// chunks: array of Uint8Array, written in order. Written to a temp file then renamed,
// so a failed export never leaves a half-written print file behind.
ipcMain.handle('write-chunks', async (_e, { filePath, chunks }) => {
  const tmp = `${filePath}.part`;
  const fd = await fs.promises.open(tmp, 'w');
  try {
    for (const c of chunks) await fd.write(c);
  } finally {
    await fd.close();
  }
  await fs.promises.rename(tmp, filePath);
  const st = await fs.promises.stat(filePath);
  return { bytes: st.size };
});

ipcMain.handle('load-settings', async () => {
  try { return JSON.parse(await fs.promises.readFile(settingsFile(), 'utf8')); } catch { return null; }
});
ipcMain.handle('save-settings', async (_e, obj) => {
  await fs.promises.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.promises.writeFile(settingsFile(), JSON.stringify(obj, null, 2));
  return true;
});
ipcMain.handle('sys-info', () => ({ cpus: os.cpus().length, mem: os.totalmem(), version: app.getVersion(), platform: process.platform }));
ipcMain.handle('confirm', async (_e, { message, detail, buttons }) => {
  const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: buttons || ['OK', 'Cancel'], cancelId: (buttons || ['OK', 'Cancel']).length - 1, defaultId: 0 });
  return r.response;
});
ipcMain.handle('close-now', () => { win.__allowClose = true; win.close(); });
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

if (!app.requestSingleInstanceLock()) app.quit();
