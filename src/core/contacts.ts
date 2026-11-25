import { GROUND_ID, type PartDef, type Vec3T } from './design';
import { boundingRadius, qRotate, sdfNormalWorld, sdfWorld, surfaceSamples } from './shapes';

export interface ContactPatch {
  a: string;
  /** other part id, or GROUND_ID */
  b: string;
  /** unit normal pointing from b into a (direction of the force b exerts on a in compression) */
  normal: Vec3T;
  area: number;
  centroid: Vec3T;
  /** representative contact points (world) used by the structural model */
  points: Vec3T[];
  /** index of the centroid point within points */
  center: number;
  /** deep overlap: normals disagree; treated as a bonded joint */
  embedded: boolean;
  /** patch size along its principal in-plane axes */
  extent: [number, number];
  axes: [Vec3T, Vec3T];
}

interface Hit {
  p: Vec3T;
  a: number;
}

const tmp3 = [0, 0, 0];

function worldSamples(def: PartDef, cb: (x: number, y: number, z: number, a: number) => void) {
  const s = surfaceSamples(def);
  const p = s.p;
  for (let i = 0; i < s.count; i++) {
    qRotate(def.quat, p[3 * i], p[3 * i + 1], p[3 * i + 2], tmp3);
    cb(tmp3[0] + def.pos[0], tmp3[1] + def.pos[1], tmp3[2] + def.pos[2], s.a[i]);
  }
}

function hitsAgainst(src: PartDef, target: PartDef, tol: number): Hit[] {
  const hits: Hit[] = [];
  const t = [0, 0, 0];
  worldSamples(src, (x, y, z, a) => {
    if (sdfWorld(target, x, y, z, t) <= tol) hits.push({ p: [x, y, z], a });
  });
  return hits;
}

function sub(a: Vec3T, b: Vec3T): Vec3T {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3T, b: Vec3T) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3T, b: Vec3T): Vec3T {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3T): Vec3T {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Build a patch from hit samples given its normal. */
function buildPatch(a: string, b: string, hits: Hit[], normal: Vec3T, embedded: boolean, spacing: number): ContactPatch {
  let area = 0;
  const c: Vec3T = [0, 0, 0];
  for (const h of hits) {
    area += h.a;
    c[0] += h.p[0] * h.a;
    c[1] += h.p[1] * h.a;
    c[2] += h.p[2] * h.a;
  }
  c[0] /= area;
  c[1] /= area;
  c[2] /= area;
  // in-plane basis
  const n = normal;
  const ref: Vec3T = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t1 = norm(cross(ref, n));
  const t2 = cross(n, t1);
  // 2D covariance
  let sxx = 0, syy = 0, sxy = 0;
  const q2: [number, number][] = hits.map((h) => {
    const d = sub(h.p, c);
    const u = dot(d, t1), v = dot(d, t2);
    sxx += u * u * h.a;
    syy += v * v * h.a;
    sxy += u * v * h.a;
    return [u, v];
  });
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const e1: Vec3T = [t1[0] * ca + t2[0] * sa, t1[1] * ca + t2[1] * sa, t1[2] * ca + t2[2] * sa];
  const e2: Vec3T = cross(n, e1);
  let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
  const pr = q2.map(([u, v]) => {
    const p1 = u * ca + v * sa, p2 = -u * sa + v * ca;
    min1 = Math.min(min1, p1);
    max1 = Math.max(max1, p1);
    min2 = Math.min(min2, p2);
    max2 = Math.max(max2, p2);
    return [p1, p2];
  });
  const L1 = max1 - min1 + spacing, L2 = max2 - min2 + spacing;
  const nearest = (t1v: number, t2v: number): Vec3T => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pr.length; i++) {
      const d = (pr[i][0] - t1v) ** 2 + (pr[i][1] - t2v) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return hits[best].p;
  };
  const points: Vec3T[] = [];
  let center = 0;
  const pointLike = L1 < 2.5 * spacing && L2 < 2.5 * spacing;
  // only genuinely narrow contacts (a rod on its side) collapse to a line; a strip as
  // wide as a plank's face keeps its width so it can resist rolling over
  const lineLike = !pointLike && L2 < Math.max(1.5 * spacing, 0.012);
  if (pointLike || hits.length < 3) {
    points.push(c);
  } else if (lineLike) {
    points.push(nearest(min1, 0), c, nearest(max1, 0));
    center = 1;
  } else {
    points.push(nearest(min1, min2), nearest(max1, min2), nearest(max1, max2), nearest(min1, max2), c);
    center = 4;
  }
  return { a, b, normal: n, area, centroid: c, points, center, embedded, extent: [L1, L2], axes: [e1, e2] };
}

/** Contact between two parts, or null when they do not touch (within tol). */
export function patchBetween(A: PartDef, B: PartDef, tol: number): ContactPatch | null {
  const d = Math.hypot(A.pos[0] - B.pos[0], A.pos[1] - B.pos[1], A.pos[2] - B.pos[2]);
  if (d > boundingRadius(A) + boundingRadius(B) + tol) return null;
  const hA = hitsAgainst(A, B, tol);
  const hB = hitsAgainst(B, A, tol);
  if (hA.length === 0 && hB.length === 0) return null;
  const useA = hA.length >= hB.length;
  const hits = useA ? hA : hB;
  // contact normal from the gradient of the *other* body's distance field
  const nm: Vec3T = [0, 0, 0];
  for (const h of hits) {
    const g = useA ? sdfNormalWorld(B, h.p[0], h.p[1], h.p[2]) : sdfNormalWorld(A, h.p[0], h.p[1], h.p[2]);
    const s = useA ? 1 : -1;
    nm[0] += s * g[0] * h.a;
    nm[1] += s * g[1] * h.a;
    nm[2] += s * g[2] * h.a;
  }
  let totalA = 0;
  for (const h of hits) totalA += h.a;
  const len = Math.hypot(nm[0], nm[1], nm[2]) / totalA;
  let normal: Vec3T;
  const embedded = len < 0.5;
  if (len > 1e-6) normal = norm(nm);
  else normal = norm(sub(A.pos, B.pos));
  const spacing = surfaceSamples(useA ? A : B).spacing;
  return buildPatch(A.id, B.id, hits, normal, embedded, spacing);
}

/** Contact of a part with the ground plane y = groundY. */
export function groundPatch(A: PartDef, tol: number, groundY = 0): ContactPatch | null {
  if (A.pos[1] - boundingRadius(A) > groundY + tol) return null;
  const hits: Hit[] = [];
  worldSamples(A, (x, y, z, a) => {
    if (y <= groundY + tol) hits.push({ p: [x, Math.max(y, groundY), z], a });
  });
  if (hits.length === 0) return null;
  return buildPatch(A.id, GROUND_ID, hits, [0, 1, 0], false, surfaceSamples(A).spacing);
}

export interface DetectOptions {
  tol: number;
  ground?: boolean;
  groundY?: number;
  /** return false to skip a pair */
  filter?: (a: PartDef, b: PartDef) => boolean;
}

/** All contacts among a set of parts (and with the ground). */
export function detectContacts(parts: PartDef[], opts: DetectOptions): ContactPatch[] {
  const out: ContactPatch[] = [];
  for (let i = 0; i < parts.length; i++) {
    const A = parts[i];
    if (opts.ground !== false && !A.anchored) {
      const g = groundPatch(A, opts.tol, opts.groundY ?? 0);
      if (g) out.push(g);
    }
    for (let j = i + 1; j < parts.length; j++) {
      const B = parts[j];
      if (A.anchored && B.anchored) continue;
      if (opts.filter && !opts.filter(A, B)) continue;
      // keep the anchored (world) part as "b" so a is always a free part
      const p = A.anchored ? patchBetween(B, A, opts.tol) : patchBetween(A, B, opts.tol);
      if (p) out.push(p);
    }
  }
  return out;
}
