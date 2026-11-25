import * as THREE from 'three';
import {
  cloneDesign, emptyDesign, GROUND_ID, jointFor, newId, pairKey, type Design, type JointType, type PartDef, type ShapeKind,
} from './core/design';
import { cutPart, type CutAim } from './core/cut';
import { lowestPoint, volume, worldAABB } from './core/shapes';
import { analyzeStructure, type StructureResult } from './fea/structure';
import { makeDeformField, type DeformField } from './render/deform';
import { PartView } from './render/partMesh';
import { Viewport } from './render/viewport';
import type { Simulation } from './sim/simulation';
import type { HammerKind } from './tools/rigs';

export type Tool = 'select' | 'box' | 'cylinder' | 'sphere' | 'beam' | 'saw' | 'hammer' | 'join' | 'measure' | 'push' | 'throw' | 'round';
/** tools that make sense while the simulation runs */
export const SIM_TOOLS: Tool[] = ['select', 'saw', 'hammer', 'join', 'measure', 'push', 'throw'];
/** workshop tools that act on a running simulation (clicking them in build mode starts one) */
export const ACTION_TOOLS: Tool[] = ['hammer', 'push', 'throw'];
export type WorkPlane = 'auto' | 'ground' | 'front' | 'side';
export type DeformMode = 'off' | 'true' | 'x10' | 'x100' | 'auto';
export type AppEvent = 'design' | 'selection' | 'analysis' | 'tool' | 'mode' | 'sim' | 'settings' | 'log';

export interface BeamSection {
  shape: 'rect' | 'round' | 'pipe';
  w: number;
  h: number;
  d: number;
  wall: number;
}

export interface LogEntry {
  t: number | null;
  text: string;
  level: 'info' | 'warn' | 'fail' | 'ok';
}

const STORAGE_KEY = 'thinkabuild.design.v1';

export class App {
  readonly viewport: Viewport;
  design: Design;
  readonly views = new Map<string, PartView>();
  selection: string | null = null;
  hover: string | null = null;
  tool: Tool = 'select';
  activeMaterial = 'pine';
  snap = 0.01;
  workPlane: WorkPlane = 'auto';
  workElevation = 0;
  stressView = false;
  deformMode: DeformMode = 'true';
  showForces = false;
  analysis: StructureResult | null = null;
  analysisStale = true;
  fields = new Map<string, DeformField>();
  mode: 'build' | 'sim' = 'build';
  beamSection: BeamSection = { shape: 'rect', w: 0.05, h: 0.05, d: 0.04, wall: 0.004 };
  /** which handles the selection gizmo shows: move arrows and / or rotation rings */
  gizmo = { move: true, rotate: true };
  /** edge tool: bevel instead of round, and treat the four corners together */
  edgeTool = { bevel: false, allCorners: true };
  /** saw settings: extra rotation of the cut (degrees) and whether offcuts are thrown away */
  saw = { angle: 0, discard: false };
  hammer: HammerKind = 'claw';
  /** joint the joining tool makes ('rest' = the pry bar) */
  joinType: JointType = 'glue';
  log: LogEntry[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Map<AppEvent, Set<() => void>>();
  private analysisTimer: number | null = null;
  /** set by the simulation module */
  sim: Simulation | null = null;
  simFactory: ((app: App) => Promise<App['sim']>) | null = null;

  constructor(container: HTMLElement) {
    this.viewport = new Viewport(container);
    this.design = this.restore() ?? emptyDesign();
    this.syncViews();
    this.undoStack.push(JSON.stringify(this.design));
    this.scheduleAnalysis(0);
    const t = this.viewport.transform;
    t.addEventListener('objectChange', () => this.onGizmoChange());
    t.addEventListener('mouseUp', () => this.commit('Move'));
    this.viewport.transform.setTranslationSnap(this.snap || null);
    this.viewport.transform.setRotationSnap(THREE.MathUtils.degToRad(15));
    const ro = this.viewport.rotator;
    ro.addEventListener('objectChange', () => this.onGizmoChange());
    ro.addEventListener('mouseUp', () => this.commit('Rotate'));
    ro.setRotationSnap(THREE.MathUtils.degToRad(15));
  }

  // ------------------------------------------------------------------ events
  on(ev: AppEvent, cb: () => void) {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(cb);
  }
  emit(ev: AppEvent) {
    this.listeners.get(ev)?.forEach((cb) => cb());
  }

  addLog(text: string, level: LogEntry['level'] = 'info', t: number | null = null) {
    this.log.push({ t, text, level });
    if (this.log.length > 200) this.log.shift();
    this.emit('log');
  }

  // ------------------------------------------------------------------ design ops
  part(id: string | null): PartDef | undefined {
    if (!id) return undefined;
    return this.design.parts.find((p) => p.id === id);
  }

  nextName(kind: ShapeKind | 'beam'): string {
    const base = { box: 'Block', cylinder: 'Cylinder', sphere: 'Ball', tube: 'Pipe', hull: 'Piece', beam: 'Beam' }[kind];
    let n = 1;
    const names = new Set(this.design.parts.map((p) => p.name));
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  addPart(def: Omit<PartDef, 'id' | 'name'> & { name?: string }, nameKind?: ShapeKind | 'beam'): PartDef {
    const p: PartDef = { ...def, id: newId(), name: def.name ?? this.nextName(nameKind ?? def.kind) } as PartDef;
    this.keepAboveGround(p);
    this.design.parts.push(p);
    this.select(p.id);
    this.commit('Add ' + p.name);
    return p;
  }

  keepAboveGround(p: PartDef) {
    if (p.anchored) return;
    const low = lowestPoint(p);
    if (low < 0) p.pos[1] -= low;
  }

  updatePart(id: string, patch: Partial<PartDef>, commit = true) {
    const p = this.part(id);
    if (!p) return;
    Object.assign(p, patch);
    this.keepAboveGround(p);
    this.views.get(id)?.update(p);
    if (commit) this.commit('Edit ' + p.name);
    else this.emit('design');
  }

  deletePart(id: string) {
    const i = this.design.parts.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = this.design.parts.splice(i, 1);
    for (const k of Object.keys(this.design.joints)) if (k.split('|').includes(id)) delete this.design.joints[k];
    if (this.selection === id) this.select(null);
    this.commit('Delete ' + p.name);
  }

  duplicate(id: string) {
    const p = this.part(id);
    if (!p) return;
    const box = worldAABB(p);
    const dx = box.max[0] - box.min[0];
    const copy: PartDef = { ...JSON.parse(JSON.stringify(p)), id: newId(), name: this.nextName(p.kind) };
    copy.pos = [p.pos[0] + dx + 0.05, p.pos[1], p.pos[2]];
    this.design.parts.push(copy);
    this.select(copy.id);
    this.commit('Duplicate ' + p.name);
  }

  setJoint(a: string, b: string, t: JointType) {
    this.design.joints[pairKey(a, b)] = t;
    this.commit('Joint');
  }

  /** a part as it is right now (its live pose while simulating) */
  livePart(id: string | null): PartDef | undefined {
    if (!id) return undefined;
    if (this.mode === 'sim' && this.sim) return this.sim.partDef(id);
    return this.part(id);
  }

  /**
   * Saw a part in two along `aim`. The bigger piece keeps the part's id (and so its joints); the
   * smaller one becomes an "offcut" that inherits the same joints with its neighbours. The two
   * pieces just rest against each other. Returns the pieces, or null if the cut misses.
   */
  cutPart(id: string, aim: CutAim, kerf: number): { kept: PartDef; offcut: PartDef } | null {
    const p = this.part(id);
    if (!p) return null;
    const res = cutPart(p, aim.n, aim.s, kerf);
    if (!res) return null;
    const [big, small] = volume(res.neg) >= volume(res.pos) ? [res.neg, res.pos] : [res.pos, res.neg];
    const root = p.name.replace(/ offcut( \d+)?$/, '');
    const names = new Set(this.design.parts.map((q) => q.name));
    let name = `${root} offcut`;
    for (let k = 2; names.has(name); k++) name = `${root} offcut ${k}`;
    const kept: PartDef = { ...big, id: p.id, name: p.name };
    const offcut: PartDef = { ...small, id: newId(), name };
    const i = this.design.parts.findIndex((q) => q.id === id);
    this.design.parts.splice(i, 1, kept, offcut);
    // the offcut was part of the same piece: it keeps the same kind of joint with its neighbours
    for (const [k, t] of Object.entries(this.design.joints)) {
      const [a, b] = k.split('|');
      if (a === id) this.design.joints[pairKey(offcut.id, b)] = t;
      else if (b === id) this.design.joints[pairKey(a, offcut.id)] = t;
    }
    this.design.joints[pairKey(kept.id, offcut.id)] = 'rest';
    this.views.get(id)?.update(kept);
    this.commit('Cut ' + p.name);
    return { kept, offcut };
  }

  jointOf = (a: PartDef, bId: string, b?: PartDef): JointType => jointFor(this.design, a, bId, b);

  /** record history, sync scene, re-analyse */
  commit(_label = '') {
    void _label;
    const snap = JSON.stringify(this.design);
    if (this.undoStack[this.undoStack.length - 1] !== snap) {
      this.undoStack.push(snap);
      if (this.undoStack.length > 120) this.undoStack.shift();
      this.redoStack = [];
    }
    this.persist();
    this.syncViews();
    this.analysisStale = true;
    this.scheduleAnalysis();
    this.emit('design');
  }

  undo() {
    if (this.mode !== 'build' || this.undoStack.length < 2) return;
    this.redoStack.push(this.undoStack.pop()!);
    this.design = JSON.parse(this.undoStack[this.undoStack.length - 1]);
    this.afterLoad();
  }

  redo() {
    if (this.mode !== 'build' || !this.redoStack.length) return;
    const s = this.redoStack.pop()!;
    this.undoStack.push(s);
    this.design = JSON.parse(s);
    this.afterLoad();
  }

  loadDesign(d: Design, frame = true) {
    if (this.mode === 'sim') this.stopSim();
    this.design = cloneDesign(d);
    this.design.parts.forEach((p) => this.keepAboveGround(p));
    this.select(null);
    this.undoStack.push(JSON.stringify(this.design));
    this.redoStack = [];
    this.afterLoad();
    if (frame) this.frameAll();
  }

  private afterLoad() {
    if (this.selection && !this.part(this.selection)) this.select(null);
    this.persist();
    this.syncViews();
    this.analysisStale = true;
    this.scheduleAnalysis(0);
    this.emit('design');
    this.emit('selection');
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.design));
    } catch {
      /* storage unavailable */
    }
  }

  private restore(): Design | null {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (!s) return null;
      const d = JSON.parse(s) as Design;
      if (d && d.version === 1 && Array.isArray(d.parts)) return d;
    } catch {
      /* ignore */
    }
    return null;
  }

  // ------------------------------------------------------------------ scene sync
  syncViews() {
    if (this.mode === 'sim') return;
    const live = new Set(this.design.parts.map((p) => p.id));
    for (const [id, v] of this.views) {
      if (!live.has(id)) {
        this.viewport.partsRoot.remove(v.group);
        v.dispose();
        this.views.delete(id);
      }
    }
    for (const p of this.design.parts) {
      let v = this.views.get(p.id);
      if (!v) {
        v = new PartView(p);
        this.views.set(p.id, v);
        this.viewport.partsRoot.add(v.group);
      }
      v.update(p);
      v.setStressView(this.stressView);
      v.setHighlight(this.selection === p.id, this.hover === p.id);
    }
    this.attachGizmo();
    this.viewport.fitShadows(this.contentBox());
  }

  contentBox(): THREE.Box3 {
    const b = new THREE.Box3();
    for (const p of this.design.parts) {
      const a = worldAABB(p);
      b.expandByPoint(new THREE.Vector3(...a.min));
      b.expandByPoint(new THREE.Vector3(...a.max));
    }
    return b;
  }

  frameAll() {
    const b = this.contentBox();
    this.viewport.frame(b.isEmpty() ? null : b);
  }

  // ------------------------------------------------------------------ selection
  select(id: string | null) {
    if (this.selection === id) return;
    const prev = this.selection;
    this.selection = id;
    if (prev) this.views.get(prev)?.setHighlight(false, this.hover === prev);
    if (id) this.views.get(id)?.setHighlight(true, false);
    this.attachGizmo();
    this.emit('selection');
  }

  setHover(id: string | null) {
    if (this.hover === id) return;
    const prev = this.hover;
    this.hover = id;
    if (prev) this.views.get(prev)?.setHighlight(this.selection === prev, false);
    if (id) this.views.get(id)?.setHighlight(this.selection === id, true);
  }

  attachGizmo() {
    const v = this.selection ? this.views.get(this.selection) : undefined;
    const show = !!v && this.tool === 'select' && this.mode === 'build';
    const pairs: [import('three/addons/controls/TransformControls.js').TransformControls, boolean][] = [
      [this.viewport.transform, this.gizmo.move],
      [this.viewport.rotator, this.gizmo.rotate],
    ];
    for (const [c, on] of pairs) {
      if (show && on) {
        if (c.object !== v!.group) c.attach(v!.group);
        c.enabled = true;
        c.getHelper().visible = true;
      } else {
        c.detach();
        c.enabled = false;
        c.getHelper().visible = false;
      }
    }
  }

  /** show or hide the move arrows / rotation rings (at least one stays) */
  toggleGizmo(kind: 'move' | 'rotate') {
    const other = kind === 'move' ? 'rotate' : 'move';
    if (this.gizmo[kind] && !this.gizmo[other]) return;
    this.gizmo[kind] = !this.gizmo[kind];
    this.attachGizmo();
    this.emit('settings');
  }

  /** set a part's edge treatment (live while dragging, committed at the end) */
  setEdge(id: string, edge: PartDef['edge'], commit = true) {
    this.updatePart(id, { edge }, commit);
  }

  private onGizmoChange() {
    const id = this.selection;
    const v = id ? this.views.get(id) : undefined;
    const p = this.part(id);
    if (!v || !p) return;
    p.pos = [v.group.position.x, v.group.position.y, v.group.position.z];
    p.quat = [v.group.quaternion.x, v.group.quaternion.y, v.group.quaternion.z, v.group.quaternion.w];
    const low = lowestPoint(p);
    if (low < 0 && !p.anchored) {
      p.pos[1] -= low;
      v.group.position.y = p.pos[1];
    }
    this.emit('design');
  }

  // ------------------------------------------------------------------ tools & settings
  setTool(t: Tool) {
    if (this.mode === 'sim' && !SIM_TOOLS.includes(t)) return;
    this.tool = t;
    this.viewport.setLeftButtonOrbit(t === 'select');
    this.attachGizmo();
    this.emit('tool');
  }

  setSnap(s: number) {
    this.snap = s;
    this.viewport.transform.setTranslationSnap(s > 0 ? s : null);
    this.emit('settings');
  }

  private autoDeform = false;

  setStressView(on: boolean) {
    this.stressView = on;
    for (const v of this.views.values()) v.setStressView(on);
    if (on && this.deformMode === 'true') {
      this.deformMode = 'auto';
      this.autoDeform = true;
    } else if (!on && this.autoDeform) {
      if (this.deformMode === 'auto') this.deformMode = 'true';
      this.autoDeform = false;
    }
    this.applyFields();
    this.emit('settings');
  }

  setDeformMode(m: DeformMode) {
    this.deformMode = m;
    this.applyFields();
    this.emit('settings');
  }

  deformScale(): number {
    let mx = 0;
    for (const f of this.fields.values()) mx = Math.max(mx, f.maxDisp);
    const size = this.contentBox().getSize(new THREE.Vector3()).length() || 1;
    let s: number;
    switch (this.deformMode) {
      case 'off':
        return 0;
      case 'true':
        s = 1;
        break;
      case 'x10':
        s = 10;
        break;
      case 'x100':
        s = 100;
        break;
      case 'auto':
        return mx > 0 ? Math.max(1, (0.04 * size) / mx) : 1;
    }
    // a failing structure's small-deflection answer runs away; never draw more than a few
    // percent of its size (the verdict already says it fails)
    if (mx > 0 && s * mx > 0.025 * size) s = (0.025 * size) / mx;
    return s;
  }

  // ------------------------------------------------------------------ analysis
  scheduleAnalysis(delay = 140) {
    if (this.analysisTimer !== null) clearTimeout(this.analysisTimer);
    this.analysisTimer = window.setTimeout(() => {
      this.analysisTimer = null;
      this.runAnalysis();
    }, delay);
  }

  runAnalysis() {
    if (this.mode !== 'build') return;
    const parts = this.design.parts;
    if (!parts.length) {
      this.analysis = null;
      this.fields.clear();
      this.analysisStale = false;
      this.applyFields();
      this.emit('analysis');
      return;
    }
    try {
      const res = analyzeStructure({ parts, jointOf: this.jointOf });
      this.analysis = res;
      this.fields.clear();
      const elemU = res.result.elements.map((e) => e.U);
      res.model.parts.forEach((info, i) => {
        this.fields.set(info.def.id, makeDeformField(info, res.model, res.result.u, elemU, res.result.parts[i].U));
      });
    } catch (e) {
      console.error('analysis failed', e);
      this.analysis = null;
      this.fields.clear();
    }
    this.analysisStale = false;
    this.applyFields();
    this.emit('analysis');
  }

  applyFields() {
    if (this.mode !== 'build') return;
    const s = this.deformScale();
    for (const [id, v] of this.views) v.setField(this.fields.get(id) ?? null, s);
  }

  // ------------------------------------------------------------------ simulation
  async startSim() {
    if (this.mode === 'sim' || !this.simFactory) return;
    if (this.analysisStale) this.runAnalysis();
    this.mode = 'sim';
    if (!SIM_TOOLS.includes(this.tool)) this.setTool('select');
    this.attachGizmo();
    this.log = [];
    this.emit('mode');
    this.sim = await this.simFactory(this);
    this.emit('sim');
  }

  stopSim() {
    if (this.mode !== 'sim') return;
    this.sim?.dispose();
    this.sim = null;
    this.mode = 'build';
    if (this.tool === 'push' || this.tool === 'throw') this.setTool('select');
    // rebuild the build-mode views
    for (const v of this.views.values()) {
      this.viewport.partsRoot.remove(v.group);
      v.dispose();
    }
    this.views.clear();
    this.viewport.fxRoot.clear();
    this.syncViews();
    this.applyFields();
    this.emit('mode');
    this.emit('sim');
  }

  update(dt: number) {
    if (this.sim && this.mode === 'sim') this.sim.update(dt);
  }

  groundJointKey(id: string) {
    return pairKey(id, GROUND_ID);
  }
}
