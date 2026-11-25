// Exposes a minimal, safe file bridge to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thinkabuild', {
  saveDesign: (json, suggested) => ipcRenderer.invoke('save-design', String(json), String(suggested || '')),
  openDesign: () => ipcRenderer.invoke('open-design'),
  savePng: (dataUrl) => ipcRenderer.invoke('save-png', String(dataUrl)),
  platform: process.platform,
});
