import type { PartDef, QuatT, Vec3T } from './design';
import { boxPolytope, clipPolytope, planeBasis, polytopeAABB, polytopeSection, prismPolytope, spherePolytope, type Polytope } from './polytope';
import { edgeKey, geomOf, hasRound, roundPolytope, roundSamples, roundSDF } from './rounding';

// ------------------------------------------------------------------ quaternion helpers (x,y,z,w)

export function qRotate(q: QuatT, x: number, y: number, z: number, out: number[] | Float64Array, o = 0): void {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

export function qConj(q: QuatT): QuatT {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function qMul(a: QuatT, b: QuatT): QuatT {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** local -> world point */
export function toWorld(def: { pos: Vec3T; quat: QuatT }, x: number, y: number, z: number): Vec3T {
  const o = [0, 0, 0];
  qRotate(def.quat, x, y, z, o);
  return [o[0] + def.pos[0], o[1] + def.pos[1], o[2] + def.pos[2]];
}

/** world -> local point */
export function toLocal(def: { pos: Vec3T; quat: QuatT }, x: number, y: number, z: number): Vec3T {
  const o = [0, 0, 0];
  qRotate(qConj(def.quat), x - def.pos[0], y - def.pos[1], z - def.pos[2], o);
  return [o[0], o[1], o[2]];
}

/** a local axis (0,1,2) of the part in world coordinates */
export function axisWorld(q: QuatT, axis: number): Vec3T {
  const o = [0, 0, 0];
  qRotate(q, axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0, o);
  return [o[0], o[1], o[2]];
}

// ------------------------------------------------------------------ dimensions

export function halfExtents(def: PartDef): Vec3T {
  const s = def.size;
  if (def.kind === 'hull' && def.hull) {
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < def.hull.length; i += 3) {
      mx = Math.max(mx, Math.abs(def.hull[i]));
      my = Math.max(my, Math.abs(def.hull[i + 1]));
      mz = Math.max(mz, Math.abs(def.hull[i + 2]));
    }
    return [mx, my, mz];
  }
  return [s[0] / 2, s[1] / 2, s[2] / 2];
}

/** wood grain direction (local axis index): kept explicitly on cut pieces, else the longest axis */
export function grainAxis(def: PartDef): number {
  if (def.kind === 'cylinder' || def.kind === 'tube') return 1;
  if (def.grain !== undefined && def.grain >= 0 && def.grain <= 2) return def.grain;
  const s = def.size;
  return [0, 1, 2].sort((a, b) => s[b] - s[a])[0];
}

export function boundingRadius(def: PartDef): number {
  if (def.kind === 'sphere') return def.size[0] / 2;
  if (def.kind === 'cylinder' || def.kind === 'tube') {
    const r = def.size[0] / 2, h = def.size[1] / 2;
    return Math.hypot(r, h);
  }
  const h = halfExtents(def);
  return Math.hypot(h[0], h[1], h[2]);
}

export function innerRadius(def: PartDef): number {
  const r = def.size[0] / 2;
  return Math.max(0, r - (def.wall ?? r * 0.15));
}

export function volume(def: PartDef): number {
  if (isShaped(def)) return cutVolume(def);
  return baseVolume(def);
}

/** volume of the uncut shape */
export function baseVolume(def: PartDef): number {
  const s = def.size;
  switch (def.kind) {
    case 'box':
      return s[0] * s[1] * s[2];
    case 'cylinder':
      return Math.PI * (s[0] / 2) ** 2 * s[1];
    case 'tube': {
      const r = s[0] / 2, ri = innerRadius(def);
      return Math.PI * (r * r - ri * ri) * s[1];
    }
    case 'sphere':
      return (4 / 3) * Math.PI * (s[0] / 2) ** 3;
    case 'hull':
      return def.hullVolume ?? s[0] * s[1] * s[2] * 0.5;
  }
}

/** lowest world-space y of a posed part (for keeping things above ground) */
export function lowestPoint(def: PartDef): number {
  if (isShaped(def)) {
    const P = clippedPolytope(def);
    let mn = Infinity;
    const o = [0, 0, 0];
    for (let i = 0; i < P.v.length; i += 3) {
      qRotate(def.quat, P.v[i], P.v[i + 1], P.v[i + 2], o);
      mn = Math.min(mn, o[1]);
    }
    return def.pos[1] + mn;
  }
  const h = halfExtents(def);
  if (def.kind === 'sphere') return def.pos[1] - h[0];
  if (def.kind === 'cylinder' || def.kind === 'tube') {
    // axis = local y; extent along world y = |ay|*h + r*sqrt(1-ay^2)
    const ay = axisWorld(def.quat, 1)[1];
    const r = def.size[0] / 2;
    return def.pos[1] - (Math.abs(ay) * h[1] + r * Math.sqrt(Math.max(0, 1 - ay * ay)));
  }
  let ext = 0;
  for (let i = 0; i < 3; i++) ext += Math.abs(axisWorld(def.quat, i)[1]) * h[i];
  if (def.kind === 'hull' && def.hull) {
    let mn = Infinity;
    const o = [0, 0, 0];
    for (let i = 0; i < def.hull.length; i += 3) {
      qRotate(def.quat, def.hull[i], def.hull[i + 1], def.hull[i + 2], o);
      mn = Math.min(mn, o[1]);
    }
    return def.pos[1] + mn;
  }
  return def.pos[1] - ext;
}

/** world-space axis-aligned bounds */
export function worldAABB(def: PartDef): { min: Vec3T; max: Vec3T } {
  const h = halfExtents(def);
  const min: Vec3T = [Infinity, Infinity, Infinity];
  const max: Vec3T = [-Infinity, -Infinity, -Infinity];
  const o = [0, 0, 0];
  if (isShaped(def)) {
    const P = clippedPolytope(def);
    for (let i = 0; i < P.v.length; i += 3) {
      qRotate(def.quat, P.v[i], P.v[i + 1], P.v[i + 2], o);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], o[k] + def.pos[k]);
        max[k] = Math.max(max[k], o[k] + def.pos[k]);
      }
    }
    return { min, max };
  }
  for (let sx = -1; sx <= 1; sx += 2)
    for (let sy = -1; sy <= 1; sy += 2)
      for (let sz = -1; sz <= 1; sz += 2) {
        qRotate(def.quat, sx * h[0], sy * h[1], sz * h[2], o);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], o[k] + def.pos[k]);
          max[k] = Math.max(max[k], o[k] + def.pos[k]);
        }
      }
  return { min, max };
}

// ------------------------------------------------------------------ signed distance (local coordinates)

export function sdfLocal(def: PartDef, x: number, y: number, z: number): number {
  let d = sdfBase(def, x, y, z);
  const c = def.cuts;
  if (c && def.kind !== 'hull') for (let i = 0; i + 3 < c.length; i += 4) d = Math.max(d, c[i] * x + c[i + 1] * y + c[i + 2] * z - c[i + 3]);
  return d;
}

/** signed distance of the uncut shape */
export function sdfBase(def: PartDef, x: number, y: number, z: number): number {
  if (hasRound(def)) return roundSDF(geomOf(def), x, y, z);
  switch (def.kind) {
    case 'sphere':
      return Math.sqrt(x * x + y * y + z * z) - def.size[0] / 2;
    case 'cylinder':
    case 'tube': {
      const r = def.size[0] / 2, h = def.size[1] / 2;
      const rr = Math.sqrt(x * x + z * z);
      const dx = rr - r, dy = Math.abs(y) - h;
      let d = Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      if (def.kind === 'tube') d = Math.max(d, innerRadius(def) - rr);
      return d;
    }
    default: {
      const he = halfExtents(def);
      const qx = Math.abs(x) - he[0], qy = Math.abs(y) - he[1], qz = Math.abs(z) - he[2];
      const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
      return out + Math.min(Math.max(qx, qy, qz), 0);
    }
  }
}

/** world-space sdf */
export function sdfWorld(def: PartDef, x: number, y: number, z: number, tmp: number[] = [0, 0, 0]): number {
  qRotate(qConj(def.quat), x - def.pos[0], y - def.pos[1], z - def.pos[2], tmp);
  return sdfLocal(def, tmp[0], tmp[1], tmp[2]);
}

/** world-space outward surface normal via central differences */
export function sdfNormalWorld(def: PartDef, x: number, y: number, z: number): Vec3T {
  const e = 1e-4;
  const t = [0, 0, 0];
  const nx = sdfWorld(def, x + e, y, z, t) - sdfWorld(def, x - e, y, z, t);
  const ny = sdfWorld(def, x, y + e, z, t) - sdfWorld(def, x, y - e, z, t);
  const nz = sdfWorld(def, x, y, z + e, t) - sdfWorld(def, x, y, z - e, t);
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// ------------------------------------------------------------------ surface sampling (local)

export interface Samples {
  p: Float64Array; // local positions
  n: Float64Array; // local outward normals
  a: Float64Array; // area per sample
  count: number;
  spacing: number;
}

const sampleCache = new Map<string, Samples>();

function sampleKey(def: PartDef, spacing: number): string {
  return `${shapeKey(def)}:${spacing.toFixed(5)}`;
}

/** identifies a part's local geometry (for caches) */
export function shapeKey(def: PartDef): string {
  const cuts = hasCuts(def) ? def.cuts!.map((v) => v.toFixed(6)).join(',') : '';
  const hull = def.kind === 'hull' && def.hull ? `${def.hull.length}:${def.hull.slice(0, 6).map((v) => v.toFixed(5)).join(',')}` : '';
  return `${def.kind}:${def.size.map((v) => v.toFixed(5)).join(',')}:${def.wall ?? 0}:${hull}:${cuts}:${edgeKey(def)}`;
}

/** cut at an angle or with treated edges: its geometry comes from the general (polytope / sdf) path */
export function isShaped(def: PartDef): boolean {
  return hasCuts(def) || hasRound(def);
}

/** has saw cuts that are not square to the part (hull fragments carry theirs in their points) */
export function hasCuts(def: PartDef): boolean {
  return !!def.cuts && def.cuts.length >= 4 && def.kind !== 'hull';
}

export function defaultSpacing(def: PartDef): number {
  const h = halfExtents(def);
  const minDim = 2 * Math.min(h[0], h[1], h[2]);
  return Math.min(0.05, Math.max(0.003, minDim / 4));
}

export function surfaceSamples(def: PartDef, spacing = defaultSpacing(def)): Samples {
  const key = sampleKey(def, spacing);
  const hit = sampleCache.get(key);
  if (hit) return hit;
  if (hasCuts(def) || hasRound(def)) {
    let out: Samples;
    if (hasCuts(def)) out = cutSamples(def, spacing);
    else {
      const r = roundSamples(geomOf(def), spacing);
      out = { p: Float64Array.from(r.P), n: Float64Array.from(r.N), a: Float64Array.from(r.A), count: r.A.length, spacing };
    }
    if (sampleCache.size > 400) sampleCache.clear();
    sampleCache.set(key, out);
    return out;
  }
  const P: number[] = [], N: number[] = [], A: number[] = [];
  const push = (px: number, py: number, pz: number, nx: number, ny: number, nz: number, a: number) => {
    P.push(px, py, pz);
    N.push(nx, ny, nz);
    A.push(a);
  };
  const cnt = (len: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.ceil(len / spacing)));

  if (def.kind === 'box' || def.kind === 'hull') {
    const h = halfExtents(def);
    for (let axis = 0; axis < 3; axis++) {
      const j = (axis + 1) % 3, k = (axis + 2) % 3;
      const nu = cnt(2 * h[j], 2, 48), nv = cnt(2 * h[k], 2, 48);
      const du = (2 * h[j]) / nu, dv = (2 * h[k]) / nv;
      for (const s of [-1, 1]) {
        for (let iu = 0; iu < nu; iu++)
          for (let iv = 0; iv < nv; iv++) {
            const c = [0, 0, 0], n = [0, 0, 0];
            c[axis] = s * h[axis];
            c[j] = -h[j] + (iu + 0.5) * du;
            c[k] = -h[k] + (iv + 0.5) * dv;
            n[axis] = s;
            push(c[0], c[1], c[2], n[0], n[1], n[2], du * dv);
          }
      }
    }
  } else if (def.kind === 'cylinder' || def.kind === 'tube') {
    const r = def.size[0] / 2, hh = def.size[1] / 2;
    const ri = def.kind === 'tube' ? innerRadius(def) : 0;
    // caps (annulus for tubes)
    const nr = cnt(r - ri, 1, 12);
    for (const s of [-1, 1]) {
      for (let ir = 0; ir < nr; ir++) {
        const r0 = ri + ((r - ri) * ir) / nr, r1 = ri + ((r - ri) * (ir + 1)) / nr;
        const rm = (r0 + r1) / 2;
        const nt = Math.max(6, Math.min(48, Math.ceil((2 * Math.PI * rm) / spacing)));
        const ringA = Math.PI * (r1 * r1 - r0 * r0);
        if (rm < 1e-9) {
          push(0, s * hh, 0, 0, s, 0, ringA);
          continue;
        }
        for (let it = 0; it < nt; it++) {
          const t = ((it + 0.5) / nt) * Math.PI * 2;
          push(rm * Math.cos(t), s * hh, rm * Math.sin(t), 0, s, 0, ringA / nt);
        }
      }
    }
    // side(s)
    const sides: [number, number][] = [[r, 1]];
    if (ri > 0) sides.push([ri, -1]);
    for (const [rad, sgn] of sides) {
      const nt = cnt(2 * Math.PI * rad, 8, 48), ny = cnt(2 * hh, 2, 64);
      const a = ((2 * Math.PI * rad) / nt) * ((2 * hh) / ny);
      for (let it = 0; it < nt; it++) {
        const t = ((it + 0.5) / nt) * Math.PI * 2;
        const c = Math.cos(t), sn = Math.sin(t);
        for (let iy = 0; iy < ny; iy++) {
          const y = -hh + ((iy + 0.5) * 2 * hh) / ny;
          push(rad * c, y, rad * sn, sgn * c, 0, sgn * sn, a);
        }
      }
    }
  } else if (def.kind === 'sphere') {
    const r = def.size[0] / 2;
    const n = Math.max(60, Math.min(1500, Math.ceil((4 * Math.PI * r * r) / (spacing * spacing))));
    const ga = Math.PI * (3 - Math.sqrt(5));
    const a = (4 * Math.PI * r * r) / n;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const rad = Math.sqrt(1 - y * y);
      const t = ga * i;
      const x = Math.cos(t) * rad, z = Math.sin(t) * rad;
      push(x * r, y * r, z * r, x, y, z, a);
    }
  }
  const out: Samples = {
    p: Float64Array.from(P),
    n: Float64Array.from(N),
    a: Float64Array.from(A),
    count: A.length,
    spacing,
  };
  if (sampleCache.size > 400) sampleCache.clear();
  sampleCache.set(key, out);
  return out;
}

export function surfaceArea(def: PartDef): number {
  if (isShaped(def)) {
    const sm = surfaceSamples(def);
    let a = 0;
    for (let i = 0; i < sm.count; i++) a += sm.a[i];
    return a;
  }
  const s = def.size;
  switch (def.kind) {
    case 'sphere':
      return 4 * Math.PI * (s[0] / 2) ** 2;
    case 'cylinder': {
      const r = s[0] / 2;
      return 2 * Math.PI * r * r + 2 * Math.PI * r * s[1];
    }
    case 'tube': {
      const r = s[0] / 2, ri = innerRadius(def);
      return 2 * Math.PI * (r * r - ri * ri) + 2 * Math.PI * (r + ri) * s[1];
    }
    default:
      return 2 * (s[0] * s[1] + s[1] * s[2] + s[0] * s[2]);
  }
}

// ------------------------------------------------------------------ cut parts

const polyCache = new Map<string, Polytope>();

/** the uncut shape as a convex polytope (tubes: their outer surface) */
export function basePolytope(def: PartDef): Polytope {
  const he = halfExtents(def);
  if (hasRound(def)) return roundPolytope(geomOf(def));
  switch (def.kind) {
    case 'cylinder':
    case 'tube':
      return prismPolytope(def.size[0] / 2, def.size[1] / 2, 64);
    case 'sphere':
      return spherePolytope(def.size[0] / 2, 32, 16);
    default:
      return boxPolytope(he[0], he[1], he[2]);
  }
}

/** the part's material (outer surface) as a convex polytope in local coordinates, cuts applied */
export function clippedPolytope(def: PartDef): Polytope {
  const key = shapeKey(def);
  const hit = polyCache.get(key);
  if (hit) return hit;
  let P: Polytope | null = basePolytope(def);
  const c = hasCuts(def) ? def.cuts! : [];
  for (let i = 0; i + 3 < c.length && P; i += 4) P = clipPolytope(P, c[i], c[i + 1], c[i + 2], c[i + 3]);
  const out = P ?? { v: [0, 0, 0], e: [] };
  if (polyCache.size > 300) polyCache.clear();
  polyCache.set(key, out);
  return out;
}

const volCache = new Map<string, number>();

/** volume of a cut part, by integrating its signed distance on a grid (copes with tubes and balls) */
function cutVolume(def: PartDef): number {
  const key = shapeKey(def);
  const hit = volCache.get(key);
  if (hit !== undefined) return hit;
  const bb = polytopeAABB(clippedPolytope(def));
  const N = 40;
  const d = [0, 1, 2].map((k) => Math.max(1e-9, bb.max[k] - bb.min[k]) / N);
  let inside = 0;
  for (let i = 0; i < N; i++) {
    const x = bb.min[0] + (i + 0.5137) * d[0];
    for (let j = 0; j < N; j++) {
      const y = bb.min[1] + (j + 0.4871) * d[1];
      for (let k = 0; k < N; k++) {
        const z = bb.min[2] + (k + 0.5059) * d[2];
        if (sdfLocal(def, x, y, z) < 0) inside++;
      }
    }
  }
  const v = Math.max(1e-9, inside * d[0] * d[1] * d[2]);
  if (volCache.size > 300) volCache.clear();
  volCache.set(key, v);
  return v;
}

/** surface samples of a cut part: the uncut surface where it survives, plus every cut face */
function cutSamples(def: PartDef, spacing: number): Samples {
  const plain: PartDef = { ...def, cuts: undefined };
  const base = surfaceSamples(plain, spacing);
  const c = def.cuts!;
  const P: number[] = [], N: number[] = [], A: number[] = [];
  const keep = (x: number, y: number, z: number, skip: number) => {
    for (let i = 0; i + 3 < c.length; i += 4) {
      if (i === skip) continue;
      if (c[i] * x + c[i + 1] * y + c[i + 2] * z > c[i + 3] + 1e-9) return false;
    }
    return true;
  };
  for (let i = 0; i < base.count; i++) {
    const x = base.p[3 * i], y = base.p[3 * i + 1], z = base.p[3 * i + 2];
    if (!keep(x, y, z, -1)) continue;
    P.push(x, y, z);
    N.push(base.n[3 * i], base.n[3 * i + 1], base.n[3 * i + 2]);
    A.push(base.a[i]);
  }
  for (let ci = 0; ci + 3 < c.length; ci += 4) {
    const nx = c[ci], ny = c[ci + 1], nz = c[ci + 2], d = c[ci + 3];
    // the cut face is the section, by this plane, of the part clipped by its other cuts
    let poly: Polytope | null = basePolytope(def);
    for (let j = 0; j + 3 < c.length && poly; j += 4) if (j !== ci) poly = clipPolytope(poly, c[j], c[j + 1], c[j + 2], c[j + 3]);
    if (!poly) continue;
    const sec = polytopeSection(poly, nx, ny, nz, d);
    if (sec.length < 9) continue;
    const [t1, t2] = planeBasis(nx, ny, nz);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < sec.length; i += 3) {
      const u = sec[i] * t1[0] + sec[i + 1] * t1[1] + sec[i + 2] * t1[2];
      const v = sec[i] * t2[0] + sec[i + 1] * t2[1] + sec[i + 2] * t2[2];
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const nu = Math.max(2, Math.min(48, Math.ceil((u1 - u0) / spacing)));
    const nv = Math.max(2, Math.min(48, Math.ceil((v1 - v0) / spacing)));
    const du = (u1 - u0) / nu, dv = (v1 - v0) / nv;
    for (let iu = 0; iu < nu; iu++)
      for (let iv = 0; iv < nv; iv++) {
        const u = u0 + (iu + 0.5) * du, v = v0 + (iv + 0.5) * dv;
        const x = nx * d + u * t1[0] + v * t2[0];
        const y = ny * d + u * t1[1] + v * t2[1];
        const z = nz * d + u * t1[2] + v * t2[2];
        if (sdfBase(plain, x, y, z) > 1e-9 || !keep(x, y, z, ci)) continue;
        P.push(x, y, z);
        N.push(nx, ny, nz);
        A.push(du * dv);
      }
  }
  return { p: Float64Array.from(P), n: Float64Array.from(N), a: Float64Array.from(A), count: A.length, spacing };
}
