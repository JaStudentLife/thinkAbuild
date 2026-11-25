/**
 * Convex polytopes stored as vertices + edges. That is all that's needed to clip them by
 * planes (saw cuts), read off a cut section, and find extents, without a full B-rep.
 */
export interface Polytope {
  /** xyz triples */
  v: number[];
  /** vertex index pairs */
  e: number[];
}

export function boxPolytope(hx: number, hy: number, hz: number): Polytope {
  const v: number[] = [];
  for (let i = 0; i < 8; i++) v.push(i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz);
  const e: number[] = [];
  for (let i = 0; i < 8; i++) for (const b of [1, 2, 4]) if (!(i & b)) e.push(i, i | b);
  return { v, e };
}

/** n-sided prism along local y (a cylinder) */
export function prismPolytope(r: number, hh: number, n = 48): Polytope {
  const v: number[] = [];
  const e: number[] = [];
  for (let s = 0; s < 2; s++)
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      v.push(r * Math.cos(t), s ? hh : -hh, r * Math.sin(t));
    }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    e.push(i, j, n + i, n + j, i, n + i);
  }
  return { v, e };
}

/** latitude/longitude sphere */
export function spherePolytope(r: number, seg = 32, rings = 16): Polytope {
  const v: number[] = [0, r, 0, 0, -r, 0];
  const e: number[] = [];
  const idx = (k: number, i: number) => 2 + (k - 1) * seg + (i % seg);
  for (let k = 1; k < rings; k++) {
    const phi = (k / rings) * Math.PI;
    const y = r * Math.cos(phi), rr = r * Math.sin(phi);
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      v.push(rr * Math.cos(t), y, rr * Math.sin(t));
    }
  }
  for (let k = 1; k < rings; k++)
    for (let i = 0; i < seg; i++) {
      e.push(idx(k, i), idx(k, i + 1));
      if (k === 1) e.push(0, idx(k, i));
      if (k === rings - 1) e.push(1, idx(k, i));
      else e.push(idx(k, i), idx(k + 1, i));
    }
  return { v, e };
}

/** an orthonormal basis (t1, t2) of the plane with normal n */
export function planeBasis(nx: number, ny: number, nz: number): [number[], number[]] {
  const ref = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let t1 = [ref[1] * nz - ref[2] * ny, ref[2] * nx - ref[0] * nz, ref[0] * ny - ref[1] * nx];
  const l = Math.hypot(t1[0], t1[1], t1[2]) || 1;
  t1 = [t1[0] / l, t1[1] / l, t1[2] / l];
  const t2 = [ny * t1[2] - nz * t1[1], nz * t1[0] - nx * t1[2], nx * t1[1] - ny * t1[0]];
  return [t1, t2];
}

/** sort coplanar points (flat xyz) into a convex loop around their centroid; removes near-duplicates */
function sortLoop(pts: number[], nx: number, ny: number, nz: number, tol: number): number[] {
  const uniq: number[] = [];
  for (let i = 0; i < pts.length; i += 3) {
    let dup = false;
    for (let j = 0; j < uniq.length; j += 3) {
      if (Math.abs(uniq[j] - pts[i]) < tol && Math.abs(uniq[j + 1] - pts[i + 1]) < tol && Math.abs(uniq[j + 2] - pts[i + 2]) < tol) {
        dup = true;
        break;
      }
    }
    if (!dup) uniq.push(pts[i], pts[i + 1], pts[i + 2]);
  }
  const n = uniq.length / 3;
  if (n < 3) return uniq;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < uniq.length; i += 3) {
    cx += uniq[i];
    cy += uniq[i + 1];
    cz += uniq[i + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const [t1, t2] = planeBasis(nx, ny, nz);
  const order = [...Array(n).keys()].map((i) => {
    const dx = uniq[3 * i] - cx, dy = uniq[3 * i + 1] - cy, dz = uniq[3 * i + 2] - cz;
    return { i, a: Math.atan2(dx * t2[0] + dy * t2[1] + dz * t2[2], dx * t1[0] + dy * t1[1] + dz * t1[2]) };
  });
  order.sort((p, q) => p.a - q.a);
  const out: number[] = [];
  for (const o of order) out.push(uniq[3 * o.i], uniq[3 * o.i + 1], uniq[3 * o.i + 2]);
  return out;
}

function scale(P: Polytope): number {
  let m = 0;
  for (const x of P.v) m = Math.max(m, Math.abs(x));
  return m || 1;
}

/** keep the part of P where n.x <= d. Returns null when nothing is left. */
export function clipPolytope(P: Polytope, nx: number, ny: number, nz: number, d: number): Polytope | null {
  const eps = 1e-9 * scale(P);
  const nv = P.v.length / 3;
  const dist = new Float64Array(nv);
  const map = new Int32Array(nv).fill(-1);
  const v: number[] = [];
  const e: number[] = [];
  const cap: number[] = [];
  let allIn = true;
  for (let i = 0; i < nv; i++) {
    dist[i] = nx * P.v[3 * i] + ny * P.v[3 * i + 1] + nz * P.v[3 * i + 2] - d;
    if (dist[i] <= eps) {
      map[i] = v.length / 3;
      v.push(P.v[3 * i], P.v[3 * i + 1], P.v[3 * i + 2]);
      if (dist[i] >= -eps) cap.push(P.v[3 * i], P.v[3 * i + 1], P.v[3 * i + 2]);
    } else allIn = false;
  }
  if (allIn) return P;
  if (!v.length) return null;
  for (let k = 0; k < P.e.length; k += 2) {
    const a = P.e[k], b = P.e[k + 1];
    const ina = dist[a] <= eps, inb = dist[b] <= eps;
    if (ina && inb) {
      e.push(map[a], map[b]);
      continue;
    }
    if (ina === inb) continue;
    const i = ina ? a : b, o = ina ? b : a;
    if (dist[i] >= -eps) continue; // leaves the region exactly at an on-plane vertex
    const t = dist[i] / (dist[i] - dist[o]);
    const x = P.v[3 * i] + (P.v[3 * o] - P.v[3 * i]) * t;
    const y = P.v[3 * i + 1] + (P.v[3 * o + 1] - P.v[3 * i + 1]) * t;
    const z = P.v[3 * i + 2] + (P.v[3 * o + 2] - P.v[3 * i + 2]) * t;
    const idx = v.length / 3;
    v.push(x, y, z);
    e.push(map[i], idx);
    cap.push(x, y, z);
  }
  // close the cut face: connect the section points around their centroid
  const loop = sortLoop(cap, nx, ny, nz, Math.max(eps * 10, 1e-12));
  const m = loop.length / 3;
  if (m >= 2) {
    const ids: number[] = [];
    for (let i = 0; i < m; i++) {
      // find (or add) the vertex
      let found = -1;
      for (let j = 0; j < v.length; j += 3) {
        if (Math.abs(v[j] - loop[3 * i]) < eps * 10 + 1e-12 && Math.abs(v[j + 1] - loop[3 * i + 1]) < eps * 10 + 1e-12 && Math.abs(v[j + 2] - loop[3 * i + 2]) < eps * 10 + 1e-12) {
          found = j / 3;
          break;
        }
      }
      if (found < 0) {
        found = v.length / 3;
        v.push(loop[3 * i], loop[3 * i + 1], loop[3 * i + 2]);
      }
      ids.push(found);
    }
    for (let i = 0; i < m; i++) if (m > 2 || i === 0) e.push(ids[i], ids[(i + 1) % m]);
  }
  return { v, e };
}

/** intersection of plane n.x = d with P, as a sorted convex loop (flat xyz); empty if they miss */
export function polytopeSection(P: Polytope, nx: number, ny: number, nz: number, d: number): number[] {
  const eps = 1e-9 * scale(P);
  const nv = P.v.length / 3;
  const dist = new Float64Array(nv);
  const pts: number[] = [];
  for (let i = 0; i < nv; i++) {
    dist[i] = nx * P.v[3 * i] + ny * P.v[3 * i + 1] + nz * P.v[3 * i + 2] - d;
    if (Math.abs(dist[i]) <= eps) pts.push(P.v[3 * i], P.v[3 * i + 1], P.v[3 * i + 2]);
  }
  for (let k = 0; k < P.e.length; k += 2) {
    const a = P.e[k], b = P.e[k + 1];
    if ((dist[a] < -eps && dist[b] > eps) || (dist[a] > eps && dist[b] < -eps)) {
      const t = dist[a] / (dist[a] - dist[b]);
      pts.push(
        P.v[3 * a] + (P.v[3 * b] - P.v[3 * a]) * t,
        P.v[3 * a + 1] + (P.v[3 * b + 1] - P.v[3 * a + 1]) * t,
        P.v[3 * a + 2] + (P.v[3 * b + 2] - P.v[3 * a + 2]) * t,
      );
    }
  }
  return sortLoop(pts, nx, ny, nz, Math.max(eps * 10, 1e-12));
}

/** min / max of n.x over the vertices */
export function polytopeExtent(P: Polytope, nx: number, ny: number, nz: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P.v.length; i += 3) {
    const s = nx * P.v[i] + ny * P.v[i + 1] + nz * P.v[i + 2];
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return [lo, hi];
}

export function polytopeAABB(P: Polytope): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.v.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P.v[i + k]);
      max[k] = Math.max(max[k], P.v[i + k]);
    }
  return { min, max };
}

/** clip a bare convex point cloud (no edges) by n.x <= d: kept points plus every crossing segment's intersection */
export function clipPoints(pts: number[], nx: number, ny: number, nz: number, d: number): number[] {
  const n = pts.length / 3;
  const dist: number[] = [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    dist.push(nx * pts[3 * i] + ny * pts[3 * i + 1] + nz * pts[3 * i + 2] - d);
    if (dist[i] <= 0) out.push(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]);
  }
  if (out.length === pts.length) return pts.slice();
  for (let i = 0; i < n; i++) {
    if (dist[i] > 0) continue;
    for (let j = 0; j < n; j++) {
      if (dist[j] <= 0) continue;
      const t = dist[i] / (dist[i] - dist[j]);
      out.push(pts[3 * i] + (pts[3 * j] - pts[3 * i]) * t, pts[3 * i + 1] + (pts[3 * j + 1] - pts[3 * i + 1]) * t, pts[3 * i + 2] + (pts[3 * j + 2] - pts[3 * i + 2]) * t);
    }
  }
  return out;
}
