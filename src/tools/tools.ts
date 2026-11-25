import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { App, Tool } from '../app';
import { ACTION_TOOLS } from '../app';
import { sound } from '../audio/sound';
import { detectContacts, type ContactPatch } from '../core/contacts';
import { aimCut, cutSeconds, cutterFor, type CutAim, type Cutter } from '../core/cut';
import { GROUND_ID, jointName, pairKey, type JointType, type PartDef, type QuatT, type Vec3T } from '../core/design';
import { jointCapacity } from '../core/joints';
import { getMaterial, GROUND_MATERIAL } from '../core/materials';
import { edgeLimit, edgeValue, nearestEdge, planRing, roundGeom, withEdge, type EdgeTarget } from '../core/rounding';
import { halfExtents, toLocal, toWorld } from '../core/shapes';
import { ghostMaterial } from '../render/materialLib';
import { Particles } from '../render/particles';
import { toast } from '../ui/toolbar';
import { HAMMERS, HammerRig, SawRig } from './rigs';

// ------------------------------------------------------------------ surfaces

interface Surface {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  origin: THREE.Vector3;
  partId: string | null;
  curved: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);

function fmtLen(m: number): string {
  const a = Math.abs(m);
  if (a >= 1) return `${m.toFixed(a >= 10 ? 1 : 2)} m`;
  if (a >= 0.1) return `${(m * 100).toFixed(1).replace(/\.0$/, '')} cm`;
  if (a >= 0.01) return `${(m * 100).toFixed(1)} cm`;
  return `${(m * 1000).toFixed(1)} mm`;
}

function fmtForce(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)} kN` : `${n.toFixed(0)} N`;
}

function partAxes(p: PartDef): THREE.Vector3[] {
  const q = new THREE.Quaternion(...p.quat);
  return [new THREE.Vector3(1, 0, 0).applyQuaternion(q), new THREE.Vector3(0, 1, 0).applyQuaternion(q), new THREE.Vector3(0, 0, 1).applyQuaternion(q)];
}

function quatFromBasis(x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3): QuatT {
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.x, q.y, q.z, q.w];
}

function label(text: string, cls = 'dim-label'): CSS2DObject {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return new CSS2DObject(d);
}

const tv = (v: THREE.Vector3): Vec3T => [v.x, v.y, v.z];
const vt = (v: Vec3T) => new THREE.Vector3(v[0], v[1], v[2]);

export const JOINT_COLORS: Record<JointType, number> = {
  rest: 0x8a93a3, glue: 0xf2c14e, screw: 0xc0c7d2, bolt: 0x7c8aa0, weld: 0xff7b2e, rigid: 0xb27dff,
};

interface BuildCut {
  partId: string;
  aim: CutAim;
  cutter: Cutter;
  rig: SawRig;
  t: number;
  duration: number;
  nextFx: number;
  nextStroke: number;
  pose: string;
}

interface JoinTarget {
  a: string;
  b: string;
  key: string;
  current: JointType;
  centroid: THREE.Vector3;
  /** sim: the bond to pry */
  bond?: string;
}

interface Measurement {
  line: THREE.Line;
  label: CSS2DObject;
  ends: THREE.Mesh[];
}

export class ToolManager {
  private app: App;
  private phase = 0;
  private surf: Surface | null = null;
  private A = new THREE.Vector3();
  private B = new THREE.Vector3();
  private height = 0;
  private preview: THREE.Mesh | null = null;
  private previewEdges: THREE.LineSegments | null = null;
  private cursor: THREE.Group;
  private snapMarker: THREE.Mesh;
  private line: THREE.Line;
  private labelA: CSS2DObject;
  private labelB: CSS2DObject;
  private downX = 0;
  private downY = 0;
  private downButton = -1;
  private lastEvent: PointerEvent | null = null;
  private shift = false;

  // ---- workshop
  private root = new THREE.Group();
  private fx = new Particles();
  private sawAim: { partId: string; aim: CutAim; cutter: Cutter } | null = null;
  private sawFill: THREE.Mesh | null = null;
  private sawLine: THREE.LineSegments | null = null;
  private sawGhost: SawRig | null = null;
  private sawKey = '';
  private cutJob: BuildCut | null = null;
  private hammerGhost: HammerRig | null = null;
  private hammerKind = '';
  private joinTarget: JoinTarget | null = null;
  private joinMark: THREE.Mesh;
  private markers = new THREE.Group();
  private markersKey = '';
  private measures: Measurement[] = [];
  private mA: THREE.Vector3 | null = null;
  private live: Measurement | null = null;
  private pushing = false;
  private pushPlane = new THREE.Plane();
  private pushLine: THREE.Line;
  private pushHand: THREE.Mesh;
  private ghosts: { mesh: THREE.Mesh; v: THREE.Vector3; w: THREE.Vector3; t: number }[] = [];
  private edgeHover: { partId: string; target: EdgeTarget; up: number } | null = null;
  private edgeDrag: {
    partId: string; target: EdgeTarget; up: number; plane: THREE.Plane; C: THREE.Vector3; bis: THREE.Vector3; d0: number; v0: number; limit: number;
  } | null = null;
  private edgeLines: THREE.LineSegments;

  constructor(app: App) {
    this.app = app;
    const vp = app.viewport;
    this.cursor = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.012, 0.016, 32),
      new THREE.MeshBasicMaterial({ color: 0x4fb3ff, depthTest: false, transparent: true, side: THREE.DoubleSide }),
    );
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, side: THREE.DoubleSide }));
    this.cursor.add(ring, dot);
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    vp.overlayRoot.add(this.cursor);
    this.snapMarker = new THREE.Mesh(new THREE.OctahedronGeometry(0.012), new THREE.MeshBasicMaterial({ color: 0xffc94f, depthTest: false }));
    this.snapMarker.visible = false;
    this.snapMarker.renderOrder = 11;
    vp.overlayRoot.add(this.snapMarker);
    this.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0x4fb3ff, dashSize: 0.02, gapSize: 0.012, depthTest: false }));
    this.line.visible = false;
    this.line.renderOrder = 10;
    vp.overlayRoot.add(this.line);
    this.labelA = label('');
    this.labelB = label('');
    this.labelA.visible = this.labelB.visible = false;
    vp.overlayRoot.add(this.labelA, this.labelB);

    // workshop scene objects (kept out of fxRoot, which the simulation clears)
    vp.scene.add(this.root, this.fx.root);
    this.joinMark = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: false, side: THREE.DoubleSide }));
    this.joinMark.renderOrder = 12;
    this.joinMark.visible = false;
    vp.overlayRoot.add(this.joinMark, this.markers);
    this.pushLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x7cf0c0, depthTest: false }));
    this.pushLine.visible = false;
    this.pushLine.renderOrder = 12;
    this.pushHand = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0x7cf0c0, depthTest: false }));
    this.pushHand.visible = false;
    this.pushHand.renderOrder = 12;
    vp.overlayRoot.add(this.pushLine, this.pushHand);
    this.edgeLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb15a, depthTest: false, transparent: true, opacity: 0.95 }));
    this.edgeLines.visible = false;
    this.edgeLines.renderOrder = 12;
    vp.overlayRoot.add(this.edgeLines);

    const el = vp.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => {
      this.cursor.visible = false;
      this.snapMarker.visible = false;
      if (this.app.tool === 'select') this.app.setHover(null);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    app.on('tool', () => this.reset());
    app.on('mode', () => {
      this.reset();
      this.clearMeasures();
    });
    app.on('analysis', () => (this.markersKey = ''));
    app.on('design', () => (this.markersKey = ''));
  }

  hint(): string {
    const t = this.app.tool;
    const sim = this.app.mode === 'sim';
    switch (t) {
      case 'select':
        return sim
          ? 'Simulating. Right-drag to orbit, middle-drag to pan, scroll to zoom. Pick a tool in the Workshop to saw, hit, push or pry the structure while it runs.'
          : 'Click a part to select it. Drag an arrow to move it or a ring to turn it (15° steps); G / R show or hide them. Left-drag on empty space orbits, right-drag pans, scroll zooms.';
      case 'box':
        return ['Box: click on the floor or on any face to start the base.', 'Click to set the base size.', 'Move to set the height, then click to finish.'][this.phase] + '  (Esc cancels, right-drag orbits)';
      case 'cylinder':
        return ['Cylinder: click on a surface to set the centre.', 'Click to set the radius.', 'Move to set the height, then click to finish.'][this.phase] + '  (Esc cancels)';
      case 'sphere':
        return ['Ball: click on a surface to set the centre.', 'Click to set the radius.'][this.phase] + '  (Esc cancels)';
      case 'beam':
        return this.phase === 0
          ? 'Beam: click a start point (snaps to corners and face centres). Hold Shift to lock to an axis.'
          : 'Click the end point. Clicks keep chaining beams; Esc or right-click ends the chain.';
      case 'saw': {
        const s = this.sawAim;
        const what = s ? `${getMaterial(this.app.livePart(s.partId)?.material ?? 'pine').name} with a ${s.cutter.name}. ` : '';
        return `Saw: point at a face (the blade goes in there) and click to cut. ${what}R turns the cut 90°, Q / E angle it by 15°.${sim ? ' Cutting a loaded part can make it give way before the cut is finished.' : ''}`;
      }
      case 'hammer':
        return `${HAMMERS[this.app.hammer].name}: click a part to hit it.${sim ? '' : ' This starts the simulation.'}`;
      case 'join':
        if (this.app.joinType === 'rest') return sim ? 'Pry bar: click near a joint to break it while the simulation runs.' : 'Pry bar: click where two parts meet to separate them (they keep touching, but nothing holds them together).';
        return sim ? 'Joints can only be made while building. Stop the simulation first (Esc).' : `${jointName(this.app.joinType)}: click where two parts touch to join them that way.`;
      case 'measure':
        return this.mA ? 'Click the second point (snaps to corners and face centres). Esc clears the measurements.' : 'Tape measure: click two points to measure between them.';
      case 'push':
        return sim ? 'Hand: drag a part to push or pull it (up to 600 N, about a strong shove). Pushing hard enough breaks things.' : 'Hand: works on a running simulation. Press Simulate (Space) first.';
      case 'throw':
        return 'Click to throw a 5 kg steel ball at 24 m/s.' + (sim ? '' : ' This starts the simulation.');
      case 'round':
        if (sim) return 'Edges are shaped while building. Stop the simulation first (Esc).';
        return `Round edges: point at an edge of a box or cylinder and drag it inwards to ${this.app.edgeTool.bevel ? 'bevel' : 'round'} it, outwards to square it again. A corner does ${this.app.edgeTool.allCorners ? 'all four corners (Shift: just one)' : 'one corner (Shift: all four)'}; a rim goes all the way round. Push a square top's corners right in for a round table.`;
    }
    return '';
  }

  reset() {
    this.phase = 0;
    this.surf = null;
    this.clearPreview();
    this.line.visible = false;
    this.labelA.visible = this.labelB.visible = false;
    this.snapMarker.visible = false;
    this.cursor.visible = false;
    this.app.viewport.workGrid.visible = false;
    this.clearSawPreview();
    this.clearHammerGhost();
    this.joinTarget = null;
    this.joinMark.visible = false;
    this.markersKey = '';
    this.clearMarkers();
    this.mA = null;
    this.clearLive();
    if (this.pushing) this.app.sim?.endPush();
    this.pushing = false;
    this.pushLine.visible = this.pushHand.visible = false;
    if (this.edgeDrag) this.edgeDragEnd();
    this.edgeHover = null;
    this.edgeLines.visible = false;
    if (this.app.tool !== 'select' && this.app.hover) this.app.setHover(null);
    this.app.emit('settings');
  }

  private clearPreview() {
    if (this.preview) {
      this.app.viewport.overlayRoot.remove(this.preview);
      this.preview.geometry.dispose();
      this.preview = null;
    }
    if (this.previewEdges) {
      this.app.viewport.overlayRoot.remove(this.previewEdges);
      this.previewEdges.geometry.dispose();
      this.previewEdges = null;
    }
  }

  private setPreview(geo: THREE.BufferGeometry, pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.clearPreview();
    this.preview = new THREE.Mesh(geo, ghostMaterial);
    this.preview.position.copy(pos);
    this.preview.quaternion.copy(quat);
    this.preview.renderOrder = 5;
    this.previewEdges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x9fd4ff }));
    this.previewEdges.position.copy(pos);
    this.previewEdges.quaternion.copy(quat);
    this.app.viewport.overlayRoot.add(this.preview, this.previewEdges);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (this.phase > 0) {
        this.reset();
        return true;
      }
      if (this.app.tool === 'measure' && (this.mA || this.measures.length)) {
        this.mA = null;
        this.clearLive();
        this.clearMeasures();
        return true;
      }
      return false;
    }
    if (e.key === 'Shift') this.shift = true;
    if (this.app.tool === 'saw' && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      const step = k === 'r' ? 90 : k === 'e' ? 15 : k === 'q' ? -15 : 0;
      if (step) {
        this.setSawAngle(this.app.saw.angle + step);
        return true;
      }
    }
    return false;
  }

  setSawAngle(a: number) {
    let v = ((Math.round(a) % 180) + 180) % 180;
    if (v > 90) v -= 180;
    this.app.saw.angle = v;
    if (this.lastEvent) this.sawHover(this.lastEvent);
    this.app.emit('settings');
  }

  keyUp(e: KeyboardEvent) {
    if (e.key === 'Shift') this.shift = false;
  }

  // ------------------------------------------------------------------ surface picking

  private workPlaneSurface(): { n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; o: THREE.Vector3 } {
    const e = this.app.workElevation;
    switch (this.app.workPlane) {
      case 'front':
        return { n: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), o: new THREE.Vector3(0, 0, e) };
      case 'side':
        return { n: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 0, -1), v: new THREE.Vector3(0, 1, 0), o: new THREE.Vector3(e, 0, 0) };
      default:
        return { n: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1), o: new THREE.Vector3(0, e, 0) };
    }
  }

  private surfaceAt(e: PointerEvent): Surface | null {
    const vp = this.app.viewport;
    // 'auto' draws on whatever face is under the cursor; explicit planes see through parts
    const useParts = this.app.workPlane === 'auto';
    const hit = useParts ? vp.pick(e.clientX, e.clientY) : null;
    if (hit && hit.partId) {
      const p = this.app.part(hit.partId);
      if (p) return this.partSurface(p, hit.point, hit.normal);
    }
    const wp = this.workPlaneSurface();
    const ray = vp.ray(e.clientX, e.clientY);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(wp.n, wp.o);
    const pt = new THREE.Vector3();
    if (!ray.intersectPlane(plane, pt)) return null;
    return { point: pt, normal: wp.n, u: wp.u, v: wp.v, origin: wp.o, partId: null, curved: false };
  }

  private partSurface(p: PartDef, point: THREE.Vector3, normal: THREE.Vector3): Surface {
    const ax = partAxes(p);
    const c = new THREE.Vector3(...p.pos);
    const he = halfExtents(p);
    // a slanted saw-cut face: draw on its own plane
    if (p.cuts?.length && p.kind !== 'hull') {
      const q = new THREE.Quaternion(...p.quat);
      for (let i = 0; i + 3 < p.cuts.length; i += 4) {
        const n = new THREE.Vector3(p.cuts[i], p.cuts[i + 1], p.cuts[i + 2]).applyQuaternion(q);
        if (n.dot(normal) > 0.98) {
          const u = Math.abs(n.dot(UP)) < 0.9 ? new THREE.Vector3().crossVectors(UP, n).normalize() : new THREE.Vector3(1, 0, 0);
          const v = new THREE.Vector3().crossVectors(n, u);
          return { point: point.clone(), normal: n, u, v, origin: point.clone(), partId: p.id, curved: false };
        }
      }
    }
    if (p.kind === 'box' || p.kind === 'hull') {
      let best = 0, bd = 0;
      for (let a = 0; a < 3; a++) {
        const d = ax[a].dot(normal);
        if (Math.abs(d) > Math.abs(bd)) {
          bd = d;
          best = a;
        }
      }
      const s = Math.sign(bd) || 1;
      const n = ax[best].clone().multiplyScalar(s);
      const j = (best + 1) % 3, k = (best + 2) % 3;
      const u = ax[j].clone(), v = ax[k].clone();
      const origin = c.clone().addScaledVector(n, he[best]).addScaledVector(u, -he[j]).addScaledVector(v, -he[k]);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, c.clone().addScaledVector(n, he[best]));
      const pt = plane.projectPoint(point, new THREE.Vector3());
      return { point: pt, normal: n, u, v, origin, partId: p.id, curved: false };
    }
    if (p.kind === 'cylinder' || p.kind === 'tube') {
      const axis = ax[1];
      const d = axis.dot(normal);
      if (Math.abs(d) > 0.7) {
        const n = axis.clone().multiplyScalar(Math.sign(d));
        const capC = c.clone().addScaledVector(n, he[1]);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, capC);
        return { point: plane.projectPoint(point, new THREE.Vector3()), normal: n, u: ax[0].clone(), v: ax[2].clone(), origin: capC, partId: p.id, curved: false };
      }
    }
    const n = normal.clone().normalize();
    const u = Math.abs(n.dot(UP)) < 0.9 ? new THREE.Vector3().crossVectors(UP, n).normalize() : new THREE.Vector3(1, 0, 0);
    const v = new THREE.Vector3().crossVectors(n, u);
    return { point: point.clone(), normal: n, u, v, origin: point.clone(), partId: p.id, curved: true };
  }

  private snapPlane(s: Surface, p: THREE.Vector3): THREE.Vector3 {
    const step = this.app.snap;
    if (!step || s.curved) return p.clone();
    const d = p.clone().sub(s.origin);
    const a = Math.round(d.dot(s.u) / step) * step;
    const b = Math.round(d.dot(s.v) / step) * step;
    return s.origin.clone().addScaledVector(s.u, a).addScaledVector(s.v, b).addScaledVector(s.normal, d.dot(s.normal));
  }

  /** corners / face centres of existing parts near the cursor */
  private vertexSnap(e: PointerEvent): THREE.Vector3 | null {
    const vp = this.app.viewport;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    let best: THREE.Vector3 | null = null;
    let bd = 12;
    const tmp = new THREE.Vector3();
    const parts = this.app.mode === 'sim' ? this.app.design.parts.map((p) => this.app.livePart(p.id)).filter((p): p is PartDef => !!p) : this.app.design.parts;
    for (const p of parts) {
      const ax = partAxes(p);
      const c = new THREE.Vector3(...p.pos);
      const he = halfExtents(p);
      const cands: THREE.Vector3[] = [];
      if (p.kind === 'box') {
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
          cands.push(c.clone().addScaledVector(ax[0], sx * he[0]).addScaledVector(ax[1], sy * he[1]).addScaledVector(ax[2], sz * he[2]));
        for (let a = 0; a < 3; a++) for (const s of [-1, 1]) cands.push(c.clone().addScaledVector(ax[a], s * he[a]));
      } else if (p.kind === 'cylinder' || p.kind === 'tube') {
        for (const s of [-1, 1]) cands.push(c.clone().addScaledVector(ax[1], s * he[1]));
      } else if (p.kind === 'sphere') {
        cands.push(c.clone().addScaledVector(UP, he[1]));
      }
      for (const q of cands) {
        // corners a saw has taken off aren't there any more
        if (p.cuts?.length && p.kind !== 'hull') {
          const l = q.clone().sub(c).applyQuaternion(new THREE.Quaternion(...p.quat).invert());
          let gone = false;
          for (let i = 0; i + 3 < p.cuts.length; i += 4) if (p.cuts[i] * l.x + p.cuts[i + 1] * l.y + p.cuts[i + 2] * l.z > p.cuts[i + 3] + 1e-6) gone = true;
          if (gone) continue;
        }
        tmp.copy(q).project(vp.camera);
        if (tmp.z > 1) continue;
        const sx = ((tmp.x + 1) / 2) * rect.width + rect.left, sy = ((1 - tmp.y) / 2) * rect.height + rect.top;
        const d = Math.hypot(sx - e.clientX, sy - e.clientY);
        if (d < bd) {
          bd = d;
          best = q;
        }
      }
    }
    return best;
  }

  private showCursor(s: Surface, p: THREE.Vector3) {
    this.cursor.visible = true;
    this.cursor.position.copy(p).addScaledVector(s.normal, 0.001);
    this.cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), s.normal);
    const k = 1 / Math.max(1, this.app.viewport.pixelsPerMetre(p) / 400);
    this.cursor.scale.setScalar(Math.max(0.6, Math.min(8, 1.4 * k)));
  }

  private showWorkGrid(s: Surface, at: THREE.Vector3) {
    const g = this.app.viewport.workGrid;
    g.visible = !(s.partId === null && s.normal.y > 0.99);
    g.position.copy(at).addScaledVector(s.normal, 0.0006);
    // plane geometry lies in local XY: map u -> x, v -> y, n -> z
    const w = new THREE.Vector3().crossVectors(s.u, s.v);
    const v = w.dot(s.normal) >= 0 ? s.v : s.v.clone().negate();
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(s.u, v, s.normal));
    const mat = g.material as THREE.ShaderMaterial;
    mat.uniforms.uMinor.value = this.app.snap >= 0.05 ? this.app.snap : 0.05;
    mat.uniforms.uMajor.value = 0.5;
  }

  // ------------------------------------------------------------------ pointer handling

  /** the part under the cursor */
  private pickPart(e: PointerEvent): { partId: string; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const h = this.app.viewport.pick(e.clientX, e.clientY);
    return h && h.partId ? { partId: h.partId, point: h.point, normal: h.normal } : null;
  }

  private onDown(e: PointerEvent) {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downButton = e.button;
    this.shift = e.shiftKey;
    if (e.button === 0 && this.app.tool === 'round' && this.app.mode === 'build' && this.edgeHover) this.edgeDragStart(e);
    if (e.button === 0 && this.app.tool === 'push' && this.app.mode === 'sim' && this.app.sim) {
      const hit = this.pickPart(e);
      if (hit) {
        const cam = new THREE.Vector3();
        this.app.viewport.camera.getWorldDirection(cam);
        this.pushPlane.setFromNormalAndCoplanarPoint(cam.negate(), hit.point);
        this.app.sim.startPush(hit.partId, hit.point);
        this.pushing = true;
      }
    }
  }

  private onUp(e: PointerEvent) {
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 5;
    if (this.edgeDrag) {
      this.edgeDragEnd();
      this.edgeHoverAt(e);
      return;
    }
    if (this.pushing) {
      this.app.sim?.endPush();
      this.pushing = false;
      this.pushLine.visible = this.pushHand.visible = false;
      this.labelA.visible = false;
      return;
    }
    if (this.downButton === 2 && !moved && this.app.tool === 'beam' && this.phase > 0) {
      this.reset();
      return;
    }
    if (this.downButton !== 0 || moved) return;
    switch (this.app.tool) {
      case 'select':
        if (this.app.mode === 'sim') return;
        for (const c of [this.app.viewport.transform, this.app.viewport.rotator])
          if (c.dragging || (c.enabled && (c as unknown as { axis: string | null }).axis)) return;
        this.app.select(this.pickPart(e)?.partId ?? null);
        return;
      case 'saw':
        this.sawClick(e);
        return;
      case 'hammer':
        this.hammerClick(e);
        return;
      case 'join':
        this.joinClick();
        return;
      case 'measure':
        this.measureClick(e);
        return;
      case 'throw':
        this.throwClick(e);
        return;
      case 'push':
        if (this.app.mode !== 'sim') toast('The hand pushes things in a running simulation: press Simulate (Space) first');
        return;
      case 'round':
        return;
    }
    if (this.app.mode === 'build') this.drawClick(e);
  }

  private onMove(e: PointerEvent) {
    this.lastEvent = e;
    this.shift = e.shiftKey;
    switch (this.app.tool) {
      case 'select': {
        if (this.app.mode === 'sim' || e.buttons) return;
        const hit = this.pickPart(e);
        this.app.setHover(hit?.partId ?? null);
        return;
      }
      case 'saw':
        if (!e.buttons) this.sawHover(e);
        return;
      case 'hammer':
        if (!e.buttons) this.hammerHover(e);
        return;
      case 'join':
        if (!e.buttons) this.joinHover(e);
        return;
      case 'measure':
        this.measureMove(e);
        return;
      case 'push':
        if (this.pushing) {
          const ray = this.app.viewport.ray(e.clientX, e.clientY);
          const pt = new THREE.Vector3();
          if (ray.intersectPlane(this.pushPlane, pt)) this.app.sim?.movePush(pt);
        } else if (!e.buttons && this.app.mode === 'sim') {
          this.app.setHover(this.pickPart(e)?.partId ?? null);
        }
        return;
      case 'throw':
        return;
      case 'round':
        if (this.edgeDrag) this.edgeDragMove(e);
        else if (!e.buttons) this.edgeHoverAt(e);
        return;
    }
    if (this.app.mode === 'build') this.drawMove(e);
  }

  // ------------------------------------------------------------------ the saw

  private clearSawSection() {
    for (const o of [this.sawFill, this.sawLine]) {
      if (!o) continue;
      o.removeFromParent();
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.sawFill = this.sawLine = null;
    this.sawKey = '';
  }

  private clearSawPreview() {
    this.sawAim = null;
    this.clearSawSection();
    if (this.sawGhost) {
      this.sawGhost.dispose();
      this.sawGhost = null;
    }
    if (this.app.tool === 'saw') this.labelA.visible = this.labelB.visible = false;
  }

  private sawHover(e: PointerEvent) {
    if (this.cutJob || (this.app.mode === 'sim' && this.app.sim?.sawing)) {
      this.clearSawPreview();
      return;
    }
    const hit = this.pickPart(e);
    const def = hit ? this.app.livePart(hit.partId) : undefined;
    if (!hit || !def) {
      this.clearSawPreview();
      this.app.setHover(null);
      return;
    }
    this.app.setHover(hit.partId);
    const cutter = cutterFor(getMaterial(def.material));
    const eye = tv(this.app.viewport.camera.position);
    const aim = aimCut(def, tv(hit.point), tv(hit.normal), { angle: this.app.saw.angle, snap: this.app.snap, kerf: cutter.kerf, eye });
    if (!aim) {
      this.clearSawPreview();
      this.labelA.visible = true;
      (this.labelA.element as HTMLElement).textContent = 'Too thin to cut here';
      this.labelA.position.copy(hit.point);
      return;
    }
    this.sawAim = { partId: hit.partId, aim, cutter };
    this.showSawPreview(aim, cutter);
  }

  private showSawPreview(aim: CutAim, cutter: Cutter) {
    const root = this.app.viewport.overlayRoot;
    const n = vt(aim.n);
    // the tool, poised at the entry point
    if (!this.sawGhost || this.sawGhost.kind !== cutter.kind) {
      this.sawGhost?.dispose();
      this.sawGhost = new SawRig(cutter.kind);
      this.sawGhost.setOpacity(0.5);
      this.root.add(this.sawGhost.group);
    }
    this.sawGhost.place(vt(aim.entry), vt(aim.line), vt(aim.feed).negate(), n);
    this.sawLabels(aim, cutter);
    const key = `${this.sawAim?.partId}|${aim.section.length}|${aim.section[0].map((v) => v.toFixed(5)).join(',')}|${aim.s.toFixed(6)}|${!!cutter.refuse}`;
    if (key === this.sawKey) return;
    this.clearSawSection();
    this.sawKey = key;
    const ref = Math.abs(n.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
    const t1 = new THREE.Vector3().crossVectors(ref, n).normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1);
    const outer = aim.section.map(vt);
    const hole = aim.hole.map(vt);
    const to2 = (p: THREE.Vector3) => new THREE.Vector2(p.dot(t1), p.dot(t2));
    let faces: number[][] = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(outer.map(to2), hole.length ? [hole.map(to2)] : []);
    } catch {
      faces = [];
    }
    const all = [...outer, ...hole];
    const pos: number[] = [];
    for (const f of faces) for (const i of f) pos.push(all[i].x, all[i].y, all[i].z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const refuse = !!cutter.refuse;
    this.sawFill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: refuse ? 0xff4d4f : 0xff8a2a, transparent: true, opacity: 0.32, depthTest: false, side: THREE.DoubleSide }));
    this.sawFill.renderOrder = 9;
    const seg: number[] = [];
    for (const loop of [outer, hole])
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        seg.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    this.sawLine = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: refuse ? 0xff6b6b : 0xffb15a, depthTest: false, transparent: true, opacity: 0.95 }));
    this.sawLine.renderOrder = 10;
    root.add(this.sawFill, this.sawLine);
  }

  /** lengths of the two pieces along the cut normal */
  private sawLabels(aim: CutAim, cutter: Cutter) {
    void cutter;
    this.labelA.visible = this.labelB.visible = true;
    (this.labelA.element as HTMLElement).textContent = fmtLen(aim.lenNeg);
    (this.labelB.element as HTMLElement).textContent = fmtLen(aim.lenPos) + (this.app.saw.angle ? `  ∠ ${this.app.saw.angle}°` : '');
    // labels sit on each piece, nudged towards the viewer so the part doesn't hide them
    const cam = this.app.viewport.camera.position;
    const put = (lab: CSS2DObject, mid: Vec3T) => {
      const p = vt(mid);
      lab.position.copy(p).addScaledVector(cam.clone().sub(p).normalize(), 0.03);
    };
    put(this.labelA, aim.midNeg);
    put(this.labelB, aim.midPos);
  }

  private sawClick(e: PointerEvent) {
    if (this.cutJob) return;
    this.sawHover(e);
    const s = this.sawAim;
    if (!s) return;
    const { partId, aim, cutter } = s;
    if (this.app.mode === 'sim') {
      const err = this.app.sim?.startSaw(partId, aim, cutter);
      if (err) toast(err);
      this.clearSawPreview();
      return;
    }
    if (cutter.refuse) {
      toast(cutter.refuse, 6000);
      return;
    }
    const def = this.app.part(partId)!;
    const real = cutSeconds(cutter, aim.area);
    const duration = cutter.kind === 'glasscutter' ? 0.6 : Math.max(0.35, Math.min(1.2, 0.25 + real * 0.08));
    const rig = new SawRig(cutter.kind);
    this.root.add(rig.group);
    if (cutter.kind === 'grinder' || cutter.kind === 'diamond') sound.grinderStart(cutter.kind === 'grinder' ? 'metal' : 'stone');
    if (cutter.kind === 'glasscutter') sound.glassScore();
    this.cutJob = { partId, aim, cutter, rig, t: 0, duration, nextFx: 0, nextStroke: 0, pose: JSON.stringify([def.pos, def.quat, def.size]) };
    this.clearSawPreview();
  }

  private updateCutJob(dt: number) {
    const j = this.cutJob;
    if (!j) return;
    j.t += dt;
    const prog = Math.min(1, j.t / j.duration);
    const a = j.aim;
    const feed = vt(a.feed), line = vt(a.line), n = vt(a.n);
    const dl = prog * a.depth;
    const edge = vt(a.entry).addScaledVector(feed, dl);
    j.rig.place(edge, line, feed.clone().negate(), n);
    j.rig.animate(dt, a.width, prog);
    if (j.t >= j.nextFx) {
      j.nextFx = j.t + 0.03;
      const c = j.cutter;
      const at = (Math.random() < 0.5 ? vt(a.entry) : edge).addScaledVector(line, (Math.random() - 0.5) * a.width * 0.8);
      const out = feed.clone().negate();
      switch (c.fx) {
        case 'sparks':
          this.fx.sparksAt(edge, 6, { color: c.color, dir: line.clone().negate().addScaledVector(out, 0.35), speed: 6 });
          break;
        case 'dust':
          this.fx.dustCloud(at, 3, c.color, 0.015, 0.5);
          break;
        case 'glitter':
          break;
        case 'crumbs':
          this.fx.debris(at, 2, c.color, 'chunk', 0.003, 0.4, out);
          break;
        case 'snow':
          this.fx.dustCloud(at, 2, c.color, 0.01, 0.2);
          break;
        default:
          this.fx.debris(at, 2, c.color, 'chip', c.fx === 'sawdust' ? 0.0035 : 0.0025, 0.5, out);
          if (c.fx === 'sawdust' && Math.random() < 0.4) this.fx.dustCloud(at, 1, c.color, 0.01, 0.12);
      }
    }
    const k = j.cutter.kind;
    if ((k === 'handsaw' || k === 'finesaw' || k === 'hacksaw' || k === 'knife') && j.t >= j.nextStroke) {
      j.nextStroke = j.t + 1 / (2 * 2.2);
      sound.sawStroke(j.cutter.fx === 'snow' ? 'snow' : k, j.rig.strokePhase() > 0);
    }
    if (prog < 1) return;
    // done: split the part
    j.rig.dispose();
    sound.grinderStop();
    this.cutJob = null;
    const def = this.app.part(j.partId);
    if (!def || JSON.stringify([def.pos, def.quat, def.size]) !== j.pose) return;
    const res = this.app.cutPart(j.partId, a, j.cutter.kerf);
    if (!res) return;
    if (j.cutter.kind === 'glasscutter') sound.glassSnap();
    const la = a.lenNeg, lb = a.lenPos;
    const kerf = j.cutter.kerf > 0 ? `, ${(j.cutter.kerf * 1000).toFixed(1)} mm kerf` : '';
    if (this.app.saw.discard) {
      this.dropGhost(res.offcut.id);
      this.app.deletePart(res.offcut.id);
      toast(`${j.cutter.verb[0].toUpperCase()}${j.cutter.verb.slice(1)} ${def.name}: kept ${fmtLen(Math.max(la, lb))}, offcut thrown away`);
    } else {
      this.app.select(res.offcut.id);
      toast(`${j.cutter.verb[0].toUpperCase()}${j.cutter.verb.slice(1)} ${def.name} into ${fmtLen(la)} + ${fmtLen(lb)}${kerf}. The offcut is selected (Del removes it).`, 3200);
    }
  }

  /** a discarded offcut tumbles away and fades */
  private dropGhost(id: string) {
    const view = this.app.views.get(id);
    if (!view) return;
    const src = view.mesh;
    const mats = (Array.isArray(src.material) ? src.material : [src.material]).map((m) => {
      const c = m.clone();
      c.transparent = true;
      return c;
    });
    const mesh = new THREE.Mesh(src.geometry.clone(), mats.length === 1 ? mats[0] : mats);
    mesh.position.copy(view.group.position);
    mesh.quaternion.copy(view.group.quaternion);
    this.root.add(mesh);
    this.ghosts.push({ mesh, v: new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.6, (Math.random() - 0.5) * 0.4), w: new THREE.Vector3(Math.random() * 3, Math.random() * 3, Math.random() * 3), t: 0 });
  }

  private updateGhosts(dt: number) {
    if (!this.ghosts.length) return;
    this.ghosts = this.ghosts.filter((g) => {
      g.t += dt;
      g.v.y -= 9.81 * dt;
      g.mesh.position.addScaledVector(g.v, dt);
      g.mesh.rotation.x += g.w.x * dt;
      g.mesh.rotation.z += g.w.z * dt;
      const a = Math.max(0, 1 - g.t / 0.7);
      for (const m of Array.isArray(g.mesh.material) ? g.mesh.material : [g.mesh.material]) m.opacity = a;
      if (g.t < 0.7) return true;
      g.mesh.removeFromParent();
      g.mesh.geometry.dispose();
      for (const m of Array.isArray(g.mesh.material) ? g.mesh.material : [g.mesh.material]) m.dispose();
      return false;
    });
  }

  // ------------------------------------------------------------------ the hammer

  private clearHammerGhost() {
    if (this.hammerGhost) {
      this.hammerGhost.dispose();
      this.hammerGhost = null;
    }
  }

  private strikeDir(e: PointerEvent, normal: THREE.Vector3): THREE.Vector3 {
    const ray = this.app.viewport.ray(e.clientX, e.clientY);
    const d = ray.direction.clone().normalize();
    // swing mostly into the face, but from where you are
    return d.multiplyScalar(0.55).addScaledVector(normal, -0.45).normalize();
  }

  private handleDir(dir: THREE.Vector3): THREE.Vector3 {
    const cam = this.app.viewport.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const h = right.multiplyScalar(0.45).addScaledVector(up, -0.9);
    h.addScaledVector(dir, -h.dot(dir));
    return h.lengthSq() > 1e-6 ? h.normalize() : up;
  }

  private hammerHover(e: PointerEvent) {
    const hit = this.pickPart(e);
    if (!hit) {
      this.clearHammerGhost();
      this.app.setHover(null);
      return;
    }
    this.app.setHover(hit.partId);
    if (!this.hammerGhost || this.hammerKind !== this.app.hammer) {
      this.clearHammerGhost();
      this.hammerGhost = new HammerRig(this.app.hammer);
      this.hammerGhost.setOpacity(0.45);
      this.hammerKind = this.app.hammer;
      this.root.add(this.hammerGhost.group);
    }
    const dir = this.strikeDir(e, hit.normal);
    this.hammerGhost.pose(hit.point, dir, this.handleDir(dir), 0.7);
  }

  private hammerClick(e: PointerEvent) {
    const hit = this.pickPart(e);
    if (!hit) return;
    const dir = this.strikeDir(e, hit.normal);
    const handle = this.handleDir(dir);
    const point = hit.point.clone();
    const id = hit.partId;
    this.clearHammerGhost();
    if (this.app.mode !== 'sim') {
      void this.app.startSim().then(() => this.app.sim?.strike(point, dir, this.app.hammer, handle, id));
      return;
    }
    this.app.sim?.strike(point, dir, this.app.hammer, handle, id);
  }

  // ------------------------------------------------------------------ throwing

  private throwClick(e: PointerEvent) {
    const ray = this.app.viewport.ray(e.clientX, e.clientY);
    if (this.app.mode !== 'sim') {
      void this.app.startSim().then(() => this.app.sim?.throwBall(ray));
      return;
    }
    this.app.sim?.throwBall(ray);
  }

  // ------------------------------------------------------------------ joining / prying

  private patches(): ContactPatch[] {
    const an = this.app.analysis;
    if (an && !this.app.analysisStale) return an.patches;
    return detectContacts(this.app.design.parts, { tol: 0.004 });
  }

  private clearMarkers() {
    for (const c of [...this.markers.children]) {
      c.removeFromParent();
      (c as THREE.Mesh).geometry?.dispose();
    }
  }

  /** a dot on every contact, coloured by its joint, while a joining tool is out */
  private updateMarkers() {
    const show = this.app.tool === 'join' && this.app.mode === 'build';
    if (!show) {
      if (this.markers.children.length) this.clearMarkers();
      return;
    }
    const key = `${this.app.design.parts.length}:${JSON.stringify(this.app.design.joints)}:${this.app.analysis?.patches.length ?? 0}:${this.app.analysisStale}`;
    if (key !== this.markersKey) {
      this.markersKey = key;
      this.clearMarkers();
      for (const p of this.patches()) {
        const a = this.app.part(p.a);
        if (!a) continue;
        const t = this.app.jointOf(a, p.b, p.b === GROUND_ID ? undefined : this.app.part(p.b));
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: JOINT_COLORS[t], depthTest: false, transparent: true, opacity: 0.9 }));
        m.position.set(...p.centroid);
        m.renderOrder = 11;
        this.markers.add(m);
      }
    }
    for (const m of this.markers.children) m.scale.setScalar(4.5 / Math.max(1, this.app.viewport.pixelsPerMetre(m.position)));
  }

  private joinHover(e: PointerEvent) {
    const hit = this.pickPart(e);
    this.joinTarget = null;
    this.joinMark.visible = false;
    this.labelA.visible = false;
    if (!hit) {
      this.app.setHover(null);
      return;
    }
    this.app.setHover(hit.partId);
    const name = (id: string) => (id === GROUND_ID ? 'the floor' : this.app.livePart(id)?.name ?? '?');
    if (this.app.mode === 'sim') {
      if (this.app.joinType !== 'rest' || !this.app.sim) return;
      let best: { d: number; b: ReturnType<NonNullable<App['sim']>['bondsOf']>[number] } | null = null;
      for (const b of this.app.sim.bondsOf(hit.partId)) {
        const d = vt(b.centroid).distanceTo(hit.point);
        if (!best || d < best.d) best = { d, b };
      }
      if (!best) {
        this.showJoinLabel(hit.point, `${name(hit.partId)} isn't joined to anything`);
        return;
      }
      const b = best.b;
      this.joinTarget = { a: b.a, b: b.b, key: b.key, current: b.joint, centroid: vt(b.centroid), bond: b.key };
      this.showJoinMark(vt(b.centroid), null, 0.03, 0xff6b6b);
      this.showJoinLabel(vt(b.centroid), `Pry ${name(b.a)} off ${name(b.b)} (${jointName(b.joint).toLowerCase()})`);
      return;
    }
    let best: { d: number; p: ContactPatch } | null = null;
    for (const p of this.patches()) {
      if (p.a !== hit.partId && p.b !== hit.partId) continue;
      let d = vt(p.centroid).distanceTo(hit.point);
      for (const q of p.points) d = Math.min(d, vt(q).distanceTo(hit.point) * 1.15);
      if (!best || d < best.d) best = { d, p };
    }
    if (!best) {
      this.showJoinLabel(hit.point, `${name(hit.partId)} doesn't touch anything`);
      return;
    }
    const p = best.p;
    const a = this.app.part(p.a)!;
    const bDef = p.b === GROUND_ID ? undefined : this.app.part(p.b);
    const cur = this.app.jointOf(a, p.b, bDef);
    this.joinTarget = { a: p.a, b: p.b, key: pairKey(p.a, p.b), current: cur, centroid: vt(p.centroid) };
    const t = this.app.joinType;
    this.showJoinMark(vt(p.centroid), p, 0, JOINT_COLORS[t]);
    const matA = getMaterial(a.material), matB = bDef ? getMaterial(bDef.material) : GROUND_MATERIAL;
    let what = `${name(p.a)} ↔ ${name(p.b)}: ${jointName(cur).toLowerCase()}`;
    if (t !== cur) {
      what += ` → ${jointName(t).toLowerCase()}`;
      const cap = jointCapacity(t, p.area, matA, matB);
      if (t === 'weld' && cap.type !== 'weld') what += ' (needs metal on both sides)';
      else if (t !== 'rest' && t !== 'rigid') what += ` (holds ${fmtForce(cap.tension)} pull, ${fmtForce(cap.shear)} shear)`;
    }
    this.showJoinLabel(vt(p.centroid), what);
  }

  private showJoinMark(at: THREE.Vector3, p: ContactPatch | null, size: number, color: number) {
    const m = this.joinMark;
    (m.material as THREE.MeshBasicMaterial).color.setHex(color);
    m.position.copy(at);
    if (p) {
      const n = vt(p.normal), e1 = vt(p.axes[0]), e2 = vt(p.axes[1]);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(e1, e2, n));
      m.scale.set(Math.max(0.01, p.extent[0]), Math.max(0.01, p.extent[1]), 1);
      m.position.addScaledVector(n, 0.002);
    } else {
      m.quaternion.copy(this.app.viewport.camera.quaternion);
      m.scale.set(size, size, 1);
    }
    m.visible = true;
  }

  private showJoinLabel(at: THREE.Vector3, text: string) {
    this.labelA.visible = true;
    (this.labelA.element as HTMLElement).textContent = text;
    this.labelA.position.copy(at);
  }

  private joinClick() {
    const t = this.joinTarget;
    if (!t) return;
    const name = (id: string) => (id === GROUND_ID ? 'the floor' : this.app.livePart(id)?.name ?? '?');
    if (this.app.mode === 'sim') {
      if (!t.bond || !this.app.sim) return;
      const err = this.app.sim.breakBond(t.bond);
      if (err) toast(err);
      this.joinTarget = null;
      this.joinMark.visible = false;
      this.labelA.visible = false;
      return;
    }
    const type = this.app.joinType;
    const a = this.app.part(t.a)!;
    const b = t.b === GROUND_ID ? undefined : this.app.part(t.b);
    if (type === 'weld') {
      const metal = (m: string) => getMaterial(m).category === 'Metal';
      if (!metal(a.material) || (b ? !metal(b.material) : true)) {
        toast(`Welding needs metal on both sides: ${name(t.a)} is ${getMaterial(a.material).name.toLowerCase()}${b ? `, ${name(t.b)} is ${getMaterial(b.material).name.toLowerCase()}` : ', and the floor is concrete'}`, 4000);
        return;
      }
    }
    if (t.current === type) {
      toast(`${name(t.a)} and ${name(t.b)} are already ${jointName(type).toLowerCase()}`);
      return;
    }
    this.app.setJoint(t.a, t.b, type);
    sound.join(type);
    const c = t.centroid;
    switch (type) {
      case 'glue':
        this.fx.debris(c, 8, '#e9c46a', 'chip', 0.004, 0.35);
        break;
      case 'screw':
      case 'bolt':
        this.fx.debris(c, 6, '#c0c7d2', 'chip', 0.003, 0.5);
        break;
      case 'weld':
        this.fx.sparksAt(c, 40);
        this.fx.dustCloud(c, 6, '#5a5d63', 0.03, 0.25);
        break;
      case 'rest':
        this.fx.dustCloud(c, 5, '#cfc6b4', 0.03, 0.25);
        break;
    }
    const verb: Record<JointType, string> = { rest: 'separated (now just resting)', glue: 'glued', screw: 'screwed together', bolt: 'bolted together', weld: 'welded', rigid: 'locked together' };
    toast(`${name(t.a)} and ${name(t.b)} ${verb[type]}`);
    this.markersKey = '';
  }

  // ------------------------------------------------------------------ rounding edges

  private edgeName(def: PartDef, target: EdgeTarget, up: number, all: boolean): string {
    const q = new THREE.Quaternion(...def.quat);
    const upW = new THREE.Vector3(up === 0 ? 1 : 0, up === 1 ? 1 : 0, up === 2 ? 1 : 0).applyQuaternion(q);
    const vertical = Math.abs(upW.y) > 0.7;
    if (target.kind === 'corner') {
      if (vertical) return all ? 'All four corners' : 'This corner';
      return all ? 'All four long edges' : 'This long edge';
    }
    if (vertical) return (upW.y > 0) === (target.side === 'top') ? 'Top edge (all round)' : 'Bottom edge (all round)';
    return 'End edge (all round)';
  }

  private edgeText(v: number): string {
    if (Math.abs(v) < 1e-6) return 'square';
    return v > 0 ? `round ${fmtLen(v)}` : `bevel ${fmtLen(-v)}`;
  }

  /** highlight the edge (or edges) the tool would change */
  private showEdgeLines(def: PartDef, target: EdgeTarget, up: number, all: boolean) {
    const g = roundGeom({ ...def, edge: def.edge && def.edge.up === up ? def.edge : { up } });
    const segs: number[] = [];
    const W = (u: number, v: number, t: number) => {
      const p = [0, 0, 0];
      p[g.ua] = u;
      p[g.va] = v;
      p[g.up] = t;
      return toWorld(def, p[0], p[1], p[2]);
    };
    if (target.kind === 'corner') {
      for (const i of all ? [0, 1, 2, 3] : [target.index]) {
        const su = i & 1 ? 1 : -1, sv = i & 2 ? 1 : -1;
        const R = g.R[i];
        // the middle of the corner as it is now
        let pu = su * g.hu, pv = sv * g.hv;
        if (R > 0) {
          pu = su * (g.hu - R + R * Math.SQRT1_2);
          pv = sv * (g.hv - R + R * Math.SQRT1_2);
        } else if (R < 0) {
          pu = su * (g.hu + R / 2);
          pv = sv * (g.hv + R / 2);
        }
        segs.push(...W(pu, pv, -g.h), ...W(pu, pv, g.h));
      }
    } else {
      const sg = target.side === 'top' ? 1 : -1;
      const r = target.side === 'top' ? g.rt : g.rb;
      // the middle of the rim as it is now
      const k = r > 0 ? r * (1 - Math.SQRT1_2) : r < 0 ? -r / 2 : 0;
      const ring = planRing(g, -k, 8);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        segs.push(...W(a[0], a[1], sg * (g.h - k)), ...W(b[0], b[1], sg * (g.h - k)));
      }
    }
    const geo = this.edgeLines.geometry as THREE.BufferGeometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    geo.computeBoundingSphere();
    this.edgeLines.visible = true;
  }

  private clearEdgeHover() {
    this.edgeHover = null;
    this.edgeLines.visible = false;
    if (this.app.tool === 'round') this.labelA.visible = false;
  }

  private edgeHoverAt(e: PointerEvent) {
    const hit = this.pickPart(e);
    const def = hit ? this.app.part(hit.partId) : undefined;
    if (!hit || !def || this.app.mode !== 'build') {
      this.clearEdgeHover();
      this.app.setHover(null);
      return;
    }
    this.app.setHover(hit.partId);
    if (def.kind !== 'box' && def.kind !== 'cylinder') {
      this.clearEdgeHover();
      this.showJoinLabel(hit.point, 'Edges can be rounded on boxes and cylinders');
      return;
    }
    const lp = toLocal(def, hit.point.x, hit.point.y, hit.point.z);
    const ne = nearestEdge(def, lp);
    if (ne.dist * this.app.viewport.pixelsPerMetre(hit.point) > 80) {
      this.clearEdgeHover();
      this.showJoinLabel(hit.point, 'Move nearer an edge');
      return;
    }
    const all = ne.target.kind === 'corner' && this.app.edgeTool.allCorners !== e.shiftKey;
    this.edgeHover = { partId: def.id, target: ne.target, up: ne.up };
    this.showEdgeLines(def, ne.target, ne.up, all);
    this.showJoinLabel(hit.point, `${this.edgeName(def, ne.target, ne.up, all)}: ${this.edgeText(edgeValue(def, ne.target, ne.up))}. Drag in to ${this.app.edgeTool.bevel ? 'bevel' : 'round'} it`);
  }

  private edgeDragStart(e: PointerEvent): boolean {
    const hv = this.edgeHover;
    const hit = this.pickPart(e);
    if (!hv || !hit || hit.partId !== hv.partId) return false;
    const def = this.app.part(hv.partId);
    if (!def) return false;
    const g0 = roundGeom({ ...def, edge: { up: hv.up } });
    const lp = toLocal(def, hit.point.x, hit.point.y, hit.point.z);
    const q = new THREE.Quaternion(...def.quat);
    const axisW = (i: number) => new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyQuaternion(q);
    const eu = axisW(g0.ua), ev = axisW(g0.va), eup = axisW(g0.up);
    const lc = [...lp];
    let bis: THREE.Vector3, pn: THREE.Vector3;
    if (hv.target.kind === 'corner') {
      const su = hv.target.index & 1 ? 1 : -1, sv = hv.target.index & 2 ? 1 : -1;
      lc[g0.ua] = su * g0.hu;
      lc[g0.va] = sv * g0.hv;
      bis = eu.clone().multiplyScalar(-su).addScaledVector(ev, -sv).normalize();
      pn = eup.clone();
    } else {
      const sg = hv.target.side === 'top' ? 1 : -1;
      const u = lp[g0.ua], v = lp[g0.va];
      let nPlan: THREE.Vector3;
      if (g0.circle) {
        const r = Math.hypot(u, v) || 1;
        lc[g0.ua] = (u / r) * g0.Rc;
        lc[g0.va] = (v / r) * g0.Rc;
        nPlan = eu.clone().multiplyScalar(u / r).addScaledVector(ev, v / r).normalize();
      } else if (g0.hu - Math.abs(u) < g0.hv - Math.abs(v)) {
        lc[g0.ua] = Math.sign(u || 1) * g0.hu;
        nPlan = eu.clone().multiplyScalar(Math.sign(u || 1));
      } else {
        lc[g0.va] = Math.sign(v || 1) * g0.hv;
        nPlan = ev.clone().multiplyScalar(Math.sign(v || 1));
      }
      lc[g0.up] = sg * g0.h;
      bis = nPlan.clone().negate().addScaledVector(eup, -sg).normalize();
      pn = new THREE.Vector3().crossVectors(nPlan, eup).normalize();
    }
    const C = vt(toWorld(def, lc[0], lc[1], lc[2]));
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(pn, C);
    const P0 = new THREE.Vector3();
    if (!this.app.viewport.ray(e.clientX, e.clientY).intersectPlane(plane, P0)) P0.copy(hit.point);
    this.edgeDrag = {
      partId: def.id, target: hv.target, up: hv.up, plane, C, bis,
      d0: P0.clone().sub(C).dot(bis), v0: Math.abs(edgeValue(def, hv.target, hv.up)), limit: edgeLimit(def, hv.target, hv.up),
    };
    return true;
  }

  private edgeDragMove(e: PointerEvent) {
    const dr = this.edgeDrag!;
    const def = this.app.part(dr.partId);
    if (!def) return;
    const P = new THREE.Vector3();
    if (!this.app.viewport.ray(e.clientX, e.clientY).intersectPlane(dr.plane, P)) return;
    const bevel = this.app.edgeTool.bevel;
    // pushing the edge in by d moves a round's middle by d: radius = d / (sqrt2 - 1); a bevel's by c / sqrt2
    const k = bevel ? Math.SQRT2 : 1 / (Math.SQRT2 - 1);
    let val = Math.max(0, Math.min(dr.limit, dr.v0 + (P.clone().sub(dr.C).dot(dr.bis) - dr.d0) * k));
    const step = this.app.snap >= 0.01 ? 0.005 : this.app.snap;
    if (step > 0) val = Math.min(dr.limit, Math.round(val / step) * step);
    const all = dr.target.kind === 'corner' && this.app.edgeTool.allCorners !== e.shiftKey;
    const edge = withEdge(def, dr.target, dr.up, bevel ? -val : val, all);
    this.app.setEdge(def.id, edge, false);
    const now = this.app.part(dr.partId)!;
    this.showEdgeLines(now, dr.target, dr.up, all);
    this.showJoinLabel(dr.C, `${this.edgeName(now, dr.target, dr.up, all)}: ${this.edgeText(bevel ? -val : val)}`);
  }

  private edgeDragEnd() {
    if (!this.edgeDrag) return;
    this.edgeDrag = null;
    this.app.commit('Round edge');
  }

  // ------------------------------------------------------------------ tape measure

  private measurePoint(e: PointerEvent): THREE.Vector3 | null {
    const vs = this.vertexSnap(e);
    if (vs) {
      this.snapMarker.visible = true;
      this.snapMarker.position.copy(vs);
      return vs;
    }
    this.snapMarker.visible = false;
    const hit = this.pickPart(e);
    if (hit) return hit.point.clone();
    const ray = this.app.viewport.ray(e.clientX, e.clientY);
    const pt = new THREE.Vector3();
    return ray.intersectPlane(new THREE.Plane(UP, 0), pt) ? pt : null;
  }

  private makeMeasure(a: THREE.Vector3, b: THREE.Vector3): Measurement {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xffd34f, depthTest: false }));
    line.renderOrder = 12;
    const ends = [a, b].map((p) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd34f, depthTest: false }));
      m.position.copy(p);
      m.renderOrder = 12;
      return m;
    });
    const lab = label('', 'dim-label measure-label');
    this.app.viewport.overlayRoot.add(line, lab, ...ends);
    const m = { line, label: lab, ends };
    this.setMeasure(m, a, b);
    return m;
  }

  private setMeasure(m: Measurement, a: THREE.Vector3, b: THREE.Vector3) {
    (m.line.geometry as THREE.BufferGeometry).setFromPoints([a, b]);
    m.ends[0].position.copy(a);
    m.ends[1].position.copy(b);
    const d = b.clone().sub(a);
    const parts = [['x', d.x], ['y', d.y], ['z', d.z]].filter(([, v]) => Math.abs(v as number) > 0.0005).map(([k, v]) => `${k} ${fmtLen(Math.abs(v as number))}`);
    (m.label.element as HTMLElement).textContent = `${fmtLen(d.length())}${parts.length > 1 ? `  (${parts.join(', ')})` : ''}`;
    m.label.position.copy(a).add(b).multiplyScalar(0.5);
  }

  private disposeMeasure(m: Measurement) {
    m.line.removeFromParent();
    m.line.geometry.dispose();
    m.label.removeFromParent();
    m.label.element.remove();
    for (const e of m.ends) {
      e.removeFromParent();
      e.geometry.dispose();
    }
  }

  private clearLive() {
    if (this.live) this.disposeMeasure(this.live);
    this.live = null;
  }

  private clearMeasures() {
    for (const m of this.measures) this.disposeMeasure(m);
    this.measures = [];
  }

  private measureMove(e: PointerEvent) {
    const p = this.measurePoint(e);
    if (!p || !this.mA) return;
    if (!this.live) this.live = this.makeMeasure(this.mA, p);
    else this.setMeasure(this.live, this.mA, p);
  }

  private measureClick(e: PointerEvent) {
    const p = this.measurePoint(e);
    if (!p) return;
    if (!this.mA) {
      this.mA = p;
      this.app.emit('settings');
      return;
    }
    this.clearLive();
    if (p.distanceTo(this.mA) > 1e-5) this.measures.push(this.makeMeasure(this.mA, p));
    if (this.measures.length > 12) this.disposeMeasure(this.measures.shift()!);
    this.mA = null;
    this.app.emit('settings');
  }

  // ------------------------------------------------------------------ drawing

  private planeHit(e: PointerEvent, s: Surface, normal: THREE.Vector3, through: THREE.Vector3): THREE.Vector3 | null {
    const ray = this.app.viewport.ray(e.clientX, e.clientY);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
    const pt = new THREE.Vector3();
    void s;
    return ray.intersectPlane(plane, pt) ? pt : null;
  }

  /** height along the surface normal from a camera-facing plane through `from` */
  private heightFrom(e: PointerEvent, s: Surface, from: THREE.Vector3): number {
    const cam = this.app.viewport.camera;
    const camDir = new THREE.Vector3();
    cam.getWorldDirection(camDir);
    let m = camDir.clone().addScaledVector(s.normal, -camDir.dot(s.normal));
    if (m.lengthSq() < 1e-6) m = s.u.clone();
    m.normalize();
    const pt = this.planeHit(e, s, m, from);
    if (!pt) return this.height;
    let h = pt.sub(from).dot(s.normal);
    const step = this.app.snap;
    if (step) h = Math.round(h / step) * step;
    if (s.partId === null && s.normal.y > 0.99 && this.app.workElevation <= 0) h = Math.max(h, step || 0.005);
    if (Math.abs(h) < 0.002) h = h < 0 ? -0.002 : 0.002;
    // snap to meet a part above (or below): a support drawn under a slab touches it
    const meet = this.surfaceAlong(this.footprintCenter(s), s.normal.clone().multiplyScalar(Math.sign(h) || 1));
    if (meet !== null && Math.abs(Math.abs(h) - meet) < Math.max(0.02, 0.04 * meet)) {
      h = (Math.sign(h) || 1) * meet;
      this.heightSnapped = true;
    } else this.heightSnapped = false;
    return h;
  }

  heightSnapped = false;

  private footprintCenter(s: Surface): THREE.Vector3 {
    if (this.app.tool === 'box') return this.A.clone().add(this.B).multiplyScalar(0.5).addScaledVector(s.normal, 0.0005);
    return this.A.clone().addScaledVector(s.normal, 0.0005);
  }

  /** distance along dir from p to the first part surface, or null */
  private surfaceAlong(p: THREE.Vector3, dir: THREE.Vector3): number | null {
    const rc = new THREE.Raycaster(p, dir.clone().normalize(), 0.001, 20);
    const hits = rc.intersectObjects(this.app.viewport.partsRoot.children, true);
    for (const h of hits) if ((h.object as THREE.Mesh).isMesh) return h.distance;
    return null;
  }

  private drawMove(e: PointerEvent) {
    const t = this.app.tool;
    if (this.phase === 0) {
      const s = this.surfaceAt(e);
      if (!s) {
        this.cursor.visible = false;
        return;
      }
      let p = this.snapPlane(s, s.point);
      const vs = t === 'beam' || t === 'box' ? this.vertexSnap(e) : null;
      if (vs) {
        p = vs.clone();
        this.snapMarker.visible = true;
        this.snapMarker.position.copy(vs);
      } else this.snapMarker.visible = false;
      this.showCursor(s, p);
      return;
    }
    const s = this.surf!;
    if (t === 'box' || t === 'cylinder' || t === 'sphere') {
      if (this.phase === 1) {
        const pt = this.planeHit(e, s, s.normal, this.A);
        if (!pt) return;
        this.B.copy(this.snapPlane(s, pt));
        this.updateShapePreview();
      } else if (this.phase === 2) {
        this.height = this.heightFrom(e, s, this.B);
        this.updateShapePreview();
      }
      return;
    }
    if (t === 'beam') {
      let p: THREE.Vector3 | null = null;
      const vs = this.vertexSnap(e);
      if (vs) {
        p = vs.clone();
        this.snapMarker.visible = true;
        this.snapMarker.position.copy(vs);
      } else {
        this.snapMarker.visible = false;
        const hs = this.surfaceAt(e);
        if (hs) p = this.snapPlane(hs, hs.point);
        // if nothing better, use a camera-facing plane through A (lets beams go up in the air)
        if (this.shift || !hs || (hs.partId === null && hs.normal.y > 0.99)) {
          const cam = this.app.viewport.camera;
          const dir = new THREE.Vector3();
          cam.getWorldDirection(dir);
          const n = new THREE.Vector3(dir.x, 0, dir.z).normalize();
          const q = this.planeHit(e, s, n.lengthSq() > 0 ? n : new THREE.Vector3(0, 0, 1), this.A);
          if (this.shift && q) p = q;
          else if (!p && q) p = q;
        }
      }
      if (!p) return;
      if (this.shift) p = this.axisLock(this.A, p);
      if (this.app.snap && !vs) {
        const d = p.clone().sub(this.A);
        const L = d.length();
        const Ls = Math.round(L / this.app.snap) * this.app.snap;
        if (L > 1e-6) p = this.A.clone().addScaledVector(d.normalize(), Ls);
      }
      this.B.copy(p);
      this.updateBeamPreview();
    }
  }

  private axisLock(a: THREE.Vector3, p: THREE.Vector3): THREE.Vector3 {
    const d = p.clone().sub(a);
    const ax = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)];
    const i = ax.indexOf(Math.max(...ax));
    const out = a.clone();
    out.setComponent(i, p.getComponent(i));
    return out;
  }

  private drawClick(e: PointerEvent) {
    const t = this.app.tool;
    if (this.phase === 0) {
      const s = this.surfaceAt(e);
      if (!s) return;
      this.surf = s;
      const vs = t === 'beam' || t === 'box' ? this.vertexSnap(e) : null;
      this.A.copy(vs ?? this.snapPlane(s, s.point));
      this.B.copy(this.A);
      this.height = 0;
      this.phase = 1;
      this.cursor.visible = false;
      this.showWorkGrid(s, this.A);
      if (t === 'beam') this.updateBeamPreview();
      else this.updateShapePreview();
      this.app.emit('settings');
      return;
    }
    if (t === 'beam') {
      if (this.B.distanceTo(this.A) < 0.01) return;
      this.commitBeam();
      this.A.copy(this.B);
      this.updateBeamPreview();
      return;
    }
    if (this.phase === 1) {
      const s = this.surf!;
      const d = this.B.clone().sub(this.A);
      const span = t === 'box' ? Math.min(Math.abs(d.dot(s.u)), Math.abs(d.dot(s.v))) : d.length();
      if (span < 0.003) return;
      if (t === 'sphere') {
        this.commitShape();
        return;
      }
      this.phase = 2;
      this.height = this.app.snap || 0.01;
      this.updateShapePreview();
      this.app.emit('settings');
      return;
    }
    if (this.phase === 2) this.commitShape();
  }

  private shapeParams(): { def: Omit<PartDef, 'id' | 'name'>; kind: 'box' | 'cylinder' | 'sphere' } | null {
    const s = this.surf!;
    const t = this.app.tool;
    const w = new THREE.Vector3().crossVectors(s.u, s.normal);
    if (t === 'box') {
      const d = this.B.clone().sub(this.A);
      const a = d.dot(s.u), b = d.dot(w);
      const h = this.phase >= 2 ? this.height : 0.002;
      const center = this.A.clone().addScaledVector(s.u, a / 2).addScaledVector(w, b / 2).addScaledVector(s.normal, h / 2);
      return {
        kind: 'box',
        def: {
          kind: 'box', size: [Math.max(0.002, Math.abs(a)), Math.max(0.002, Math.abs(h)), Math.max(0.002, Math.abs(b))],
          pos: [center.x, center.y, center.z], quat: quatFromBasis(s.u, s.normal, w), material: this.app.activeMaterial,
        },
      };
    }
    const r = Math.max(0.002, this.B.clone().sub(this.A).length());
    if (t === 'cylinder') {
      const h = this.phase >= 2 ? this.height : 0.002;
      const center = this.A.clone().addScaledVector(s.normal, h / 2);
      return {
        kind: 'cylinder',
        def: { kind: 'cylinder', size: [2 * r, Math.max(0.002, Math.abs(h)), 2 * r], pos: [center.x, center.y, center.z], quat: quatFromBasis(s.u, s.normal, w), material: this.app.activeMaterial },
      };
    }
    const center = this.A.clone().addScaledVector(s.normal, r);
    return { kind: 'sphere', def: { kind: 'sphere', size: [2 * r, 2 * r, 2 * r], pos: [center.x, center.y, center.z], quat: [0, 0, 0, 1], material: this.app.activeMaterial } };
  }

  private updateShapePreview() {
    const sp = this.shapeParams();
    if (!sp) return;
    const d = sp.def;
    let geo: THREE.BufferGeometry;
    if (d.kind === 'box') geo = new THREE.BoxGeometry(d.size[0], d.size[1], d.size[2]);
    else if (d.kind === 'cylinder') geo = new THREE.CylinderGeometry(d.size[0] / 2, d.size[0] / 2, d.size[1], 40);
    else geo = new THREE.SphereGeometry(d.size[0] / 2, 32, 20);
    this.setPreview(geo, new THREE.Vector3(...d.pos), new THREE.Quaternion(...d.quat));
    const c = new THREE.Vector3(...d.pos);
    this.labelA.visible = true;
    if (d.kind === 'box') {
      (this.labelA.element as HTMLElement).textContent = `${fmtLen(d.size[0])} × ${fmtLen(d.size[2])}`;
      this.labelA.position.copy(this.B);
      this.labelB.visible = this.phase >= 2;
      (this.labelB.element as HTMLElement).textContent = `h ${fmtLen(this.height)}${this.heightSnapped ? ' • touches' : ''}`;
      this.labelB.position.copy(c).addScaledVector(this.surf!.normal, d.size[1] / 2 + 0.02);
    } else if (d.kind === 'cylinder') {
      (this.labelA.element as HTMLElement).textContent = `Ø ${fmtLen(d.size[0])}`;
      this.labelA.position.copy(this.B);
      this.labelB.visible = this.phase >= 2;
      (this.labelB.element as HTMLElement).textContent = `h ${fmtLen(this.height)}${this.heightSnapped ? ' • touches' : ''}`;
      this.labelB.position.copy(c).addScaledVector(this.surf!.normal, d.size[1] / 2 + 0.02);
    } else {
      (this.labelA.element as HTMLElement).textContent = `Ø ${fmtLen(d.size[0])}`;
      this.labelA.position.copy(c).add(new THREE.Vector3(0, d.size[0] / 2 + 0.03, 0));
      this.labelB.visible = false;
    }
  }

  private beamDef(): Omit<PartDef, 'id' | 'name'> | null {
    const d = this.B.clone().sub(this.A);
    const L = d.length();
    if (L < 0.005) return null;
    const y = d.clone().normalize();
    let x = new THREE.Vector3().crossVectors(y, UP);
    if (x.lengthSq() < 1e-6) x = new THREE.Vector3(1, 0, 0);
    x.normalize();
    const z = new THREE.Vector3().crossVectors(x, y).normalize();
    const c = this.A.clone().add(this.B).multiplyScalar(0.5);
    const bs = this.app.beamSection;
    if (bs.shape === 'rect') {
      return { kind: 'box', size: [bs.w, L, bs.h], pos: [c.x, c.y, c.z], quat: quatFromBasis(x, y, z), material: this.app.activeMaterial };
    }
    return {
      kind: bs.shape === 'pipe' ? 'tube' : 'cylinder', size: [bs.d, L, bs.d], wall: bs.shape === 'pipe' ? bs.wall : undefined,
      pos: [c.x, c.y, c.z], quat: quatFromBasis(x, y, z), material: this.app.activeMaterial,
    };
  }

  private updateBeamPreview() {
    const line = this.line;
    (line.geometry as THREE.BufferGeometry).setFromPoints([this.A, this.B]);
    line.computeLineDistances();
    line.visible = true;
    const d = this.beamDef();
    if (d) {
      const geo = d.kind === 'box' ? new THREE.BoxGeometry(d.size[0], d.size[1], d.size[2]) : new THREE.CylinderGeometry(d.size[0] / 2, d.size[0] / 2, d.size[1], 24);
      this.setPreview(geo, new THREE.Vector3(...d.pos), new THREE.Quaternion(...d.quat));
      this.labelA.visible = true;
      (this.labelA.element as HTMLElement).textContent = fmtLen(this.B.distanceTo(this.A));
      this.labelA.position.copy(this.A).add(this.B).multiplyScalar(0.5);
    } else {
      this.clearPreview();
      this.labelA.visible = false;
    }
  }

  private commitShape() {
    const sp = this.shapeParams();
    this.reset();
    if (!sp) return;
    this.app.addPart(sp.def, sp.kind);
  }

  private commitBeam() {
    const d = this.beamDef();
    if (!d) return;
    this.app.addPart(d, 'beam');
    // keep the tool active for chaining
    this.app.select(null);
  }

  // ------------------------------------------------------------------ per frame

  /** called each frame: keeps previews in sync with the camera (and moving parts), runs tool animations */
  update(dt = 1 / 60) {
    const t = this.app.tool;
    const e = this.lastEvent;
    if (this.phase > 0 && e && (t === 'box' || t === 'cylinder' || t === 'sphere' || t === 'beam')) this.drawMove(e);
    if (e && !e.buttons && !this.cutJob) {
      // the scene moves under a still cursor while simulating; keep the aim on it
      if (t === 'saw' && (this.app.mode === 'sim' || this.sawAim)) this.sawHover(e);
      else if (t === 'hammer' && this.hammerGhost && this.app.mode === 'sim') this.hammerHover(e);
    }
    this.updateCutJob(dt);
    this.updateGhosts(dt);
    this.updateMarkers();
    this.fx.update(dt, this.app.viewport.renderer.domElement.clientHeight);
    // the push line
    const info = this.pushing ? this.app.sim?.pushInfo() : null;
    if (info) {
      (this.pushLine.geometry as THREE.BufferGeometry).setFromPoints([info.point, info.target]);
      this.pushLine.visible = true;
      this.pushHand.visible = true;
      this.pushHand.position.copy(info.target);
      this.pushHand.scale.setScalar(5 / Math.max(1, this.app.viewport.pixelsPerMetre(info.target)));
      this.labelA.visible = true;
      (this.labelA.element as HTMLElement).textContent = fmtForce(info.force);
      this.labelA.position.copy(info.target);
    }
    // measuring markers keep a constant screen size
    for (const m of [...this.measures, ...(this.live ? [this.live] : [])])
      for (const s of m.ends) s.scale.setScalar(3.5 / Math.max(1, this.app.viewport.pixelsPerMetre(s.position)));
  }

  get activeTool(): Tool {
    return this.app.tool;
  }

  get drawing(): boolean {
    return this.phase > 0;
  }

  /** a workshop tool is busy (an animation is running) */
  get busy(): boolean {
    return !!this.cutJob;
  }

  get actionTool(): boolean {
    return ACTION_TOOLS.includes(this.app.tool);
  }
}

export type { Vec3T };
