import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { App } from '../app';
import { sound } from '../audio/sound';
import { detectContacts, groundPatch, patchBetween, type ContactPatch } from '../core/contacts';
import { cutPart, cutSeconds, ligament, type CutAim, type Cutter } from '../core/cut';
import { GROUND_ID, newId, pairKey, type JointType, type PartDef, type Vec3T } from '../core/design';
import { getMaterial, GROUND_MATERIAL, type Material } from '../core/materials';
import { boundingRadius, clippedPolytope, halfExtents, innerRadius, isShaped, toLocal, volume } from '../core/shapes';
import type { FailMode } from '../fea/analyze';
import { beamLocalK, matVec12, vecToLocal12 } from '../fea/beam';
import { classifyPart, type FEPartInfo } from '../fea/model';
import { analyzeStructure, MODE_LABEL, type StructureResult } from '../fea/structure';
import { makeDeformField, type DeformField } from '../render/deform';
import { PartView } from '../render/partMesh';
import { Particles } from '../render/particles';
import { HAMMERS, HammerRig, SawRig, type HammerKind, type HammerSpec } from '../tools/rigs';
import { fracture, resetPieceNames } from './fracture';

let rapierReady: Promise<void> | null = null;
function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const H = 1 / 120;
const WORLD = '__world__';

interface SimBody {
  rb: RAPIER.RigidBody;
  parts: Set<string>;
  world: boolean;
  vPrev: THREE.Vector3;
  wPrev: THREE.Vector3;
  mass: number;
  radius: number;
}

interface SimPart {
  def: PartDef;
  mat: Material;
  body: SimBody;
  lp: THREE.Vector3;
  lq: THREE.Quaternion;
  collider: RAPIER.Collider | null;
  view: PartView;
  debris: boolean;
  alive: boolean;
  pending: boolean;
  yielded: boolean;
  bornAt: number;
}

interface Bond {
  key: string;
  a: string;
  b: string;
  joint: JointType;
  /** patch in a's local frame */
  pts: Vec3T[];
  normal: Vec3T;
  centroid: Vec3T;
  area: number;
  center: number;
  embedded: boolean;
  extent: [number, number];
  axes: [Vec3T, Vec3T];
}

interface Hinge {
  joint: RAPIER.ImpulseJoint;
  a: string;
  b: string;
  Mp: number;
  maxAngle: number;
  q0: THREE.Quaternion;
}

interface Pending {
  at: number;
  partId: string;
  kind: 'member' | 'joint' | 'bearing';
  mode: FailMode;
  U: number;
  a: number;
  b: number;
  dir: number;
  local: Vec3T;
  bondKey?: string;
  crushAxis?: number;
  crushSign?: number;
  message: string;
  kick?: THREE.Vector3;
}

interface Anim {
  start: number;
  end: number;
  fields: Map<string, { field: DeformField; target: number }>;
}

/** internal forces where a member is being sawn, for checking the shrinking ligament */
interface LigamentCheck {
  /** local axis indices of the member's section frame */
  e2: number;
  e3: number;
  N: number;
  My: number;
  Mz: number;
  V: number;
  ft: number;
  fc: number;
  fm: number;
  fv: number;
  ductile: boolean;
}

interface SawJob {
  partId: string;
  cutter: Cutter;
  nl: Vec3T;
  sl: number;
  entryL: Vec3T;
  feedL: Vec3T;
  lineL: Vec3T;
  depth: number;
  width: number;
  area: number;
  start: number;
  duration: number;
  rig: SawRig;
  nextFx: number;
  nextStroke: number;
  nextCheck: number;
  lig: LigamentCheck | null;
  creaked: boolean;
  lastU: number;
  lastT: number;
}

interface StrikeJob {
  rig: HammerRig;
  spec: HammerSpec;
  point: THREE.Vector3;
  dir: THREE.Vector3;
  handle: THREE.Vector3;
  start: number;
  headId: string | null;
  target: string;
}

interface PushState {
  partId: string;
  local: Vec3T;
  target: THREE.Vector3;
  point: THREE.Vector3;
  force: THREE.Vector3;
  nextCheck: number;
}

/** what a workshop tool needs to know about a joint in the running simulation */
export interface LiveBond {
  key: string;
  a: string;
  b: string;
  joint: JointType;
  centroid: Vec3T;
}

const PUSH_MAX = 600;

const v3 = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y, v.z);
const q4 = (q: { x: number; y: number; z: number; w: number }) => new THREE.Quaternion(q.x, q.y, q.z, q.w);

function rotVec(q: [number, number, number, number], v: Vec3T): Vec3T {
  const r = new THREE.Vector3(...v).applyQuaternion(new THREE.Quaternion(...q));
  return [r.x, r.y, r.z];
}

export class Simulation {
  readonly app: App;
  readonly world: RAPIER.World;
  private queue: RAPIER.EventQueue;
  private parts = new Map<string, SimPart>();
  private bodies = new Map<number, SimBody>();
  private colliderPart = new Map<number, string>();
  private groundCollider: RAPIER.Collider;
  private worldBody: SimBody;
  private bonds = new Map<string, Bond>();
  private hinges: Hinge[] = [];
  private pending: Pending[] = [];
  private anims: Anim[] = [];
  private particles = new Particles();
  private acc = 0;
  private nextCheck = 0.25;
  private signatures = new Map<string, string>();
  private impactBudget = 0;
  private debrisCount = 0;
  private lastImpactLog = new Map<string, number>();
  private colorFields = new Map<string, DeformField>();
  private disposed = false;
  private saw: SawJob | null = null;
  private strikes: StrikeJob[] = [];
  private push: PushState | null = null;
  paused = false;
  timeScale = 1;
  time = 0;

  constructor(app: App) {
    this.app = app;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = H;
    this.world.numSolverIterations = 8;
    this.queue = new RAPIER.EventQueue(true);
    const groundRb = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.groundCollider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(GROUND_MATERIAL.friction).setRestitution(0.1),
      groundRb,
    );
    this.worldBody = { rb: groundRb, parts: new Set(), world: true, vPrev: new THREE.Vector3(), wPrev: new THREE.Vector3(), mass: Infinity, radius: 0 };
    app.viewport.fxRoot.add(this.particles.root);
  }

  // ------------------------------------------------------------------ setup

  start() {
    resetPieceNames();
    const app = this.app;
    const defs = app.design.parts.map((p) => JSON.parse(JSON.stringify(p)) as PartDef);
    // reuse the build views
    for (const d of defs) {
      let view = app.views.get(d.id);
      if (!view) {
        view = new PartView(d);
        app.views.set(d.id, view);
        app.viewport.partsRoot.add(view.group);
      }
      view.update(d);
      view.setField(null, 0);
      view.setStressView(app.stressView);
      view.setHighlight(false, false);
      this.parts.set(d.id, {
        def: d, mat: getMaterial(d.material), body: this.worldBody, lp: new THREE.Vector3(), lq: new THREE.Quaternion(),
        collider: null, view, debris: false, alive: true, pending: false, yielded: false, bornAt: 0,
      });
    }
    // bonds from contact patches
    const patches = app.analysis && !app.analysisStale ? app.analysis.patches : detectContacts(defs, { tol: 0.004 });
    for (const patch of patches) {
      const a = this.parts.get(patch.a);
      if (!a) continue;
      const bDef = patch.b === GROUND_ID ? undefined : this.parts.get(patch.b)?.def;
      const joint = app.jointOf(a.def, patch.b, bDef);
      if (joint === 'rest' && !patch.embedded) continue;
      this.addBond(patch, joint === 'rest' ? 'glue' : joint);
    }
    this.rebuild([...this.parts.keys()], null);
    // initial verdict from the build analysis (identical geometry)
    if (app.analysis && !app.analysisStale) {
      this.schedule(app.analysis, 0.35);
      this.recordColors(app.analysis);
    } else {
      const res = this.analyzeParts([...this.parts.keys()]);
      if (res) {
        this.schedule(res, 0.35);
        this.recordColors(res);
      }
    }
    app.on('settings', () => {
      if (this.disposed) return;
      for (const [id, p] of this.parts) if (p.alive) p.view.setField(this.app.stressView ? this.colorFields.get(id) ?? null : null, 0);
    });
    const n = this.pending.length;
    app.addLog(n ? `Simulation started: ${n} overloaded part${n > 1 ? 's' : ''} detected` : 'Simulation started: the structure is carrying its load', n ? 'warn' : 'ok', 0);
  }

  private addBond(patch: ContactPatch, joint: JointType) {
    const a = this.parts.get(patch.a)!.def;
    const toA = (p: Vec3T) => toLocal(a, p[0], p[1], p[2]);
    const qi: [number, number, number, number] = [-a.quat[0], -a.quat[1], -a.quat[2], a.quat[3]];
    const key = pairKey(patch.a, patch.b);
    this.bonds.set(key, {
      key, a: patch.a, b: patch.b, joint,
      pts: patch.points.map(toA), normal: rotVec(qi, patch.normal), centroid: toA(patch.centroid), area: patch.area,
      center: patch.center, embedded: patch.embedded, extent: patch.extent, axes: [rotVec(qi, patch.axes[0]), rotVec(qi, patch.axes[1])],
    });
  }

  /** world-space patch of a bond (using a's current pose) */
  private bondPatch(b: Bond): ContactPatch | null {
    const a = this.parts.get(b.a);
    if (!a) return null;
    const d = a.def;
    const w = (p: Vec3T): Vec3T => {
      const r = rotVec(d.quat, p);
      return [r[0] + d.pos[0], r[1] + d.pos[1], r[2] + d.pos[2]];
    };
    return {
      a: b.a, b: b.b, normal: rotVec(d.quat, b.normal), area: b.area, centroid: w(b.centroid), points: b.pts.map(w), center: b.center,
      embedded: b.embedded, extent: b.extent, axes: [rotVec(d.quat, b.axes[0]), rotVec(d.quat, b.axes[1])],
    };
  }

  private isWorldNode(id: string): boolean {
    if (id === GROUND_ID) return true;
    const p = this.parts.get(id);
    return !!p && !!p.def.anchored;
  }

  // ------------------------------------------------------------------ bodies

  private colliderDesc(def: PartDef, mat: Material): RAPIER.ColliderDesc {
    let d: RAPIER.ColliderDesc | null = null;
    let density = mat.density;
    if (isShaped(def)) {
      // what the saw left: the convex hull of the clipped shape
      const P = clippedPolytope(def);
      if (P.v.length >= 12) d = RAPIER.ColliderDesc.convexHull(Float32Array.from(P.v));
      if (!d) d = RAPIER.ColliderDesc.ball(0.004);
      if (def.kind === 'tube') density *= 1 - (innerRadius(def) / (def.size[0] / 2)) ** 2;
      return d.setDensity(density).setFriction(mat.friction).setRestitution(mat.restitution);
    }
    switch (def.kind) {
      case 'sphere':
        d = RAPIER.ColliderDesc.ball(def.size[0] / 2);
        break;
      case 'cylinder':
      case 'tube': {
        const r = def.size[0] / 2;
        d = RAPIER.ColliderDesc.cylinder(def.size[1] / 2, r);
        if (def.kind === 'tube') density *= 1 - (innerRadius(def) / r) ** 2;
        break;
      }
      case 'hull':
        if (def.hull && def.hull.length >= 12) d = RAPIER.ColliderDesc.convexHull(Float32Array.from(def.hull));
        if (d && def.hullVolume) {
          const he = halfExtents(def);
          const boxV = 8 * he[0] * he[1] * he[2];
          // convex hull mass from Rapier is exact; nothing to correct
          void boxV;
        }
        break;
    }
    if (!d) d = RAPIER.ColliderDesc.cuboid(Math.max(0.0005, def.size[0] / 2), Math.max(0.0005, def.size[1] / 2), Math.max(0.0005, def.size[2] / 2));
    return d.setDensity(density).setFriction(mat.friction).setRestitution(mat.restitution);
  }

  private partMass(p: SimPart): number {
    return p.mat.density * volume(p.def);
  }

  /** (re)create rigid bodies for a set of parts according to their intact bonds */
  private rebuild(ids: string[], inherit: { v: THREE.Vector3; w: THREE.Vector3; com: THREE.Vector3 } | null) {
    const set = new Set(ids.filter((id) => this.parts.get(id)?.alive));
    // detach from old bodies
    for (const id of set) {
      const p = this.parts.get(id)!;
      if (p.collider) {
        this.colliderPart.delete(p.collider.handle);
        this.world.removeCollider(p.collider, true);
        p.collider = null;
      }
      p.body.parts.delete(id);
      if (!p.body.world && p.body.parts.size === 0 && this.bodies.has(p.body.rb.handle)) {
        this.bodies.delete(p.body.rb.handle);
        this.world.removeRigidBody(p.body.rb);
      }
    }
    // union-find
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));
    parent.set(WORLD, WORLD);
    for (const id of set) parent.set(id, id);
    for (const id of set) if (this.parts.get(id)!.def.anchored) union(id, WORLD);
    for (const b of this.bonds.values()) {
      const inA = set.has(b.a), inB = set.has(b.b);
      if (inA && inB) union(b.a, b.b);
      else if (inA && this.isWorldNode(b.b)) union(b.a, WORLD);
      else if (inB && this.isWorldNode(b.a)) union(b.b, WORLD);
      else if (inA && this.parts.get(b.b)?.body.world) union(b.a, WORLD);
      else if (inB && this.parts.get(b.a)?.body.world) union(b.b, WORLD);
    }
    const comps = new Map<string, string[]>();
    for (const id of set) {
      const r = find(id);
      const arr = comps.get(r) ?? [];
      arr.push(id);
      comps.set(r, arr);
    }
    for (const [root, members] of comps) {
      if (root === find(WORLD)) this.attachWorld(members);
      else this.createBody(members, inherit);
    }
  }

  private attachWorld(ids: string[]) {
    for (const id of ids) {
      const p = this.parts.get(id)!;
      const d = p.def;
      const desc = this.colliderDesc(d, p.mat).setTranslation(d.pos[0], d.pos[1], d.pos[2]).setRotation({ x: d.quat[0], y: d.quat[1], z: d.quat[2], w: d.quat[3] });
      p.collider = this.world.createCollider(desc, this.worldBody.rb);
      this.colliderPart.set(p.collider.handle, id);
      p.body = this.worldBody;
      p.lp.set(d.pos[0], d.pos[1], d.pos[2]);
      p.lq.set(d.quat[0], d.quat[1], d.quat[2], d.quat[3]);
      this.worldBody.parts.add(id);
    }
  }

  private createBody(ids: string[], inherit: { v: THREE.Vector3; w: THREE.Vector3; com: THREE.Vector3 } | null): SimBody {
    let M = 0;
    const com = new THREE.Vector3();
    let small = true;
    let anyDebris = false;
    for (const id of ids) {
      const p = this.parts.get(id)!;
      const m = this.partMass(p);
      M += m;
      com.addScaledVector(new THREE.Vector3(...p.def.pos), m);
      if (boundingRadius(p.def) > 0.12) small = false;
      if (p.debris) anyDebris = true;
    }
    com.multiplyScalar(1 / Math.max(M, 1e-9));
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(com.x, com.y, com.z).setCanSleep(true);
    if (inherit) {
      const v = inherit.v.clone().add(new THREE.Vector3().crossVectors(inherit.w, com.clone().sub(inherit.com)));
      desc.setLinvel(v.x, v.y, v.z).setAngvel({ x: inherit.w.x, y: inherit.w.y, z: inherit.w.z });
    }
    if (small || anyDebris) desc.setCcdEnabled(true);
    const rb = this.world.createRigidBody(desc);
    const body: SimBody = { rb, parts: new Set(), world: false, vPrev: v3(rb.linvel()), wPrev: v3(rb.angvel()), mass: M, radius: 0 };
    for (const id of ids) {
      const p = this.parts.get(id)!;
      const d = p.def;
      const lp = new THREE.Vector3(...d.pos).sub(com);
      const lq = new THREE.Quaternion(...d.quat);
      p.lp.copy(lp);
      p.lq.copy(lq);
      const cd = this.colliderDesc(d, p.mat).setTranslation(lp.x, lp.y, lp.z).setRotation({ x: lq.x, y: lq.y, z: lq.z, w: lq.w });
      p.collider = this.world.createCollider(cd, rb);
      this.colliderPart.set(p.collider.handle, id);
      p.body = body;
      body.parts.add(id);
      body.radius = Math.max(body.radius, lp.length() + boundingRadius(d));
    }
    this.bodies.set(rb.handle, body);
    return body;
  }

  // ------------------------------------------------------------------ main loop

  update(dtReal: number) {
    const vpH = this.app.viewport.renderer.domElement.clientHeight;
    if (this.paused) {
      this.particles.update(0, vpH);
      return;
    }
    const dt = dtReal * this.timeScale;
    this.acc += dt;
    let steps = 0;
    this.impactBudget = 3;
    const t0 = this.time;
    while (this.acc >= H && steps < 8) {
      // the hand's push goes in before the velocity snapshot so it never reads as an impact
      this.applyPush();
      for (const b of this.bodies.values()) {
        b.vPrev.copy(v3(b.rb.linvel()));
        b.wPrev.copy(v3(b.rb.angvel()));
      }
      this.applyHinges();
      this.world.step(this.queue);
      this.queue.drainContactForceEvents(() => {});
      this.acc -= H;
      this.time += H;
      steps++;
      this.detectImpacts();
      this.runPending();
    }
    if (this.acc > H * 8) this.acc = 0;
    this.syncPoses();
    this.updateSaw(this.time - t0);
    this.updateStrikes();
    this.checkPush();
    this.updateAnims();
    if (this.time >= this.nextCheck) {
      this.nextCheck = this.time + 0.2;
      this.periodicCheck();
    }
    this.particles.update(dt, vpH);
  }

  private syncPoses() {
    for (const b of this.bodies.values()) {
      if (b.rb.isSleeping()) continue;
      const t = v3(b.rb.translation());
      const q = q4(b.rb.rotation());
      for (const id of b.parts) {
        const p = this.parts.get(id)!;
        const wp = p.lp.clone().applyQuaternion(q).add(t);
        const wq = q.clone().multiply(p.lq);
        p.def.pos = [wp.x, wp.y, wp.z];
        p.def.quat = [wq.x, wq.y, wq.z, wq.w];
        p.view.setPose(wp, wq);
        if (wp.y < -50) this.removePart(id);
      }
    }
  }

  // ------------------------------------------------------------------ plastic hinges

  private applyHinges() {
    const keep: Hinge[] = [];
    for (const h of this.hinges) {
      const a = this.parts.get(h.a), b = this.parts.get(h.b);
      if (!a?.alive || !b?.alive || a.body === b.body || !h.joint.isValid()) {
        if (h.joint.isValid()) this.world.removeImpulseJoint(h.joint, true);
        continue;
      }
      const ra = a.body.rb, rbb = b.body.rb;
      const wr = v3(rbb.angvel()).sub(v3(ra.angvel()));
      const m = wr.length();
      if (m > 1e-4) {
        const ia = a.body.world ? Infinity : Math.max(...Object.values(ra.principalInertia()));
        const ib = b.body.world ? Infinity : Math.max(...Object.values(rbb.principalInertia()));
        const ieff = 1 / (1 / ia + 1 / ib);
        const J = Math.min(ieff * m, h.Mp * H);
        const dir = wr.multiplyScalar(1 / m);
        if (!a.body.world) ra.applyTorqueImpulse({ x: dir.x * J, y: dir.y * J, z: dir.z * J }, true);
        if (!b.body.world) rbb.applyTorqueImpulse({ x: -dir.x * J, y: -dir.y * J, z: -dir.z * J }, true);
      }
      const qa = q4(ra.rotation()).multiply(a.lq), qb = q4(rbb.rotation()).multiply(b.lq);
      const rel = qa.clone().invert().multiply(qb);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(rel.dot(h.q0))));
      if (ang > h.maxAngle) {
        this.world.removeImpulseJoint(h.joint, true);
        const at = v3(rbb.translation());
        this.particles.sparksAt(at, 10);
        sound.fracture('metal', 0.5);
        this.log(`${b.def.name} tore off after bending ${(ang * 57.3).toFixed(0)}°`, 'fail');
        continue;
      }
      keep.push(h);
    }
    this.hinges = keep;
  }

  // ------------------------------------------------------------------ impacts

  private detectImpacts() {
    if (this.impactBudget <= 0) return;
    const cands: { body: SimBody; dv: number; J: number }[] = [];
    for (const b of this.bodies.values()) {
      if (b.rb.isSleeping()) continue;
      let fresh = false;
      for (const id of b.parts) if (this.time - (this.parts.get(id)?.bornAt ?? 0) < 0.12 && this.parts.get(id)!.bornAt > 0) fresh = true;
      if (fresh) continue;
      const dvLin = v3(b.rb.linvel()).sub(b.vPrev);
      const dvAng = v3(b.rb.angvel()).sub(b.wPrev);
      const dv = dvLin.length() + dvAng.length() * Math.min(b.radius, 1) * 0.5;
      if (dv < 1.1) continue;
      // gravity alone changes v by g*H; ignore smooth motion
      if (dvLin.length() < 9.81 * H * 3 && dvAng.length() < 2) continue;
      cands.push({ body: b, dv, J: b.mass * dvLin.length() });
    }
    cands.sort((a, b) => b.J - a.J);
    for (const c of cands) {
      if (this.impactBudget-- <= 0) break;
      this.handleImpact(c.body, c.dv, c.J);
    }
  }

  private handleImpact(body: SimBody, dv: number, J: number) {
    // strongest contact of this body
    let best: { other: RAPIER.Collider; mine: RAPIER.Collider; imp: number; pt: THREE.Vector3; n: THREE.Vector3; count: number; spread: number; pts: THREE.Vector3[] } | null = null;
    for (const id of body.parts) {
      const p = this.parts.get(id)!;
      if (!p.collider) continue;
      const mine = p.collider;
      this.world.contactPairsWith(mine, (other) => {
        this.world.contactPair(mine, other, (m, flipped) => {
          let imp = 0;
          const pt = new THREE.Vector3();
          const pts: THREE.Vector3[] = [];
          for (let i = 0; i < m.numSolverContacts(); i++) {
            const sp = m.solverContactPoint(i);
            if (!sp) continue;
            pts.push(v3(sp));
          }
          for (let i = 0; i < m.numContacts(); i++) imp += m.contactImpulse(i);
          if (!pts.length) return;
          for (const q of pts) pt.add(q);
          pt.multiplyScalar(1 / pts.length);
          let spread = 0;
          for (const q of pts) spread = Math.max(spread, q.distanceTo(pt));
          const n = v3(m.normal());
          if (!flipped) n.negate(); // now points from other into mine
          if (!best || imp > best.imp) best = { other, mine, imp, pt, n, count: pts.length, spread, pts };
        });
      });
    }
    if (!best) return;
    const b = best as { other: RAPIER.Collider; mine: RAPIER.Collider; imp: number; pt: THREE.Vector3; n: THREE.Vector3; count: number; spread: number; pts: THREE.Vector3[] };
    const myId = this.colliderPart.get(b.mine.handle)!;
    const me = this.parts.get(myId)!;
    const otherId = this.colliderPart.get(b.other.handle);
    const other = otherId ? this.parts.get(otherId) : undefined;
    const otherMat = other ? other.mat : GROUND_MATERIAL;
    const partnerMass = other ? (other.body.world ? Infinity : other.body.mass) : Infinity;
    const mEff = 1 / (1 / body.mass + 1 / partnerMass);
    const Jn = Math.max(J, b.imp);
    // feedback
    const energy = 0.5 * mEff * dv * dv;
    const intensity = Math.min(1, Math.log10(1 + energy) / 3.2);
    sound.impact(me.mat.sound === 'metal' || otherMat.sound === 'metal' ? 'metal' : me.mat.sound, intensity, boundingRadius(me.def));
    if (energy > 30) this.particles.dustCloud(b.pt, Math.min(40, 4 + energy / 60), otherId ? me.mat.visual.color : '#b8b2a6', 0.25 + Math.min(1, energy / 2e4), Math.min(2, 0.5 + energy / 5000));
    if (energy > 200 && (me.mat.category === 'Metal' || otherMat.category === 'Metal') && dv > 3) this.particles.sparksAt(b.pt, Math.min(30, 6 + energy / 400));
    if (energy > 2000) this.app.viewport.addShake(Math.min(0.05, energy / 2e6));
    const lastLog = this.lastImpactLog.get(myId) ?? -1;
    if (energy > 400 && this.time - lastLog > 0.6 && !me.debris) {
      this.lastImpactLog.set(myId, this.time);
      this.log(`${me.def.name} hit ${other ? other.def.name : 'the floor'} at ${dv.toFixed(1)} m/s`, 'info');
    }
    if (dv < 1.5) return;
    // peak force: spring-mass impact against local contact stiffness (+ structure flexibility)
    const Estar = 1 / ((1 - me.mat.nu ** 2) / me.mat.E + (1 - otherMat.nu ** 2) / otherMat.E);
    const area = b.count >= 3 ? Math.max(1e-4, Math.PI * b.spread * b.spread * 0.5) : 1e-4;
    const kLocal = 2 * Math.sqrt(area / Math.PI) * Estar;
    const e = (me.mat.restitution + otherMat.restitution) / 2;
    // local crushing cushions hard knocks: the contact can't push harder than the weaker
    // material's crushing strength over the area that the impact energy crushes
    const crushStrength = (m: Material) => (m.ductile ? 2.5 * (m.fy ?? m.ft) : m.grain ? (m.fcPerp ?? m.fc * 0.15) * 2 : m.fc);
    const fCrush = Math.min(crushStrength(me.mat), crushStrength(otherMat));
    const aCrush = Math.pow((3 * energy) / Math.max(fCrush, 1e3), 2 / 3);
    const fCap = fCrush * Math.max(area, aCrush);
    const peak = (kStruct: number) => {
      const k = 1 / (1 / kLocal + (kStruct > 0 ? 1 / kStruct : 0));
      const w = Math.sqrt(k / mEff);
      return Math.min((Jn * w) / (1 + e), Jn / 1e-4, fCap);
    };
    // (1) the struck structure, if it is standing still
    const thrown = me.def.parentId === 'projectile';
    // judge the struck structure by how it was moving before this blow, not after it
    if (other && !other.debris && !other.body.world && this.wasQuiescent(other.body)) {
      this.impactOnIsland(other, b.pt, b.n.clone().negate(), peak, b.pts, thrown, body.parts);
    } else if (other && !other.debris && other.body.world && !other.def.anchored) {
      this.impactOnIsland(other, b.pt, b.n.clone().negate(), peak, b.pts, thrown, body.parts);
    }
    // (2) the moving body itself (inertia relief)
    if (!me.debris && me.alive) this.impactOnBody(body, me, b.pt, b.n, peak, area, b.pts);
  }

  private impactOnIsland(target: SimPart, pt: THREE.Vector3, dirInto: THREE.Vector3, peak: (k: number) => number, pts: THREE.Vector3[], thrown = false, striker: Set<string> = new Set()) {
    // the thing doing the hitting is not part of the structure being hit
    const island = this.islandOf(target.def.id).filter((i) => !striker.has(i));
    if (island.length > 60) return;
    const point: Vec3T = [pt.x, pt.y, pt.z];
    const dir: Vec3T = [dirInto.x, dirInto.y, dirInto.z];
    // A blow lasts a millisecond or so. A structure fixed to the world takes it through its
    // supports; a free-standing one is barely held by floor friction in that time, so its own
    // inertia is what resists (d'Alembert loads balance the blow).
    const held = island.some((id) => this.parts.get(id)?.body.world);
    const probeAt = { part: target.def.id, point, dir };
    let probe = held ? this.analyzeParts(island, { probe: probeAt }) : null;
    let relief = false;
    if (!probe || probe.status === 'unstable') {
      probe = this.analyzeParts(island, { probe: probeAt, inertiaRelief: true });
      relief = true;
    }
    if (!probe || probe.status === 'unstable') return;
    const c = probe.result.compliance;
    const F = peak(c > 0 ? 1 / c : 0);
    // small knocks are irrelevant next to the structure's own weight (a hammer blow or a thrown
    // ball is always worth checking: it is a deliberately concentrated hit)
    if ((!thrown && F < 0.3 * probe.model.totalWeight) || F < 50) return;
    const share = F / Math.max(1, pts.length);
    const loads = (pts.length ? pts : [pt]).map((q) => ({ part: target.def.id, point: [q.x, q.y, q.z] as Vec3T, force: [dir[0] * share, dir[1] * share, dir[2] * share] as Vec3T }));
    const res = this.analyzeParts(island, { loads, inertiaRelief: relief });
    if (res) this.schedule(res, 0.02, `an impact of ${F >= 1000 ? (F / 1000).toFixed(1) + ' kN' : F.toFixed(0) + ' N'}`, true);
  }

  private impactOnBody(body: SimBody, me: SimPart, pt: THREE.Vector3, nInto: THREE.Vector3, peak: (k: number) => number, contactArea: number, pts: THREE.Vector3[]) {
    let F = peak(0);
    const ids = [...body.parts].filter((id) => !this.parts.get(id)!.debris);
    if (!ids.length) return;
    const point: Vec3T = [pt.x, pt.y, pt.z];
    const force: Vec3T = [nInto.x * F, nInto.y * F, nInto.z * F];
    const cls = classifyPart(me.def);
    if (ids.length === 1 && cls.kind === 'block') {
      // a solid lump: check crushing / shattering at the contact
      const he = halfExtents(me.def);
      const maxFace = 4 * Math.max(he[0] * he[1], he[1] * he[2], he[0] * he[2]);
      const area = Math.max(1e-4, Math.min(maxFace, contactArea));
      const p = F / area;
      const m = me.mat;
      const limit = m.ductile ? 3 * (m.fy ?? m.ft) : m.failure === 'shatter' || m.failure === 'dice' ? 4 * m.ft : m.fc;
      if (p > limit && !me.pending) {
        me.pending = true;
        this.pending.push({ at: this.time + 0.005, partId: me.def.id, kind: 'member', mode: 'compression', U: p / limit, a: 0, b: 0, dir: 0, local: toLocal(me.def, point[0], point[1], point[2]), message: `${me.def.name} shattered on impact` });
      }
      return;
    }
    void force;
    // the body's own flexibility (relative to its rigid-body motion) softens the blow
    const probe = this.analyzeParts(ids, { probe: { part: me.def.id, point, dir: [nInto.x, nInto.y, nInto.z] }, inertiaRelief: true });
    const c = probe?.result.compliance ?? 0;
    if (c > 0) F = peak(1 / c);
    const share = F / Math.max(1, pts.length);
    const loads = (pts.length ? pts : [pt]).map((q) => ({ part: me.def.id, point: [q.x, q.y, q.z] as Vec3T, force: [nInto.x * share, nInto.y * share, nInto.z * share] as Vec3T }));
    const res = this.analyzeParts(ids, { loads, inertiaRelief: true });
    if (res) this.schedule(res, 0.005, `an impact of ${F >= 1000 ? (F / 1000).toFixed(1) + ' kN' : F.toFixed(0) + ' N'}`, true);
  }

  // ------------------------------------------------------------------ islands & analysis

  /** standing still at the start of the last step */
  private wasQuiescent(b: SimBody): boolean {
    if (b.world) return true;
    return b.vPrev.length() < 0.06 && b.wPrev.length() < 0.25;
  }

  private isQuiescent(b: SimBody): boolean {
    if (b.world || b.rb.isSleeping()) return true;
    return v3(b.rb.linvel()).length() < 0.06 && v3(b.rb.angvel()).length() < 0.25;
  }

  private contactsOf(p: SimPart): string[] {
    const out: string[] = [];
    if (!p.collider) return out;
    const c = p.collider;
    this.world.contactPairsWith(c, (other) => {
      let touching = false;
      this.world.contactPair(c, other, (m) => {
        if (m.numContacts() > 0) touching = true;
      });
      if (!touching) return;
      if (other.handle === this.groundCollider.handle) out.push(GROUND_ID);
      else {
        const id = this.colliderPart.get(other.handle);
        if (id) out.push(id);
      }
    });
    return out;
  }

  /** connected structural parts (through bonds and resting contacts), excluding supports */
  private islandOf(id: string): string[] {
    const seen = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      const p = this.parts.get(cur);
      if (!p) continue;
      const nb = new Set<string>(this.contactsOf(p));
      for (const b of this.bonds.values()) {
        if (b.a === cur) nb.add(b.b);
        else if (b.b === cur) nb.add(b.a);
      }
      for (const n of nb) {
        if (n === GROUND_ID || seen.has(n)) continue;
        const q = this.parts.get(n);
        if (!q || !q.alive || q.debris || q.def.anchored) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    return [...seen];
  }

  analyzeParts(ids: string[], opts: { loads?: { part: string; point: Vec3T; force: Vec3T }[]; probe?: { part: string; point: Vec3T; dir: Vec3T }; inertiaRelief?: boolean } = {}): StructureResult | null {
    const members = ids.map((id) => this.parts.get(id)!).filter((p) => p && p.alive && !p.debris);
    if (!members.length) return null;
    const memberSet = new Set(members.map((p) => p.def.id));
    const defs: PartDef[] = members.map((p) => p.def);
    const supports = new Map<string, PartDef>();
    const patches: ContactPatch[] = [];
    const joints = new Map<string, JointType>();
    // bonds
    for (const b of this.bonds.values()) {
      const inA = memberSet.has(b.a), inB = memberSet.has(b.b);
      if (!inA && !inB) continue;
      if (opts.inertiaRelief && !(inA && inB)) continue;
      if (!inA || !inB) {
        const other = inA ? b.b : b.a;
        if (other !== GROUND_ID) {
          const o = this.parts.get(other);
          if (!o || !o.alive) continue;
          if (!o.def.anchored) continue; // the other side is a separate structure; ignore
          supports.set(other, o.def);
        }
      }
      const patch = this.bondPatch(b);
      if (!patch) continue;
      if (!inA) {
        // keep the free part as "a"
        continue;
      }
      patches.push(patch);
      joints.set(pairKey(patch.a, patch.b), b.joint);
    }
    if (!opts.inertiaRelief) {
      // resting contacts (between different bodies) and floor contacts
      const done = new Set<string>();
      for (const p of members) {
        for (const o of this.contactsOf(p)) {
          const key = pairKey(p.def.id, o);
          if (done.has(key) || this.bonds.has(key)) continue;
          done.add(key);
          if (o === GROUND_ID) {
            const g = groundPatch(p.def, 0.015);
            if (g) patches.push(g);
            continue;
          }
          const q = this.parts.get(o);
          if (!q || !q.alive || q.debris) continue;
          if (!memberSet.has(o) && !q.def.anchored) continue;
          if (q.def.anchored) supports.set(o, q.def);
          const patch = patchBetween(p.def, q.def, 0.015);
          if (patch) patches.push(patch);
        }
      }
    }
    try {
      return analyzeStructure({
        parts: [...defs, ...supports.values()],
        jointOf: () => 'rest',
        patchJoint: (patch) => joints.get(pairKey(patch.a, patch.b)),
        patches,
        loads: opts.loads,
        probe: opts.probe,
        inertiaRelief: opts.inertiaRelief,
      });
    } catch (e) {
      console.warn('sim analysis failed', e);
      return null;
    }
  }

  private periodicCheck() {
    const visited = new Set<string>();
    let budget = 2;
    for (const [id, p] of this.parts) {
      if (!p.alive || p.debris || p.def.anchored || visited.has(id) || p.pending) continue;
      const island = this.islandOf(id);
      island.forEach((i) => visited.add(i));
      if (island.length > 80) continue;
      if (!island.every((i) => this.isQuiescent(this.parts.get(i)!.body))) continue;
      if (island.some((i) => this.parts.get(i)!.pending)) continue;
      const sig = island
        .map((i) => {
          const d = this.parts.get(i)!.def;
          return `${i}:${d.pos.map((v) => Math.round(v * 200)).join(',')}`;
        })
        .sort()
        .join('|');
      const key = [...island].sort()[0];
      if (this.signatures.get(key) === sig) continue;
      this.signatures.set(key, sig);
      if (budget-- <= 0) break;
      const res = this.analyzeParts(island);
      if (res) {
        this.schedule(res, 0.25);
        this.recordColors(res);
      }
    }
  }

  // ------------------------------------------------------------------ scheduling failures

  /**
   * Queue the failures an analysis found. For a blow (`impact`), only the weakest link goes (and
   * anything nearly as overloaded): once it gives, the rest of the structure never feels the full
   * force, and later knocks and checks take care of what follows.
   */
  private schedule(res: StructureResult, lead: number, cause?: string, impact = false) {
    let creak = false;
    const animFields = new Map<string, { field: DeformField; target: number }>();
    let animEnd = 0;
    let buckling = false;
    let umax = 0;
    for (const r of res.failing) if (!r.unstable) umax = Math.max(umax, r.U);
    for (const rep of res.failing) {
      const id = rep.info.def.id;
      const p = this.parts.get(id);
      if (!p || !p.alive || p.debris || p.pending || rep.unstable) continue;
      if (impact && rep.U < 0.85 * umax) continue;
      let kind: Pending['kind'] = 'member';
      let bondKey: string | undefined;
      let crushAxis: number | undefined, crushSign: number | undefined;
      if (rep.mode === 'joint') {
        const pi = res.model.patches[rep.patch];
        if (!pi) continue;
        bondKey = pairKey(pi.patch.a, pi.patch.b);
        if (!this.bonds.has(bondKey)) continue;
        kind = 'joint';
      } else if (rep.mode === 'bearing' || rep.mode === 'punching') {
        if (p.yielded) continue;
        kind = 'bearing';
        const pi = res.model.patches[rep.patch];
        if (pi) {
          // crush along the local axis closest to the contact normal, keeping the far side fixed
          const n = pi.patch.normal;
          const qi: [number, number, number, number] = [-p.def.quat[0], -p.def.quat[1], -p.def.quat[2], p.def.quat[3]];
          let ln = rotVec(qi, n);
          if (pi.patch.a !== id) ln = [-ln[0], -ln[1], -ln[2]];
          const ax = [0, 1, 2].reduce((best, k) => (Math.abs(ln[k]) > Math.abs(ln[best]) ? k : best), 0);
          crushAxis = ax;
          crushSign = Math.sign(ln[ax]) || -1;
        }
      }
      const U = rep.U;
      const delay = lead > 0.1 ? Math.max(0.12, Math.min(0.45, 0.6 / U)) : lead;
      p.pending = true;
      const local = toLocal(p.def, rep.point[0], rep.point[1], rep.point[2]);
      const pend: Pending = { at: this.time + delay, partId: id, kind, mode: rep.mode, U, a: rep.a, b: rep.b, dir: rep.dir, local, bondKey, crushAxis, crushSign, message: rep.message };
      if (rep.mode === 'buckling' && res.result.mode) {
        buckling = true;
        // lateral direction of the buckle at the failing section
        const info = rep.info;
        let best = 0, dvec = new THREE.Vector3();
        for (const nd of info.nodes) {
          const m = res.result.mode;
          const d = new THREE.Vector3(m[6 * nd], m[6 * nd + 1], m[6 * nd + 2]);
          if (d.length() > best) {
            best = d.length();
            dvec = d;
          }
        }
        pend.kick = dvec.normalize();
      }
      this.pending.push(pend);
      animEnd = Math.max(animEnd, pend.at);
      if (!this.notable(p)) {
        /* quiet */
      } else if (lead > 0.1) {
        this.log(`${p.def.name} (${p.mat.name}): ${MODE_LABEL[rep.mode].toLowerCase()} at ${(U * 100).toFixed(0)}%${cause ? ` from ${cause}` : ''}`, 'warn');
        creak = true;
      } else {
        this.log(`${p.def.name}: ${MODE_LABEL[rep.mode].toLowerCase()} at ${(U * 100).toFixed(0)}%${cause ? ` from ${cause}` : ''}`, 'warn');
      }
    }
    if (creak) {
      const first = res.failing.find((r) => this.parts.get(r.info.def.id)?.pending);
      sound.creak(first ? getMaterial(first.info.def.material).sound : 'wood', Math.min(0.6, animEnd - this.time + 0.1));
    }
    // anticipation: the structure visibly bows before it lets go
    if (animEnd - this.time > 0.08) {
      const disp = buckling ? res.result.mode : res.result.u;
      if (disp) {
        const elemU = res.result.elements.map((e) => e.U);
        res.model.parts.forEach((info, i) => {
          const id = info.def.id;
          const p = this.parts.get(id);
          if (!p || !p.alive) return;
          const field = makeDeformField(info, res.model, disp, elemU, res.result.parts[i].U);
          if (field.maxDisp <= 0) return;
          const target = buckling ? 0.035 * Math.max(0.3, info.length) : 0.02 * Math.max(0.3, info.length);
          animFields.set(id, { field, target });
        });
        if (animFields.size) this.anims.push({ start: this.time, end: animEnd, fields: animFields });
      }
    }
  }

  /** remember each part's utilisation field so the stress view stays live during the run */
  private recordColors(res: StructureResult) {
    const elemU = res.result.elements.map((e) => e.U);
    res.model.parts.forEach((info, i) => {
      const id = info.def.id;
      const p = this.parts.get(id);
      if (!p || !p.alive) return;
      const field = makeDeformField(info, res.model, null, elemU, res.result.parts[i].U);
      this.colorFields.set(id, field);
      if (this.app.stressView) p.view.setField(field, 0);
    });
  }

  private updateAnims() {
    const keep: Anim[] = [];
    for (const a of this.anims) {
      const k = Math.min(1, (this.time - a.start) / Math.max(1e-3, a.end - a.start));
      const done = this.time > a.end + 0.02;
      for (const [id, f] of a.fields) {
        const p = this.parts.get(id);
        if (!p || !p.alive) continue;
        if (done) p.view.setField(this.app.stressView ? this.colorFields.get(id) ?? null : null, 0);
        else p.view.setField(f.field, (f.target * k * k) / Math.max(1e-9, f.field.maxDisp));
      }
      if (!done) keep.push(a);
    }
    this.anims = keep;
  }

  private runPending() {
    if (!this.pending.length) return;
    const due = this.pending.filter((p) => p.at <= this.time);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.at > this.time);
    due.sort((a, b) => b.U - a.U);
    for (const p of due) this.execute(p);
  }

  // ------------------------------------------------------------------ executing failures

  private execute(pd: Pending) {
    const part = this.parts.get(pd.partId);
    if (!part || !part.alive) return;
    part.pending = false;
    const name = part.def.name;
    const pt = new THREE.Vector3(...rotVec(part.def.quat, pd.local)).add(new THREE.Vector3(...part.def.pos));
    if (pd.kind === 'joint') {
      const b = pd.bondKey ? this.bonds.get(pd.bondKey) : undefined;
      if (!b) return;
      this.bonds.delete(b.key);
      const other = b.a === pd.partId ? b.b : b.a;
      const otherName = other === GROUND_ID ? 'the floor' : this.parts.get(other)?.def.name ?? '?';
      const inherit = this.inheritFrom(part.body);
      const ids = new Set([...part.body.parts]);
      const op = this.parts.get(other);
      if (op && op.body === part.body) for (const i of op.body.parts) ids.add(i);
      if (part.body.world) {
        // reattach everything that was held by the world
        for (const i of this.worldBody.parts) if (!this.parts.get(i)!.def.anchored) ids.add(i);
      }
      this.rebuild([...ids], inherit);
      sound.fracture(part.mat.sound === 'metal' ? 'metal' : 'wood', 0.5);
      this.particles.dustCloud(pt, 8, '#cfc6b4', 0.1, 0.4);
      this.log(`The ${b.joint} joint between ${name} and ${otherName} gave way`, 'fail');
      return;
    }
    if (pd.kind === 'bearing') {
      const m = part.mat;
      if (m.failure !== 'crush' && (m.ductile || (m.grain && pd.U < 2.5))) {
        part.yielded = true;
        this.particles.dustCloud(pt, 5, m.visual.color, 0.05, 0.3);
        if (this.notable(part)) this.log(`${name} was dented: local crushing where it bears on its support`, 'warn');
        return;
      }
    }
    this.fracturePart(part, pd, pt);
  }

  private inheritFrom(b: SimBody) {
    if (b.world) return null;
    return { v: v3(b.rb.linvel()), w: v3(b.rb.angvel()), com: v3(b.rb.worldCom()) };
  }

  private fracturePart(part: SimPart, pd: Pending, pt: THREE.Vector3) {
    const def = part.def;
    const cls = classifyPart(def);
    const info = { def, mat: part.mat, kind: cls.kind, axis: cls.axis, uAxis: cls.uAxis, vAxis: cls.vAxis, disk: cls.disk } as unknown as FEPartInfo;
    if (cls.kind === 'plate' && cls.disk) {
      info.uAxis = 0;
      info.vAxis = 2;
    }
    let a = pd.a;
    if (pd.mode === 'buckling' && cls.kind === 'beam') {
      // a buckled leg kinks towards its high-moment end, but never shears off a sliver
      const L = def.size[cls.axis];
      a = Math.max(-0.25 * L, Math.min(0.25 * L, a));
      if (Math.abs(a) < 0.05 * L) a = (pd.a >= 0 ? 1 : -1) * 0.2 * L;
    }
    const res = fracture(def, {
      info, mat: part.mat, a, b: pd.b, dir: pd.dir, local: pd.local,
      crushAxis: pd.crushAxis, crushSign: pd.crushSign,
    });
    if (!res.pieces.length && !res.debris.length) {
      part.yielded = true;
      if (this.notable(part)) this.log(`${def.name} yielded locally`, 'warn');
      return;
    }
    const { newIds, debrisIds } = this.replaceWithPieces(part, res.pieces, res.pieces.length === 1 ? () => 0 : res.owner, res.debris);
    // kicks: a freed piece is shoved sideways at its broken end so it rotates and splays out
    const kick = pd.kick ? pd.kick.clone() : new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
    kick.y = 0;
    if (kick.lengthSq() < 1e-6) kick.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    kick.normalize();
    for (const id of newIds) {
      const p = this.parts.get(id);
      if (!p || p.body.world || p.body.parts.size > 1) continue;
      const rb = p.body.rb;
      const m = p.body.mass;
      const speed = pd.mode === 'buckling' ? 1.4 : 0.5;
      const lin = kick.clone().multiplyScalar(m * speed * (0.7 + Math.random() * 0.6));
      // apply at the end nearest the break
      const c = new THREE.Vector3(...p.def.pos);
      const toBreak = pt.clone().sub(c);
      const at = c.addScaledVector(toBreak, 0.9);
      rb.applyImpulseAtPoint({ x: lin.x, y: lin.y, z: lin.z }, { x: at.x, y: at.y, z: at.z }, true);
    }
    for (const id of debrisIds) {
      const p = this.parts.get(id)!;
      const rb = p.body.rb;
      const out = new THREE.Vector3(...p.def.pos).sub(pt).normalize().multiplyScalar(0.8 + Math.random() * 1.6);
      out.y += Math.random() * 0.8;
      rb.setLinvel({ x: rb.linvel().x + out.x, y: rb.linvel().y + out.y, z: rb.linvel().z + out.z }, true);
      rb.setAngvel({ x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 12 }, true);
    }
    // ductile hinge: a plastic joint that keeps the halves together while they fold
    if (res.hinge && newIds[res.hinge.a] && newIds[res.hinge.b]) {
      const hw = new THREE.Vector3(...rotVec(def.quat, res.hinge.point)).add(new THREE.Vector3(...def.pos));
      this.addHinge(newIds[res.hinge.a], newIds[res.hinge.b], hw, res.hinge.Mp, res.hinge.maxAngle);
    }
    this.effects(part, res.style, pt, pd);
  }

  /**
   * Swap a part for the pieces it broke (or was cut) into. Its bonds go to whichever piece now
   * holds them (`owner` maps a point in the old part's frame to a piece index, -1 = none) and
   * every affected body is rebuilt, inheriting the old body's motion.
   */
  private replaceWithPieces(part: SimPart, pieces: PartDef[], owner: (lp: Vec3T) => number, debris: PartDef[]): { newIds: string[]; debrisIds: string[] } {
    const def = part.def;
    const oldBody = part.body;
    const inherit = this.inheritFrom(oldBody);
    const neighbours = new Set([...oldBody.parts].filter((i) => i !== def.id));
    // pieces a saw cut had already removed are dropped
    const real = pieces.map((p) => volume(p) > 1e-8);
    // retire the original
    this.removePart(def.id, false);
    // re-home its bonds
    const qi: [number, number, number, number] = [-def.quat[0], -def.quat[1], -def.quat[2], def.quat[3]];
    for (const b of [...this.bonds.values()]) {
      if (b.a !== def.id && b.b !== def.id) continue;
      this.bonds.delete(b.key);
      // centroid in the original part's frame
      let cLocal: Vec3T;
      if (b.a === def.id) cLocal = b.centroid;
      else {
        const pa = this.parts.get(b.a);
        if (!pa) continue;
        const w = rotVec(pa.def.quat, b.centroid);
        const wp: Vec3T = [w[0] + pa.def.pos[0], w[1] + pa.def.pos[1], w[2] + pa.def.pos[2]];
        cLocal = rotVec(qi, [wp[0] - def.pos[0], wp[1] - def.pos[1], wp[2] - def.pos[2]]);
      }
      const k = owner(cLocal);
      if (k < 0 || !pieces[k] || !real[k]) continue;
      const piece = pieces[k];
      if (b.a === def.id) {
        // patch stored in a's frame: move into the piece's frame (same rotation, shifted origin)
        const off = rotVec(qi, [piece.pos[0] - def.pos[0], piece.pos[1] - def.pos[1], piece.pos[2] - def.pos[2]]);
        const sh = (p: Vec3T): Vec3T => [p[0] - off[0], p[1] - off[1], p[2] - off[2]];
        const nb: Bond = { ...b, a: piece.id, pts: b.pts.map(sh), centroid: sh(b.centroid), key: pairKey(piece.id, b.b) };
        this.bonds.set(nb.key, nb);
      } else {
        const nb: Bond = { ...b, b: piece.id, key: pairKey(b.a, piece.id) };
        this.bonds.set(nb.key, nb);
      }
    }
    // new parts
    const newIds: string[] = [];
    pieces.forEach((p, i) => {
      if (!real[i]) {
        newIds.push('');
        return;
      }
      // after a few generations, or when tiny, fragments are just rubble
      const tiny = Math.max(...p.size) < 0.08 || (p.gen ?? 0) >= 3;
      newIds.push(this.addPart(tiny ? { ...p, debris: true } : p, tiny));
    });
    const debrisIds: string[] = [];
    for (const d of debris) debrisIds.push(this.addPart({ ...d, debris: true }, true));
    this.rebuild([...neighbours, ...newIds.filter(Boolean)], inherit);
    for (const id of debrisIds) this.rebuild([id], inherit);
    return { newIds, debrisIds };
  }

  /** a plastic hinge (ductile metal folding) between two parts at a world point */
  private addHinge(aId: string, bId: string, at: THREE.Vector3, Mp: number, maxAngle: number) {
    const pa = this.parts.get(aId), pb = this.parts.get(bId);
    if (!pa || !pb || pa.body === pb.body) return;
    const toBody = (b: SimBody) => {
      const t = v3(b.rb.translation()), q = q4(b.rb.rotation()).invert();
      const l = at.clone().sub(t).applyQuaternion(q);
      return { x: l.x, y: l.y, z: l.z };
    };
    const jd = RAPIER.JointData.spherical(toBody(pa.body), toBody(pb.body));
    const joint = this.world.createImpulseJoint(jd, pa.body.rb, pb.body.rb, true);
    joint.setContactsEnabled(false);
    const qa = q4(pa.body.rb.rotation()).multiply(pa.lq), qb = q4(pb.body.rb.rotation()).multiply(pb.lq);
    this.hinges.push({ joint, a: pa.def.id, b: pb.def.id, Mp, maxAngle, q0: qa.invert().multiply(qb) });
  }

  private effects(part: SimPart, style: string, pt: THREE.Vector3, pd: Pending) {
    const m = part.mat;
    const he = halfExtents(part.def);
    const size = Math.min(0.06, Math.max(0.008, Math.min(...he.filter((x) => x > 0)) * 0.6));
    const mass = this.partMass(part);
    const k = Math.min(1, 0.35 + Math.log10(1 + mass * 10) / 4);
    const verb: Record<string, string> = {
      splinter: 'snapped',
      shatter: 'shattered',
      dice: 'burst into fragments',
      crumble: 'cracked apart',
      bend: 'buckled and bent (plastic hinge)',
      crush: 'was crushed',
      tear: 'tore',
    };
    const how = pd.kind === 'bearing' ? (style === 'crush' ? 'was crushed under the load' : 'cracked under the concentrated load') : `${verb[style] ?? 'failed'}`;
    if (this.notable(part)) this.log(`${part.def.name} ${how} (${MODE_LABEL[pd.mode].toLowerCase()}, ${(pd.U * 100).toFixed(0)}%)`, 'fail');
    switch (style) {
      case 'splinter':
        this.particles.debris(pt, 26, m.visual.color, 'splinter', size, 2.2);
        this.particles.debris(pt, 14, m.visual.color2 ?? m.visual.color, 'chip', size * 0.6, 1.6);
        this.particles.dustCloud(pt, 10, '#d8c6a0', 0.05, 0.4);
        sound.fracture('wood', k);
        break;
      case 'shatter':
      case 'dice':
        this.particles.debris(pt, style === 'dice' ? 160 : 70, '#dff4ee', style === 'dice' ? 'cube' : 'shard', style === 'dice' ? 0.012 : 0.03, 2.6);
        sound.fracture('glass', k);
        break;
      case 'crumble':
        this.particles.debris(pt, 30, m.visual.color, 'chunk', size, 2.0);
        this.particles.dustCloud(pt, 30, m.visual.color2 ?? m.visual.color, 0.15, 1);
        sound.fracture(m.sound === 'metal' ? 'stone' : 'stone', k);
        break;
      case 'bend':
        this.particles.sparksAt(pt, 6);
        sound.fracture(m.sound === 'metal' ? 'metal' : 'plastic', k);
        break;
      case 'crush':
        this.particles.debris(pt, 30, m.visual.color, 'chip', 0.008, 1.2);
        sound.fracture('soft', k);
        break;
      default:
        sound.fracture(m.sound, k);
    }
    this.app.viewport.addShake(Math.min(0.03, 0.004 + mass / 20000));
  }

  // ------------------------------------------------------------------ part bookkeeping

  private addPart(def: PartDef, debris: boolean): string {
    const view = new PartView(def);
    view.update(def);
    this.app.views.set(def.id, view);
    this.app.viewport.partsRoot.add(view.group);
    this.parts.set(def.id, {
      def, mat: getMaterial(def.material), body: this.worldBody, lp: new THREE.Vector3(), lq: new THREE.Quaternion(), collider: null, view,
      debris, alive: true, pending: false, yielded: false, bornAt: this.time,
    });
    if (debris) {
      this.debrisCount++;
      if (this.debrisCount > 260) this.cullDebris();
    }
    return def.id;
  }

  private cullDebris() {
    const list = [...this.parts.values()].filter((p) => p.debris && p.alive).sort((a, b) => a.bornAt - b.bornAt);
    for (const p of list.slice(0, 40)) this.removePart(p.def.id);
  }

  private removePart(id: string, rebuildBody = true) {
    const p = this.parts.get(id);
    if (!p || !p.alive) return;
    p.alive = false;
    if (p.debris) this.debrisCount--;
    const body = p.body;
    if (p.collider) {
      this.colliderPart.delete(p.collider.handle);
      this.world.removeCollider(p.collider, true);
      p.collider = null;
    }
    body.parts.delete(id);
    if (!body.world && body.parts.size === 0 && this.bodies.has(body.rb.handle)) {
      this.bodies.delete(body.rb.handle);
      this.world.removeRigidBody(body.rb);
    } else if (!body.world && rebuildBody) {
      this.rebuild([...body.parts], this.inheritFrom(body));
    }
    this.app.viewport.partsRoot.remove(p.view.group);
    p.view.dispose();
    this.app.views.delete(id);
    this.parts.delete(id);
  }

  /** original parts and sizeable fragments are worth a log line */
  private notable(p: SimPart): boolean {
    return !p.def.parentId || Math.max(...p.def.size) >= 0.15;
  }

  private log(text: string, level: 'info' | 'warn' | 'fail' | 'ok') {
    this.app.addLog(text, level, this.time);
  }

  // ------------------------------------------------------------------ workshop tools

  /** a live part (with its current pose) */
  partDef(id: string): PartDef | undefined {
    const p = this.parts.get(id);
    return p && p.alive ? p.def : undefined;
  }

  get sawing(): boolean {
    return !!this.saw;
  }

  /** how the current saw job is going (for the overlay) */
  sawStatus(): { partId: string; progress: number; U: number; seconds: number } | null {
    const j = this.saw;
    if (!j) return null;
    return { partId: j.partId, progress: Math.min(1, (this.time - j.start) / j.duration), U: j.lastU, seconds: j.duration };
  }

  /** bonded joints of a part, for the pry bar */
  bondsOf(id: string): LiveBond[] {
    const out: LiveBond[] = [];
    for (const b of this.bonds.values()) {
      if (b.a !== id && b.b !== id) continue;
      const a = this.parts.get(b.a);
      if (!a || !a.alive) continue;
      const w = rotVec(a.def.quat, b.centroid);
      out.push({ key: b.key, a: b.a, b: b.b, joint: b.joint, centroid: [w[0] + a.def.pos[0], w[1] + a.def.pos[1], w[2] + a.def.pos[2]] });
    }
    return out;
  }

  /** pry two bonded parts apart (they keep touching, but nothing holds them together any more) */
  breakBond(key: string): string | null {
    const b = this.bonds.get(key);
    if (!b) return 'Those parts are not joined';
    if (b.joint === 'rigid') return 'An unbreakable joint cannot be pried apart';
    const a = this.parts.get(b.a);
    if (!a || !a.alive) return 'That part is gone';
    const w = rotVec(a.def.quat, b.centroid);
    const at = new THREE.Vector3(w[0] + a.def.pos[0], w[1] + a.def.pos[1], w[2] + a.def.pos[2]);
    this.bonds.delete(key);
    const inherit = this.inheritFrom(a.body);
    const ids = new Set([...a.body.parts]);
    const o = this.parts.get(b.b);
    if (o && o.body === a.body) for (const i of o.body.parts) ids.add(i);
    if (a.body.world) for (const i of this.worldBody.parts) if (!this.parts.get(i)!.def.anchored) ids.add(i);
    this.rebuild([...ids], inherit);
    this.signatures.clear();
    sound.join('rest');
    this.particles.dustCloud(at, 6, '#cfc6b4', 0.05, 0.3);
    const otherName = b.b === GROUND_ID ? 'the floor' : o?.def.name ?? '?';
    this.log(`Pried ${a.def.name} off ${otherName}: the ${b.joint === 'glue' ? 'glue' : b.joint} joint is gone`, 'warn');
    return null;
  }

  // ---- the saw

  /** start cutting a part along `aim` (computed on its current pose). Returns an error, or null. */
  startSaw(partId: string, aim: CutAim, cutter: Cutter): string | null {
    if (this.saw) return 'Already cutting';
    const p = this.parts.get(partId);
    if (!p || !p.alive) return 'That part is gone';
    const def = p.def;
    if (cutter.refuse) {
      // scoring tempered glass releases its built-in stress
      const local = toLocal(def, aim.entry[0], aim.entry[1], aim.entry[2]);
      this.log(`Scoring ${def.name} released its tempering stress: the whole pane burst`, 'fail');
      p.pending = false;
      this.fracturePart(p, { at: this.time, partId, kind: 'member', mode: 'tension', U: 1, a: local[0], b: local[2], dir: 0, local, message: '' }, new THREE.Vector3(...aim.entry));
      return null;
    }
    const qi: [number, number, number, number] = [-def.quat[0], -def.quat[1], -def.quat[2], def.quat[3]];
    const job: SawJob = {
      partId, cutter, nl: aim.nl, sl: aim.sl,
      entryL: toLocal(def, aim.entry[0], aim.entry[1], aim.entry[2]),
      feedL: rotVec(qi, aim.feed), lineL: rotVec(qi, aim.line),
      depth: aim.depth, width: aim.width, area: aim.area,
      start: this.time,
      duration: cutter.kind === 'glasscutter' ? 0.9 : Math.max(0.9, Math.min(7, cutSeconds(cutter, aim.area) * 0.6)),
      rig: new SawRig(cutter.kind), nextFx: 0, nextStroke: 0, nextCheck: this.time + 0.05, lig: null, creaked: false, lastU: 0, lastT: this.time,
    };
    job.lig = this.prepareLigament(p, aim);
    this.app.viewport.fxRoot.add(job.rig.group);
    this.saw = job;
    if (cutter.kind === 'grinder' || cutter.kind === 'diamond') sound.grinderStart(cutter.kind === 'grinder' ? 'metal' : 'stone', Math.min(1, 0.25 / Math.max(0.05, cutter.rate * 1e4)));
    if (cutter.kind === 'glasscutter') sound.glassScore();
    this.log(`Cutting ${def.name} with a ${cutter.name} (${(aim.area * 1e4).toFixed(1)} cm² to cut)`, 'info');
    return null;
  }

  /** internal forces in a member where it is being cut, from a fresh analysis of its structure */
  private prepareLigament(p: SimPart, aim: CutAim): LigamentCheck | null {
    const cls = classifyPart(p.def);
    if (cls.kind !== 'beam' || p.def.anchored || p.debris) return null;
    const a = cls.axis;
    // a cut along the member (a rip) doesn't sever its cross-section
    if (Math.abs(aim.nl[a]) < 0.7) return null;
    const island = this.islandOf(p.def.id);
    if (island.length > 60) return null;
    const res = this.analyzeParts(island);
    if (!res || res.status === 'unstable') return null;
    const pi = res.model.partIndex.get(p.def.id);
    if (pi === undefined) return null;
    const info = res.model.parts[pi];
    const st = aim.sl / aim.nl[a];
    let ei = info.elems[0];
    for (const e of info.elems) {
      const el = res.model.elements[e];
      if (st >= Math.min(el.a1, el.a2) - 1e-9 && st <= Math.max(el.a1, el.a2) + 1e-9) {
        ei = e;
        break;
      }
    }
    if (ei === undefined) return null;
    const el = res.model.elements[ei];
    const u = res.result.u;
    const ue = new Float64Array(12);
    for (let k = 0; k < 6; k++) {
      ue[k] = u[6 * el.n1 + k];
      ue[k + 6] = u[6 * el.n2 + k];
    }
    const s = el.sec;
    const kl = beamLocalK(el.str.E, el.str.G, s.A, s.Iy, s.Iz, s.J, el.L, s.Asy, s.Asz);
    const f = matVec12(kl, vecToLocal12(el.R, ue));
    const x = Math.max(0, Math.min(el.L, st - el.a1));
    // stress resultants on the cut face (left segment's free body)
    const e2 = p.def.kind === 'cylinder' || p.def.kind === 'tube' ? 2 : (a + 1) % 3;
    const e3 = p.def.kind === 'cylinder' || p.def.kind === 'tube' ? 0 : (a + 2) % 3;
    return {
      e2, e3,
      N: -f[0], My: -f[4] - x * f[2], Mz: -f[5] + x * f[1], V: Math.hypot(f[1], f[2]),
      ft: el.str.ft, fc: el.str.fc, fm: el.str.fm, fv: el.str.fv, ductile: el.ductile,
    };
  }

  /** utilisation of the uncut ligament once the blade is `prog` of the way through */
  private ligamentU(p: SimPart, j: SawJob, prog: number): { U: number; mode: FailMode; A: number; depthLeft: number } {
    const lc = j.lig!;
    const L = ligament(p.def, { nl: j.nl, sl: j.sl }, j.feedL, j.entryL, j.depth, prog, lc.e2, lc.e3);
    const depthLeft = (1 - prog) * j.depth;
    if (L.A < 1e-9) return { U: Infinity, mode: 'tension', A: 0, depthLeft };
    const My = lc.My - L.zc * lc.N, Mz = lc.Mz + L.yc * lc.N;
    const det = L.Iyy * L.Izz - L.Iyz * L.Iyz;
    let alpha = 0, beta = 0;
    if (det > 1e-30) {
      alpha = (-Mz * L.Izz - L.Iyz * My) / det;
      beta = (L.Iyy * My + L.Iyz * Mz) / det;
    }
    const s0 = lc.N / L.A;
    let smax = -Infinity, smin = Infinity;
    for (let i = 0; i < L.cells.length; i += 3) {
      const sg = s0 + alpha * (L.cells[i] - L.yc) + beta * (L.cells[i + 1] - L.zc);
      smax = Math.max(smax, sg);
      smin = Math.min(smin, sg);
    }
    const sigM = Math.max(Math.abs(smax - s0), Math.abs(smin - s0));
    const bf = sigM / (Math.abs(s0) + sigM + 1e-30);
    const fm = lc.ductile ? lc.fm * 1.5 : lc.fm;
    const ft = (1 - bf) * lc.ft + bf * fm, fc = (1 - bf) * lc.fc + bf * Math.max(lc.fc, fm);
    const Ut = Math.max(0, smax) / ft, Uc = Math.max(0, -smin) / fc, Uv = (1.5 * lc.V) / L.A / lc.fv;
    let U = Ut, mode: FailMode = bf > 0.5 ? 'bending' : 'tension';
    if (Uc > U) {
      U = Uc;
      mode = bf > 0.5 ? 'bending' : 'compression';
    }
    if (Uv > U) {
      U = Uv;
      mode = 'shear';
    }
    return { U, mode, A: L.A, depthLeft };
  }

  private updateSaw(dt: number) {
    const j = this.saw;
    if (!j) return;
    const p = this.parts.get(j.partId);
    if (!p || !p.alive) {
      this.endSaw('The part being cut broke away');
      return;
    }
    if (!p.body.world && v3(p.body.rb.linvel()).length() > 1.5) {
      this.endSaw(`The ${j.cutter.name} jumped out of the cut as ${p.def.name} moved`);
      return;
    }
    const prog = Math.min(1, (this.time - j.start) / j.duration);
    const d = p.def;
    const W = (lp: Vec3T) => new THREE.Vector3(...rotVec(d.quat, lp)).add(new THREE.Vector3(...d.pos));
    const D = (v: Vec3T) => new THREE.Vector3(...rotVec(d.quat, v));
    const feedW = D(j.feedL), lineW = D(j.lineL), nW = D(j.nl);
    const dl = prog * j.depth;
    const edge = W([j.entryL[0] + j.feedL[0] * dl, j.entryL[1] + j.feedL[1] * dl, j.entryL[2] + j.feedL[2] * dl]);
    j.rig.place(edge, lineW, feedW.clone().negate(), nW);
    j.rig.animate(dt, j.width, prog, true);
    if (this.time >= j.nextFx) {
      j.nextFx = this.time + 0.035;
      this.sawFx(j, edge, lineW, feedW, dl);
    }
    const k = j.cutter.kind;
    if ((k === 'handsaw' || k === 'finesaw' || k === 'hacksaw' || k === 'knife') && this.time >= j.nextStroke) {
      j.nextStroke = this.time + 1 / (2 * 2.2);
      sound.sawStroke(j.cutter.fx === 'snow' ? 'snow' : k, j.rig.strokePhase() > 0, Math.min(1, 0.6 / Math.max(0.1, j.cutter.rate * 1e4)));
    }
    if (j.lig && this.time >= j.nextCheck) {
      j.nextCheck = this.time + 0.05;
      const r = this.ligamentU(p, j, prog);
      j.lastU = r.U;
      if (r.U > 0.75 && !j.creaked) {
        j.creaked = true;
        sound.creak(p.mat.sound, 0.7);
        this.log(`${d.name} creaks: the uncut ${(r.depthLeft * 100).toFixed(1)} cm is nearly at its limit`, 'warn');
      }
      if (r.U >= 1) {
        this.finishSaw(p, j, r);
        return;
      }
    }
    if (prog >= 1) this.finishSaw(p, j, null);
  }

  /** chips, dust and sparks flying out of the kerf */
  private sawFx(j: SawJob, edge: THREE.Vector3, line: THREE.Vector3, feed: THREE.Vector3, dl: number) {
    const c = j.cutter;
    const mouth = edge.clone().addScaledVector(feed, -dl);
    const at = (Math.random() < 0.5 ? mouth : edge).clone().addScaledVector(line, (Math.random() - 0.5) * j.width * 0.8);
    const out = feed.clone().negate();
    switch (c.fx) {
      case 'sawdust':
        this.particles.debris(at, 2, c.color, 'chip', 0.0035, 0.5, out);
        if (Math.random() < 0.5) this.particles.dustCloud(at, 1, c.color, 0.01, 0.12);
        break;
      case 'sparks':
        this.particles.sparksAt(edge, j.cutter.color === '#d8692e' ? 3 : 7, { color: c.color, dir: line.clone().multiplyScalar(-1).addScaledVector(out, 0.35), speed: 6, life: c.color === '#d8692e' ? 0.5 : 1 });
        break;
      case 'dust':
        this.particles.dustCloud(at, 3, c.color, 0.015, 0.5);
        break;
      case 'shavings':
        this.particles.debris(at, 2, c.color, 'chip', 0.0025, 0.4, out);
        break;
      case 'crumbs':
        this.particles.debris(at, 2, c.color, 'chunk', 0.003, 0.4, out);
        break;
      case 'snow':
        this.particles.dustCloud(at, 2, c.color, 0.01, 0.2);
        this.particles.debris(at, 1, c.color, 'chip', 0.003, 0.4, out);
        break;
      case 'glitter':
        if (Math.random() < 0.3) this.particles.debris(at, 1, '#e8fbff', 'shard', 0.002, 0.15);
        break;
    }
  }

  private finishSaw(p: SimPart, j: SawJob, snap: { U: number; mode: FailMode; A: number; depthLeft: number } | null) {
    const def = p.def;
    const prog = Math.min(1, (this.time - j.start) / j.duration);
    const dl = prog * j.depth;
    const edgeL: Vec3T = [j.entryL[0] + j.feedL[0] * dl, j.entryL[1] + j.feedL[1] * dl, j.entryL[2] + j.feedL[2] * dl];
    const ew = rotVec(def.quat, edgeL);
    const edge = new THREE.Vector3(ew[0] + def.pos[0], ew[1] + def.pos[1], ew[2] + def.pos[2]);
    const nW = rotVec(def.quat, j.nl);
    const sW = j.sl + nW[0] * def.pos[0] + nW[1] * def.pos[1] + nW[2] * def.pos[2];
    const seconds = this.time - j.start;
    this.endSaw();
    const res = cutPart(def, nW, sW, j.cutter.kerf);
    if (!res) return;
    const bigFirst = volume(res.neg) >= volume(res.pos);
    const pieces = [res.neg, res.pos].map((q, i) => ({ ...q, id: newId('s'), name: (i === 0) === bigFirst ? def.name : `${def.name} offcut` }));
    const owner = (lp: Vec3T) => (j.nl[0] * lp[0] + j.nl[1] * lp[1] + j.nl[2] * lp[2] < j.sl ? 0 : 1);
    const { newIds } = this.replaceWithPieces(p, pieces, owner, []);
    this.signatures.clear();
    if (snap) {
      const pd: Pending = { at: this.time, partId: def.id, kind: 'member', mode: snap.mode, U: snap.U, a: 0, b: 0, dir: 0, local: edgeL, message: '' };
      if (p.mat.ductile && newIds[0] && newIds[1]) {
        // the last of the steel yields and folds instead of letting go
        const fy = p.mat.fy ?? p.mat.ft;
        this.addHinge(newIds[0], newIds[1], edge, (fy * snap.A * Math.max(0.002, snap.depthLeft)) / 4, 1.4);
      }
      this.effects(p, p.mat.ductile ? 'bend' : p.mat.failure, edge, pd);
      this.log(`${def.name} gave way ${(prog * 100).toFixed(0)}% of the way through the cut: the last ${(snap.A * 1e4).toFixed(1)} cm² could not carry the load`, 'fail');
    } else {
      if (j.cutter.kind === 'glasscutter') sound.glassSnap();
      else sound.impact(p.mat.sound, 0.15, 0.1);
      this.log(`${j.cutter.verb[0].toUpperCase()}${j.cutter.verb.slice(1)} through ${def.name} in ${seconds.toFixed(1)} s`, 'ok');
    }
  }

  private endSaw(msg?: string) {
    const j = this.saw;
    if (!j) return;
    j.rig.dispose();
    sound.grinderStop();
    this.saw = null;
    if (msg) this.log(msg, 'warn');
  }

  // ---- the hammer

  /** swing a hammer so that it hits `point`, travelling along `dir` */
  strike(point: THREE.Vector3, dir: THREE.Vector3, kind: HammerKind, handle: THREE.Vector3, target: string) {
    if (this.strikes.length > 2) return;
    const rig = new HammerRig(kind);
    this.app.viewport.fxRoot.add(rig.group);
    const d = dir.clone().normalize();
    rig.pose(point, d, handle, 1.3);
    this.strikes.push({ rig, spec: HAMMERS[kind], point: point.clone(), dir: d, handle: handle.clone(), start: this.time, headId: null, target });
    sound.whoosh();
  }

  private updateStrikes() {
    if (!this.strikes.length) return;
    const SWING = 0.16;
    const keep: StrikeJob[] = [];
    for (const s of this.strikes) {
      const t = this.time - s.start;
      if (t < SWING) {
        const k = t / SWING;
        s.rig.pose(s.point, s.dir, s.handle, 1.3 * (1 - k * k));
        keep.push(s);
        continue;
      }
      if (s.headId === null) {
        // the head arrives: an invisible steel slug of the head's mass, at the head's speed
        const r = Math.cbrt((3 * s.spec.mass) / (4 * Math.PI * 7850));
        const c = s.point.clone().addScaledVector(s.dir, -(r + 0.003));
        const def: PartDef = { id: newId('hammer'), name: s.spec.name, kind: 'sphere', size: [2 * r, 2 * r, 2 * r], pos: [c.x, c.y, c.z], quat: [0, 0, 0, 1], material: 'steel', parentId: 'projectile' };
        const id = this.addPart(def, false);
        const hp = this.parts.get(id)!;
        hp.bornAt = 0;
        hp.view.group.visible = false;
        this.rebuild([id], null);
        const v = s.dir.clone().multiplyScalar(s.spec.speed);
        hp.body.rb.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
        hp.body.rb.enableCcd(true);
        s.headId = id;
        const tn = this.parts.get(s.target)?.def.name ?? 'it';
        this.log(`Hit ${tn} with a ${s.spec.name.toLowerCase()} (${s.spec.mass} kg head at ${s.spec.speed} m/s)`, 'info');
      }
      const after = t - SWING;
      s.rig.pose(s.point, s.dir, s.handle, 0.35 * Math.sin((Math.min(1, after / 0.25) * Math.PI) / 2));
      if (after > 0.12 && s.headId) {
        this.removePart(s.headId);
        s.headId = '';
      }
      if (after > 0.3) s.rig.setOpacity(Math.max(0, 1 - (after - 0.3) / 0.25));
      if (after > 0.55) {
        if (s.headId) this.removePart(s.headId);
        s.rig.dispose();
        continue;
      }
      keep.push(s);
    }
    this.strikes = keep;
  }

  // ---- the hand

  startPush(partId: string, at: THREE.Vector3) {
    const p = this.parts.get(partId);
    if (!p || !p.alive) return;
    this.push = { partId, local: toLocal(p.def, at.x, at.y, at.z), target: at.clone(), point: at.clone(), force: new THREE.Vector3(), nextCheck: this.time + 0.25 };
  }

  movePush(target: THREE.Vector3) {
    if (this.push) this.push.target.copy(target);
  }

  endPush() {
    this.push = null;
  }

  pushInfo(): { point: THREE.Vector3; target: THREE.Vector3; force: number } | null {
    const s = this.push;
    return s ? { point: s.point, target: s.target, force: s.force.length() } : null;
  }

  private applyPush() {
    const s = this.push;
    if (!s) return;
    const p = this.parts.get(s.partId);
    if (!p || !p.alive) {
      this.push = null;
      return;
    }
    const local = new THREE.Vector3(...s.local);
    let gp: THREE.Vector3;
    let vel = new THREE.Vector3();
    if (p.body.world) {
      gp = local.applyQuaternion(new THREE.Quaternion(...p.def.quat)).add(new THREE.Vector3(...p.def.pos));
    } else {
      const rb = p.body.rb;
      const q = q4(rb.rotation());
      gp = local.applyQuaternion(p.lq).add(p.lp).applyQuaternion(q).add(v3(rb.translation()));
      vel = v3(rb.linvel()).add(new THREE.Vector3().crossVectors(v3(rb.angvel()), gp.clone().sub(v3(rb.worldCom()))));
    }
    s.point.copy(gp);
    const k = 1500;
    const m = p.body.world ? 80 : Math.min(p.body.mass, 80);
    const F = s.target.clone().sub(gp).multiplyScalar(k).addScaledVector(vel, -2 * Math.sqrt(k * m));
    if (F.length() > PUSH_MAX) F.setLength(PUSH_MAX);
    s.force.copy(F);
    if (p.body.world) return;
    const J = F.clone().multiplyScalar(H);
    const maxJ = p.body.mass * 2.5;
    if (J.length() > maxJ) J.setLength(maxJ);
    p.body.rb.applyImpulseAtPoint({ x: J.x, y: J.y, z: J.z }, { x: gp.x, y: gp.y, z: gp.z }, true);
  }

  /** a sustained push is a load on the structure: check it every so often */
  private checkPush() {
    const s = this.push;
    if (!s || this.time < s.nextCheck) return;
    s.nextCheck = this.time + 0.25;
    if (s.force.length() < 25) return;
    const p = this.parts.get(s.partId);
    if (!p || !p.alive || p.debris || p.pending) return;
    const island = this.islandOf(s.partId);
    if (island.length > 60) return;
    const calm = island.every((i) => {
      const b = this.parts.get(i)!.body;
      return b.world || v3(b.rb.linvel()).length() < 0.4;
    });
    if (!calm) return;
    const res = this.analyzeParts(island, { loads: [{ part: s.partId, point: [s.point.x, s.point.y, s.point.z], force: [s.force.x, s.force.y, s.force.z] }] });
    if (res) this.schedule(res, 0.12, `your push of ${s.force.length().toFixed(0)} N`);
  }

  // ------------------------------------------------------------------ interaction

  throwBall(ray: THREE.Ray) {
    const r = 0.0534;
    const start = ray.origin.clone().addScaledVector(ray.direction, 0.5);
    if (start.y < r) start.y = r + 0.01;
    const def: PartDef = { id: newId('ball'), name: 'Steel ball', kind: 'sphere', size: [2 * r, 2 * r, 2 * r], pos: [start.x, start.y, start.z], quat: [0, 0, 0, 1], material: 'steel', parentId: 'projectile' };
    const id = this.addPart(def, false);
    this.rebuild([id], null);
    const p = this.parts.get(id)!;
    // a projectile's impacts count from the first moment (unlike fresh fragments)
    p.bornAt = 0;
    const v = ray.direction.clone().multiplyScalar(24);
    p.body.rb.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    p.body.rb.enableCcd(true);
    sound.whoosh();
    this.log('Threw a 5 kg steel ball at 24 m/s', 'info');
  }

  dispose() {
    this.disposed = true;
    this.endSaw();
    for (const s of this.strikes) s.rig.dispose();
    this.strikes = [];
    this.push = null;
    try {
      this.queue.free();
      this.world.free();
    } catch {
      /* already freed */
    }
    this.particles.clear();
    this.app.viewport.fxRoot.remove(this.particles.root);
  }
}

/** warm up the physics engine (WASM) so the first Simulate press is instant */
export function preloadPhysics(): Promise<void> {
  return initRapier();
}

export async function createSimulation(app: App): Promise<App['sim']> {
  await initRapier();
  const sim = new Simulation(app);
  sim.start();
  return sim;
}
