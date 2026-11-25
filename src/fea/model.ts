import type { ContactPatch } from '../core/contacts';
import { GROUND_ID, type JointType, type PartDef, type Vec3T } from '../core/design';
import { jointCapacity } from '../core/joints';
import {
  bearingStrength, getMaterial, GROUND_MATERIAL, strengthsFor, type Material, type Strengths,
} from '../core/materials';
import { geomOf, hasRound, sectionFactors, type RoundGeom } from '../core/rounding';
import { axisWorld, clippedPolytope, grainAxis, halfExtents, isShaped, qRotate, sdfLocal, toLocal, volume } from '../core/shapes';
import { circleSection, rectSection, stripSection, tubeSection, type Section } from './sections';

export const GRAVITY = 9.81;

export type MemberKind = 'beam' | 'plate' | 'block';

export interface FEElement {
  part: number;
  n1: number;
  n2: number;
  L: number;
  /** 3x3 row-major, rows = local axes (e1 = member axis, e2, e3) in global coordinates */
  R: Float64Array;
  sec: Section;
  str: Strengths;
  ductile: boolean;
  /** plate strips: 0 = along u, 1 = along v */
  plateDir?: number;
  /** local coordinates of the two ends (beam: station along axis; plate: (u,v) of ends) */
  a1: number;
  a2: number;
  b1: number;
  b2: number;
}

export interface FEContactPoint {
  patch: number;
  nA: number;
  /** -1 = ground / anchored support */
  nB: number;
  rA: Vec3T;
  rB: Vec3T;
  n: Vec3T;
  kn: number;
  kt: number;
  bonded: boolean;
  isCenter: boolean;
  area: number;
  capT: number;
  capV: number;
  /** bearing strength of each side (Pa) */
  bearA: number;
  bearB: number;
  point: Vec3T;
}

export interface FEPatchInfo {
  patch: ContactPatch;
  joint: JointType;
  effectiveJoint: JointType;
  partA: number;
  /** -1 for ground or anchored parts */
  partB: number;
  bId: string;
  matA: Material;
  matB: Material;
  points: number[];
  capT: number;
  capV: number;
  friction: number;
  hertz?: { R: number; Estar: number };
  /** plate punched by a concentrated load: which side is the plate (0 none, 1 = A, 2 = B) */
  punchPlate: 0 | 1 | 2;
  punchPerimeter: number;
  bearingAlongA: boolean;
  bearingAlongB: boolean;
}

export interface FEPartInfo {
  def: PartDef;
  mat: Material;
  kind: MemberKind;
  /** beam axis / plate normal (local index); -1 for blocks */
  axis: number;
  uAxis: number;
  vAxis: number;
  stations: number[];
  gridU: number[];
  gridV: number[];
  /** plate: node index per (iu, iv) cell, row-major iu * nv + iv; -1 masked */
  grid: Int32Array;
  nodes: number[];
  elems: number[];
  mass: number;
  length: number;
  /** solid wood plates: in-plane axis index (local) of the grain */
  grainAxis: number;
  disk: boolean;
}

export interface FEModel {
  nodePos: Float64Array;
  nodePart: Int32Array;
  nodeMass: Float64Array;
  nodeCount: number;
  elements: FEElement[];
  contacts: FEContactPoint[];
  patches: FEPatchInfo[];
  parts: FEPartInfo[];
  partIndex: Map<string, number>;
  load: Float64Array;
  totalWeight: number;
  probe: FEProbe | null;
  /** loads are inertia-balanced (a free body): the solver pins each piece at one node */
  relief: boolean;
}

export interface ExternalLoad {
  part: string;
  point: Vec3T;
  force: Vec3T;
}

export interface BuildInput {
  parts: PartDef[];
  patches: { patch: ContactPatch; joint: JointType }[];
  loads?: ExternalLoad[];
  gravity?: number;
  /**
   * Free body (no supports): gravity is ignored and the external loads are balanced by
   * d'Alembert inertial forces of the rigid-body acceleration they cause.
   */
  inertiaRelief?: boolean;
  /** unit-load compliance probe: flexibility of the structure at a point along dir */
  probe?: { part: string; point: Vec3T; dir: Vec3T };
}

export interface FEProbe {
  node: number;
  r: Vec3T;
  dir: Vec3T;
  /** full unit-load vector (6 per node), inertia-balanced for free bodies */
  load: Float64Array;
}

// ---------------------------------------------------------------------------------------------

export function classifyPart(def: PartDef): { kind: MemberKind; axis: number; uAxis: number; vAxis: number; disk: boolean } {
  const s = def.size;
  if (def.kind === 'sphere' || def.kind === 'hull') return { kind: 'block', axis: -1, uAxis: 0, vAxis: 2, disk: false };
  if (def.kind === 'cylinder' || def.kind === 'tube') {
    const D = s[0], L = s[1];
    if (L >= (def.kind === 'tube' ? 1.5 : 2) * D) return { kind: 'beam', axis: 1, uAxis: 0, vAxis: 2, disk: false };
    if (def.kind === 'cylinder' && D >= 2.2 * L) return { kind: 'plate', axis: 1, uAxis: 0, vAxis: 2, disk: true };
    return { kind: 'block', axis: -1, uAxis: 0, vAxis: 2, disk: false };
  }
  const idx = [0, 1, 2].sort((a, b) => s[b] - s[a]);
  if (s[idx[0]] >= 2.2 * s[idx[1]]) return { kind: 'beam', axis: idx[0], uAxis: 0, vAxis: 0, disk: false };
  if (s[idx[1]] >= 2.2 * s[idx[2]]) return { kind: 'plate', axis: idx[2], uAxis: idx[0], vAxis: idx[1], disk: false };
  return { kind: 'block', axis: -1, uAxis: 0, vAxis: 2, disk: false };
}

/** grain direction of a part (local axis index) for wood-like materials */
export function grainAxisOf(def: PartDef): number {
  return grainAxis(def);
}

/** a point (local) that a saw cut has removed, with some tolerance */
function cutAway(def: PartDef, lp: number[], tol: number): boolean {
  if (!isShaped(def)) return false;
  return sdfLocal(def, lp[0], lp[1], lp[2]) > tol;
}

const factorCache = new WeakMap<RoundGeom, ReturnType<typeof sectionFactors>>();

function minDim(def: PartDef): number {
  const h = halfExtents(def);
  return 2 * Math.min(h[0], h[1], h[2]);
}

function mergeStations(required: number[], base: number[], gap: number): number[] {
  const out: number[] = [];
  const req = [...required].sort((a, b) => a - b);
  for (const r of req) if (!out.some((o) => Math.abs(o - r) < gap)) out.push(r);
  for (const b of base) if (!out.some((o) => Math.abs(o - b) < gap)) out.push(b);
  return out.sort((a, b) => a - b);
}

function sectionFor(def: PartDef, axis: number): { sec: Section; e2: number; e3: number } {
  if (def.kind === 'cylinder') return { sec: circleSection(def.size[0]), e2: 2, e3: 0 };
  if (def.kind === 'tube') return { sec: tubeSection(def.size[0], def.wall ?? def.size[0] * 0.15), e2: 2, e3: 0 };
  const j = (axis + 1) % 3, k = (axis + 2) % 3;
  const sec = rectSection(def.size[j], def.size[k]);
  if (hasRound(def)) {
    // rounded / bevelled corners of the cross-section (a rounded leg) take material away
    const g = geomOf(def);
    if (!g.circle && g.up === axis && g.R.some((r) => r !== 0)) {
      let f = factorCache.get(g);
      if (!f) {
        f = sectionFactors(g);
        factorCache.set(g, f);
      }
      sec.A *= f.kA;
      sec.Asy *= f.kA;
      sec.Asz *= f.kA;
      sec.Iz *= f.kIu;
      sec.Iy *= f.kIv;
      sec.Wz *= f.kIu;
      sec.Wy *= f.kIv;
      sec.J *= f.kA * f.kA;
      sec.Wt *= f.kA ** 1.5;
      sec.rmin = Math.sqrt(Math.min(sec.Iy, sec.Iz) / sec.A);
    }
  }
  return { sec, e2: j, e3: k };
}

function rotRows(e1: Vec3T, e2: Vec3T): Float64Array {
  // orthonormalise e2 against e1, e3 = e1 x e2
  const d = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
  let x = e2[0] - d * e1[0], y = e2[1] - d * e1[1], z = e2[2] - d * e1[2];
  const l = Math.hypot(x, y, z) || 1;
  x /= l; y /= l; z /= l;
  const e3: Vec3T = [e1[1] * z - e1[2] * y, e1[2] * x - e1[0] * z, e1[0] * y - e1[1] * x];
  return Float64Array.from([e1[0], e1[1], e1[2], x, y, z, e3[0], e3[1], e3[2]]);
}

// ---------------------------------------------------------------------------------------------

export function buildModel(input: BuildInput): FEModel {
  const g = input.gravity ?? GRAVITY;
  const parts: FEPartInfo[] = [];
  const partIndex = new Map<string, number>();
  const defs = new Map<string, PartDef>();
  for (const d of input.parts) defs.set(d.id, d);

  // stations required by contacts, per part, in local coordinates
  const reqLocal = new Map<string, Vec3T[]>();
  const addReq = (id: string, p: Vec3T) => {
    const d = defs.get(id);
    if (!d || d.anchored) return;
    const arr = reqLocal.get(id) ?? [];
    arr.push(toLocal(d, p[0], p[1], p[2]));
    reqLocal.set(id, arr);
  };
  for (const { patch } of input.patches) {
    const large = Math.max(patch.extent[0], patch.extent[1]);
    const pts = large > 0.15 ? patch.points : [patch.centroid];
    for (const p of pts) {
      addReq(patch.a, p);
      if (patch.b !== GROUND_ID) addReq(patch.b, p);
    }
  }
  for (const l of input.loads ?? []) addReq(l.part, l.point);

  const nodePos: number[] = [];
  const nodePart: number[] = [];
  const nodeMass: number[] = [];
  const nodeGyr2: number[] = [];
  const elements: FEElement[] = [];
  const addNode = (pi: number, def: PartDef, lx: number, ly: number, lz: number, m: number, gyr2 = 0): number => {
    const o = [0, 0, 0];
    qRotate(def.quat, lx, ly, lz, o);
    nodePos.push(o[0] + def.pos[0], o[1] + def.pos[1], o[2] + def.pos[2]);
    nodePart.push(pi);
    nodeMass.push(m);
    nodeGyr2.push(gyr2);
    return nodePart.length - 1;
  };

  for (const def of input.parts) {
    if (def.anchored || def.debris) continue;
    const mat = getMaterial(def.material);
    const cls = classifyPart(def);
    const pi = parts.length;
    const mass = mat.density * volume(def);
    const info: FEPartInfo = {
      def, mat, kind: cls.kind, axis: cls.axis, uAxis: cls.uAxis, vAxis: cls.vAxis,
      stations: [], gridU: [], gridV: [], grid: new Int32Array(0), nodes: [], elems: [],
      mass, length: 0, grainAxis: grainAxisOf(def), disk: cls.disk,
    };
    parts.push(info);
    partIndex.set(def.id, pi);
    const req = reqLocal.get(def.id) ?? [];

    if (cls.kind === 'block') {
      const he = halfExtents(def);
      info.nodes.push(addNode(pi, def, 0, 0, 0, mass, (4 * (he[0] ** 2 + he[1] ** 2 + he[2] ** 2)) / 18));
      info.length = 2 * Math.max(...halfExtents(def));
      continue;
    }

    if (cls.kind === 'beam') {
      const a = cls.axis;
      // the member runs over the material that is actually there (a saw cut can shorten it)
      let lo = -def.size[a] / 2, hi = def.size[a] / 2;
      if (isShaped(def)) {
        const P = clippedPolytope(def);
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < P.v.length; i += 3) {
          mn = Math.min(mn, P.v[i + a]);
          mx = Math.max(mx, P.v[i + a]);
        }
        if (mx - mn > 1e-6) {
          lo = Math.max(lo, mn);
          hi = Math.min(hi, mx);
        }
      }
      const L = hi - lo;
      info.length = L;
      const { sec, e2, e3 } = sectionFor(def, a);
      void e3;
      const maxSec = Math.max(sec.dy, sec.dz);
      const nBase = Math.max(2, Math.min(14, Math.ceil(L / (2 * maxSec))));
      const base: number[] = [];
      for (let i = 0; i <= nBase; i++) base.push(lo + (L * i) / nBase);
      const required = [lo, hi, ...req.map((p) => Math.max(lo, Math.min(hi, p[a])))];
      const st = mergeStations(required, base, Math.max(L / 50, 0.5 * maxSec));
      info.stations = st;
      const along = true;
      const str = strengthsFor(mat, along);
      // an angled saw cut removes some material from the member's ends
      const fill = isShaped(def) ? Math.max(0.05, Math.min(1, volume(def) / Math.max(1e-12, sec.A * L))) : 1;
      for (let i = 0; i < st.length; i++) {
        const lp = [0, 0, 0];
        lp[a] = st[i];
        info.nodes.push(addNode(pi, def, lp[0], lp[1], lp[2], 0, (sec.dy ** 2 + sec.dz ** 2) / 12));
      }
      const e1w = axisWorld(def.quat, a);
      const e2w = axisWorld(def.quat, e2);
      const R = rotRows(e1w, e2w);
      for (let i = 0; i + 1 < st.length; i++) {
        const Le = st[i + 1] - st[i];
        const m = mat.density * sec.A * Le * fill;
        nodeMass[info.nodes[i]] += m / 2;
        nodeMass[info.nodes[i + 1]] += m / 2;
        info.elems.push(elements.length);
        elements.push({
          part: pi, n1: info.nodes[i], n2: info.nodes[i + 1], L: Le, R, sec, str, ductile: mat.ductile,
          a1: st[i], a2: st[i + 1], b1: 0, b2: 0,
        });
      }
      // tubes/cylinders: total mass may differ slightly from lumped sum (it doesn't, A*L) - fine
      continue;
    }

    // ---- plate (grillage)
    const w = cls.axis;
    let ua = cls.uAxis, va = cls.vAxis;
    if (cls.disk) {
      ua = 0;
      va = 2;
    }
    info.uAxis = ua;
    info.vAxis = va;
    const A = def.size[ua], B = def.size[va], t = def.size[w];
    info.length = Math.max(A, B);
    const hsp = Math.max(A, B) / 8;
    const nu = Math.max(3, Math.min(10, Math.round(A / hsp)));
    const nv = Math.max(3, Math.min(10, Math.round(B / hsp)));
    const baseU: number[] = [], baseV: number[] = [];
    for (let i = 0; i <= nu; i++) baseU.push(-A / 2 + (A * i) / nu);
    for (let i = 0; i <= nv; i++) baseV.push(-B / 2 + (B * i) / nv);
    const clampU = (x: number) => Math.max(-A / 2, Math.min(A / 2, x));
    const clampV = (x: number) => Math.max(-B / 2, Math.min(B / 2, x));
    const gu = mergeStations([-A / 2, A / 2, ...req.map((p) => clampU(p[ua]))], baseU, hsp / 3);
    const gv = mergeStations([-B / 2, B / 2, ...req.map((p) => clampV(p[va]))], baseV, hsp / 3);
    info.gridU = gu;
    info.gridV = gv;
    const NU = gu.length, NV = gv.length;
    const grid = new Int32Array(NU * NV).fill(-1);
    info.grid = grid;
    const rad = A / 2;
    const trib = (arr: number[], i: number) =>
      ((i + 1 < arr.length ? arr[i + 1] : arr[i]) - (i > 0 ? arr[i - 1] : arr[i])) / 2;
    let massSum = 0;
    // grid points a saw cut has removed are left out (unless that would leave nothing)
    let useMask = false;
    if (isShaped(def)) {
      for (let i = 0; i < NU && !useMask; i++)
        for (let j = 0; j < NV; j++) {
          const lp = [0, 0, 0];
          lp[ua] = gu[i];
          lp[va] = gv[j];
          if (!cutAway(def, lp, 0.3 * hsp)) {
            useMask = true;
            break;
          }
        }
    }
    for (let i = 0; i < NU; i++)
      for (let j = 0; j < NV; j++) {
        if (cls.disk && gu[i] ** 2 + gv[j] ** 2 > rad * rad * 1.0001 + 1e-12) continue;
        const lp = [0, 0, 0];
        lp[ua] = gu[i];
        lp[va] = gv[j];
        if (useMask && cutAway(def, lp, 0.3 * hsp)) continue;
        const m = mat.density * t * trib(gu, i) * trib(gv, j);
        massSum += m;
        const n = addNode(pi, def, lp[0], lp[1], lp[2], m, (t * t + hsp * hsp) / 12);
        grid[i * NV + j] = n;
        info.nodes.push(n);
      }
    if (massSum > 0) {
      const f = mass / massSum;
      for (const n of info.nodes) nodeMass[n] *= f;
    }
    const uW = axisWorld(def.quat, ua), vW = axisWorld(def.quat, va);
    const Ru = rotRows(uW, vW), Rv = rotRows(vW, uW);
    const solidWood = mat.grain === 'solid';
    // grain runs along the longer in-plane axis (or wherever it ran before the part was cut)
    const g = grainAxis(def);
    const grainU = !solidWood || (g === ua ? true : g === va ? false : A >= B);
    info.grainAxis = grainU ? ua : va;
    const strU = strengthsFor(mat, grainU);
    const strV = strengthsFor(mat, !solidWood || !grainU);
    for (let i = 0; i < NU; i++)
      for (let j = 0; j < NV; j++) {
        const n0 = grid[i * NV + j];
        if (n0 < 0) continue;
        if (i + 1 < NU) {
          const n1 = grid[(i + 1) * NV + j];
          if (n1 >= 0) {
            const sec = stripSection(Math.max(1e-4, trib(gv, j)), t);
            info.elems.push(elements.length);
            elements.push({
              part: pi, n1: n0, n2: n1, L: gu[i + 1] - gu[i], R: Ru, sec, str: strU, ductile: mat.ductile, plateDir: 0,
              a1: gu[i], a2: gu[i + 1], b1: gv[j], b2: gv[j],
            });
          }
        }
        if (j + 1 < NV) {
          const n1 = grid[i * NV + j + 1];
          if (n1 >= 0) {
            const sec = stripSection(Math.max(1e-4, trib(gu, i)), t);
            info.elems.push(elements.length);
            elements.push({
              part: pi, n1: n0, n2: n1, L: gv[j + 1] - gv[j], R: Rv, sec, str: strV, ductile: mat.ductile, plateDir: 1,
              a1: gu[i], a2: gu[i], b1: gv[j], b2: gv[j + 1],
            });
          }
        }
      }
  }

  const nodeCount = nodePart.length;
  const NP = Float64Array.from(nodePos);

  // ---------------------------------------------------------------- nearest node lookup
  const nearestNode = (pi: number, p: Vec3T): number => {
    const info = parts[pi];
    if (info.kind === 'block') return info.nodes[0];
    const lp = toLocal(info.def, p[0], p[1], p[2]);
    if (info.kind === 'beam') {
      const s = lp[info.axis];
      let best = 0, bd = Infinity;
      info.stations.forEach((st, i) => {
        const d = Math.abs(st - s);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return info.nodes[best];
    }
    const u = lp[info.uAxis], v = lp[info.vAxis];
    const NV = info.gridV.length;
    let best = info.nodes[0], bd = Infinity;
    for (let i = 0; i < info.gridU.length; i++)
      for (let j = 0; j < NV; j++) {
        const n = info.grid[i * NV + j];
        if (n < 0) continue;
        const d = (info.gridU[i] - u) ** 2 + (info.gridV[j] - v) ** 2;
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
    return best;
  };

  // ---------------------------------------------------------------- contacts
  const contacts: FEContactPoint[] = [];
  const patches: FEPatchInfo[] = [];
  const isAlong = (def: PartDef | undefined, mat: Material, n: Vec3T, kind?: MemberKind): boolean => {
    if (!def || !mat.grain) return true;
    if (mat.grain === 'panel') {
      // panels: bearing on the face is "across"
      const cls = kind ?? classifyPart(def).kind;
      if (cls === 'plate') {
        const ax = axisWorld(def.quat, classifyPart(def).axis);
        return Math.abs(ax[0] * n[0] + ax[1] * n[1] + ax[2] * n[2]) < 0.7;
      }
      return true;
    }
    const ga = axisWorld(def.quat, grainAxisOf(def));
    return Math.abs(ga[0] * n[0] + ga[1] * n[1] + ga[2] * n[2]) > 0.7;
  };
  const modulusNormal = (def: PartDef | undefined, mat: Material, n: Vec3T): number => {
    if (!def || mat.grain !== 'solid') return mat.E;
    return isAlong(def, mat, n) ? mat.E : mat.Eperp ?? mat.E / 20;
  };

  for (const { patch, joint } of input.patches) {
    const pa = partIndex.get(patch.a);
    if (pa === undefined) continue;
    const bDef = patch.b === GROUND_ID ? undefined : defs.get(patch.b);
    let pb = -1;
    if (patch.b !== GROUND_ID) {
      if (!bDef) continue;
      if (!bDef.anchored) {
        const idx = partIndex.get(patch.b);
        if (idx === undefined) continue;
        pb = idx;
      }
    }
    const aDef = parts[pa].def;
    const matA = parts[pa].mat;
    const matB = bDef ? getMaterial(bDef.material) : GROUND_MATERIAL;
    const n = patch.normal;
    const bonded = joint !== 'rest' || patch.embedded;
    const effJoint: JointType = patch.embedded && joint === 'rest' ? 'glue' : joint;
    const cap = jointCapacity(effJoint, patch.area, matA, matB);
    const npts = patch.points.length;
    const EA = modulusNormal(aDef, matA, n), EB = modulusNormal(bDef, matB, n);
    const Ec = (2 * EA * EB) / (EA + EB);
    const hc = Math.max(0.001, Math.min(0.05, (0.1 * (minDim(aDef) + (bDef ? minDim(bDef) : 0.2))) / 2));
    const alongA = isAlong(aDef, matA, n, parts[pa].kind);
    const alongB = isAlong(bDef, matB, n, pb >= 0 ? parts[pb].kind : undefined);
    const info: FEPatchInfo = {
      patch, joint, effectiveJoint: cap.type, partA: pa, partB: pb, bId: patch.b, matA, matB, points: [],
      capT: cap.tension, capV: cap.shear, friction: (matA.friction + matB.friction) / 2,
      punchPlate: 0, punchPerimeter: 0, bearingAlongA: alongA, bearingAlongB: alongB,
    };
    // Hertzian point contact for spheres
    const sphereA = aDef.kind === 'sphere', sphereB = bDef?.kind === 'sphere';
    if ((sphereA || sphereB) && npts === 1) {
      const R = sphereA ? aDef.size[0] / 2 : bDef!.size[0] / 2;
      const inv = (1 - matA.nu ** 2) / matA.E + (1 - matB.nu ** 2) / matB.E;
      info.hertz = { R, Estar: 1 / inv };
    }
    // punching of a plate by a small patch
    const plateSide = parts[pa].kind === 'plate' ? 1 : pb >= 0 && parts[pb].kind === 'plate' ? 2 : 0;
    if (plateSide) {
      const pinfo = plateSide === 1 ? parts[pa] : parts[pb];
      const pn = axisWorld(pinfo.def.quat, pinfo.axis);
      const t = pinfo.def.size[pinfo.axis];
      const plateArea = pinfo.def.size[pinfo.uAxis] * pinfo.def.size[pinfo.vAxis];
      if (Math.abs(pn[0] * n[0] + pn[1] * n[1] + pn[2] * n[2]) > 0.8 && patch.area < 0.25 * plateArea) {
        info.punchPlate = plateSide as 1 | 2;
        info.punchPerimeter = 2 * (patch.extent[0] + patch.extent[1]) + Math.PI * t;
      }
    }
    const pIdx = patches.length;
    patches.push(info);
    const bearA = bearingStrength(matA, alongA);
    const bearB = bearingStrength(matB, alongB);
    patch.points.forEach((p, k) => {
      const nA = nearestNode(pa, p);
      const nB = pb >= 0 ? nearestNode(pb, p) : -1;
      const area = patch.area / npts;
      const kn = (Ec * Math.max(area, 1e-6)) / hc;
      const xa = [NP[3 * nA], NP[3 * nA + 1], NP[3 * nA + 2]];
      const rA: Vec3T = [p[0] - xa[0], p[1] - xa[1], p[2] - xa[2]];
      let rB: Vec3T = [0, 0, 0];
      if (nB >= 0) rB = [p[0] - NP[3 * nB], p[1] - NP[3 * nB + 1], p[2] - NP[3 * nB + 2]];
      info.points.push(contacts.length);
      contacts.push({
        // resting contacts: friction can slip, so only a soft tangential restraint
        patch: pIdx, nA, nB, rA, rB, n, kn, kt: bonded ? 0.5 * kn : 1e-5 * kn, bonded, isCenter: k === patch.center, area,
        capT: cap.tension / npts, capV: cap.shear / npts, bearA, bearB, point: p,
      });
    });
  }

  // ---------------------------------------------------------------- loads
  const load = new Float64Array(nodeCount * 6);
  let totalWeight = 0;
  const gEff = input.inertiaRelief ? 0 : g;
  for (let i = 0; i < nodeCount; i++) {
    load[6 * i + 1] -= nodeMass[i] * gEff;
    totalWeight += nodeMass[i] * g;
  }
  for (const l of input.loads ?? []) {
    const pi = partIndex.get(l.part);
    if (pi === undefined) continue;
    const nd = nearestNode(pi, l.point);
    const r = [l.point[0] - NP[3 * nd], l.point[1] - NP[3 * nd + 1], l.point[2] - NP[3 * nd + 2]];
    const f = l.force;
    load[6 * nd] += f[0];
    load[6 * nd + 1] += f[1];
    load[6 * nd + 2] += f[2];
    load[6 * nd + 3] += r[1] * f[2] - r[2] * f[1];
    load[6 * nd + 4] += r[2] * f[0] - r[0] * f[2];
    load[6 * nd + 5] += r[0] * f[1] - r[1] * f[0];
  }
  if (input.inertiaRelief) applyInertiaRelief(NP, nodeMass, nodeGyr2, load, nodeCount);

  let probe: FEProbe | null = null;
  if (input.probe) {
    const pi = partIndex.get(input.probe.part);
    if (pi !== undefined) {
      const nd = nearestNode(pi, input.probe.point);
      const p = input.probe.point;
      const r: Vec3T = [p[0] - NP[3 * nd], p[1] - NP[3 * nd + 1], p[2] - NP[3 * nd + 2]];
      const d = input.probe.dir;
      const pl = new Float64Array(nodeCount * 6);
      pl[6 * nd] = d[0];
      pl[6 * nd + 1] = d[1];
      pl[6 * nd + 2] = d[2];
      pl[6 * nd + 3] = r[1] * d[2] - r[2] * d[1];
      pl[6 * nd + 4] = r[2] * d[0] - r[0] * d[2];
      pl[6 * nd + 5] = r[0] * d[1] - r[1] * d[0];
      if (input.inertiaRelief) applyInertiaRelief(NP, nodeMass, nodeGyr2, pl, nodeCount);
      probe = { node: nd, r, dir: d, load: pl };
    }
  }

  return {
    nodePos: NP, nodePart: Int32Array.from(nodePart), nodeMass: Float64Array.from(nodeMass), nodeCount,
    elements, contacts, patches, parts, partIndex, load, totalWeight, probe, relief: !!input.inertiaRelief,
  };
}

/**
 * d'Alembert balancing of a free body: the applied loads give the lumped-mass system a
 * rigid acceleration a + alpha x r; adding -m_i (a + alpha x r_i) at every node makes the
 * load set self-equilibrated so the elastic solution is the true internal state.
 */
function applyInertiaRelief(NP: Float64Array, mass: number[], gyr2: number[], load: Float64Array, n: number) {
  let M = 0;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    M += mass[i];
    for (let k = 0; k < 3; k++) c[k] += mass[i] * NP[3 * i + k];
  }
  if (M <= 0) return;
  for (let k = 0; k < 3; k++) c[k] /= M;
  const F = [0, 0, 0], T = [0, 0, 0];
  const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const r = [NP[3 * i] - c[0], NP[3 * i + 1] - c[1], NP[3 * i + 2] - c[2]];
    const f = [load[6 * i], load[6 * i + 1], load[6 * i + 2]];
    for (let k = 0; k < 3; k++) F[k] += f[k];
    T[0] += r[1] * f[2] - r[2] * f[1] + load[6 * i + 3];
    T[1] += r[2] * f[0] - r[0] * f[2] + load[6 * i + 4];
    T[2] += r[0] * f[1] - r[1] * f[0] + load[6 * i + 5];
    const m = mass[i];
    const rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[a * 3 + b] += m * ((a === b ? rr + gyr2[i] : 0) - r[a] * r[b]);
  }
  const acc = F.map((v) => v / M);
  const alpha = solveSym3(I, T);
  for (let i = 0; i < n; i++) {
    const r = [NP[3 * i] - c[0], NP[3 * i + 1] - c[1], NP[3 * i + 2] - c[2]];
    const ar = [alpha[1] * r[2] - alpha[2] * r[1], alpha[2] * r[0] - alpha[0] * r[2], alpha[0] * r[1] - alpha[1] * r[0]];
    for (let k = 0; k < 3; k++) {
      load[6 * i + k] -= mass[i] * (acc[k] + ar[k]);
      load[6 * i + 3 + k] -= mass[i] * gyr2[i] * alpha[k];
    }
  }
}

/** solve a symmetric 3x3 system, ignoring near-singular directions (pseudo-inverse) */
export function solveSym3(A: number[], b: number[]): number[] {
  // Jacobi eigen-decomposition
  const a = A.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p * 3 + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p * 3 + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
        for (let k = 0; k < 3; k++) {
          const akp = a[k * 3 + p], akq = a[k * 3 + q];
          a[k * 3 + p] = cs * akp - sn * akq;
          a[k * 3 + q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p * 3 + k], aqk = a[q * 3 + k];
          a[p * 3 + k] = cs * apk - sn * aqk;
          a[q * 3 + k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
          v[k * 3 + p] = cs * vkp - sn * vkq;
          v[k * 3 + q] = sn * vkp + cs * vkq;
        }
      }
  }
  const ev = [a[0], a[4], a[8]];
  const maxEv = Math.max(...ev.map(Math.abs), 1e-30);
  const x = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ev[k]) < 1e-9 * maxEv) continue;
    const proj = v[k] * b[0] + v[3 + k] * b[1] + v[6 + k] * b[2];
    const s = proj / ev[k];
    for (let i = 0; i < 3; i++) x[i] += s * v[i * 3 + k];
  }
  return x;
}

export function partOtherName(model: FEModel, patch: FEPatchInfo, fromA: boolean, names: (id: string) => string): string {
  if (fromA) return patch.bId === GROUND_ID ? 'the floor' : names(patch.bId);
  return names(model.parts[patch.partA].def.id);
}
