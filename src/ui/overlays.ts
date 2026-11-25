import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { App } from '../app';
import { getMaterial } from '../core/materials';
import { volume } from '../core/shapes';
import { MODE_LABEL } from '../fea/structure';
import type { ViewPreset } from '../render/viewport';
import type { ToolManager } from '../tools/tools';
import { clear, fmtMass, h } from './dom';

export class Overlays {
  private app: App;
  private tools: ToolManager;
  private verdict = document.getElementById('verdict')!;
  private viewbar = document.getElementById('viewbar')!;
  private legend = document.getElementById('legend')!;
  private hud = document.getElementById('simhud')!;
  private status = document.getElementById('status')!;
  private failLabels: CSS2DObject[] = [];
  private emptyHint: HTMLElement;
  private hudTime!: HTMLElement;
  private hudLog!: HTMLElement;
  private logCount = -1;

  constructor(app: App, tools: ToolManager) {
    this.app = app;
    this.tools = tools;
    this.emptyHint = h('div', { class: 'empty-hint', html: '<b>Start building</b><br>Pick the <b>Box</b> tool (B), click the floor, size the base, then lift it.<br>Or open an <b>Example</b>, such as the tungsten slab on pine legs.' });
    document.getElementById('view')!.appendChild(this.emptyHint);
    this.buildViewbar();
    this.buildHud();
    for (const ev of ['analysis', 'mode', 'design', 'settings', 'sim', 'tool'] as const) app.on(ev, () => this.refresh());
    app.on('log', () => this.renderLog());
    this.refresh();
  }

  private buildViewbar() {
    const app = this.app;
    clear(this.viewbar);
    const vb = (label: string, title: string, fn: () => void, active = false) => {
      const b = h('button', { class: `vb ${active ? 'active' : ''}`, title }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const box = () => {
      const b = app.contentBox();
      return { c: b.isEmpty() ? new THREE.Vector3(0, 0.4, 0) : b.getCenter(new THREE.Vector3()), r: b.isEmpty() ? 1 : b.getSize(new THREE.Vector3()).length() / 2 };
    };
    const view = (v: ViewPreset) => () => {
      const { c, r } = box();
      app.viewport.viewPreset(v, c, r);
    };
    this.viewbar.append(
      vb('3D', 'Isometric view (0)', view('iso')),
      vb('Top', 'Top view (7)', view('top')),
      vb('Front', 'Front view (1)', view('front')),
      vb('Right', 'Right view (3)', view('right')),
      vb('Left', 'Left view', view('left')),
      vb('Back', 'Back view', view('back')),
      vb(app.viewport.isOrtho ? 'Orth' : 'Persp', 'Toggle orthographic / perspective (5)', () => {
        app.viewport.setOrtho(!app.viewport.isOrtho);
        this.buildViewbar();
      }, app.viewport.isOrtho),
      vb('Fit', 'Frame everything (F)', () => app.frameAll()),
    );
  }

  private buildHud() {
    clear(this.hud);
    this.hudTime = h('div', { class: 'hud-time' });
    this.hudLog = h('div', { class: 'hud-log' });
    this.hud.append(h('div', { class: 'hud-card' }, this.hudTime), h('div', { class: 'hud-card' }, h('div', { style: { fontSize: '11px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.7px', marginBottom: '4px' } }, 'Events'), this.hudLog));
  }

  refresh() {
    const app = this.app;
    const an = app.analysis;
    const sim = app.mode === 'sim';
    this.emptyHint.style.display = app.design.parts.length || sim || app.tool !== 'select' ? 'none' : 'block';
    // verdict
    this.verdict.className = 'verdict hidden';
    if (!sim && an && an.byPart.size) {
      clear(this.verdict);
      const st = an.status;
      let title = '', sub = '';
      const w = an.worst;
      if (st === 'fail') {
        const f = an.failing[0];
        title = `Will fail: ${an.failing.length} part${an.failing.length > 1 ? 's' : ''} overloaded`;
        sub = `${f.info.def.name}: ${MODE_LABEL[f.mode]} at ${(f.U * 100).toFixed(0)}% of capacity`;
      } else if (st === 'unstable') {
        title = 'Not stable';
        const u = [...an.byPart.values()].filter((r) => r.unstable);
        sub = `${u.map((r) => r.info.def.name).slice(0, 3).join(', ')}${u.length > 3 ? '…' : ''} will tip, slide or fall`;
      } else {
        title = st === 'warn' ? 'Stands, but close to the limit' : 'Stands';
        sub = w && w.U > 0.005 ? `Safety factor ${(1 / w.U).toFixed(w.U > 0.3 ? 2 : 1)}× (weakest: ${w.info.def.name}, ${MODE_LABEL[w.mode].toLowerCase()})` : 'Hardly loaded';
      }
      this.verdict.className = `verdict ${st}`;
      this.verdict.append(h('div', { class: 'vicon' }, st === 'fail' ? '✕' : st === 'unstable' ? '!' : st === 'warn' ? '!' : '✓'), h('div', { class: 'vtext' }, h('b', {}, title), h('span', {}, sub)));
      this.verdict.onclick = () => {
        const target = st === 'fail' ? an.failing[0] : st === 'unstable' ? [...an.byPart.values()].find((r) => r.unstable) : w;
        if (target) app.select(target.info.def.id);
      };
    }
    // legend
    this.legend.className = app.stressView ? '' : 'hidden';
    if (app.stressView) {
      clear(this.legend);
      this.legend.append(h('div', {}, 'Utilisation (load ÷ capacity)'), h('div', { class: 'bar' }), h('div', { class: 'ticks' }, h('span', {}, '0%'), h('span', {}, '50%'), h('span', {}, '100%'), h('span', {}, '200%')));
    }
    // sim hud
    this.hud.className = sim ? '' : 'hidden';
    this.updateFailLabels();
    this.renderStatus();
    if (sim) this.renderLog();
  }

  private updateFailLabels() {
    for (const l of this.failLabels) {
      l.removeFromParent();
      l.element.remove();
    }
    this.failLabels = [];
    const an = this.app.analysis;
    if (!an || this.app.mode !== 'build') return;
    for (const f of an.failing.slice(0, 8)) {
      const el = h('div', { class: 'fail-label' }, `${MODE_LABEL[f.mode]} ${(f.U * 100).toFixed(0)}%`);
      const o = new CSS2DObject(el);
      o.position.set(f.point[0], f.point[1], f.point[2]);
      this.app.viewport.overlayRoot.add(o);
      this.failLabels.push(o);
    }
  }

  renderLog() {
    const app = this.app;
    if (app.log.length === this.logCount) return;
    this.logCount = app.log.length;
    clear(this.hudLog);
    for (const e of app.log.slice(-60)) {
      this.hudLog.appendChild(h('div', {}, e.t !== null ? h('span', { class: 't' }, `${e.t.toFixed(2)} s`) : null, h('span', { class: e.level }, e.text)));
    }
    this.hudLog.scrollTop = this.hudLog.scrollHeight;
  }

  renderStatus() {
    const app = this.app;
    clear(this.status);
    let mass = 0;
    for (const p of app.design.parts) mass += getMaterial(p.material).density * volume(p);
    this.status.append(
      h('div', { class: 'hint' }, this.tools.hint()),
      h('div', { class: 'stat' }, 'Parts ', h('b', {}, String(app.design.parts.length))),
      h('div', { class: 'stat' }, 'Mass ', h('b', {}, fmtMass(mass))),
    );
    if (app.analysis) this.status.append(h('div', { class: 'stat' }, 'Solve ', h('b', {}, `${app.analysis.result.timeMs.toFixed(0)} ms`)));
  }

  /** per-frame (cheap) */
  tick() {
    const s = this.app.sim;
    if (this.app.mode === 'sim' && s) {
      clear(this.hudTime);
      this.hudTime.append(h('b', {}, `${s.time.toFixed(2)} s`), h('span', {}, s.paused ? 'Paused' : s.timeScale === 1 ? 'Real time' : `Slow motion ×${s.timeScale}`));
    }
  }
}
