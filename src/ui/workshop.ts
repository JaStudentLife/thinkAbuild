import type { App, Tool } from '../app';
import { cutSeconds, cutterFor } from '../core/cut';
import { JOINT_TYPES, type JointType } from '../core/design';
import { getMaterial } from '../core/materials';
import { HAMMERS, type HammerKind } from '../tools/rigs';
import { clear, h, icon, type ICONS } from './dom';

interface Entry {
  tool: Tool;
  join?: JointType;
  icon: keyof typeof ICONS;
  label: string;
  title: string;
}

const ENTRIES: Entry[] = [
  { tool: 'saw', icon: 'saw', label: 'Saw', title: 'Saw (S): cut any part in two. Uses the right tool for the material: saw, hacksaw, angle grinder, diamond blade, glass cutter or knife.' },
  { tool: 'hammer', icon: 'hammer', label: 'Hammer', title: 'Hammer (H): hit a part. Starts the simulation.' },
  { tool: 'push', icon: 'hand', label: 'Push', title: 'Hand (P): push and pull parts while the simulation runs' },
  { tool: 'throw', icon: 'ball', label: 'Throw', title: 'Throw (T): hurl a 5 kg steel ball' },
  { tool: 'join', join: 'glue', icon: 'glue', label: 'Glue', title: 'Glue (J): glue two touching parts together' },
  { tool: 'join', join: 'screw', icon: 'screw', label: 'Screws', title: 'Screwdriver: screw two touching parts together' },
  { tool: 'join', join: 'bolt', icon: 'bolt', label: 'Bolts', title: 'Wrench: bolt two touching parts together' },
  { tool: 'join', join: 'weld', icon: 'weld', label: 'Weld', title: 'Welder: weld two metal parts together' },
  { tool: 'join', join: 'rest', icon: 'pry', label: 'Pry bar', title: 'Pry bar: separate joined parts. Also works on a running simulation.' },
  { tool: 'measure', icon: 'tape', label: 'Tape', title: 'Tape measure (M): measure between two points' },
  { tool: 'round', icon: 'round', label: 'Round', title: 'Round edges (E): drag an edge of a box or cylinder inwards to round it over or bevel it' },
];

const TIPS: Partial<Record<Tool, string>> = {
  push: 'Drag a part while the simulation runs: up to 600 N, about a strong shove. Push hard enough and something gives.',
  throw: 'Click anywhere to throw a 5 kg steel ball at 24 m/s.',
  measure: 'Click two points. It snaps to corners and face centres. Esc clears.',
};

/** The Workshop: tools that act on what you have built. */
export class WorkshopPanel {
  private el: HTMLElement;
  private app: App;

  constructor(el: HTMLElement, app: App) {
    this.el = el;
    this.app = app;
    for (const ev of ['tool', 'mode', 'settings', 'selection', 'design'] as const) app.on(ev, () => this.render());
    this.render();
  }

  private isActive(e: Entry): boolean {
    return this.app.tool === e.tool && (!e.join || this.app.joinType === e.join);
  }

  private pick(e: Entry) {
    const app = this.app;
    if (this.isActive(e)) {
      app.setTool('select');
      return;
    }
    if (e.join) app.joinType = e.join;
    app.setTool(e.tool);
  }

  render() {
    if (this.el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    const app = this.app;
    const sim = app.mode === 'sim';
    clear(this.el);
    this.el.appendChild(h('div', { class: 'panel-h ws-h' }, h('h2', {}, 'Workshop')));
    const grid = h('div', { class: 'wgrid' });
    for (const e of ENTRIES) {
      const disabled = (sim && e.tool === 'join' && e.join !== 'rest') || (sim && e.tool === 'round');
      const b = h('button', { class: `wtool ${this.isActive(e) ? 'active' : ''}`, title: disabled ? 'Joints are made while building: stop the simulation first' : e.title, disabled }, icon(e.icon), h('span', {}, e.label));
      b.addEventListener('click', () => this.pick(e));
      grid.appendChild(b);
    }
    this.el.appendChild(grid);
    const opts = this.options();
    if (opts) this.el.appendChild(opts);
  }

  private options(): HTMLElement | null {
    const app = this.app;
    const t = app.tool;
    if (t === 'saw') return this.sawOptions();
    if (t === 'round') return this.roundOptions();
    if (t === 'hammer') {
      const box = h('div', { class: 'wopts' });
      for (const k of Object.keys(HAMMERS) as HammerKind[]) {
        const spec = HAMMERS[k];
        const energy = 0.5 * spec.mass * spec.speed * spec.speed;
        const r = h('label', { class: 'wradio' }, h('input', { type: 'radio', name: 'hammer', checked: app.hammer === k }), h('span', {}, h('b', {}, spec.name), ` ${spec.mass} kg head at ${spec.speed} m/s (${energy.toFixed(0)} J)`));
        r.querySelector('input')!.addEventListener('change', () => {
          app.hammer = k;
          app.emit('settings');
        });
        box.appendChild(r);
      }
      box.appendChild(h('div', { class: 'wnote' }, 'Click a part to hit it. The blow goes through the same impact physics as a falling part.'));
      return box;
    }
    if (t === 'join') {
      const j = JOINT_TYPES.find((x) => x.id === app.joinType)!;
      const text = app.joinType === 'rest'
        ? 'Click where two joined parts meet to separate them. They keep touching but nothing holds them together. While simulating, it breaks the joint live.'
        : `${j.blurb} Click where two parts touch. Dots show every contact, coloured by its joint.`;
      return h('div', { class: 'wopts' }, h('div', { class: 'wnote' }, text), this.legend());
    }
    const tip = TIPS[t];
    return tip ? h('div', { class: 'wopts' }, h('div', { class: 'wnote' }, tip)) : null;
  }

  private legend(): HTMLElement {
    const colors: Record<JointType, string> = { rest: '#8a93a3', glue: '#f2c14e', screw: '#c0c7d2', bolt: '#7c8aa0', weld: '#ff7b2e', rigid: '#b27dff' };
    return h('div', { class: 'wlegend' }, ...JOINT_TYPES.map((j) => h('span', {}, h('i', { style: { background: colors[j.id] } }), j.name)));
  }

  private roundOptions(): HTMLElement {
    const app = this.app;
    const box = h('div', { class: 'wopts' });
    const btn = (label: string, title: string, active: boolean, fn: () => void) => {
      const b = h('button', { class: `wbtn ${active ? 'active' : ''}`, title }, label);
      b.addEventListener('click', fn);
      return b;
    };
    box.appendChild(
      h('div', { class: 'wrow' },
        h('span', { class: 'wlab' }, 'Profile'),
        btn('Round', 'A rounded-over edge (a router\u2019s round-over bit)', !app.edgeTool.bevel, () => {
          app.edgeTool.bevel = false;
          app.emit('settings');
        }),
        btn('Bevel', 'A flat 45\u00b0 chamfer', app.edgeTool.bevel, () => {
          app.edgeTool.bevel = true;
          app.emit('settings');
        }),
      ),
    );
    const cb = h('input', { type: 'checkbox', checked: app.edgeTool.allCorners });
    cb.addEventListener('change', () => {
      app.edgeTool.allCorners = cb.checked;
      app.emit('settings');
    });
    box.appendChild(h('label', { class: 'wcheck' }, cb, 'All four corners together (Shift swaps)'));
    const sel = app.part(app.selection);
    if (sel && sel.edge && (sel.kind === 'box' || sel.kind === 'cylinder')) {
      const sq = h('button', { class: 'wbtn', style: { marginTop: '7px' }, title: 'Make every edge of the selected part square again' }, `Square up ${sel.name}`);
      sq.addEventListener('click', () => app.setEdge(sel.id, undefined));
      box.appendChild(sq);
    }
    box.appendChild(h('div', { class: 'wnote' }, 'Drag an edge inwards to round it, outwards to square it again. Corners round from above (a table top) or along a leg; a rim goes all the way round, following rounded corners. Push all four corners of a square top right in and it becomes a disc. Exact sizes: Edges, in the panel on the right.'));
    return box;
  }

  private sawOptions(): HTMLElement {
    const app = this.app;
    const box = h('div', { class: 'wopts' });
    const ang = app.saw.angle;
    const set = (v: number) => {
      let a = ((Math.round(v) % 180) + 180) % 180;
      if (a > 90) a -= 180;
      app.saw.angle = a;
      app.emit('settings');
    };
    const btn = (label: string, title: string, fn: () => void, active = false) => {
      const b = h('button', { class: `wbtn ${active ? 'active' : ''}`, title }, label);
      b.addEventListener('click', fn);
      return b;
    };
    box.appendChild(
      h('div', { class: 'wrow' },
        h('span', { class: 'wlab' }, 'Angle'),
        btn('−15°', 'Angle the cut (Q)', () => set(ang - 15)),
        h('span', { class: 'wval' }, `${ang}°`),
        btn('+15°', 'Angle the cut (E)', () => set(ang + 15)),
        btn('Square', 'Cut straight across the part', () => set(0), ang === 0),
        btn('45°', 'Mitre cut', () => set(45), ang === 45),
        btn('Along', 'Rip along the part instead of across it (R)', () => set(90), Math.abs(ang) === 90),
      ),
    );
    const cb = h('input', { type: 'checkbox', checked: app.saw.discard });
    cb.addEventListener('change', () => {
      app.saw.discard = cb.checked;
      app.emit('settings');
    });
    box.appendChild(h('label', { class: 'wcheck' }, cb, 'Throw the offcut away'));
    // what the saw will be cutting
    const sel = app.livePart(app.selection);
    const m = getMaterial(sel?.material ?? app.activeMaterial);
    const c = cutterFor(m);
    let info: string;
    if (c.refuse) info = `${m.name}: ${c.refuse}`;
    else {
      const per = cutSeconds(c, 1e-3);
      const speed = c.kind === 'glasscutter' ? 'any size in a second' : `about ${(10 / per).toFixed(1)} cm² a second`;
      info = `${m.name}: ${c.name}${c.kerf > 0 ? `, ${(c.kerf * 1000).toFixed(1)} mm kerf` : ''}, ${speed}.${c.note ? ' ' + c.note : ''}`;
    }
    box.appendChild(h('div', { class: 'wnote' }, h('b', {}, sel ? 'Selected part: ' : 'Active material: '), info));
    box.appendChild(h('div', { class: 'wnote' }, 'Point at a face: the blade goes in there. While simulating, a loaded part can give way before the cut is finished.'));
    return box;
  }
}
