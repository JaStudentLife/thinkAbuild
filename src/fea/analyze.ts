import type { Vec3T } from '../core/design';
import { formatPa } from '../core/materials';
import { beamLocalK, beamLocalKG, matVec12, toGlobal12, vecToLocal12 } from './beam';
import { solveSym3, type FEContactPoint, type FEModel } from './model';
import { rcmOrder, SkylineMatrix } from './skyline';

export type FailMode =
  | 'none'
  | 'tension'
  | 'compression'
  | 'bending'
  | 'shear'
  | 'torsion'
  | 'buckling'
  | 'bearing'
  | 'punching'
  | 'joint'
  | 'unstable';

export interface ElementResult {
  N: number;
  V: number;
  T: number;
  M1: number;
  M2: number;
  U: number;
  mode: FailMode;
  end: 0 | 1;
  sigma: number;
  strength: number;
}

export interface PatchResult {
  Fn: number;
  Ft: number;
  F: Vec3T;
  U: number;
  mode: FailMode;
  jointU: number;
  bearingU: number;
  punchU: number;
  slipU: number;
  lifted: boolean;
  /** which part fails for bearing/punching: 0 = A, 1 = B */
  side: 0 | 1;
  point: Vec3T;
  message: string;
}

export interface PartResult {
  U: number;
  mode: FailMode;
  point: Vec3T;
  /** beam: station; plate: u */
  a: number;
  /** plate: v */
  b: number;
  /** plate: direction (0 u / 1 v) of the critical strip */
  dir: number;
  unstable: boolean;
  maxDisp: number;
  N: number;
  Ncr: number;
  sigma: number;
  strength: number;
  message: string;
  /** patch index when governed by a contact (bearing / punching) */
  patch: number;
}

export interface AnalysisResult {
  u: Float64Array;
  elements: ElementResult[];
  contactFn: Float64Array;
  contactFt: Float64Array;
  patches: PatchResult[];
  parts: PartResult[];
  lambda: number;
  mode: Float64Array | null;
  amplification: number;
  unstableParts: number[];
  totalWeight: number;
  timeMs: number;
  iterations: number;
  /** displacement per unit force at the probe point (m/N), if a probe was requested */
  compliance: number;
}

export interface AnalyzeOptions {
  buckling?: boolean;
  imperfections?: boolean;
  maxContactIter?: number;
}

// ------------------------------------------------------------------------------------------

interface Ctx {
  model: FEModel;
  n: number;
  inv: Int32Array;
  top: Int32Array;
  K0: SkylineMatrix;
  kl: Float64Array[]; // local element stiffness
  kg: Float64Array[]; // global element stiffness
  dofOf: (node: number, d: number) => number;
  /** connected piece of each node (bodies balanced by inertia relief) */
  comp: Int32Array;
}

/** connected pieces through members and bonded contacts */
function components(model: FEModel): Int32Array {
  const nn = model.nodeCount;
  const parent = Int32Array.from({ length: nn }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const join = (a: number, b: number) => {
    if (a < 0 || b < 0) return;
    parent[find(a)] = find(b);
  };
  for (const e of model.elements) join(e.n1, e.n2);
  for (const c of model.contacts) if (c.bonded) join(c.nA, c.nB);
  const out = new Int32Array(nn);
  for (let i = 0; i < nn; i++) out[i] = find(i);
  return out;
}

function buildCtx(model: FEModel): Ctx {
  const nn = model.nodeCount;
  const adj: Set<number>[] = Array.from({ length: nn }, () => new Set<number>());
  const link = (a: number, b: number) => {
    if (a < 0 || b < 0 || a === b) return;
    adj[a].add(b);
    adj[b].add(a);
  };
  for (const e of model.elements) link(e.n1, e.n2);
  for (const c of model.contacts) link(c.nA, c.nB);
  const { inv } = rcmOrder(nn, adj.map((s) => [...s]));
  const n = nn * 6;
  const top = new Int32Array(n);
  for (let j = 0; j < n; j++) top[j] = j - (j % 6);
  const touch = (a: number, b: number) => {
    const mn = Math.min(inv[a], b >= 0 ? inv[b] : inv[a]) * 6;
    for (const x of b >= 0 ? [a, b] : [a])
      for (let d = 0; d < 6; d++) {
        const j = inv[x] * 6 + d;
        if (top[j] > mn) top[j] = mn;
      }
  };
  for (const e of model.elements) touch(e.n1, e.n2);
  for (const c of model.contacts) touch(c.nA, c.nB);
  const K0 = new SkylineMatrix(n, top);
  const dofOf = (node: number, d: number) => inv[node] * 6 + d;
  const kl: Float64Array[] = [];
  const kg: Float64Array[] = [];
  const map = new Int32Array(12);
  for (const e of model.elements) {
    const s = e.sec;
    const k = beamLocalK(e.str.E, e.str.G, s.A, s.Iy, s.Iz, s.J, e.L, s.Asy, s.Asz);
    const K = toGlobal12(k, e.R);
    kl.push(k);
    kg.push(K);
    for (let a = 0; a < 6; a++) {
      map[a] = dofOf(e.n1, a);
      map[a + 6] = dofOf(e.n2, a);
    }
    for (let i = 0; i < 12; i++)
      for (let j = i; j < 12; j++) {
        const v = K[i * 12 + j];
        if (v !== 0) K0.add(map[i], map[j], v);
      }
  }
  const comp = components(model);
  if (model.relief) {
    // A free body's loads are self-balanced, so holding one node of each piece still costs no
    // force; it just removes the rigid-body motions a factorisation cannot pin down reliably.
    let maxDiag = 0;
    for (let j = 0; j < n; j++) maxDiag = Math.max(maxDiag, K0.get(j, j));
    for (const c of model.contacts) maxDiag = Math.max(maxDiag, c.kn);
    const pin = 100 * (maxDiag || 1);
    const heaviest = new Map<number, number>();
    for (let nd = 0; nd < nn; nd++) {
      const k = comp[nd];
      const cur = heaviest.get(k);
      if (cur === undefined || model.nodeMass[nd] > model.nodeMass[cur]) heaviest.set(k, nd);
    }
    for (const nd of heaviest.values()) for (let d = 0; d < 6; d++) K0.add(dofOf(nd, d), dofOf(nd, d), pin);
  }
  return { model, n, inv, top, K0, kl, kg, dofOf, comp };
}

/** B matrix rows for a contact: delta = B q, q = [uA, thA, uB, thB] */
function contactB(c: FEContactPoint): Float64Array {
  const B = new Float64Array(36);
  const [ax, ay, az] = c.rA;
  const [bx, by, bz] = c.rB;
  // row-major 3 x 12
  const set = (r: number, col: number, v: number) => (B[r * 12 + col] = v);
  for (let i = 0; i < 3; i++) {
    set(i, i, 1);
    set(i, 6 + i, -1);
  }
  // -[rA]x
  set(0, 4, az); set(0, 5, -ay);
  set(1, 3, -az); set(1, 5, ax);
  set(2, 3, ay); set(2, 4, -ax);
  // +[rB]x
  set(0, 10, -bz); set(0, 11, by);
  set(1, 9, bz); set(1, 11, -bx);
  set(2, 9, -by); set(2, 10, bx);
  return B;
}

function addContact(ctx: Ctx, K: SkylineMatrix, c: FEContactPoint, knScale = 1) {
  const B = contactB(c);
  const n = c.n;
  const kn = c.kn * knScale, kt = c.kt * knScale;
  const D = new Float64Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) D[i * 3 + j] = (kn - kt) * n[i] * n[j] + (i === j ? kt : 0);
  const cols = c.nB >= 0 ? 12 : 6;
  const map = new Int32Array(12);
  for (let a = 0; a < 6; a++) {
    map[a] = ctx.dofOf(c.nA, a);
    if (c.nB >= 0) map[a + 6] = ctx.dofOf(c.nB, a);
  }
  // DB (3 x cols)
  const DB = new Float64Array(36);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < cols; j++) {
      let s = 0;
      for (let m = 0; m < 3; m++) s += D[i * 3 + m] * B[m * 12 + j];
      DB[i * 12 + j] = s;
    }
  for (let i = 0; i < cols; i++)
    for (let j = i; j < cols; j++) {
      let s = 0;
      for (let m = 0; m < 3; m++) s += B[m * 12 + i] * DB[m * 12 + j];
      if (s !== 0) K.add(map[i], map[j], s);
    }
}

function contactDelta(ctx: Ctx, c: FEContactPoint, x: Float64Array): Vec3T {
  const B = contactB(c);
  const q = new Float64Array(12);
  for (let a = 0; a < 6; a++) {
    q[a] = x[ctx.dofOf(c.nA, a)];
    if (c.nB >= 0) q[a + 6] = x[ctx.dofOf(c.nB, a)];
  }
  const d: Vec3T = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let s = 0;
    for (let j = 0; j < 12; j++) s += B[i * 12 + j] * q[j];
    d[i] = s;
  }
  return d;
}

interface StaticState {
  x: Float64Array; // permuted solution
  K: SkylineMatrix; // factored
  Kraw: SkylineMatrix; // unfactored copy
  unstableNodes: Uint8Array;
  iterations: number;
  changed: boolean;
}

const UNSTABLE_DISP = 10;

/** rigid translation (of the centre of mass) and rotation that best match a displacement field */
function meanMotion(ctx: Ctx, x: Float64Array, piece: number): { t: number[]; theta: number[]; c: number[] } {
  const { model } = ctx;
  const P = model.nodePos, m = model.nodeMass;
  let M = 0;
  const c = [0, 0, 0], t = [0, 0, 0];
  for (let nd = 0; nd < model.nodeCount; nd++) {
    if (ctx.comp[nd] !== piece) continue;
    const b = ctx.inv[nd] * 6;
    M += m[nd];
    for (let k = 0; k < 3; k++) {
      c[k] += m[nd] * P[3 * nd + k];
      t[k] += m[nd] * x[b + k];
    }
  }
  if (M <= 0) return { t: [0, 0, 0], theta: [0, 0, 0], c: [0, 0, 0] };
  for (let k = 0; k < 3; k++) {
    c[k] /= M;
    t[k] /= M;
  }
  const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const L = [0, 0, 0];
  for (let nd = 0; nd < model.nodeCount; nd++) {
    if (ctx.comp[nd] !== piece) continue;
    const b = ctx.inv[nd] * 6;
    const r = [P[3 * nd] - c[0], P[3 * nd + 1] - c[1], P[3 * nd + 2] - c[2]];
    const u = [x[b] - t[0], x[b + 1] - t[1], x[b + 2] - t[2]];
    const w = m[nd];
    const rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[3 * i + j] += w * ((i === j ? rr : 0) - r[i] * r[j]);
    L[0] += w * (r[1] * u[2] - r[2] * u[1]);
    L[1] += w * (r[2] * u[0] - r[0] * u[2]);
    L[2] += w * (r[0] * u[1] - r[1] * u[0]);
  }
  return { t, theta: solveSym3(I, L), c };
}

function solveOnce(ctx: Ctx, F: Float64Array, active: Uint8Array): Omit<StaticState, 'iterations' | 'changed'> {
  const { model } = ctx;
  const K = ctx.K0.clone();
  model.contacts.forEach((c, i) => {
    if (c.bonded || active[i]) addContact(ctx, K, c);
  });
  const Kraw = K.clone();
  K.factor(1e-11);
  const x = K.solve(F);
  const unstableNodes = new Uint8Array(model.nodeCount);
  for (let nd = 0; nd < model.nodeCount; nd++) {
    const b = ctx.inv[nd] * 6;
    const t = Math.hypot(x[b], x[b + 1], x[b + 2]);
    const r = Math.hypot(x[b + 3], x[b + 4], x[b + 5]);
    if (!(t < UNSTABLE_DISP && r < UNSTABLE_DISP)) unstableNodes[nd] = 1;
  }
  return { x, K, Kraw, unstableNodes };
}

/**
 * Static solve with unilateral (compression-only) resting contacts using an active-set
 * iteration. Tension in one contact is often only *induced* by tension in another
 * (a plate lifting off pulls up the support it sits on), so releasing every tensile
 * contact at once overshoots into a spurious mechanism. Each step therefore releases
 * only the most tensile point of the patches carrying near-peak tension, and if a
 * step still creates a new instability it is retried releasing a single contact.
 */
function solveStatic(ctx: Ctx, F: Float64Array, active: Uint8Array, maxIter: number, tolF: number): StaticState {
  const { model } = ctx;
  let anyChange = false;
  const base = solveOnce(ctx, F, active);
  const countUnstable = (u: Uint8Array) => u.reduce((s, v) => s + v, 0);
  let st: StaticState = { ...base, iterations: 1, changed: false };
  const limit = Math.max(maxIter, 30);
  for (let it = 1; it < limit; it++) {
    const tension: { i: number; patch: number; F: number }[] = [];
    const penetrate: number[] = [];
    model.contacts.forEach((c, i) => {
      if (c.bonded) return;
      if (st.unstableNodes[c.nA] || (c.nB >= 0 && st.unstableNodes[c.nB])) return;
      const d = contactDelta(ctx, c, st.x);
      const dn = d[0] * c.n[0] + d[1] * c.n[1] + d[2] * c.n[2];
      const Fn = -c.kn * dn;
      if (active[i] && Fn < -tolF) tension.push({ i, patch: c.patch, F: Fn });
      else if (!active[i] && dn < -1e-9) penetrate.push(i);
    });
    if (tension.length === 0 && penetrate.length === 0) break;
    tension.sort((a, b) => a.F - b.F);
    const prev = active.slice();
    const unstableBefore = countUnstable(st.unstableNodes);
    for (const i of penetrate) active[i] = 1;
    if (tension.length) {
      const peak = -tension[0].F;
      const seen = new Set<number>();
      for (const t of tension) {
        if (-t.F < 0.3 * peak) break;
        if (seen.has(t.patch)) continue;
        seen.add(t.patch);
        active[t.i] = 0;
      }
    }
    let next = solveOnce(ctx, F, active);
    if (countUnstable(next.unstableNodes) > unstableBefore && tension.length) {
      // overshoot: retry releasing only the single most tensile contact
      active.set(prev);
      for (const i of penetrate) active[i] = 1;
      active[tension[0].i] = 0;
      next = solveOnce(ctx, F, active);
    }
    anyChange = true;
    st = { ...next, iterations: it + 1, changed: anyChange };
  }
  return st;
}

// ------------------------------------------------------------------ geometric stiffness

interface KGData {
  list: { e: number; K: Float64Array }[];
}

function buildKG(ctx: Ctx, N: Float64Array): KGData {
  const list: { e: number; K: Float64Array }[] = [];
  ctx.model.elements.forEach((e, i) => {
    if (Math.abs(N[i]) < 1e-9) return;
    const k = beamLocalKG(N[i], e.L, e.sec.A, e.sec.Iy, e.sec.Iz);
    list.push({ e: i, K: toGlobal12(k, e.R) });
  });
  return { list };
}

/** y = -KG x (positive for compression), permuted space */
function mulKGneg(ctx: Ctx, kg: KGData, x: Float64Array, y: Float64Array) {
  y.fill(0);
  const xe = new Float64Array(12);
  const map = new Int32Array(12);
  for (const { e, K } of kg.list) {
    const el = ctx.model.elements[e];
    for (let a = 0; a < 6; a++) {
      map[a] = ctx.dofOf(el.n1, a);
      map[a + 6] = ctx.dofOf(el.n2, a);
    }
    for (let a = 0; a < 12; a++) xe[a] = x[map[a]];
    for (let i = 0; i < 12; i++) {
      let s = 0;
      for (let j = 0; j < 12; j++) s += K[i * 12 + j] * xe[j];
      y[map[i]] -= s;
    }
  }
}

function skylineMul(K: SkylineMatrix, x: Float64Array, y: Float64Array) {
  y.fill(0);
  const { n, top, ptr, vals } = K;
  for (let j = 0; j < n; j++) {
    const tj = top[j];
    const pj = ptr[j];
    let s = 0;
    const xj = x[j];
    for (let r = tj; r < j; r++) {
      const v = vals[pj + r - tj];
      s += v * x[r];
      y[r] += v * xj;
    }
    y[j] += s + vals[pj + j - tj] * xj;
  }
}

function dot(a: Float64Array, b: Float64Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function maxTrans(ctx: Ctx, x: Float64Array): number {
  let m = 0;
  for (let nd = 0; nd < ctx.model.nodeCount; nd++) {
    const b = ctx.inv[nd] * 6;
    m = Math.max(m, Math.hypot(x[b], x[b + 1], x[b + 2]));
  }
  return m;
}

/** Smallest positive buckling load factor by (shifted) power iteration on K^-1 (-KG). */
function buckling(ctx: Ctx, st: StaticState, kg: KGData, x0?: Float64Array): { lambda: number; mode: Float64Array | null } {
  const n = ctx.n;
  if (kg.list.length === 0) return { lambda: Infinity, mode: null };
  let x = new Float64Array(n);
  if (x0) x.set(x0);
  else for (let i = 0; i < n; i++) x[i] = Math.sin(i * 12.9898 + 1.234) * 0.5 + Math.cos(i * 0.731) * 0.5;
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const Kz = new Float64Array(n);
  const run = (shift: number) => {
    let mu = 0, prev = NaN;
    for (let it = 0; it < 60; it++) {
      mulKGneg(ctx, kg, x, y);
      st.K.solve(y, z);
      if (shift !== 0) for (let i = 0; i < n; i++) z[i] += shift * x[i];
      // Rayleigh quotient of z for the pencil (-KG, K)
      mulKGneg(ctx, kg, z, y);
      skylineMul(st.Kraw, z, Kz);
      const den = dot(z, Kz);
      if (!(Math.abs(den) > 0)) return 0;
      mu = dot(z, y) / den;
      let mx = 0;
      for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(z[i]));
      if (!(mx > 0) || !isFinite(mx)) return 0;
      for (let i = 0; i < n; i++) x[i] = z[i] / mx;
      if (it > 4 && Math.abs(mu - prev) <= 2e-4 * Math.abs(mu)) break;
      prev = mu;
    }
    return mu;
  };
  let mu = run(0);
  if (mu < 0) {
    mu = run(1.2 * Math.abs(mu));
  }
  if (!(mu > 1e-12)) return { lambda: Infinity, mode: null };
  // ignore modes living only on mechanism (unstable) nodes
  const mt = maxTrans(ctx, x);
  if (mt > 0) for (let i = 0; i < n; i++) x[i] /= mt;
  return { lambda: 1 / mu, mode: x };
}

// ------------------------------------------------------------------ main entry

export function analyze(model: FEModel, opts: AnalyzeOptions = {}): AnalysisResult {
  const t0 = performance.now();
  const ctx = buildCtx(model);
  const { n } = ctx;
  const F = new Float64Array(n);
  for (let nd = 0; nd < model.nodeCount; nd++) for (let d = 0; d < 6; d++) F[ctx.dofOf(nd, d)] = model.load[6 * nd + d];
  const active = new Uint8Array(model.contacts.length).fill(1);
  const tolF = 1e-7 * (model.totalWeight + 1);
  const maxIt = opts.maxContactIter ?? 16;
  let st = solveStatic(ctx, F, active, maxIt, tolF);
  let iterations = st.iterations;

  const axial = (x: Float64Array): Float64Array => {
    const N = new Float64Array(model.elements.length);
    const ue = new Float64Array(12);
    model.elements.forEach((e, i) => {
      for (let a = 0; a < 6; a++) {
        ue[a] = x[ctx.dofOf(e.n1, a)];
        ue[a + 6] = x[ctx.dofOf(e.n2, a)];
      }
      if (st.unstableNodes[e.n1] || st.unstableNodes[e.n2]) return;
      const ul = vecToLocal12(e.R, ue);
      const f = matVec12(ctx.kl[i], ul);
      N[i] = f[6];
    });
    return N;
  };

  let lambda = Infinity;
  let mode: Float64Array | null = null;
  let amplification = 1;
  let xFinal = st.x;
  const anyUnstable = st.unstableNodes.some((v) => v);

  if (opts.buckling !== false && !anyUnstable) {
    let N = axial(st.x);
    let kg = buildKG(ctx, N);
    let b = buckling(ctx, st, kg);
    lambda = b.lambda;
    mode = b.mode;
    if (opts.imperfections !== false && mode && lambda > 1 && isFinite(lambda)) {
      for (let outer = 0; outer < 4; outer++) {
        const A = lambda / (lambda - 1);
        // imperfection amplitude from the governing member
        const e0 = imperfectionAmplitude(ctx, mode);
        const d0 = new Float64Array(n);
        for (let i = 0; i < n; i++) d0[i] = mode[i] * e0;
        const fimp = new Float64Array(n);
        mulKGneg(ctx, kg, d0, fimp);
        const F2 = new Float64Array(n);
        for (let i = 0; i < n; i++) F2[i] = F[i] + A * fimp[i];
        const act2 = active.slice();
        const st2 = solveStatic(ctx, F2, act2, maxIt, tolF);
        iterations += st2.iterations;
        amplification = A;
        xFinal = st2.x;
        const unstable2 = st2.unstableNodes.some((v) => v);
        if (unstable2) {
          // rocking turned the structure into a mechanism: it topples / buckles
          lambda = Math.min(lambda, 0.999);
          st = st2;
          break;
        }
        if (!st2.changed) break;
        // contacts lifted (rocking): stability must be re-evaluated with the new contact state
        active.set(act2);
        st = st2;
        N = axial(st2.x);
        kg = buildKG(ctx, N);
        b = buckling(ctx, st2, kg, mode);
        if (!b.mode) break;
        const prevLambda = lambda;
        lambda = b.lambda;
        mode = b.mode;
        if (lambda <= 1) break;
        if (Math.abs(lambda - prevLambda) < 0.01 * prevLambda) break;
      }
    }
  }

  const res = evaluate(ctx, st, xFinal, lambda, mode, amplification);
  if (model.probe) {
    // flexibility at the probe point: one extra solve with the final factorisation
    const pr = model.probe;
    const fp = new Float64Array(n);
    const d = pr.dir, r = pr.r;
    for (let nd = 0; nd < model.nodeCount; nd++) for (let k = 0; k < 6; k++) fp[ctx.dofOf(nd, k)] = pr.load[6 * nd + k];
    const xp = st.K.solve(fp);
    const b = ctx.inv[pr.node] * 6;
    let ux = xp[b] + (xp[b + 4] * r[2] - xp[b + 5] * r[1]);
    let uy = xp[b + 1] + (xp[b + 5] * r[0] - xp[b + 3] * r[2]);
    let uz = xp[b + 2] + (xp[b + 3] * r[1] - xp[b + 4] * r[0]);
    if (model.relief) {
      // flexibility of a free body: measured against its mass-weighted mean motion
      const rig = meanMotion(ctx, xp, ctx.comp[pr.node]);
      const P = model.nodePos;
      const q = [P[3 * pr.node] + r[0] - rig.c[0], P[3 * pr.node + 1] + r[1] - rig.c[1], P[3 * pr.node + 2] + r[2] - rig.c[2]];
      const th = rig.theta;
      ux -= rig.t[0] + th[1] * q[2] - th[2] * q[1];
      uy -= rig.t[1] + th[2] * q[0] - th[0] * q[2];
      uz -= rig.t[2] + th[0] * q[1] - th[1] * q[0];
    }
    const c = ux * d[0] + uy * d[1] + uz * d[2];
    res.compliance = isFinite(c) && c > 0 && c < 1 ? c : 0;
  }
  res.iterations = iterations;
  res.timeMs = performance.now() - t0;
  return res;
}

function imperfectionAmplitude(ctx: Ctx, mode: Float64Array): number {
  const { model } = ctx;
  let best = -1, bestE = 0;
  const ue = new Float64Array(12);
  model.elements.forEach((e, i) => {
    for (let a = 0; a < 6; a++) {
      ue[a] = mode[ctx.dofOf(e.n1, a)];
      ue[a + 6] = mode[ctx.dofOf(e.n2, a)];
    }
    const ul = vecToLocal12(e.R, ue);
    const f = matVec12(ctx.kl[i], ul);
    let E = 0;
    for (let k = 0; k < 12; k++) E += f[k] * ul[k];
    if (E > bestE) {
      bestE = E;
      best = i;
    }
  });
  if (best < 0) return 0.002;
  const p = model.parts[model.elements[best].part];
  return Math.max(0.0005, p.length / p.mat.imperfection);
}

// ------------------------------------------------------------------ checks

function fmtN(f: number): string {
  const a = Math.abs(f);
  if (a >= 1e6) return (f / 1e6).toFixed(2) + ' MN';
  if (a >= 1e3) return (f / 1e3).toFixed(a >= 1e5 ? 0 : 2) + ' kN';
  return f.toFixed(0) + ' N';
}

function evaluate(
  ctx: Ctx, st: StaticState, x: Float64Array, lambda: number, mode: Float64Array | null, amplification: number,
): AnalysisResult {
  const { model } = ctx;
  const nn = model.nodeCount;
  // unpermute
  const u = new Float64Array(nn * 6);
  for (let nd = 0; nd < nn; nd++) for (let d = 0; d < 6; d++) u[6 * nd + d] = x[ctx.dofOf(nd, d)];
  let modeOut: Float64Array | null = null;
  if (mode) {
    modeOut = new Float64Array(nn * 6);
    for (let nd = 0; nd < nn; nd++) for (let d = 0; d < 6; d++) modeOut[6 * nd + d] = mode[ctx.dofOf(nd, d)];
  }
  const unstablePart = new Uint8Array(model.parts.length);
  for (let nd = 0; nd < nn; nd++) if (st.unstableNodes[nd]) unstablePart[model.nodePart[nd]] = 1;

  // modal participation: strain energy of each member in the buckling mode. A member
  // buckles as a whole, so every element of a participating part shares its value.
  const partic = new Float64Array(model.elements.length);
  if (mode) {
    const partE = new Float64Array(model.parts.length);
    const ue = new Float64Array(12);
    model.elements.forEach((e, i) => {
      for (let a = 0; a < 6; a++) {
        ue[a] = mode[ctx.dofOf(e.n1, a)];
        ue[a + 6] = mode[ctx.dofOf(e.n2, a)];
      }
      const ul = vecToLocal12(e.R, ue);
      const f = matVec12(ctx.kl[i], ul);
      let E = 0;
      for (let k = 0; k < 12; k++) E += f[k] * ul[k];
      partE[e.part] += E;
    });
    let mx = 0;
    for (const v of partE) mx = Math.max(mx, v);
    if (mx > 0) model.elements.forEach((e, i) => (partic[i] = partE[e.part] / mx));
  }

  // ---- elements
  const elements: ElementResult[] = [];
  const ue = new Float64Array(12);
  model.elements.forEach((e, i) => {
    for (let a = 0; a < 6; a++) {
      ue[a] = u[6 * e.n1 + a];
      ue[a + 6] = u[6 * e.n2 + a];
    }
    const ul = vecToLocal12(e.R, ue);
    const f = matVec12(ctx.kl[i], ul);
    const N = f[6];
    const V = Math.hypot(f[1], f[2]);
    const T = Math.abs(f[9]);
    const s = e.sec;
    const str = e.str;
    let best: ElementResult = { N, V, T, M1: 0, M2: 0, U: 0, mode: 'none', end: 0, sigma: 0, strength: 1 };
    if (unstablePart[e.part]) {
      elements.push(best);
      return;
    }
    const fmEff = e.ductile ? str.fm * s.plastic : str.fm;
    for (let end = 0; end < 2; end++) {
      const My = Math.abs(end === 0 ? f[4] : f[10]);
      const Mz = Math.abs(end === 0 ? f[5] : f[11]);
      const sigN = N / s.A;
      const sigM = s.shape === 'circle' || s.shape === 'tube' ? Math.hypot(My, Mz) / s.Wy : My / s.Wy + Mz / s.Wz;
      const beta = sigM / (Math.abs(sigN) + sigM + 1e-30);
      const ftEff = (1 - beta) * str.ft + beta * fmEff;
      const fcEff = (1 - beta) * str.fc + beta * Math.max(str.fc, fmEff);
      const sigT = sigN + sigM; // most tensile fibre
      const sigC = -(sigN - sigM); // most compressive fibre (positive = compression)
      const Ut = Math.max(0, sigT) / ftEff;
      const Uc = Math.max(0, sigC) / fcEff;
      const tau = (s.kv * V) / s.A + T / s.Wt;
      const Uv = tau / str.fv;
      let U = Ut, m: FailMode = beta > 0.5 ? 'bending' : 'tension', sg = Math.max(0, sigT), fs = ftEff;
      if (Uc > U) {
        U = Uc;
        m = beta > 0.5 ? 'bending' : 'compression';
        sg = sigC;
        fs = fcEff;
      }
      if (Uv > U) {
        U = Uv;
        m = T / s.Wt > (s.kv * V) / s.A ? 'torsion' : 'shear';
        sg = tau;
        fs = str.fv;
      }
      if (N < 0 && partic[i] > 0.08 && amplification > 1.6 && (m === 'bending' || m === 'compression')) m = 'buckling';
      if (U > best.U) best = { N, V, T, M1: Math.abs(f[4]) + Math.abs(f[5]), M2: Math.abs(f[10]) + Math.abs(f[11]), U, mode: m, end: end as 0 | 1, sigma: sg, strength: fs };
    }
    // global buckling governs members taking part in the critical mode
    if (N < 0 && partic[i] > 0.08 && isFinite(lambda)) {
      const Ub = 1 / lambda;
      if (Ub > best.U) best = { ...best, U: Ub, mode: 'buckling', end: Math.abs(f[4]) + Math.abs(f[5]) > Math.abs(f[10]) + Math.abs(f[11]) ? 0 : 1 };
    }
    elements.push(best);
  });

  // ---- contacts
  const nc = model.contacts.length;
  const contactFn = new Float64Array(nc);
  const contactFt = new Float64Array(nc);
  const Fvec: Vec3T[] = [];
  const active = new Uint8Array(nc);
  model.contacts.forEach((c, i) => {
    const d = contactDelta(ctx, c, x);
    const dn = d[0] * c.n[0] + d[1] * c.n[1] + d[2] * c.n[2];
    let Fn = -c.kn * dn;
    const dt: Vec3T = [d[0] - dn * c.n[0], d[1] - dn * c.n[1], d[2] - dn * c.n[2]];
    let ft: Vec3T = [-c.kt * dt[0], -c.kt * dt[1], -c.kt * dt[2]];
    if (!c.bonded && Fn < 0) {
      Fn = 0;
      ft = [0, 0, 0];
    } else active[i] = 1;
    contactFn[i] = Fn;
    contactFt[i] = Math.hypot(ft[0], ft[1], ft[2]);
    Fvec.push([Fn * c.n[0] + ft[0], Fn * c.n[1] + ft[1], Fn * c.n[2] + ft[2]]);
  });

  const patches: PatchResult[] = model.patches.map((p) => {
    const F: Vec3T = [0, 0, 0];
    let Fn = 0;
    let jointU = 0, bearingU = 0, punchU = 0, slipU = 0, side: 0 | 1 = 0;
    let anyActive = false;
    let worstPoint = p.patch.centroid;
    const unstable = unstablePart[p.partA] || (p.partB >= 0 && unstablePart[p.partB]);
    for (const ci of p.points) {
      const c = model.contacts[ci];
      F[0] += Fvec[ci][0];
      F[1] += Fvec[ci][1];
      F[2] += Fvec[ci][2];
      Fn += contactFn[ci];
      if (active[ci]) anyActive = true;
      if (unstable) continue;
      if (c.bonded) {
        const T = Math.max(0, -contactFn[ci]);
        const Uj = Math.hypot(isFinite(c.capT) ? T / Math.max(c.capT, 1e-9) : 0, isFinite(c.capV) ? contactFt[ci] / Math.max(c.capV, 1e-9) : 0);
        if (Uj > jointU) {
          jointU = Uj;
          worstPoint = c.point;
        }
      }
      if (!p.hertz) {
        const pr = Math.max(0, contactFn[ci]) / Math.max(c.area, 1e-8);
        const weak = Math.min(c.bearA, c.bearB);
        const Ub = pr / weak;
        if (Ub > bearingU) {
          bearingU = Ub;
          side = c.bearA <= c.bearB ? 0 : 1;
        }
      }
    }
    const Ft = Math.sqrt(Math.max(0, F[0] ** 2 + F[1] ** 2 + F[2] ** 2 - Fn * Fn));
    if (!unstable && p.hertz && Fn > 0) {
      const a = Math.cbrt((3 * Fn * p.hertz.R) / (4 * p.hertz.Estar));
      const pmax = (3 * Fn) / (2 * Math.PI * a * a);
      const sideU = (m: typeof p.matA, along: boolean) => {
        if (m.ductile) return pmax / (1.6 * (m.fy ?? m.ft));
        if (m.failure === 'shatter' || m.failure === 'dice' || m.failure === 'crumble') return (((1 - 2 * m.nu) / 3) * pmax) / m.ft;
        if (m.grain && !along) return pmax / (m.fcPerp ?? m.fc * 0.15);
        return pmax / m.fc;
      };
      const uA = sideU(p.matA, p.bearingAlongA), uB = p.partB >= 0 || p.bId !== 'ground' ? sideU(p.matB, p.bearingAlongB) : 0;
      bearingU = Math.max(uA, uB);
      side = uA >= uB ? 0 : 1;
    }
    if (!unstable && p.punchPlate && Fn > 0) {
      const plate = p.punchPlate === 1 ? model.parts[p.partA] : model.parts[p.partB];
      const t = plate.def.size[plate.axis];
      const tau = Fn / (p.punchPerimeter * t);
      punchU = tau / plate.mat.fv;
    }
    if (p.joint === 'rest' && !p.patch.embedded && Fn > 0) slipU = Ft / (p.friction * Fn);
    let U = 0, mode: FailMode = 'none', message = '';
    const jointName = p.effectiveJoint;
    if (jointU > U) {
      U = jointU;
      mode = 'joint';
      message = `${jointName} joint overloaded (${(jointU * 100).toFixed(0)}% of capacity)`;
    }
    if (bearingU > U) {
      U = bearingU;
      mode = 'bearing';
      const m = side === 0 ? p.matA : p.matB;
      message = `${m.name} crushed at contact (${(bearingU * 100).toFixed(0)}% of bearing strength)`;
    }
    if (punchU > U) {
      U = punchU;
      mode = 'punching';
      message = `punches through (${(punchU * 100).toFixed(0)}% of punching shear strength)`;
    }
    return {
      Fn, Ft, F, U, mode, jointU, bearingU, punchU, slipU, lifted: !anyActive, side,
      point: mode === 'joint' ? worstPoint : p.patch.centroid, message,
    };
  });

  // ---- parts
  const parts: PartResult[] = model.parts.map((info, pi) => {
    let maxDisp = 0;
    for (const nd of info.nodes) maxDisp = Math.max(maxDisp, Math.hypot(u[6 * nd], u[6 * nd + 1], u[6 * nd + 2]));
    const r: PartResult = {
      U: 0, mode: 'none', point: [info.def.pos[0], info.def.pos[1], info.def.pos[2]], a: 0, b: 0, dir: 0,
      unstable: !!unstablePart[pi], maxDisp: unstablePart[pi] ? 0 : maxDisp, N: 0, Ncr: Infinity, sigma: 0, strength: 0,
      message: '', patch: -1,
    };
    if (unstablePart[pi]) {
      r.mode = 'unstable';
      r.message = 'Not stable: it will tip, slide or fall';
      return r;
    }
    let maxComp = 0;
    for (const ei of info.elems) {
      const er = elements[ei];
      const e = model.elements[ei];
      if (er.N < maxComp) maxComp = er.N;
      if (er.U > r.U) {
        const nd = er.end === 0 ? e.n1 : e.n2;
        r.U = er.U;
        r.mode = er.mode;
        r.point = [model.nodePos[3 * nd], model.nodePos[3 * nd + 1], model.nodePos[3 * nd + 2]];
        r.a = er.end === 0 ? e.a1 : e.a2;
        r.b = er.end === 0 ? e.b1 : e.b2;
        r.dir = e.plateDir ?? 0;
        r.N = er.N;
        r.sigma = er.sigma;
        r.strength = er.strength;
      }
    }
    if (r.mode === 'buckling') {
      // a buckled member kinks where the (amplified) bending moment peaks
      let bestM = -1;
      for (const ei of info.elems) {
        const er = elements[ei];
        const e = model.elements[ei];
        for (const end of [0, 1] as const) {
          const M = end === 0 ? er.M1 : er.M2;
          if (M > bestM) {
            bestM = M;
            const nd = end === 0 ? e.n1 : e.n2;
            r.point = [model.nodePos[3 * nd], model.nodePos[3 * nd + 1], model.nodePos[3 * nd + 2]];
            r.a = end === 0 ? e.a1 : e.a2;
            r.b = end === 0 ? e.b1 : e.b2;
            r.dir = e.plateDir ?? 0;
          }
        }
      }
      r.N = maxComp;
      r.Ncr = isFinite(lambda) ? Math.abs(maxComp) * lambda : Infinity;
    }
    return r;
  });
  // contact-governed failures
  model.patches.forEach((p, i) => {
    const pr = patches[i];
    if (pr.mode === 'bearing' || pr.mode === 'punching') {
      let pi = pr.side === 0 ? p.partA : p.partB;
      if (pr.mode === 'punching') pi = p.punchPlate === 1 ? p.partA : p.partB;
      if (pi < 0) return;
      const r = parts[pi];
      if (pr.U > r.U && !r.unstable) {
        r.U = pr.U;
        r.mode = pr.mode;
        r.point = pr.point;
        r.patch = i;
        r.sigma = 0;
        r.strength = 0;
        const loc = toLocalSafe(model, pi, pr.point);
        r.a = loc[0];
        r.b = loc[1];
      }
    } else if (pr.mode === 'joint') {
      const r = parts[p.partA];
      if (pr.U > r.U && !r.unstable && pr.U >= 1) {
        r.U = pr.U;
        r.mode = 'joint';
        r.point = pr.point;
        r.patch = i;
      }
    }
  });
  parts.forEach((r, pi) => {
    if (!r.message) r.message = describe(model, pi, r, patches, lambda);
  });

  const unstableParts: number[] = [];
  unstablePart.forEach((v, i) => v && unstableParts.push(i));
  return {
    u, elements, contactFn, contactFt, patches, parts, lambda, mode: modeOut, amplification, unstableParts,
    totalWeight: model.totalWeight, timeMs: 0, iterations: 0, compliance: 0,
  };
}

function toLocalSafe(model: FEModel, pi: number, p: Vec3T): [number, number] {
  const info = model.parts[pi];
  const def = info.def;
  // inverse rotate
  const q = def.quat;
  const v = [p[0] - def.pos[0], p[1] - def.pos[1], p[2] - def.pos[2]];
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  const l = [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
  if (info.kind === 'beam') return [l[info.axis], 0];
  if (info.kind === 'plate') return [l[info.uAxis], l[info.vAxis]];
  return [l[1], 0];
}

function describe(model: FEModel, pi: number, r: PartResult, patches: PatchResult[], lambda: number): string {
  const info = model.parts[pi];
  const m = info.mat;
  const pct = (r.U * 100).toFixed(0) + '%';
  switch (r.mode) {
    case 'none':
      return 'Carries almost no load';
    case 'buckling':
      return `Buckling: carries ${fmtN(-r.N)} in compression; the structure becomes unstable at ${isFinite(r.Ncr) ? fmtN(r.Ncr) : '—'} (${pct})`;
    case 'bending':
      return m.ductile
        ? `Bending: ${formatPa(r.sigma)} against a yield strength of ${formatPa(r.strength)} (${pct})`
        : `Bending: ${formatPa(r.sigma)} against a strength of ${formatPa(r.strength)} (${pct})`;
    case 'compression':
      return `Crushing: ${formatPa(r.sigma)} against a compressive strength of ${formatPa(r.strength)} (${pct})`;
    case 'tension':
      return `Tension: ${formatPa(r.sigma)} against a tensile strength of ${formatPa(r.strength)} (${pct})`;
    case 'shear':
      return `Shear: ${formatPa(r.sigma)} against a shear strength of ${formatPa(r.strength)} (${pct})`;
    case 'torsion':
      return `Twisting: ${formatPa(r.sigma)} against a shear strength of ${formatPa(r.strength)} (${pct})`;
    case 'bearing':
    case 'punching':
    case 'joint':
      return r.patch >= 0 ? cap(patches[r.patch].message) : pct;
    default:
      void lambda;
      return pct;
  }
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

