import type { App, DeformMode, Tool, WorkPlane } from '../app';
import { emptyDesign } from '../core/design';
import { openDesignFile, saveDesignFile, saveScreenshot } from '../core/files';
import { PRESETS } from '../presets';
import { sound } from '../audio/sound';
import { clear, h, icon, type ICONS } from './dom';

export function toast(text: string, ms = 2200) {
  const t = h('div', { class: 'toast' }, text);
  document.body.appendChild(t);
  setTimeout(() => (t.style.opacity = '0'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function popover(anchor: HTMLElement, items: { label: string | Node; onClick: () => void }[]) {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
  const r = anchor.getBoundingClientRect();
  const pop = h('div', { class: 'popover', style: { left: `${Math.min(r.left, window.innerWidth - 340)}px`, top: `${r.bottom + 6}px` } });
  for (const it of items) {
    const el = h('div', { class: 'pitem' }, it.label);
    el.addEventListener('click', () => {
      pop.remove();
      it.onClick();
    });
    pop.appendChild(el);
  }
  document.body.appendChild(pop);
  const close = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node)) {
      pop.remove();
      window.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => window.addEventListener('mousedown', close, true), 0);
}

export class Toolbar {
  private el: HTMLElement;
  private app: App;

  constructor(el: HTMLElement, app: App) {
    this.el = el;
    this.app = app;
    for (const ev of ['tool', 'mode', 'sim', 'settings', 'selection', 'design'] as const) app.on(ev, () => this.render());
    this.render();
  }

  private btn(ic: keyof typeof ICONS, title: string, onClick: () => void, opts: { active?: boolean; label?: string; disabled?: boolean; cls?: string } = {}) {
    const b = h('button', { class: `tbtn ${opts.active ? 'active' : ''} ${opts.cls ?? ''}`, title, disabled: opts.disabled }, icon(ic), opts.label ?? null);
    b.addEventListener('click', onClick);
    return b;
  }

  render() {
    if (this.el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    const app = this.app;
    const el = this.el;
    clear(el);
    const sim = app.mode === 'sim';
    el.appendChild(h('div', { class: 'brand' }, h('img', { class: 'logo-img', src: './icon.png', alt: '' }), h('span', {}, 'think', h('span', { class: 'a' }, 'A'), 'build')));

    // tools
    const tools: [Tool, keyof typeof ICONS, string][] = [
      ['select', 'select', 'Select / move (V)'],
      ['box', 'box', 'Box (B): slabs, legs, blocks, walls'],
      ['cylinder', 'cylinder', 'Cylinder (C): posts, rods, discs'],
      ['sphere', 'sphere', 'Ball (O)'],
      ['beam', 'beam', 'Beam (L): a member between two points, for braces and trusses'],
    ];
    const tg = h('div', { class: 'tgroup' });
    for (const [t, ic, title] of tools) tg.appendChild(this.btn(ic, title, () => app.setTool(t), { active: app.tool === t, disabled: sim && t !== 'select' }));
    // the active workshop tool, so it's clear what a click will do
    const ws: Partial<Record<Tool, [keyof typeof ICONS, string]>> = {
      saw: ['saw', 'Saw'], hammer: ['hammer', 'Hammer'], push: ['hand', 'Push'], measure: ['tape', 'Tape'], round: ['round', 'Round edges'],
      join: [app.joinType === 'rest' ? 'pry' : app.joinType === 'glue' ? 'glue' : app.joinType === 'screw' ? 'screw' : app.joinType === 'bolt' ? 'bolt' : 'weld', app.joinType === 'rest' ? 'Pry bar' : { glue: 'Glue', screw: 'Screws', bolt: 'Bolts', weld: 'Weld', rigid: 'Lock', rest: '' }[app.joinType]],
    };
    const cur = ws[app.tool];
    if (cur) tg.appendChild(this.btn(cur[0], 'Workshop tool in use (Esc puts it down)', () => app.setTool('select'), { active: true, label: cur[1], cls: 'wsel' }));
    el.appendChild(tg);

    if (app.tool === 'beam' && !sim) {
      const bs = app.beamSection;
      const g = h('div', { class: 'tgroup' });
      const shape = h('select', { title: 'Beam cross-section' }, ...(['rect', 'round', 'pipe'] as const).map((s) => h('option', { value: s, selected: bs.shape === s }, { rect: 'Rectangular', round: 'Round', pipe: 'Pipe' }[s])));
      shape.addEventListener('change', () => {
        bs.shape = shape.value as typeof bs.shape;
        this.render();
      });
      g.appendChild(shape);
      const num = (val: number, set: (v: number) => void, title: string, unit = 'cm', scale = 100) => {
        const i = h('input', { type: 'number', value: +(val * scale).toFixed(2), step: unit === 'mm' ? 0.5 : 0.5, min: 0.1, title });
        i.addEventListener('change', () => {
          const v = parseFloat(i.value);
          if (v > 0) set(v / scale);
        });
        return [i, h('span', { class: 'tlabel' }, unit)];
      };
      if (bs.shape === 'rect') {
        g.append(h('span', { class: 'tlabel' }, 'W'), ...num(bs.w, (v) => (bs.w = v), 'Width'), h('span', { class: 'tlabel' }, 'H'), ...num(bs.h, (v) => (bs.h = v), 'Depth'));
      } else {
        g.append(h('span', { class: 'tlabel' }, 'Ø'), ...num(bs.d, (v) => (bs.d = v), 'Diameter'));
        if (bs.shape === 'pipe') g.append(h('span', { class: 'tlabel' }, 'wall'), ...num(bs.wall, (v) => (bs.wall = v), 'Wall thickness', 'mm', 1000));
      }
      el.appendChild(g);
    }

    // edit
    const eg = h('div', { class: 'tgroup' });
    eg.append(
      this.btn('undo', 'Undo (Ctrl+Z)', () => app.undo(), { disabled: sim }),
      this.btn('redo', 'Redo (Ctrl+Y)', () => app.redo(), { disabled: sim }),
      this.btn('copy', 'Duplicate (Ctrl+D)', () => app.selection && app.duplicate(app.selection), { disabled: sim || !app.selection }),
      this.btn('trash', 'Delete (Del)', () => app.selection && app.deletePart(app.selection), { disabled: sim || !app.selection }),
    );
    el.appendChild(eg);

    // snapping / work plane
    if (!sim) {
      const sg = h('div', { class: 'tgroup' });
      sg.appendChild(icon('magnet', 'ico'));
      const snap = h('select', { title: 'Grid snapping' }, ...[0, 0.001, 0.005, 0.01, 0.05, 0.1].map((v) => h('option', { value: v, selected: Math.abs(app.snap - v) < 1e-9 }, v === 0 ? 'No snap' : v < 0.01 ? `${v * 1000} mm` : `${v * 100} cm`)));
      snap.addEventListener('change', () => app.setSnap(parseFloat(snap.value)));
      sg.appendChild(snap);
      const wp = h('select', { title: 'Drawing plane' }, ...(['auto', 'ground', 'front', 'side'] as WorkPlane[]).map((v) => h('option', { value: v, selected: app.workPlane === v }, { auto: 'Faces + floor', ground: 'Horizontal plane', front: 'Front plane (XY)', side: 'Side plane (YZ)' }[v])));
      wp.addEventListener('change', () => {
        app.workPlane = wp.value as WorkPlane;
        app.emit('settings');
      });
      sg.append(icon('plane', 'ico'), wp);
      wp.title = 'Where new shapes are drawn: on any face under the cursor, or on a fixed plane (lets you draw behind or under things)';
      if (app.workPlane !== 'auto') {
        const ev = h('input', { type: 'number', value: +(app.workElevation * 100).toFixed(1), step: 1, title: 'Plane offset (cm)' });
        ev.addEventListener('change', () => {
          app.workElevation = (parseFloat(ev.value) || 0) / 100;
          app.emit('settings');
        });
        sg.append(h('span', { class: 'tlabel' }, app.workPlane === 'ground' ? 'height' : 'offset'), ev, h('span', { class: 'tlabel' }, 'cm'));
      }
      if (app.tool === 'select' && app.selection) {
        sg.append(
          this.btn('frame', 'Move arrows on the selected part (G toggles)', () => app.toggleGizmo('move'), { active: app.gizmo.move }),
          this.btn('reset', 'Rotation rings on the selected part (R toggles): drag a ring to turn the part, in 15° steps', () => app.toggleGizmo('rotate'), { active: app.gizmo.rotate }),
        );
      }
      el.appendChild(sg);
    }

    // analysis view
    const ag = h('div', { class: 'tgroup' });
    ag.appendChild(this.btn('stress', 'Stress view: colour every part by how close it is to failing', () => app.setStressView(!app.stressView), { active: app.stressView, label: 'Stress' }));
    if (!sim) {
      const dm = h('select', { title: 'Show deformation' }, ...(['off', 'true', 'x10', 'x100', 'auto'] as DeformMode[]).map((v) => h('option', { value: v, selected: app.deformMode === v }, { off: 'No bending', true: 'True bending', x10: 'Bending ×10', x100: 'Bending ×100', auto: 'Exaggerated' }[v])));
      dm.addEventListener('change', () => app.setDeformMode(dm.value as DeformMode));
      ag.appendChild(dm);
    }
    el.appendChild(ag);

    // simulation
    const sgp = h('div', { class: 'tgroup' });
    if (!sim) {
      sgp.appendChild(this.btn('play', 'Run the physics simulation (Space)', () => app.startSim(), { cls: 'primary', label: 'Simulate', disabled: !app.design.parts.length }));
    } else {
      sgp.appendChild(this.btn('stop', 'Stop and return to building (Esc)', () => app.stopSim(), { cls: 'danger', label: 'Stop' }));
      const s = app.sim;
      if (s) {
        sgp.appendChild(this.btn(s.paused ? 'play' : 'pause', s.paused ? 'Resume (Space)' : 'Pause (Space)', () => {
          s.paused = !s.paused;
          app.emit('sim');
        }));
        const sp = h('select', { title: 'Simulation speed' }, ...[1, 0.5, 0.25, 0.1].map((v) => h('option', { value: v, selected: s.timeScale === v }, v === 1 ? 'Real time' : `Slow ×${v}`)));
        sp.addEventListener('change', () => {
          s.timeScale = parseFloat(sp.value);
          app.emit('sim');
        });
        sgp.appendChild(sp);
        sgp.appendChild(this.btn('ball', 'Throw (T): click in the scene to throw a 5 kg steel ball', () => app.setTool(app.tool === 'throw' ? 'select' : 'throw'), { active: app.tool === 'throw', label: 'Throw' }));
      }
    }
    el.appendChild(sgp);

    // file
    const fg = h('div', { class: 'tgroup' });
    fg.append(
      this.btn('file', 'New design', () => {
        if (app.design.parts.length && !confirm('Start a new design? Unsaved changes will be lost.')) return;
        app.loadDesign(emptyDesign());
      }, { disabled: sim }),
      this.btn('open', 'Open design (Ctrl+O)', async () => {
        const d = await openDesignFile();
        if (d) {
          app.loadDesign(d);
          toast(`Opened “${d.name}”`);
        }
      }, { disabled: sim }),
      this.btn('save', 'Save design (Ctrl+S)', async () => {
        if (await saveDesignFile(app.design)) toast('Design saved');
      }),
    );
    const ex = this.btn('book', 'Example builds', () => {
      popover(ex, PRESETS.map((p) => ({
        label: h('div', {}, h('b', {}, p.title), h('span', { style: { display: 'block', color: 'var(--muted)', fontSize: '11.5px', maxWidth: '300px', whiteSpace: 'normal', marginTop: '2px' } }, p.blurb)),
        onClick: () => {
          app.loadDesign(p.make());
          toast(`Loaded: ${p.title}`);
        },
      })));
    }, { label: 'Examples', disabled: sim });
    fg.appendChild(ex);
    fg.appendChild(this.btn('camera', 'Save a screenshot', () => saveScreenshot(app.viewport.screenshot())));
    fg.appendChild(this.btn(sound.muted ? 'mute' : 'sound', sound.muted ? 'Unmute' : 'Mute', () => {
      sound.muted = !sound.muted;
      this.render();
    }));
    el.appendChild(fg);
  }
}
