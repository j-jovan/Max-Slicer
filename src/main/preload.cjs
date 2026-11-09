// Narrow, explicit bridge between the UI and the operating system.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  openFiles: (filters, multi = true) => ipcRenderer.invoke('open-files', { filters, multi }),
  readPath: (p) => ipcRenderer.invoke('read-path', p),
  saveDialog: (defaultName, filters) => ipcRenderer.invoke('save-dialog', { defaultName, filters }),
  writeChunks: (filePath, chunks) => ipcRenderer.invoke('write-chunks', { filePath, chunks }),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (obj) => ipcRenderer.invoke('save-settings', obj),
  sysInfo: () => ipcRenderer.invoke('sys-info'),
  confirm: (message, detail, buttons) => ipcRenderer.invoke('confirm', { message, detail, buttons }),
  closeNow: () => ipcRenderer.invoke('close-now'),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  onRequestClose: (cb) => ipcRenderer.on('request-close', () => cb()),
});
