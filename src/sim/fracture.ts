import { newId, type PartDef, type Vec3T } from '../core/design';
import type { FailureStyle, Material } from '../core/materials';
import { clipPoints } from '../core/polytope';
import { hasRound } from '../core/rounding';
import { grainAxis, halfExtents, hasCuts, qRotate } from '../core/shapes';
import type { FEPartInfo } from '../fea/model';
import { rectSection, circleSection, tubeSection } from '../fea/sections';

export interface HingeSpec {
  a: number;
  b: number;
  /** hinge point in the ORIGINAL part's local frame */
  point: Vec3T;
  /** plastic moment capacity (N m) */
  Mp: number;
  maxAngle: number;
}

export interface FractureResult {
  pieces: PartDef[];
  debris: PartDef[];
  /** which piece owns a point given in the original part's local frame (-1 = none) */
  owner: (local: Vec3T) => number;
  hinge?: HingeSpec;
  style: FailureStyle;
  /** break location in the original local frame */
  at: Vec3T;
  /** pieces were made by a straight cut (beam/plate) */
  cut: boolean;
}

let seedCounter = 1;
function rnd(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const pieceCounters = new Map<string, number>();

/** fresh numbering for a new simulation run */
export function resetPieceNames() {
  pieceCounters.clear();
}

function pieceName(parent: PartDef): string {
  const root = parent.name.replace(/ \(piece \d+\)$/, '');
  const k = (pieceCounters.get(root) ?? 0) + 1;
  pieceCounters.set(root, k);
  return `${root} (piece ${k})`;
}

function child(parent: PartDef, localCenter: Vec3T, patch: Partial<PartDef>, n: number): PartDef {
  void n;
  const o = [0, 0, 0];
  qRotate(parent.quat, localCenter[0], localCenter[1], localCenter[2], o);
  const out: PartDef = {
    ...parent,
    id: newId('f'),
    name: pieceName(parent),
    pos: [parent.pos[0] + o[0], parent.pos[1] + o[1], parent.pos[2] + o[2]],
    quat: [...parent.quat] as PartDef['quat'],
    parentId: parent.id,
    gen: (parent.gen ?? 0) + 1,
    breaks: [],
    grain: grainAxis(parent),
    ...patch,
  };
  // saw cuts on the parent move with the piece's new origin
  if (hasCuts(parent)) {
    const c = parent.cuts!;
    const moved: number[] = [];
    for (let i = 0; i + 3 < c.length; i += 4) moved.push(c[i], c[i + 1], c[i + 2], c[i + 3] - (c[i] * localCenter[0] + c[i + 1] * localCenter[1] + c[i + 2] * localCenter[2]));
    if (out.kind === 'hull') {
      let pts = out.hull ?? [];
      for (let i = 0; i + 3 < moved.length && pts.length >= 12; i += 4) pts = clipPoints(pts, moved[i], moved[i + 1], moved[i + 2], moved[i + 3]);
      out.hull = pts;
      out.cuts = undefined;
    } else out.cuts = moved;
  }
  return out;
}

/**
 * A rounded part broken across `axis`: the piece on `side` (-1 / +1) keeps its rounded edges
 * except along the fresh break.
 */
function breakEdges(def: PartDef, axis: number, side: number): PartDef['edge'] {
  const e = def.edge;
  if (!e || !hasRound(def)) return e;
  const up = def.kind === 'box' ? e.up : 1;
  const out = { ...e, corners: e.corners ? [...e.corners] : undefined };
  if (axis === up) {
    if (side < 0) out.top = 0;
    else out.bottom = 0;
  } else if (out.corners) {
    const bit = axis === (up + 1) % 3 ? 1 : 2;
    // the break is on the + side of the piece at -1, and on the - side of the piece at +1
    out.corners = out.corners.map((r, i) => ((side < 0) === !!(i & bit) ? 0 : r));
  }
  return out;
}

/** hull fragments that a saw cut had already removed */
function emptyHull(p: PartDef): boolean {
  return p.kind === 'hull' && (p.hull ?? []).length < 12;
}

/** clip a convex polygon by the half plane n.x <= d */
function clip(poly: [number, number][], nx: number, ny: number, d: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - d, db = nx * b[0] + ny * b[1] - d;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function polyArea(p: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** extrude a convex polygon (in the uA/vA plane of the part, thickness along w) into a hull part */
function prismPiece(parent: PartDef, poly: [number, number][], uA: number, vA: number, w: number, t: number, n: number, debris: boolean): PartDef | null {
  const area = polyArea(poly);
  if (poly.length < 3 || area < 1e-6) return null;
  let cu = 0, cv = 0;
  for (const p of poly) {
    cu += p[0];
    cv += p[1];
  }
  cu /= poly.length;
  cv /= poly.length;
  const center: Vec3T = [0, 0, 0];
  center[uA] = cu;
  center[vA] = cv;
  const pts: number[] = [];
  let ext = [0, 0, 0];
  for (const s of [-1, 1])
    for (const p of poly) {
      const q = [0, 0, 0];
      q[uA] = p[0] - cu;
      q[vA] = p[1] - cv;
      q[w] = (s * t) / 2;
      pts.push(q[0], q[1], q[2]);
      ext = ext.map((e, k) => Math.max(e, Math.abs(q[k])));
    }
  return child(parent, center, { kind: 'hull', hull: pts, hullVolume: area * t, size: [ext[0] * 2, ext[1] * 2, ext[2] * 2], debris }, n);
}

function voronoiCells(boundary: [number, number][], seeds: [number, number][]): [number, number][][] {
  const cells: [number, number][][] = [];
  for (let i = 0; i < seeds.length; i++) {
    let poly = boundary.slice();
    const si = seeds[i];
    for (let j = 0; j < seeds.length && poly.length >= 3; j++) {
      if (i === j) continue;
      const sj = seeds[j];
      const nx = sj[0] - si[0], ny = sj[1] - si[1];
      const d = (nx * (sj[0] + si[0])) / 2 + (ny * (sj[1] + si[1])) / 2;
      poly = clip(poly, nx, ny, d);
    }
    if (poly.length >= 3) cells.push(poly);
  }
  return cells;
}

/** irregular chunks filling a box region (crumbling stone/concrete) */
function chunkBox(parent: PartDef, center: Vec3T, half: Vec3T, nx: number, ny: number, nz: number, rand: () => number, debris: boolean, startN: number): PartDef[] {
  const out: PartDef[] = [];
  let n = startN;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        const size = [(2 * half[0]) / nx, (2 * half[1]) / ny, (2 * half[2]) / nz];
        const c: Vec3T = [
          center[0] - half[0] + size[0] * (i + 0.5),
          center[1] - half[1] + size[1] * (j + 0.5),
          center[2] - half[2] + size[2] * (k + 0.5),
        ];
        const pts: number[] = [];
        for (const sx of [-1, 1])
          for (const sy of [-1, 1])
            for (const sz of [-1, 1]) {
              const j0 = 0.38 + rand() * 0.14;
              pts.push(sx * size[0] * j0 * (0.8 + rand() * 0.25), sy * size[1] * j0 * (0.8 + rand() * 0.25), sz * size[2] * j0 * (0.8 + rand() * 0.25));
            }
        out.push(child(parent, c, { kind: 'hull', hull: pts, hullVolume: size[0] * size[1] * size[2] * 0.55, size: [size[0] * 0.95, size[1] * 0.95, size[2] * 0.95], debris }, n++));
      }
  return out;
}

function sectionOf(def: PartDef, axis: number) {
  if (def.kind === 'cylinder') return circleSection(def.size[0]);
  if (def.kind === 'tube') return tubeSection(def.size[0], def.wall ?? def.size[0] * 0.15);
  return rectSection(def.size[(axis + 1) % 3], def.size[(axis + 2) % 3]);
}

export interface FractureInput {
  info: FEPartInfo;
  mat: Material;
  /** beam: station; plate: u coordinate; blocks: ignored */
  a: number;
  /** plate: v coordinate */
  b: number;
  /** plate: failed strip direction (0 = along u, 1 = along v) */
  dir: number;
  /** local point of failure (for blocks/shatter centres) */
  local: Vec3T;
  crushAxis?: number;
  crushSign?: number;
}

export function fracture(def: PartDef, inp: FractureInput): FractureResult {
  const res = fractureRaw(def, inp);
  if (hasCuts(def)) {
    res.debris = res.debris.filter((p) => !emptyHull(p));
    if (!res.cut) res.pieces = res.pieces.filter((p) => !emptyHull(p));
  }
  return res;
}

function fractureRaw(def: PartDef, inp: FractureInput): FractureResult {
  const { info, mat } = inp;
  const seed = (seedCounter += 7919);
  const rand = rnd(seed);
  const style = mat.failure;
  if (style === 'crush') return crush(def, inp);

  // glassy flat strips (a glass shelf is "beam-like" but breaks like a pane)
  if ((style === 'shatter' || style === 'dice') && def.kind === 'box' && info.kind !== 'block') {
    const order = [0, 1, 2].sort((x, y) => def.size[y] - def.size[x]);
    if (def.size[order[2]] <= 0.3 * def.size[order[1]]) {
      const flat = { ...info, kind: 'plate', uAxis: order[0], vAxis: order[1], axis: order[2], disk: false } as FEPartInfo;
      return shatterPlate(def, { ...inp, info: flat, a: inp.local[order[0]], b: inp.local[order[1]] }, rand, seed);
    }
  }

  // ---- beams: one clean cut through the critical section
  if (info.kind === 'beam') {
    const a = info.axis;
    const L = def.size[a];
    const h = L / 2;
    const sec = sectionOf(def, a);
    const minLen = Math.max(0.02, 0.6 * Math.max(sec.dy, sec.dz));
    if (L < 2.2 * minLen) return crumbleWhole(def, inp, rand, seed);
    const s = Math.max(-h + minLen, Math.min(h - minLen, inp.a));
    const gap = style === 'bend' ? 0.0005 : 0.003;
    const L1 = s - gap / 2 + h, L2 = h - s - gap / 2;
    const c1 = (-h + s - gap / 2) / 2, c2 = (s + gap / 2 + h) / 2;
    const sz1 = [...def.size] as Vec3T, sz2 = [...def.size] as Vec3T;
    sz1[a] = L1;
    sz2[a] = L2;
    const old = def.breaks ?? [];
    const keep = (side: number) => old.filter((b) => b.axis === a && b.side === side);
    const brk = style === 'bend' ? [] : [{ axis: a, side: 1, seed, style }];
    const brk2 = style === 'bend' ? [] : [{ axis: a, side: -1, seed: seed + 1, style }];
    const lc1: Vec3T = [0, 0, 0], lc2: Vec3T = [0, 0, 0];
    lc1[a] = c1;
    lc2[a] = c2;
    const p1 = child(def, lc1, { size: sz1, breaks: [...keep(-1), ...brk], edge: breakEdges(def, a, -1) }, 1);
    const p2 = child(def, lc2, { size: sz2, breaks: [...keep(1), ...brk2], edge: breakEdges(def, a, 1) }, 2);
    const debris: PartDef[] = [];
    const at: Vec3T = [0, 0, 0];
    at[a] = s;
    if (style === 'crumble' || style === 'shatter' || style === 'dice') {
      const hs = [sec.dy / 2, sec.dz / 2];
      const half: Vec3T = [0, 0, 0];
      half[a] = Math.min(sec.dy, sec.dz) * 0.35;
      half[(a + 1) % 3] = hs[0] * 0.9;
      half[(a + 2) % 3] = hs[1] * 0.9;
      debris.push(...chunkBox(def, at, half, 1, 2, 2, rand, true, 3).filter(() => rand() > 0.35));
    }
    let hinge: HingeSpec | undefined;
    if (style === 'bend') {
      const Wmin = Math.min(sec.Wy, sec.Wz);
      const fy = mat.fy ?? mat.ft;
      hinge = { a: 0, b: 1, point: at, Mp: fy * sec.plastic * Wmin, maxAngle: mat.id === 'lead' || mat.id === 'gold' || mat.id === 'copper' ? 2.4 : mat.id === 'aluminum' ? 1.1 : 1.6 };
    }
    return { pieces: [p1, p2], debris, owner: (lp) => (lp[a] < s ? 0 : 1), hinge, style, at, cut: true };
  }

  // ---- plates
  if (info.kind === 'plate') {
    const uA = info.uAxis, vA = info.vAxis, w = info.axis;
    const A = def.size[uA], B = def.size[vA], t = def.size[w];
    const at: Vec3T = [0, 0, 0];
    at[uA] = inp.a;
    at[vA] = inp.b;
    if (style === 'shatter' || style === 'dice' || info.disk) {
      return shatterPlate(def, inp, rand, seed);
    }
    // straight crack across the failed strip direction
    const along = inp.dir === 0 ? uA : vA;
    const span = inp.dir === 0 ? A : B;
    const minW = Math.max(0.03, span * 0.08);
    const x = Math.max(-span / 2 + minW, Math.min(span / 2 - minW, inp.dir === 0 ? inp.a : inp.b));
    const gap = style === 'bend' ? 0.0005 : 0.003;
    const L1 = x - gap / 2 + span / 2, L2 = span / 2 - x - gap / 2;
    const sz1 = [...def.size] as Vec3T, sz2 = [...def.size] as Vec3T;
    sz1[along] = L1;
    sz2[along] = L2;
    const lc1: Vec3T = [0, 0, 0], lc2: Vec3T = [0, 0, 0];
    lc1[along] = (-span / 2 + x - gap / 2) / 2;
    lc2[along] = (x + gap / 2 + span / 2) / 2;
    const old = def.breaks ?? [];
    const keep = (side: number) => old.filter((b) => b.axis !== along || b.side === side);
    const p1 = child(def, lc1, { size: sz1, breaks: [...keep(-1), ...(style === 'bend' ? [] : [{ axis: along, side: 1, seed, style }])], edge: breakEdges(def, along, -1) }, 1);
    const p2 = child(def, lc2, { size: sz2, breaks: [...keep(1), ...(style === 'bend' ? [] : [{ axis: along, side: -1, seed: seed + 1, style }])], edge: breakEdges(def, along, 1) }, 2);
    const debris: PartDef[] = [];
    if (style === 'crumble') {
      const half: Vec3T = [0, 0, 0];
      half[along] = Math.min(0.03, t);
      half[along === uA ? vA : uA] = (along === uA ? B : A) * 0.45;
      half[w] = t * 0.45;
      const c: Vec3T = [0, 0, 0];
      c[along] = x;
      debris.push(...chunkBox(def, c, half, 1, along === uA ? 1 : 3, along === uA ? 3 : 1, rand, true, 3).filter(() => rand() > 0.3));
    }
    let hinge: HingeSpec | undefined;
    if (style === 'bend') {
      const other = along === uA ? B : A;
      const W = (other * t * t) / 6;
      hinge = { a: 0, b: 1, point: [...at] as Vec3T, Mp: (mat.fy ?? mat.ft) * 1.5 * W, maxAngle: 1.6 };
      hinge.point[along] = x;
    }
    return { pieces: [p1, p2], debris, owner: (lp) => (lp[along] < x ? 0 : 1), hinge, style, at, cut: true };
  }

  // ---- blocks
  if (mat.ductile) {
    return { pieces: [], debris: [], owner: () => -1, style: 'bend', at: inp.local, cut: false };
  }
  return crumbleWhole(def, inp, rand, seed);
}

function crumbleWhole(def: PartDef, inp: FractureInput, rand: () => number, seed: number): FractureResult {
  void seed;
  const he = halfExtents(def);
  const big = Math.max(...he);
  const counts = he.map((x) => Math.max(1, Math.min(3, Math.round((x / big) * 3))));
  if (counts[0] * counts[1] * counts[2] < 4) counts[counts.indexOf(Math.max(...counts))] = 2;
  const pieces = chunkBox(def, [0, 0, 0], [he[0], he[1], he[2]], counts[0], counts[1], counts[2], rand, false, 1);
  for (const p of pieces) if (Math.max(...p.size) < 0.06) p.debris = true;
  return { pieces: pieces.filter((p) => !p.debris), debris: pieces.filter((p) => p.debris), owner: () => -1, style: inp.mat.failure, at: inp.local, cut: false };
}

function shatterPlate(def: PartDef, inp: FractureInput, rand: () => number, seed: number): FractureResult {
  void seed;
  const { info } = inp;
  const uA = info.uAxis, vA = info.vAxis, w = info.axis;
  const A = def.size[uA], B = def.size[vA], t = def.size[w];
  let boundary: [number, number][];
  if (info.disk) {
    boundary = [];
    for (let i = 0; i < 24; i++) boundary.push([(Math.cos((i / 24) * Math.PI * 2) * A) / 2, (Math.sin((i / 24) * Math.PI * 2) * A) / 2]);
  } else
    boundary = [
      [-A / 2, -B / 2],
      [A / 2, -B / 2],
      [A / 2, B / 2],
      [-A / 2, B / 2],
    ];
  const tempered = inp.mat.failure === 'dice';
  const area = A * B;
  const seeds: [number, number][] = [];
  if (tempered) {
    const cell = Math.max(0.035, Math.sqrt(area / 70));
    for (let u = -A / 2 + cell / 2; u < A / 2; u += cell)
      for (let v = -B / 2 + cell / 2; v < B / 2; v += cell) seeds.push([u + (rand() - 0.5) * cell * 0.5, v + (rand() - 0.5) * cell * 0.5]);
  } else {
    const n = Math.max(10, Math.min(34, Math.round(area / 0.012) + 10));
    const r0 = Math.min(A, B) * 0.22;
    for (let i = 0; i < n; i++) {
      if (i < n * 0.55) {
        const ang = rand() * Math.PI * 2, rr = r0 * Math.sqrt(rand()) * (0.3 + rand());
        seeds.push([Math.max(-A / 2, Math.min(A / 2, inp.a + Math.cos(ang) * rr)), Math.max(-B / 2, Math.min(B / 2, inp.b + Math.sin(ang) * rr))]);
      } else seeds.push([(rand() - 0.5) * A, (rand() - 0.5) * B]);
    }
  }
  const cells = voronoiCells(boundary, seeds);
  const debris: PartDef[] = [];
  let k = 1;
  for (const c of cells) {
    const p = prismPiece(def, c, uA, vA, w, t, k++, true);
    if (p) debris.push(p);
  }
  const at: Vec3T = [0, 0, 0];
  at[uA] = inp.a;
  at[vA] = inp.b;
  return { pieces: [], debris, owner: () => -1, style: inp.mat.failure, at, cut: false };
}

function crush(def: PartDef, inp: FractureInput): FractureResult {
  const ax = inp.crushAxis ?? (inp.info.kind === 'beam' ? inp.info.axis : 1);
  const sign = inp.crushSign ?? -1;
  const old = def.size[ax];
  const nsz = Math.max(0.01, old * 0.4);
  const shift = ((old - nsz) / 2) * sign;
  const lc: Vec3T = [0, 0, 0];
  lc[ax] = shift;
  const size = [...def.size] as Vec3T;
  size[ax] = nsz;
  const p = child(def, lc, { size, crushed: (def.crushed ?? 0) + 1, name: def.name }, 1);
  p.name = def.name;
  return { pieces: [p], debris: [], owner: () => 0, style: 'crush', at: inp.local, cut: false };
}
