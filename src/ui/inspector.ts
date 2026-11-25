import * as THREE from 'three';
import type { App } from '../app';
import { GROUND_ID, JOINT_TYPES, type JointType, type PartDef } from '../core/design';
import { CATEGORIES, MATERIALS, getMaterial } from '../core/materials';
import { defaultUp, withEdge, type EdgeTarget } from '../core/rounding';
import { axisWorld, volume } from '../core/shapes';
import { MODE_LABEL, type PartReport, type Status } from '../fea/structure';
import { utilColor } from '../render/materialLib';
import { PRESETS } from '../presets';
import { clear, fmtForce, fmtLen, fmtMass, h, icon } from './dom';
import { swatch } from './materials';

export function statusBadge(st: Status, text?: string): HTMLElement {
  const label = { ok: 'Holds', warn: 'Close to limit', fail: 'Fails', unstable: 'Unstable', empty: '—' }[st];
  return h('span', { class: `badge ${st}` }, text ?? label);
}

export function utilBar(U: number): HTMLElement {
  const c = utilColor(U).getStyle();
  return h('div', { class: 'util' }, h('div', { style: { width: `${Math.min(100, U * 100)}%`, background: c } }));
}

const SHAPE_NAME: Record<string, string> = { box: 'Box', cylinder: 'Cylinder', sphere: 'Ball', tube: 'Pipe', hull: 'Fragment' };

export class Inspector {
  private el: HTMLElement;
  private app: App;
  private pending = false;

  constructor(el: HTMLElement, app: App) {
    this.el = el;
    this.app = app;
    for (const ev of ['selection', 'design', 'analysis', 'mode'] as const) app.on(ev, () => this.schedule());
    this.render();
  }

  private schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    const active = document.activeElement as HTMLElement | null;
    if (active && this.el.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
    const scroll = this.el.scrollTop;
    clear(this.el);
    const p = this.app.part(this.app.selection);
    if (p && this.app.mode === 'build') this.renderPart(p);
    else this.renderScene();
    this.el.scrollTop = scroll;
  }

  // ------------------------------------------------------------------ part
  private num(value: number, onSet: (v: number) => void, opts: { step?: number; min?: number; scale?: number; digits?: number } = {}) {
    const scale = opts.scale ?? 100;
    const i = h('input', { type: 'number', value: +(value * scale).toFixed(opts.digits ?? 1), step: opts.step ?? 1 });
    if (opts.min !== undefined) i.min = String(opts.min);
    const commit = () => {
      const v = parseFloat(i.value);
      if (!isFinite(v)) return;
      if (opts.min !== undefined && v < opts.min) return;
      onSet(v / scale);
    };
    i.addEventListener('change', commit);
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit();
        i.blur();
      }
      e.stopPropagation();
    });
    return i;
  }

  private xyz(labels: [string, string, string], values: [number, number, number], onSet: (i: number, v: number) => void, opts: { scale?: number; step?: number; min?: number; digits?: number } = {}) {
    return h(
      'div',
      { class: 'xyz' },
      ...labels.map((l, k) => h('div', {}, h('span', {}, l), this.num(values[k], (v) => onSet(k, v), opts))),
    );
  }

  private renderPart(p: PartDef) {
    const app = this.app;
    const mat = getMaterial(p.material);
    const rep = app.analysis?.byPart.get(p.id);

    // header
    const name = h('input', { type: 'text', class: 'name-input', value: p.name });
    name.addEventListener('change', () => app.updatePart(p.id, { name: name.value || p.name }));
    name.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.appendChild(
      h('div', { class: 'section' }, h('h3', {}, `${SHAPE_NAME[p.kind] ?? p.kind}`, rep ? statusBadge(rep.status) : null), name),
    );

    // verdict
    if (rep) this.el.appendChild(this.analysisSection(rep));

    // material
    const sel = h('select', { style: { flex: '1' } });
    for (const cat of CATEGORIES) {
      const og = h('optgroup', { label: cat });
      for (const m of MATERIALS.filter((m) => m.category === cat)) og.appendChild(h('option', { value: m.id, selected: m.id === p.material }, m.name));
      sel.appendChild(og);
    }
    sel.addEventListener('change', () => {
      app.activeMaterial = sel.value;
      app.updatePart(p.id, { material: sel.value });
    });
    const mass = mat.density * volume(p);
    this.el.appendChild(
      h(
        'div',
        { class: 'section' },
        h('h3', {}, 'Material'),
        h('div', { class: 'row' }, h('img', { src: swatch(mat), style: { width: '28px', height: '28px', borderRadius: '50%' } }), sel),
        h('div', { class: 'kv', style: { marginTop: '8px' } }, h('span', {}, 'Mass'), h('span', {}, fmtMass(mass)), h('span', {}, 'Weight'), h('span', {}, fmtForce(mass * 9.81))),
      ),
    );

    // dimensions
    const dims = h('div', { class: 'section' }, h('h3', {}, 'Size'));
    const setSize = (s: [number, number, number]) => app.updatePart(p.id, { size: s });
    if (p.kind === 'box') {
      dims.appendChild(this.xyz(['W', 'H', 'D'], p.size, (k, v) => {
        const s = [...p.size] as [number, number, number];
        s[k] = Math.max(0.001, v);
        setSize(s);
      }, { min: 0.1, step: 0.5 }));
      dims.appendChild(h('div', { class: 'msg' }, 'Width / height / depth in cm, along the part’s own axes.'));
    } else if (p.kind === 'sphere') {
      dims.appendChild(h('div', { class: 'row' }, h('label', {}, 'Diameter'), this.num(p.size[0], (v) => setSize([v, v, v]), { min: 0.1, step: 0.5 }), h('span', { class: 'unit' }, 'cm')));
    } else if (p.kind === 'cylinder' || p.kind === 'tube') {
      dims.appendChild(h('div', { class: 'row' }, h('label', {}, 'Diameter'), this.num(p.size[0], (v) => setSize([v, p.size[1], v]), { min: 0.1, step: 0.5 }), h('span', { class: 'unit' }, 'cm')));
      dims.appendChild(h('div', { class: 'row' }, h('label', {}, 'Length'), this.num(p.size[1], (v) => setSize([p.size[0], v, p.size[2]]), { min: 0.1, step: 1 }), h('span', { class: 'unit' }, 'cm')));
      if (p.kind === 'tube') {
        dims.appendChild(h('div', { class: 'row' }, h('label', {}, 'Wall'), this.num(p.wall ?? 0.003, (v) => app.updatePart(p.id, { wall: Math.min(v, p.size[0] / 2 - 0.0005) }), { min: 0.1, step: 0.5, scale: 1000 }), h('span', { class: 'unit' }, 'mm')));
      }
      const hollow = h('input', { type: 'checkbox', checked: p.kind === 'tube' });
      hollow.addEventListener('change', () => app.updatePart(p.id, { kind: hollow.checked ? 'tube' : 'cylinder', wall: p.wall ?? Math.max(0.002, p.size[0] * 0.08) }));
      dims.appendChild(h('label', { class: 'row', style: { cursor: 'pointer' } }, hollow, 'Hollow (pipe)'));
    }
    this.el.appendChild(dims);
    if (p.kind === 'box' || p.kind === 'cylinder') this.el.appendChild(this.edgesSection(p));

    // transform
    const q = new THREE.Quaternion(...p.quat);
    const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    const deg = [e.x, e.y, e.z].map((r) => THREE.MathUtils.radToDeg(r)) as [number, number, number];
    const tr = h('div', { class: 'section' }, h('h3', {}, 'Position & rotation'));
    tr.appendChild(this.xyz(['X', 'Y', 'Z'], p.pos, (k, v) => {
      const pos = [...p.pos] as [number, number, number];
      pos[k] = v;
      app.updatePart(p.id, { pos });
    }, { step: 1 }));
    tr.appendChild(h('div', { style: { height: '6px' } }));
    tr.appendChild(this.xyz(['RX', 'RY', 'RZ'], deg, (k, v) => {
      const d = [...deg];
      d[k] = v;
      const nq = new THREE.Quaternion().setFromEuler(new THREE.Euler(...d.map((x) => THREE.MathUtils.degToRad(x)) as [number, number, number], 'XYZ'));
      app.updatePart(p.id, { quat: [nq.x, nq.y, nq.z, nq.w] });
    }, { scale: 1, step: 5, digits: 1 }));
    tr.appendChild(h('div', { class: 'msg' }, 'Position of the centre in cm; rotation in degrees.'));
    const anch = h('input', { type: 'checkbox', checked: !!p.anchored });
    anch.addEventListener('change', () => app.updatePart(p.id, { anchored: anch.checked }));
    tr.appendChild(h('label', { class: 'row', style: { cursor: 'pointer', marginTop: '8px' } }, anch, icon('anchor', 'ico'), 'Fixed to the world (a wall or foundation)'));
    this.el.appendChild(tr);

    // connections
    this.el.appendChild(this.connections(p));

    // actions
    const del = h('button', { class: 'btn danger' }, icon('trash'), 'Delete');
    del.addEventListener('click', () => app.deletePart(p.id));
    const dup = h('button', { class: 'btn' }, icon('copy'), 'Duplicate');
    dup.addEventListener('click', () => app.duplicate(p.id));
    this.el.appendChild(h('div', { class: 'section' }, h('div', { class: 'btnrow' }, dup, del)));
  }

  /** rounded / bevelled edges, typed in exactly */
  private edgesSection(p: PartDef): HTMLElement {
    const app = this.app;
    const up = p.kind === 'cylinder' ? 1 : p.edge?.up ?? defaultUp(p);
    const e = p.edge && p.edge.up === up ? p.edge : undefined;
    const upW = axisWorld(p.quat, up);
    const vertical = Math.abs(upW[1]) > 0.7;
    const topIsUp = upW[1] >= 0;
    const s = h('div', { class: 'section' }, h('h3', {}, 'Edges'));
    const row = (label: string, target: EdgeTarget, value: number) => {
      const kind = h('select', { title: 'Round or bevel' }, h('option', { value: 'round', selected: value >= 0 }, 'Round'), h('option', { value: 'bevel', selected: value < 0 }, 'Bevel'));
      const apply = (mag: number) => {
        const v = Math.max(0, mag) * (kind.value === 'bevel' ? -1 : 1);
        app.setEdge(p.id, withEdge(p, target, up, v, true));
      };
      const input = this.num(Math.abs(value), (v) => apply(v), { min: 0, step: 0.5 });
      kind.addEventListener('change', () => apply(Math.abs(value)));
      return h('div', { class: 'row' }, h('label', { style: { minWidth: '92px' } }, label), input, h('span', { class: 'unit' }, 'cm'), kind);
    };
    if (p.kind === 'box') {
      const cs = e?.corners ?? [0, 0, 0, 0];
      const mixed = cs.some((c) => Math.abs(c - cs[0]) > 1e-9);
      s.appendChild(row(vertical ? 'Corners' : 'Long edges', { kind: 'corner', index: 0 }, Math.max(...cs.map(Math.abs)) * (cs.some((c) => c < 0) ? -1 : 1)));
      if (mixed) s.appendChild(h('div', { class: 'msg' }, 'The corners differ (set with the Round tool); typing a size sets all four.'));
    }
    const topLabel = vertical ? (topIsUp ? 'Top edge' : 'Bottom edge') : 'End edge';
    const botLabel = vertical ? (topIsUp ? 'Bottom edge' : 'Top edge') : 'Other end edge';
    s.appendChild(row(topLabel, { kind: 'rim', side: 'top' }, e?.top ?? 0));
    s.appendChild(row(botLabel, { kind: 'rim', side: 'bottom' }, e?.bottom ?? 0));
    s.appendChild(h('div', { class: 'msg' }, 'Rounds or bevels the edges, like a router run round them. Or use the Round tool (E) and drag an edge.'));
    return s;
  }

  private analysisSection(rep: PartReport): HTMLElement {
    const s = h('div', { class: 'section' }, h('h3', {}, 'Structural check', h('span', { style: { color: 'var(--text)', textTransform: 'none', letterSpacing: '0' } }, rep.unstable ? '' : `${(rep.U * 100).toFixed(0)}% of capacity`)));
    if (!rep.unstable) s.appendChild(utilBar(rep.U));
    const mode = rep.unstable ? 'Unstable' : rep.U < 0.005 ? 'Unloaded' : MODE_LABEL[rep.mode];
    s.appendChild(h('div', { class: 'kv' }, h('span', {}, 'Critical'), h('span', {}, mode), h('span', {}, 'Safety factor'), h('span', {}, rep.unstable ? '—' : rep.U > 0 ? `${(1 / rep.U).toFixed(rep.U > 0.5 ? 2 : 1)}×` : '∞'), h('span', {}, 'Deflection'), h('span', {}, fmtLen(rep.maxDisp))));
    s.appendChild(h('div', { class: 'msg' }, rep.message));
    if (rep.status === 'fail') s.appendChild(h('div', { class: 'msg', style: { color: '#ff9a9a' } }, 'Press Simulate to watch it fail.'));
    return s;
  }

  private connections(p: PartDef): HTMLElement {
    const app = this.app;
    const s = h('div', { class: 'section' }, h('h3', {}, 'Joints & contacts'));
    const an = app.analysis;
    const rows: { other: string; otherName: string; joint: JointType; Fn: number; U: number; msg: string; lifted: boolean }[] = [];
    if (an) {
      an.model.patches.forEach((pi, i) => {
        const a = an.model.parts[pi.partA]?.def.id;
        const b = pi.bId;
        if (a !== p.id && b !== p.id) return;
        const other = a === p.id ? b : a;
        const otherName = other === GROUND_ID ? 'Floor' : app.part(other)?.name ?? '?';
        const r = an.result.patches[i];
        rows.push({ other, otherName, joint: pi.joint, Fn: r.Fn, U: r.U, msg: r.message, lifted: r.lifted });
      });
    }
    if (!rows.length) {
      s.appendChild(h('div', { class: 'msg' }, p.anchored ? 'Fixed to the world.' : 'Not touching anything. In the simulation it will fall.'));
      return s;
    }
    for (const r of rows) {
      const sel = h('select', {}, ...JOINT_TYPES.filter((j) => r.other !== GROUND_ID || j.id !== 'weld').map((j) => h('option', { value: j.id, selected: j.id === r.joint, title: j.blurb }, j.id === 'rest' && r.other === GROUND_ID ? 'Resting' : j.id === 'bolt' && r.other === GROUND_ID ? 'Bolted down' : j.name)));
      sel.addEventListener('change', () => app.setJoint(p.id, r.other, sel.value as JointType));
      const stat = r.lifted ? 'lifted off (no contact force)' : `${fmtForce(Math.abs(r.Fn))} ${r.Fn >= 0 ? 'compression' : 'tension'}${r.U > 0.01 ? ` · ${(r.U * 100).toFixed(0)}%` : ''}`;
      s.appendChild(h('div', { class: 'conn' }, h('div', { class: 'cname' }, r.otherName), sel, h('div', { class: 'cstat', style: r.U >= 1 ? { color: '#ff9a9a' } : {} }, r.U >= 1 ? r.msg : stat)));
    }
    return s;
  }

  // ------------------------------------------------------------------ scene
  private renderScene() {
    const app = this.app;
    const an = app.analysis;
    const head = h('div', { class: 'section' });
    const name = h('input', { type: 'text', class: 'name-input', value: app.design.name });
    name.addEventListener('change', () => {
      app.design.name = name.value || 'Untitled';
      app.commit('Rename');
    });
    name.addEventListener('keydown', (e) => e.stopPropagation());
    head.append(h('h3', {}, 'Design', an ? statusBadge(an.status) : null), name);
    let mass = 0;
    for (const p of app.design.parts) mass += getMaterial(p.material).density * volume(p);
    head.appendChild(h('div', { class: 'kv', style: { marginTop: '8px' } }, h('span', {}, 'Parts'), h('span', {}, String(app.design.parts.length)), h('span', {}, 'Total mass'), h('span', {}, fmtMass(mass))));
    const dj = h('select', {}, ...JOINT_TYPES.filter((j) => j.id !== 'rigid').map((j) => h('option', { value: j.id, selected: app.design.defaultJoint === j.id }, j.name)));
    dj.addEventListener('change', () => {
      app.design.defaultJoint = dj.value as JointType;
      app.commit('Default joint');
    });
    head.appendChild(h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', {}, 'Touching parts are'), dj));
    this.el.appendChild(head);

    if (an && an.byPart.size && app.mode === 'build') {
      const sec = h('div', { class: 'section' }, h('h3', {}, 'Most loaded parts'));
      const reps = [...an.byPart.values()].sort((a, b) => (b.unstable ? 10 : b.U) - (a.unstable ? 10 : a.U)).slice(0, 12);
      for (const r of reps) {
        const col = utilColor(r.U).getStyle();
        const item = h(
          'div',
          { class: 'list-item' },
          h('div', {}, r.info.def.name, ' ', h('span', { style: { color: 'var(--dim)', fontSize: '11px' } }, getMaterial(r.info.def.material).name)),
          r.unstable ? statusBadge('unstable') : h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, h('span', { style: { fontSize: '11px', color: 'var(--muted)' } }, `${(r.U * 100).toFixed(0)}%`), h('div', { class: 'minibar' }, h('div', { style: { width: `${Math.min(100, r.U * 100)}%`, background: col } }))),
          h('div', { class: 'li-sub' }, r.unstable ? r.message : r.U < 0.005 ? 'Unloaded' : `${MODE_LABEL[r.mode]}: ${r.message}`),
        );
        item.addEventListener('click', () => app.select(r.info.def.id));
        sec.appendChild(item);
      }
      this.el.appendChild(sec);
    }

    const ex = h('div', { class: 'section' }, h('h3', {}, 'Try an example'));
    for (const pr of PRESETS) {
      const card = h('div', { class: 'preset' }, h('b', {}, pr.title, h('span', { class: `tag ${pr.expect}` }, pr.expect === 'fails' ? 'fails' : 'holds')), h('span', {}, pr.blurb));
      card.addEventListener('click', () => app.loadDesign(pr.make()));
      ex.appendChild(card);
    }
    this.el.appendChild(ex);

    this.el.appendChild(
      h(
        'div',
        { class: 'section help', html: `
        <h3>How it works</h3>
        Draw shapes on the floor or on any face. Pick a material on the left. Every change is checked live: the structure is solved as a 3D frame (finite elements) with real material strengths, buckling, joint and contact limits, then <b>Simulate</b> lets real physics play it out.<br><br>
        <kbd>V</kbd> select &nbsp;<kbd>B</kbd> box &nbsp;<kbd>C</kbd> cylinder &nbsp;<kbd>O</kbd> ball &nbsp;<kbd>L</kbd> beam<br>
        <kbd>G</kbd>/<kbd>R</kbd> move/rotate gizmo &nbsp;<kbd>Del</kbd> delete &nbsp;<kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate<br>
        <kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> undo/redo &nbsp;<kbd>Space</kbd> simulate &nbsp;<kbd>F</kbd> frame all<br>
        <kbd>1</kbd> front &nbsp;<kbd>3</kbd> right &nbsp;<kbd>7</kbd> top &nbsp;<kbd>0</kbd> iso &nbsp;<kbd>5</kbd> ortho/perspective<br>
        Right-drag orbits while drawing, middle-drag pans, scroll zooms.` },
      ),
    );
  }
}
