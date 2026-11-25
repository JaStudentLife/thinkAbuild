import type { EdgeSpec, PartDef } from './design';
import type { Polytope } from './polytope';

/**
 * Rounded and bevelled edges. A treated part is a "router sweep": a 2D profile (the part's
 * thickness along `up`, with its top and bottom edges rounded or bevelled) carried all the way
 * round the plan outline (a rectangle with rounded / bevelled corners, or a circle). Everything is
 * in the part's local frame.
 */
export interface RoundGeom {
  circle: boolean;
  up: number;
  ua: number;
  va: number;
  /** plan half extents and half thickness along `up` */
  hu: number;
  hv: number;
  h: number;
  /** plan radius (cylinders) */
  Rc: number;
  /** corner treatment (index = (+u ? 1 : 0) + (+v ? 2 : 0)): > 0 radius, < 0 bevel size */
  R: number[];
  /** rims round the +up and -up faces */
  rt: number;
  rb: number;
}

export function hasRound(def: PartDef): boolean {
  const e = def.edge;
  if (!e || (def.kind !== 'box' && def.kind !== 'cylinder')) return false;
  return !!(e.top || e.bottom || (def.kind === 'box' && e.corners?.some((c) => c)));
}

/** which local axis a box's edge treatment is organised around: a plate's thickness, a beam's length, else the axis nearest vertical */
export function defaultUp(def: PartDef): number {
  if (def.kind !== 'box') return 1;
  const s = def.size;
  const idx = [0, 1, 2].sort((a, b) => s[b] - s[a]);
  if (s[idx[0]] >= 2.2 * s[idx[1]]) return idx[0];
  if (s[idx[1]] >= 2.2 * s[idx[2]]) return idx[2];
  // world-y component of each local axis (second row of the rotation matrix)
  const [x, y, z, w] = def.quat;
  const ry = [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)];
  return [0, 1, 2].reduce((b, a) => (Math.abs(ry[a]) > Math.abs(ry[b]) ? a : b), 1);
}

function clampV(v: number, max: number): number {
  if (!(max > 0)) return 0;
  return v > 0 ? Math.min(v, max) : v < 0 ? -Math.min(-v, max) : 0;
}

/** the treatment in usable form; `cosmetic` adds a tiny round to otherwise sharp edges (rendering) */
export function roundGeom(def: PartDef, cosmetic = 0): RoundGeom {
  const e: EdgeSpec = def.edge ?? { up: defaultUp(def) };
  const circle = def.kind === 'cylinder' || def.kind === 'tube';
  const up = circle ? 1 : e.up;
  const ua = circle ? 0 : (up + 1) % 3, va = circle ? 2 : (up + 2) % 3;
  const s = def.size;
  const hu = s[ua] / 2, hv = s[va] / 2, h = s[up] / 2;
  const Rc = s[0] / 2;
  const lim = circle ? Rc : Math.min(hu, hv);
  const R = [0, 1, 2, 3].map((i) => {
    if (circle) return 0;
    let v = clampV(e.corners?.[i] ?? 0, lim);
    if (v === 0 && cosmetic) v = Math.min(cosmetic, lim);
    return v;
  });
  let rt = e.top ?? 0, rb = e.bottom ?? 0;
  if (cosmetic) {
    if (!rt) rt = cosmetic;
    if (!rb) rb = cosmetic;
  }
  const m = Math.min(lim, 2 * h);
  rt = clampV(rt, m);
  rb = clampV(rb, m);
  const tot = Math.abs(rt) + Math.abs(rb);
  if (tot > 2 * h) {
    const k = (2 * h) / tot;
    rt *= k;
    rb *= k;
  }
  return { circle, up, ua, va, hu, hv, h, Rc, R, rt, rb };
}

// cache per part object (validated against the fields that matter)
const geomCache = new WeakMap<PartDef, { s0: number; s1: number; s2: number; e: EdgeSpec | undefined; k: string; g: RoundGeom }>();

export function geomOf(def: PartDef): RoundGeom {
  const c = geomCache.get(def);
  if (c && c.s0 === def.size[0] && c.s1 === def.size[1] && c.s2 === def.size[2] && c.e === def.edge && c.k === def.kind) return c.g;
  const g = roundGeom(def);
  geomCache.set(def, { s0: def.size[0], s1: def.size[1], s2: def.size[2], e: def.edge, k: def.kind, g });
  return g;
}

// ------------------------------------------------------------------ distance

/** signed distance to the plan outline (negative inside) */
export function planSDF(g: RoundGeom, u: number, v: number): number {
  if (g.circle) return Math.hypot(u, v) - g.Rc;
  const r = g.R[(u > 0 ? 1 : 0) + (v > 0 ? 2 : 0)];
  const au = Math.abs(u), av = Math.abs(v);
  if (r > 0) {
    const qx = au - g.hu + r, qy = av - g.hv + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  const qx = au - g.hu, qy = av - g.hv;
  let d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  if (r < 0) d = Math.max(d, (au + av - (g.hu + g.hv) - r) * Math.SQRT1_2);
  return d;
}

/** outward unit normal of the plan outline nearest (u, v) */
function planNormal(g: RoundGeom, u: number, v: number): [number, number] {
  if (g.circle) {
    const r = Math.hypot(u, v);
    return r > 1e-12 ? [u / r, v / r] : [1, 0];
  }
  const su = u >= 0 ? 1 : -1, sv = v >= 0 ? 1 : -1;
  const r = g.R[(u > 0 ? 1 : 0) + (v > 0 ? 2 : 0)];
  const au = Math.abs(u), av = Math.abs(v);
  const rr = Math.max(r, 0);
  const qx = au - g.hu + rr, qy = av - g.hv + rr;
  if (r < 0) {
    // the bevel is the nearest face wherever its plane is the binding one
    const dc = (au + av - (g.hu + g.hv) - r) * Math.SQRT1_2;
    if (dc >= Math.max(qx, qy)) return [su * Math.SQRT1_2, sv * Math.SQRT1_2];
  }
  if (qx > 0 && qy > 0) {
    const l = Math.hypot(qx, qy);
    return [(su * qx) / l, (sv * qy) / l];
  }
  return qx > qy ? [su, 0] : [0, sv];
}

/** signed distance of the profile (s = distance to the plan outline, t = height along up) */
export function profileSDF(g: RoundGeom, s: number, t: number): number {
  const r = t >= 0 ? g.rt : g.rb;
  const tt = Math.abs(t);
  if (r > 0) {
    const qx = s + r, qy = tt - g.h + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  const qy = tt - g.h;
  let d = Math.hypot(Math.max(s, 0), Math.max(qy, 0)) + Math.min(Math.max(s, qy), 0);
  if (r < 0) d = Math.max(d, (s + tt - g.h - r) * Math.SQRT1_2);
  return d;
}

export function roundSDF(g: RoundGeom, x: number, y: number, z: number): number {
  const p = [x, y, z];
  return profileSDF(g, planSDF(g, p[g.ua], p[g.va]), p[g.up]);
}

// ------------------------------------------------------------------ projection (rendering)

/** closest point of the profile boundary to (s, t), with the profile normal there */
function profileClosest(g: RoundGeom, s: number, t: number): [number, number, number, number] {
  const sg = t >= 0 ? 1 : -1;
  const r = t >= 0 ? g.rt : g.rb;
  const tt = Math.abs(t);
  const h = g.h;
  if (r > 0) {
    const cx = -r, cy = h - r;
    if (s > cx && tt > cy) {
      const dx = s - cx, dy = tt - cy;
      const l = Math.hypot(dx, dy) || 1;
      return [cx + (r * dx) / l, sg * (cy + (r * dy) / l), dx / l, (sg * dy) / l];
    }
    if (tt > cy) return [s, sg * h, 0, sg];
    return [0, t, 1, 0];
  }
  const c = Math.max(0, -r);
  // candidates: the side, the bevel (if any), the top
  const side: [number, number] = [0, Math.min(tt, h - c)];
  const top: [number, number] = [Math.min(s, -c), h];
  let best: [number, number, number, number] = [side[0], sg * side[1], 1, 0];
  let bd = (s - side[0]) ** 2 + (tt - side[1]) ** 2;
  const dt = (s - top[0]) ** 2 + (tt - top[1]) ** 2;
  if (dt < bd) {
    bd = dt;
    best = [top[0], sg * top[1], 0, sg];
  }
  if (c > 0) {
    // segment from (0, h - c) to (-c, h)
    const ax = 0, ay = h - c, bx = -c, by = h;
    const k = Math.max(0, Math.min(1, ((s - ax) * (bx - ax) + (tt - ay) * (by - ay)) / (2 * c * c)));
    const px = ax + k * (bx - ax), py = ay + k * (by - ay);
    const dc = (s - px) ** 2 + (tt - py) ** 2;
    if (dc <= bd) best = [px, sg * py, Math.SQRT1_2, sg * Math.SQRT1_2];
  }
  return best;
}

/**
 * Closest point on the treated shape to a local point on (or outside) its surface, and the outward
 * normal there. Used to wrap a box's face grids onto the rounded shape.
 */
export function roundProject(g: RoundGeom, p: number[], out: number[], n: number[]) {
  const u = p[g.ua], v = p[g.va], t = p[g.up];
  const s = planSDF(g, u, v);
  const [nu, nv] = planNormal(g, u, v);
  const [s2, t2, ns, nt] = profileClosest(g, s, t);
  out[g.ua] = u + nu * (s2 - s);
  out[g.va] = v + nv * (s2 - s);
  out[g.up] = t2;
  n[g.ua] = ns * nu;
  n[g.va] = ns * nv;
  n[g.up] = nt;
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  n[0] /= l;
  n[1] /= l;
  n[2] /= l;
}

// ------------------------------------------------------------------ outlines and polytopes

/** the profile's outer boundary from the bottom face's edge to the top face's edge: [s, t] pairs */
export function profilePoints(g: RoundGeom, M = 8): number[][] {
  const out: number[][] = [];
  const h = g.h;
  if (g.rb > 0) {
    const r = g.rb;
    for (let i = 0; i <= M; i++) {
      const a = -Math.PI / 2 + ((i / M) * Math.PI) / 2;
      out.push([-r + r * Math.cos(a), -h + r + r * Math.sin(a)]);
    }
  } else if (g.rb < 0) out.push([g.rb, -h], [0, -h - g.rb]);
  else out.push([0, -h]);
  if (g.rt > 0) {
    const r = g.rt;
    for (let i = 0; i <= M; i++) {
      const a = ((i / M) * Math.PI) / 2;
      out.push([-r + r * Math.cos(a), h - r + r * Math.sin(a)]);
    }
  } else if (g.rt < 0) out.push([0, h + g.rt], [g.rt, h]);
  else out.push([0, h]);
  // drop consecutive duplicates
  return out.filter((q, i) => i === 0 || Math.hypot(q[0] - out[i - 1][0], q[1] - out[i - 1][1]) > 1e-12);
}

/**
 * The plan outline offset inwards by -s (s <= 0) as a closed loop of [u, v, nu, nv] (CCW seen from
 * +up), always with the same number of points for the same M so that rings can be stitched.
 */
export function planRing(g: RoundGeom, s: number, M = 8): number[][] {
  const out: number[][] = [];
  if (g.circle) {
    const r = Math.max(0, g.Rc + s);
    const N = 8 * M;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      out.push([r * Math.cos(a), r * Math.sin(a), Math.cos(a), Math.sin(a)]);
    }
    return out;
  }
  const hu = Math.max(0, g.hu + s), hv = Math.max(0, g.hv + s);
  // corners in CCW order: (+,+), (-,+), (-,-), (+,-)
  const order: [number, number][] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  order.forEach(([su, sv], k) => {
    const idx = (su > 0 ? 1 : 0) + (sv > 0 ? 2 : 0);
    const R = g.R[idx];
    const a0 = (k * Math.PI) / 2;
    if (R > 0 && R + s > 0) {
      const r = R + s;
      const cu = su * (g.hu - R), cv = sv * (g.hv - R);
      for (let i = 0; i <= M; i++) {
        const a = a0 + ((i / M) * Math.PI) / 2;
        out.push([cu + r * Math.cos(a), cv + r * Math.sin(a), Math.cos(a), Math.sin(a)]);
      }
    } else if (R < 0) {
      const c = Math.max(0, -R + s * (2 - Math.SQRT2));
      // from the end on the side reached first (CCW) to the other end
      const p0 = k % 2 === 0 ? [su * hu, sv * (hv - c)] : [su * (hu - c), sv * hv];
      const p1 = k % 2 === 0 ? [su * (hu - c), sv * hv] : [su * hu, sv * (hv - c)];
      for (let i = 0; i <= M; i++) {
        const f = i / M;
        out.push([p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, su * Math.SQRT1_2, sv * Math.SQRT1_2]);
      }
    } else {
      const l = Math.SQRT1_2;
      for (let i = 0; i <= M; i++) out.push([su * hu, sv * hv, su * l, sv * l]);
    }
  });
  return out;
}

function toLocal3(g: RoundGeom, u: number, v: number, t: number): number[] {
  const p = [0, 0, 0];
  p[g.ua] = u;
  p[g.va] = v;
  p[g.up] = t;
  return p;
}

/** the treated shape as a convex polytope: plan rings stacked along the profile */
export function roundPolytope(g: RoundGeom): Polytope {
  const prof = profilePoints(g, 8);
  const v: number[] = [];
  const e: number[] = [];
  let n = 0;
  prof.forEach(([s, t], j) => {
    const ring = planRing(g, s, 8);
    n = ring.length;
    for (const q of ring) v.push(...toLocal3(g, q[0], q[1], t));
    const base = j * n;
    for (let i = 0; i < n; i++) {
      e.push(base + i, base + ((i + 1) % n));
      if (j > 0) e.push(base - n + i, base + i);
    }
  });
  return { v, e };
}

// ------------------------------------------------------------------ surface samples (contacts)

export function roundSamples(g: RoundGeom, sp: number): { P: number[]; N: number[]; A: number[] } {
  const P: number[] = [], N: number[] = [], A: number[] = [];
  const push = (p: number[], n: number[], a: number) => {
    P.push(p[0], p[1], p[2]);
    N.push(n[0], n[1], n[2]);
    A.push(a);
  };
  // flat top and bottom faces
  const U = g.circle ? g.Rc : g.hu, V = g.circle ? g.Rc : g.hv;
  const nu = Math.max(2, Math.min(48, Math.ceil((2 * U) / sp))), nv = Math.max(2, Math.min(48, Math.ceil((2 * V) / sp)));
  const du = (2 * U) / nu, dv = (2 * V) / nv;
  const inTop = Math.abs(g.rt), inBot = Math.abs(g.rb);
  const upN = toLocal3(g, 0, 0, 1), dnN = toLocal3(g, 0, 0, -1);
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const u = -U + (i + 0.5) * du, v = -V + (j + 0.5) * dv;
      const d = planSDF(g, u, v);
      if (d <= -inTop) push(toLocal3(g, u, v, g.h), upN, du * dv);
      if (d <= -inBot) push(toLocal3(g, u, v, -g.h), dnN, du * dv);
    }
  // the band round the sides
  const prof = profilePoints(g, 6);
  for (let k = 0; k + 1 < prof.length; k++) {
    const [s0, t0] = prof[k], [s1, t1] = prof[k + 1];
    const len = Math.hypot(s1 - s0, t1 - t0);
    if (len < 1e-9) continue;
    const ns = (t1 - t0) / len, nt = -(s1 - s0) / len; // outward: rotate the upward tangent clockwise
    const pieces = Math.max(1, Math.min(24, Math.ceil(len / sp)));
    for (let pc = 0; pc < pieces; pc++) {
      const f = (pc + 0.5) / pieces;
      const s = s0 + (s1 - s0) * f, t = t0 + (t1 - t0) * f;
      const dsig = len / pieces;
      const ring = planRing(g, s, 12);
      // walk the closed outline
      const segs: number[] = [];
      let L = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        segs.push(l);
        L += l;
      }
      if (L < 1e-9) continue;
      const nl = Math.max(8, Math.min(160, Math.ceil(L / sp)));
      const dl = L / nl;
      let acc = 0, si = 0;
      for (let q = 0; q < nl; q++) {
        const target = (q + 0.5) * dl;
        while (si < segs.length - 1 && acc + segs[si] < target) acc += segs[si++];
        const a = ring[si], b = ring[(si + 1) % ring.length];
        const f2 = segs[si] > 0 ? (target - acc) / segs[si] : 0;
        const u = a[0] + (b[0] - a[0]) * f2, v = a[1] + (b[1] - a[1]) * f2;
        // plan normal: perpendicular of the outline segment (CCW loop: outward = (dy, -dx))
        let pu = b[1] - a[1], pv = -(b[0] - a[0]);
        const pl = Math.hypot(pu, pv);
        if (pl > 1e-12) {
          pu /= pl;
          pv /= pl;
        } else {
          pu = a[2];
          pv = a[3];
        }
        const n = toLocal3(g, ns * pu, ns * pv, nt);
        push(toLocal3(g, u, v, t), n, dsig * dl);
      }
    }
  }
  return { P, N, A };
}

// ------------------------------------------------------------------ structural section

/** how rounding the plan corners of a beam's cross-section scales its area and second moments */
export function sectionFactors(g: RoundGeom): { kA: number; kIu: number; kIv: number } {
  const N = 48;
  const du = (2 * g.hu) / N, dv = (2 * g.hv) / N;
  let A = 0, Iu = 0, Iv = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const u = -g.hu + (i + 0.5) * du, v = -g.hv + (j + 0.5) * dv;
      if (planSDF(g, u, v) > 0) continue;
      const a = du * dv;
      A += a;
      Iu += u * u * a;
      Iv += v * v * a;
    }
  const A0 = 4 * g.hu * g.hv;
  const Iu0 = (2 * g.hv * (2 * g.hu) ** 3) / 12, Iv0 = (2 * g.hu * (2 * g.hv) ** 3) / 12;
  return { kA: A / A0, kIu: Iu / Iu0, kIv: Iv / Iv0 };
}

// ------------------------------------------------------------------ editing

export type EdgeTarget = { kind: 'corner'; index: number } | { kind: 'rim'; side: 'top' | 'bottom' };

/**
 * The edge of a part nearest a local point: one of the four plan corners or one of the two rims.
 * `dist` is how far the point is from that (sharp) edge.
 */
export function nearestEdge(def: PartDef, lp: number[]): { target: EdgeTarget; dist: number; up: number } {
  const up = def.edge?.up ?? defaultUp(def);
  const g = roundGeom({ ...def, edge: { up } });
  const u = lp[g.ua], v = lp[g.va], t = lp[g.up];
  const tt = Math.abs(t);
  const side: 'top' | 'bottom' = t >= 0 ? 'top' : 'bottom';
  if (g.circle) {
    const r = Math.hypot(u, v);
    return { target: { kind: 'rim', side }, dist: Math.hypot(g.Rc - r, g.h - tt), up: 1 };
  }
  const du = g.hu - Math.abs(u), dv = g.hv - Math.abs(v);
  const corner = Math.hypot(du, dv);
  const toOutline = Math.min(du, dv);
  const rim = Math.hypot(Math.max(0, toOutline), g.h - tt);
  const index = (u > 0 ? 1 : 0) + (v > 0 ? 2 : 0);
  // on a thin top the corner edges are short and the rims always close by: anywhere near a
  // corner (seen from above) means that corner
  if (2 * g.h < 0.5 * Math.min(2 * g.hu, 2 * g.hv)) {
    if (corner < Math.max(6 * g.h, 0.03)) return { target: { kind: 'corner', index }, dist: Math.min(corner, rim), up };
    return { target: { kind: 'rim', side }, dist: rim, up };
  }
  if (corner <= rim) return { target: { kind: 'corner', index }, dist: corner, up };
  return { target: { kind: 'rim', side }, dist: rim, up };
}

/** the largest radius / bevel an edge can take */
export function edgeLimit(def: PartDef, target: EdgeTarget, up: number): number {
  const g = roundGeom({ ...def, edge: { up } });
  const lim = g.circle ? g.Rc : Math.min(g.hu, g.hv);
  if (target.kind === 'corner') return lim;
  return Math.min(lim, 2 * g.h);
}

/** a copy of the part's edge spec with one edge (or all four corners) set to `value` */
export function withEdge(def: PartDef, target: EdgeTarget, up: number, value: number, allCorners = false): EdgeSpec {
  const cur = def.edge && def.edge.up === up ? def.edge : { up };
  const next: EdgeSpec = { up, corners: cur.corners ? [...cur.corners] : [0, 0, 0, 0], top: cur.top ?? 0, bottom: cur.bottom ?? 0 };
  if (target.kind === 'corner') {
    if (allCorners) next.corners = [value, value, value, value];
    else next.corners![target.index] = value;
  } else if (target.side === 'top') next.top = value;
  else next.bottom = value;
  return next;
}

/** the current value of an edge */
export function edgeValue(def: PartDef, target: EdgeTarget, up: number): number {
  const e = def.edge && def.edge.up === up ? def.edge : undefined;
  if (!e) return 0;
  if (target.kind === 'corner') return e.corners?.[target.index] ?? 0;
  return (target.side === 'top' ? e.top : e.bottom) ?? 0;
}

export function edgeKey(def: PartDef): string {
  const e = def.edge;
  if (!e || !hasRound(def)) return '';
  return `${e.up}:${(e.corners ?? []).map((v) => v.toFixed(5)).join(',')}:${(e.top ?? 0).toFixed(5)}:${(e.bottom ?? 0).toFixed(5)}`;
}
