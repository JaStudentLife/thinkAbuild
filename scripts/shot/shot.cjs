// Visual test harness: loads the app in an offscreen Electron window, runs scripted
// steps and saves screenshots plus a log file.
//   electron scripts/shot <config.json>
// config: { "url": "...", "outDir": "...", "width": 1600, "height": 940,
//           "steps": [{ "js": "...", "wait": 500, "shot": "name" }, ...] }
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const cfgFile = process.argv.slice(2).find((a) => !a.startsWith('--') && a.endsWith('.json'));
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const outDir = cfg.outDir;
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'log.txt');
fs.writeFileSync(logFile, '');
const NL = String.fromCharCode(10);
function log(...a) {
  fs.appendFileSync(logFile, a.join(' ') + NL);
}
log('[start]', process.versions.electron);
app.setPath('userData', path.join(outDir, 'userdata'));
process.on('uncaughtException', (e) => {
  log('[uncaught]', e && e.stack);
  app.exit(3);
});
setTimeout(() => {
  log('[timeout]');
  app.exit(4);
}, cfg.timeout || 120000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: cfg.width || 1600,
    height: cfg.height || 940,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', (e, level, message) => {
    const msg = typeof message === 'string' ? message : e.message;
    const lvl = typeof level === 'number' ? level : e.level;
    if (msg && !/Electron Security Warning/.test(msg)) log(`[console:${lvl}]`, msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => log('[crash]', JSON.stringify(d)));
  try {
    await win.loadURL(cfg.url);
  } catch (e) {
    log('[load error]', e.message);
  }
  for (const s of cfg.steps) {
    try {
      if (s.js) {
        const r = await win.webContents.executeJavaScript(s.js, true);
        if (r !== undefined) log('[js]', typeof r === 'string' ? r : JSON.stringify(r));
      }
      if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
      if (s.shot) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, s.shot + '.png'), img.toPNG());
        log('[shot]', s.shot);
      }
    } catch (e) {
      log('[step error]', e && e.message ? e.message : String(e));
    }
  }
  log('[done]');
  app.exit(0);
});
