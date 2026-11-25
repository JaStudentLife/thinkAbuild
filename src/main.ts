import { App } from './app';
import { openDesignFile, saveDesignFile } from './core/files';
import { PRESETS } from './presets';
import { ToolManager } from './tools/tools';
import { Inspector } from './ui/inspector';
import { MaterialsPanel } from './ui/materials';
import { Overlays } from './ui/overlays';
import { Toolbar, toast } from './ui/toolbar';
import { WorkshopPanel } from './ui/workshop';

const host = document.getElementById('canvas-host')!;
const app = new App(host);
const tools = new ToolManager(app);
new Toolbar(document.getElementById('toolbar')!, app);
const left = document.getElementById('left')!;
const workshopEl = document.createElement('section');
workshopEl.id = 'workshop';
const materialsEl = document.createElement('section');
materialsEl.id = 'materials';
left.append(workshopEl, materialsEl);
new WorkshopPanel(workshopEl, app);
new MaterialsPanel(materialsEl, app);
new Inspector(document.getElementById('right')!, app);
const overlays = new Overlays(app, tools);

app.simFactory = async (a) => {
  const { createSimulation } = await import('./sim/simulation');
  return createSimulation(a);
};

// first run: show the headline example
if (!app.design.parts.length && !localStorage.getItem('thinkabuild.seen')) {
  localStorage.setItem('thinkabuild.seen', '1');
  app.loadDesign(PRESETS[0].make());
} else app.frameAll();

// ------------------------------------------------------------------ keyboard
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (tools.key(e)) {
    e.preventDefault();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'z' && !e.shiftKey) return void (app.undo(), e.preventDefault());
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) return void (app.redo(), e.preventDefault());
  if (ctrl && k === 'd') {
    e.preventDefault();
    if (app.selection && app.mode === 'build') app.duplicate(app.selection);
    return;
  }
  if (ctrl && k === 's') {
    e.preventDefault();
    void saveDesignFile(app.design).then((ok) => ok && toast('Design saved'));
    return;
  }
  if (ctrl && k === 'o') {
    e.preventDefault();
    void openDesignFile().then((d) => d && app.loadDesign(d));
    return;
  }
  if (ctrl) return;
  const box = app.contentBox();
  const c = box.isEmpty() ? undefined : box.getCenter(box.min.clone());
  const r = box.isEmpty() ? undefined : box.getSize(box.min.clone()).length() / 2;
  switch (k) {
    case 'v':
      app.setTool('select');
      break;
    case 'b':
      app.setTool('box');
      break;
    case 'c':
      app.setTool('cylinder');
      break;
    case 'o':
      app.setTool('sphere');
      break;
    case 'l':
      app.setTool('beam');
      break;
    case 's':
      app.setTool('saw');
      break;
    case 'h':
      app.setTool('hammer');
      break;
    case 'j':
      app.joinType = 'glue';
      app.setTool('join');
      break;
    case 'm':
      app.setTool('measure');
      break;
    case 'p':
      app.setTool('push');
      break;
    case 't':
      app.setTool('throw');
      break;
    case 'g':
      app.toggleGizmo('move');
      break;
    case 'r':
      app.toggleGizmo('rotate');
      break;
    case 'e':
      app.setTool('round');
      break;
    case 'f':
      app.frameAll();
      break;
    case 'delete':
    case 'backspace':
      if (app.selection && app.mode === 'build') app.deletePart(app.selection);
      break;
    case 'escape':
      if (app.tool !== 'select') app.setTool('select');
      else if (app.mode === 'sim') app.stopSim();
      else app.select(null);
      break;
    case ' ':
      e.preventDefault();
      if (app.mode === 'build') void app.startSim();
      else if (app.sim) {
        app.sim.paused = !app.sim.paused;
        app.emit('sim');
      }
      break;
    case '1':
      app.viewport.viewPreset('front', c, r);
      break;
    case '3':
      app.viewport.viewPreset('right', c, r);
      break;
    case '7':
      app.viewport.viewPreset('top', c, r);
      break;
    case '0':
      app.viewport.viewPreset('iso', c, r);
      break;
    case '5':
      app.viewport.setOrtho(!app.viewport.isOrtho);
      break;
    default:
      return;
  }
});
window.addEventListener('keyup', (e) => tools.keyUp(e));

// ------------------------------------------------------------------ loop
let last = performance.now();
let statusTimer = 0;
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  app.update(dt);
  tools.update(dt);
  app.viewport.render(dt);
  overlays.tick();
  statusTimer += dt;
  if (statusTimer > 0.25) {
    statusTimer = 0;
    overlays.renderStatus();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// hide splash once the first frame is up, then warm up the physics engine
requestAnimationFrame(() => {
  document.getElementById('splash')?.classList.add('gone');
  setTimeout(() => void import('./sim/simulation').then((m) => m.preloadPhysics()), 300);
});

// expose for debugging
(window as unknown as { app: App; presets: typeof PRESETS }).app = app;
(window as unknown as { presets: typeof PRESETS }).presets = PRESETS;
