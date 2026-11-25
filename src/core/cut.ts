import type { PartDef, Vec3T } from './design';
import type { Material } from './materials';
import { clipPoints, clipPolytope, polytopeAABB, polytopeSection, planeBasis, prismPolytope, type Polytope } from './polytope';
import { hasRound } from './rounding';
import {
  basePolytope, clippedPolytope, grainAxis, halfExtents, hasCuts, innerRadius, qConj, qRotate, sdfBase, toLocal, volume,
} from './shapes';

// ------------------------------------------------------------------ cutters

export type CutterKind = 'handsaw' | 'finesaw' | 'hacksaw' | 'grinder' | 'diamond' | 'glasscutter' | 'knife';
export type CutFx = 'sawdust' | 'sparks' | 'shavings' | 'dust' | 'glitter' | 'crumbs' | 'snow';

export interface Cutter {
  kind: CutterKind;
  /** what the tool is called ("hand saw") */
  name: string;
  /** width of material the blade removes (m) */
  kerf: number;
  /** cutting speed (m² of cross-section per second, real time) */
  rate: number;
  fx: CutFx;
  /** particle colour for the chips / dust / sparks */
  color: string;
  /** past tense for the log */
  verb: string;
  /** a remark for the tool panel */
  note?: string;
  /** set when the material cannot be cut at all */
  refuse?: string;
}

/** cutting speeds in cm² of cross-section per second, roughly what a person with the right tool manages */
const RATE_CM2: Record<string, number> = {
  pine: 3, oak: 1.8, balsa: 15, plywood: 2.5, bamboo: 2,
  steel: 0.8, stainless: 0.6, aluminum: 2.5, titanium: 0.45, copper: 1.6, lead: 4, gold: 2.2, tungsten: 0.22, castiron: 0.9,
  concrete: 1.0, rconcrete: 0.6, brick: 1.5, granite: 0.55, marble: 0.9,
  ceramic: 0.7, ice: 5, acrylic: 2, abs: 3, pvc: 3, hdpe: 3, carbon: 1, rubber: 6, foam: 40,
};

const SPARK: Record<string, string> = {
  steel: '#ffb347', stainless: '#ffd27a', castiron: '#ff8a3d', titanium: '#f4f7ff', tungsten: '#d8692e',
};

export function cutterFor(m: Material): Cutter {
  const rate = (RATE_CM2[m.id] ?? 2) * 1e-4;
  const light = m.visual.color2 ?? m.visual.color;
  switch (m.id) {
    case 'tglass':
      return {
        kind: 'glasscutter', name: 'glass cutter', kerf: 0, rate: 1, fx: 'glitter', color: '#e8fbff', verb: 'scored',
        refuse: 'Tempered glass cannot be cut. It is pre-stressed, so a score line releases the stress and the whole pane bursts into little cubes. Cut annealed glass, then temper it.',
      };
    case 'glass':
      return { kind: 'glasscutter', name: 'glass cutter', kerf: 0, rate: 1, fx: 'glitter', color: '#e8fbff', verb: 'scored and snapped', note: 'Score and snap: no material is removed.' };
    case 'balsa':
      return { kind: 'knife', name: 'craft knife', kerf: 0.0003, rate, fx: 'shavings', color: light, verb: 'sliced' };
    case 'foam':
      return { kind: 'knife', name: 'hot-wire / knife', kerf: 0.0005, rate, fx: 'crumbs', color: '#f4f4f0', verb: 'sliced' };
    case 'rubber':
      return { kind: 'knife', name: 'utility knife', kerf: 0.0003, rate, fx: 'crumbs', color: m.visual.color, verb: 'sliced' };
    case 'ice':
      return { kind: 'handsaw', name: 'ice saw', kerf: 0.002, rate, fx: 'snow', color: '#f2fbff', verb: 'sawed' };
  }
  if (m.category === 'Wood') return { kind: 'handsaw', name: 'hand saw', kerf: 0.0015, rate, fx: 'sawdust', color: light, verb: 'sawed' };
  if (m.category === 'Metal') {
    if (SPARK[m.id]) {
      return {
        kind: 'grinder', name: 'angle grinder', kerf: 0.002, rate, fx: 'sparks', color: SPARK[m.id], verb: 'cut',
        note: m.id === 'tungsten' ? 'Tungsten is brutally hard: slow going, dull red sparks.' : m.id === 'titanium' ? 'Titanium throws brilliant white sparks.' : undefined,
      };
    }
    return { kind: 'hacksaw', name: 'hacksaw', kerf: 0.001, rate, fx: 'shavings', color: m.visual.color, verb: 'cut', note: 'Non-ferrous metal: no sparks, just bright shavings.' };
  }
  if (m.category === 'Stone & Masonry' || m.id === 'ceramic' || m.id === 'carbon') {
    return { kind: 'diamond', name: 'diamond blade', kerf: 0.0024, rate, fx: 'dust', color: m.id === 'carbon' ? '#2a2c30' : light, verb: 'cut' };
  }
  return { kind: 'finesaw', name: 'fine-tooth saw', kerf: 0.001, rate, fx: 'shavings', color: m.visual.color, verb: 'sawed' };
}

/** real-world seconds to cut a section of `area` m² */
export function cutSeconds(c: Cutter, area: number): number {
  if (c.kind === 'glasscutter') return 0.8;
  return area / Math.max(1e-6, c.rate);
}

// ------------------------------------------------------------------ vector helpers

type V = Vec3T;
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a: V, b: V, s = 1): V => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const scl = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
function rot(q: PartDef['quat'], v: V): V {
  const o = [0, 0, 0];
  qRotate(q, v[0], v[1], v[2], o);
  return [o[0], o[1], o[2]];
}
/** rotate v about unit axis k by angle a (Rodrigues) */
function rotAbout(v: V, k: V, a: number): V {
  const c = Math.cos(a), s = Math.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

function loopArea(loop: number[], n: V): number {
  // Newell area of a planar loop
  let ax = 0, ay = 0, az = 0;
  const m = loop.length / 3;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const a = [loop[3 * i], loop[3 * i + 1], loop[3 * i + 2]], b = [loop[3 * j], loop[3 * j + 1], loop[3 * j + 2]];
    ax += a[1] * b[2] - a[2] * b[1];
    ay += a[2] * b[0] - a[0] * b[2];
    az += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(ax * n[0] + ay * n[1] + az * n[2]) / 2;
}

// ------------------------------------------------------------------ aiming a cut

export interface CutAim {
  /** plane (world): n.x = s */
  n: V;
  s: number;
  /** outward normal of the face the blade goes in through */
  face: V;
  /** where the blade starts (on the plane, at the face) */
  entry: V;
  /** direction the blade advances through the material */
  feed: V;
  /** direction of the blade strokes */
  line: V;
  /** how far the blade has to advance */
  depth: number;
  /** how wide the cut is along the stroke direction */
  width: number;
  /** cut area (m²) */
  area: number;
  /** extent of the part along n */
  lo: number;
  hi: number;
  /** the cut section (world loops) */
  section: V[];
  hole: V[];
  /** the cut is square to the part, so the pieces stay plain boxes / cylinders */
  square: boolean;
  /** how long each piece is, measured along the part's axis that the cut crosses */
  lenNeg: number;
  lenPos: number;
  /** middle of each piece (world), for labels */
  midNeg: V;
  midPos: V;
  /** local-frame copy of the plane: nl.x = sl */
  nl: V;
  sl: number;
}

export interface AimOptions {
  /** extra rotation of the cut about the face normal (degrees) */
  angle: number;
  /** position snapping step (m), 0 = free */
  snap: number;
  kerf: number;
  /** where the viewer is (world): the blade comes in from that side when it has a choice */
  eye?: V;
}

/** outward normal (local) of the face hit at local point pl with local hit normal nh */
function faceNormal(def: PartDef, pl: V, nh: V): V {
  const cands: V[] = [];
  const c = hasCuts(def) ? def.cuts! : [];
  for (let i = 0; i + 3 < c.length; i += 4) cands.push([c[i], c[i + 1], c[i + 2]]);
  if (def.kind === 'box') {
    for (let a = 0; a < 3; a++)
      for (const s of [-1, 1]) {
        const v: V = [0, 0, 0];
        v[a] = s;
        cands.push(v);
      }
  } else if (def.kind === 'cylinder' || def.kind === 'tube') {
    cands.push([0, 1, 0], [0, -1, 0]);
    const r = Math.hypot(pl[0], pl[2]);
    if (r > 1e-9) cands.push([pl[0] / r, 0, pl[2] / r]);
  } else if (def.kind === 'sphere') {
    cands.push(norm(pl));
  } else return norm(nh);
  let best = cands[0], bd = -Infinity;
  for (const v of cands) {
    const d = dot(v, nh);
    if (d > bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

/** local extent of the part along each local axis (for choosing a cross cut) */
function axisExtent(def: PartDef): V {
  if (def.kind === 'cylinder' || def.kind === 'tube') return [def.size[0], def.size[1], def.size[0]];
  const h = halfExtents(def);
  return [2 * h[0], 2 * h[1], 2 * h[2]];
}

/**
 * Where a saw pointed at `hit` (world) on a face with normal `hitNormal` would cut. The blade goes
 * in through the face under the cursor; by default it cuts square across the part's longest
 * dimension, rotated by `angle` about the face normal.
 */
export function aimCut(def: PartDef, hit: V, hitNormal: V, opts: AimOptions): CutAim | null {
  const qi = qConj(def.quat);
  const pl = toLocal(def, hit[0], hit[1], hit[2]);
  const nh = norm(rot(qi, hitNormal));
  const face = faceNormal(def, pl, nh);
  // default plane normal: a local axis lying (mostly) in the face, along the longest extent
  const ext = axisExtent(def);
  const pref = [1, 0, 2];
  let n0: V | null = null;
  let bestScore = -Infinity;
  for (const a of pref) {
    const e: V = [0, 0, 0];
    e[a] = 1;
    const d = Math.abs(dot(e, face));
    if (d > 0.6) continue;
    const score = ext[a] * (1 - d * d) + (a === 1 ? 1e-6 : 0);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      n0 = e;
    }
  }
  if (!n0) n0 = norm(cross(face, [0, 1, 0]));
  let nl = norm(rotAbout(n0, face, (opts.angle * Math.PI) / 180));
  // canonical sign (so labels read left-to-right consistently)
  if (nl[0] + nl[1] * 1.0001 + nl[2] * 1.0002 < 0) nl = scl(nl, -1);
  const n = norm(rot(def.quat, nl));
  const P = clippedPolytope(def);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P.v.length; i += 3) {
    const s = nl[0] * P.v[i] + nl[1] * P.v[i + 1] + nl[2] * P.v[i + 2];
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  const off = dot(n, def.pos);
  lo += off;
  hi += off;
  const k = opts.kerf / 2;
  const minPiece = 0.003;
  if (hi - lo < 2 * (minPiece + k)) return null;
  let s = dot(n, hit);
  if (opts.snap > 0) s = lo + Math.round((s - lo) / opts.snap) * opts.snap;
  const mid = (lo + hi) / 2;
  if (Math.abs(s - mid) < Math.max(0.004, 0.025 * (hi - lo))) s = mid;
  s = Math.max(lo + minPiece + k, Math.min(hi - minPiece - k, s));
  const sl = s - off;
  // the section
  const secL = polytopeSection(P, nl[0], nl[1], nl[2], sl);
  if (secL.length < 9) return null;
  const toW = (x: number, y: number, z: number): V => add(rot(def.quat, [x, y, z]), def.pos);
  const section: V[] = [];
  for (let i = 0; i < secL.length; i += 3) section.push(toW(secL[i], secL[i + 1], secL[i + 2]));
  let area = loopArea(secL, nl);
  const hole: V[] = [];
  if (def.kind === 'tube') {
    let inner: Polytope | null = prismPolytope(innerRadius(def), def.size[1] / 2 + 1e-4, 48);
    const c = hasCuts(def) ? def.cuts! : [];
    for (let i = 0; i + 3 < c.length && inner; i += 4) inner = clipPolytope(inner, c[i], c[i + 1], c[i + 2], c[i + 3]);
    if (inner) {
      const h = polytopeSection(inner, nl[0], nl[1], nl[2], sl);
      if (h.length >= 9) {
        area -= loopArea(h, nl);
        for (let i = 0; i < h.length; i += 3) hole.push(toW(h[i], h[i + 1], h[i + 2]));
      }
    }
  }
  const faceW = norm(rot(def.quat, face));
  // the blade goes in through the face under the cursor, unless the cut is much thinner the
  // other way (pointing at the edge of a slab still saws down through its thickness, from the
  // side facing you)
  let f1 = add(scl(faceW, -1), n, dot(faceW, n));
  if (Math.hypot(f1[0], f1[1], f1[2]) < 1e-6) f1 = cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  f1 = norm(f1);
  const f2 = norm(cross(n, f1));
  const extent = (f: V) => {
    let lo2 = Infinity, hi2 = -Infinity;
    for (const q of section) {
      const d = dot(q, f);
      lo2 = Math.min(lo2, d);
      hi2 = Math.max(hi2, d);
    }
    return hi2 - lo2;
  };
  let feed = f1;
  if (extent(f2) < 0.8 * extent(f1)) {
    feed = f2;
    let c: V = [0, 0, 0];
    for (const q of section) c = add(c, q, 1 / section.length);
    const toward = add(opts.eye ?? hit, c, -1);
    if (dot(feed, toward) > 0) feed = scl(feed, -1);
  }
  const line = norm(cross(n, feed));
  let fmin = Infinity, fmax = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const q of section) {
    const f = dot(q, feed), w = dot(q, line);
    fmin = Math.min(fmin, f);
    fmax = Math.max(fmax, f);
    wlo = Math.min(wlo, w);
    whi = Math.max(whi, w);
  }
  // start at the middle of the cut line, on the entry side
  const entry = add(add(scl(n, s), line, (wlo + whi) / 2), feed, fmin);
  const dmax = fmax - fmin;
  let square = false;
  if (def.kind === 'box') square = Math.max(Math.abs(nl[0]), Math.abs(nl[1]), Math.abs(nl[2])) > 0.99999;
  else if (def.kind === 'cylinder' || def.kind === 'tube') square = Math.abs(nl[1]) > 0.99999;
  // piece lengths along the axis the cut crosses (an angled cut is measured at the long side)
  const ax = [0, 1, 2].reduce((b, a) => (Math.abs(nl[a]) > Math.abs(nl[b]) ? a : b), 0);
  const piece = (pn: V, pd: number): [number, V] => {
    const Q = clipPolytope(P, pn[0], pn[1], pn[2], pd);
    if (!Q || !Q.v.length) return [0, def.pos];
    let mn = Infinity, mx = -Infinity;
    let c: V = [0, 0, 0];
    const m = Q.v.length / 3;
    for (let i = 0; i < Q.v.length; i += 3) {
      mn = Math.min(mn, Q.v[i + ax]);
      mx = Math.max(mx, Q.v[i + ax]);
      c = add(c, [Q.v[i], Q.v[i + 1], Q.v[i + 2]], 1 / m);
    }
    return [mx - mn, toW(c[0], c[1], c[2])];
  };
  const [lenNeg, midNeg] = piece(nl, sl - k);
  const [lenPos, midPos] = piece(scl(nl, -1), -(sl + k));
  return {
    n, s, face: faceW, entry, feed, line, depth: Math.max(dmax, 1e-3), width: Math.max(whi - wlo, 1e-3), area: Math.max(area, 0), lo, hi, section, hole, square, nl, sl,
    lenNeg, lenPos, midNeg, midPos,
  };
}

// ------------------------------------------------------------------ cutting

export interface CutPieces {
  /** the piece on the side n.x < s */
  neg: PartDef;
  /** the piece on the side n.x > s */
  pos: PartDef;
}

/**
 * Split a part along the world plane n.x = s, removing a kerf of material. The pieces keep the
 * material, grain direction and flags of the original. Square cuts give plain boxes / cylinders;
 * angled ones are kept as cut planes on the shape. Ids and names are left to the caller.
 */
export function cutPart(def: PartDef, n: V, s: number, kerf: number): CutPieces | null {
  const qi = qConj(def.quat);
  const nl = norm(rot(qi, n));
  const sl = s - dot(n, def.pos);
  const k = kerf / 2;
  const a = makePiece(def, [nl[0], nl[1], nl[2], sl - k]);
  const b = makePiece(def, [-nl[0], -nl[1], -nl[2], -(sl + k)]);
  if (!a || !b) return null;
  return { neg: a, pos: b };
}

function makePiece(def: PartDef, plane: number[]): PartDef | null {
  const grain = grainAxis(def);
  if (def.kind === 'hull') {
    const pts = clipPoints(def.hull ?? [], plane[0], plane[1], plane[2], plane[3]);
    if (pts.length < 12) return null;
    let cx = 0, cy = 0, cz = 0;
    const m = pts.length / 3;
    for (let i = 0; i < pts.length; i += 3) {
      cx += pts[i];
      cy += pts[i + 1];
      cz += pts[i + 2];
    }
    cx /= m;
    cy /= m;
    cz /= m;
    const he = [0, 0, 0];
    const out: number[] = [];
    for (let i = 0; i < pts.length; i += 3) {
      const p = [pts[i] - cx, pts[i + 1] - cy, pts[i + 2] - cz];
      out.push(p[0], p[1], p[2]);
      for (let j = 0; j < 3; j++) he[j] = Math.max(he[j], Math.abs(p[j]));
    }
    const old = halfExtents(def);
    const ratio = (he[0] * he[1] * he[2]) / Math.max(1e-12, old[0] * old[1] * old[2]);
    const shift = rot(def.quat, [cx, cy, cz]);
    return {
      ...def, hull: out, hullVolume: (def.hullVolume ?? volume(def)) * Math.min(1, ratio), size: [2 * he[0], 2 * he[1], 2 * he[2]],
      pos: add(def.pos, shift), cuts: undefined, grain,
    };
  }
  const planes = [...(hasCuts(def) ? def.cuts! : []), ...plane];
  let P: Polytope | null = basePolytope(def);
  for (let i = 0; i + 3 < planes.length && P; i += 4) P = clipPolytope(P, planes[i], planes[i + 1], planes[i + 2], planes[i + 3]);
  if (!P || P.v.length < 12) return null;
  const bb = polytopeAABB(P);
  const t: V = [0, 0, 0];
  const size = [...def.size] as V;
  // a part with rounded / bevelled edges keeps its outline: the cut is just another plane
  const keepOutline = hasRound(def);
  if (keepOutline) {
    /* no tightening */
  } else if (def.kind === 'box') {
    for (let a = 0; a < 3; a++) {
      t[a] = (bb.max[a] + bb.min[a]) / 2;
      size[a] = bb.max[a] - bb.min[a];
    }
  } else if (def.kind === 'cylinder' || def.kind === 'tube') {
    t[1] = (bb.max[1] + bb.min[1]) / 2;
    size[1] = bb.max[1] - bb.min[1];
  }
  if (Math.min(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) < 5e-4) return null;
  // planes in the new frame; drop the ones that no longer cut anything
  const trial: PartDef = { ...def, size, cuts: undefined };
  const tight = basePolytope(trial);
  const kept: number[] = [];
  const scale = Math.max(size[0], size[1], size[2]);
  for (let i = 0; i + 3 < planes.length; i += 4) {
    const pn = [planes[i], planes[i + 1], planes[i + 2]];
    const d = planes[i + 3] - (pn[0] * t[0] + pn[1] * t[1] + pn[2] * t[2]);
    let cutsSomething = false;
    for (let j = 0; j < tight.v.length; j += 3) {
      if (pn[0] * tight.v[j] + pn[1] * tight.v[j + 1] + pn[2] * tight.v[j + 2] > d + 1e-7 * scale) {
        cutsSomething = true;
        break;
      }
    }
    if (cutsSomething) kept.push(pn[0], pn[1], pn[2], d);
  }
  // fracture faces only stay on the ends the piece still has
  const he0 = halfExtents(def);
  const breaks = (def.breaks ?? []).filter((b) => {
    const end = t[b.axis] + (b.side * size[b.axis]) / 2;
    return Math.abs(end - b.side * he0[b.axis]) < 1e-6;
  });
  const piece: PartDef = {
    ...def, size, pos: add(def.pos, rot(def.quat, t)), cuts: kept.length ? kept : undefined, grain,
    breaks: def.breaks ? breaks : undefined,
  };
  if (volume(piece) < 1e-9) return null;
  return piece;
}

// ------------------------------------------------------------------ the uncut ligament (for live sawing)

export interface Ligament {
  /** remaining area (m²) */
  A: number;
  /** centroid in the cross-section frame (e2, e3 of the member) */
  yc: number;
  zc: number;
  /** cells of the remaining section: y, z, area */
  cells: number[];
  /** second moments about the centroid */
  Iyy: number;
  Izz: number;
  Iyz: number;
}

/**
 * The material the blade has not reached yet, after it has advanced `progress` (0..1) of the way
 * through the cut. Coordinates are in the member's cross-section frame: e2 / e3 are local axis
 * indices of the part, measured from its axis.
 */
export function ligament(def: PartDef, aim: Pick<CutAim, 'nl' | 'sl'>, feedL: V, entryL: V, depth: number, progress: number, e2: number, e3: number): Ligament {
  const nl = aim.nl;
  const feed = norm(feedL);
  const line = norm(cross(nl, feed));
  const P = clippedPolytope(def);
  const sec = polytopeSection(P, nl[0], nl[1], nl[2], aim.sl);
  // the section's extent along the stroke direction and how far it reaches along the feed
  let l0 = Infinity, l1 = -Infinity, f1 = -Infinity;
  for (let i = 0; i < sec.length; i += 3) {
    const r = add([sec[i], sec[i + 1], sec[i + 2]], entryL, -1);
    l0 = Math.min(l0, dot(r, line));
    l1 = Math.max(l1, dot(r, line));
    f1 = Math.max(f1, dot(r, feed));
  }
  const cut = Math.max(0, progress * depth);
  const cells: number[] = [];
  let A = 0, sy = 0, sz = 0;
  if (!(f1 > cut) || !(l1 > l0)) return { A: 0, yc: 0, zc: 0, cells, Iyy: 0, Izz: 0, Iyz: 0 };
  // a grid over just the material still ahead of the blade, so even the last few millimetres
  // are resolved finely
  const NL = 26, NF = 26;
  const dl = (l1 - l0) / NL, df = (f1 - cut) / NF;
  // the oblique section projects onto the member's cross-section
  const proj = Math.abs(nl[3 - e2 - e3]) || 1;
  for (let i = 0; i < NL; i++)
    for (let j = 0; j < NF; j++) {
      const l = l0 + (i + 0.5) * dl, f = cut + (j + 0.5) * df;
      const q: V = add(add(entryL, line, l), feed, f);
      // inside the material?
      if (!isInside(def, q)) continue;
      const a = dl * df * proj;
      const cy = q[e2], cz = q[e3];
      cells.push(cy, cz, a);
      A += a;
      sy += cy * a;
      sz += cz * a;
    }
  const yc = A > 0 ? sy / A : 0, zc = A > 0 ? sz / A : 0;
  let Iyy = 0, Izz = 0, Iyz = 0;
  for (let i = 0; i < cells.length; i += 3) {
    const dy = cells[i] - yc, dz = cells[i + 1] - zc, a = cells[i + 2];
    Iyy += dy * dy * a;
    Izz += dz * dz * a;
    Iyz += dy * dz * a;
  }
  return { A, yc, zc, cells, Iyy, Izz, Iyz };
}

function isInside(def: PartDef, q: V): boolean {
  // the section itself lies on a cut plane, so test the base shape and the other cuts with tolerance
  const plain: PartDef = { ...def, cuts: undefined };
  const c = hasCuts(def) ? def.cuts! : [];
  for (let i = 0; i + 3 < c.length; i += 4) if (c[i] * q[0] + c[i + 1] * q[1] + c[i + 2] * q[2] > c[i + 3] + 1e-9) return false;
  if (hasRound(plain)) return sdfBase(plain, q[0], q[1], q[2]) <= 1e-9;
  switch (plain.kind) {
    case 'sphere':
      return Math.hypot(q[0], q[1], q[2]) <= plain.size[0] / 2;
    case 'cylinder':
      return Math.hypot(q[0], q[2]) <= plain.size[0] / 2 && Math.abs(q[1]) <= plain.size[1] / 2 + 1e-9;
    case 'tube': {
      const r = Math.hypot(q[0], q[2]);
      return r <= plain.size[0] / 2 && r >= innerRadius(plain) && Math.abs(q[1]) <= plain.size[1] / 2 + 1e-9;
    }
    default:
      return Math.abs(q[0]) <= plain.size[0] / 2 + 1e-9 && Math.abs(q[1]) <= plain.size[1] / 2 + 1e-9 && Math.abs(q[2]) <= plain.size[2] / 2 + 1e-9;
  }
}
