// thinkAbuild - Electron main process
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const devUrl = process.env.VITE_DEV_SERVER_URL;
// automated smoke test: run hidden, report whether the app booted, then quit
const smokeFile = process.env.THINKABUILD_SMOKE;
if (smokeFile) app.setPath('userData', path.join(path.dirname(smokeFile), 'smoke-userdata'));

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0f1218',
    title: 'thinkAbuild',
    show: false,
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'dist', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (smokeFile) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let result;
        try {
          result = await win.webContents.executeJavaScript(
            "JSON.stringify({ ok: !!window.app, bridge: !!window.thinkabuild, parts: window.app && window.app.design.parts.length, status: window.app && window.app.analysis && window.app.analysis.status })",
          );
        } catch (e) {
          result = JSON.stringify({ ok: false, error: String(e) });
        }
        fs.writeFileSync(smokeFile, result);
        app.exit(0);
      }, 4000);
    });
  } else {
    win.once('ready-to-show', () => {
      win.maximize();
      win.show();
    });
  }
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

ipcMain.handle('save-design', async (event, json, suggested) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save design',
    defaultPath: suggested || 'design.tab.json',
    filters: [{ name: 'thinkAbuild design', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, json, 'utf8');
  return true;
});

ipcMain.handle('open-design', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open design',
    properties: ['openFile'],
    filters: [{ name: 'thinkAbuild design', extensions: ['json'] }],
  });
  if (canceled || !filePaths.length) return null;
  return fs.readFileSync(filePaths[0], 'utf8');
});

ipcMain.handle('save-png', async (event, dataUrl) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save screenshot',
    defaultPath: 'thinkabuild.png',
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return false;
  const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  return true;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
