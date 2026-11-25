import { qConj, qRotate } from '../core/shapes';
import type { FEModel, FEPartInfo, MemberKind } from '../fea/model';

/** Deformation + utilisation field of one part, expressed in the part's local frame. */
export interface DeformField {
  kind: MemberKind;
  axis: number;
  uAxis: number;
  vAxis: number;
  stations: Float64Array;
  gridU: Float64Array;
  gridV: Float64Array;
  grid: Int32Array; // local node index per (iu, iv) or -1
  disp: Float32Array; // 3 per node
  rot: Float32Array; // 3 per node
  eA1: Float32Array;
  eA2: Float32Array;
  eB1: Float32Array;
  eB2: Float32Array;
  eU: Float32Array;
  eDir: Uint8Array;
  U: number;
  maxDisp: number;
}

export function makeDeformField(
  info: FEPartInfo, model: FEModel, u: ArrayLike<number> | null, elemU: ArrayLike<number> | null, partU: number,
): DeformField {
  const nodes = info.nodes;
  const local = new Map<number, number>();
  nodes.forEach((n, i) => local.set(n, i));
  const disp = new Float32Array(nodes.length * 3);
  const rot = new Float32Array(nodes.length * 3);
  const qi = qConj(info.def.quat);
  const o = [0, 0, 0];
  let maxDisp = 0;
  if (u) {
    nodes.forEach((n, i) => {
      qRotate(qi, u[6 * n], u[6 * n + 1], u[6 * n + 2], o);
      disp[3 * i] = o[0];
      disp[3 * i + 1] = o[1];
      disp[3 * i + 2] = o[2];
      maxDisp = Math.max(maxDisp, Math.hypot(o[0], o[1], o[2]));
      qRotate(qi, u[6 * n + 3], u[6 * n + 4], u[6 * n + 5], o);
      rot[3 * i] = o[0];
      rot[3 * i + 1] = o[1];
      rot[3 * i + 2] = o[2];
    });
  }
  const ne = info.elems.length;
  const eA1 = new Float32Array(ne), eA2 = new Float32Array(ne), eB1 = new Float32Array(ne), eB2 = new Float32Array(ne);
  const eU = new Float32Array(ne);
  const eDir = new Uint8Array(ne);
  info.elems.forEach((ei, k) => {
    const e = model.elements[ei];
    eA1[k] = e.a1;
    eA2[k] = e.a2;
    eB1[k] = e.b1;
    eB2[k] = e.b2;
    eU[k] = elemU ? elemU[ei] : 0;
    eDir[k] = e.plateDir ?? 0;
  });
  const grid = new Int32Array(info.grid.length);
  for (let i = 0; i < grid.length; i++) grid[i] = info.grid[i] >= 0 ? local.get(info.grid[i]) ?? -1 : -1;
  return {
    kind: info.kind, axis: info.axis, uAxis: info.uAxis, vAxis: info.vAxis,
    stations: Float64Array.from(info.stations), gridU: Float64Array.from(info.gridU), gridV: Float64Array.from(info.gridV),
    grid, disp, rot, eA1, eA2, eB1, eB2, eU, eDir, U: partU, maxDisp,
  };
}

function findInterval(arr: Float64Array, x: number): number {
  let lo = 0, hi = arr.length - 2;
  if (hi < 0) return 0;
  if (x <= arr[0]) return 0;
  if (x >= arr[arr.length - 1]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, arr.length - 2);
}

/** displacement (local frame, metres, unscaled) at local point p */
export function displacementAt(f: DeformField, px: number, py: number, pz: number, out: number[]): void {
  const p = [px, py, pz];
  const d = f.disp, r = f.rot;
  if (f.kind === 'block' || d.length < 3) {
    if (d.length < 3) {
      out[0] = out[1] = out[2] = 0;
      return;
    }
    // rigid: u + theta x p
    out[0] = d[0] + (r[1] * pz - r[2] * py);
    out[1] = d[1] + (r[2] * px - r[0] * pz);
    out[2] = d[2] + (r[0] * py - r[1] * px);
    return;
  }
  if (f.kind === 'beam') {
    const a = f.axis, e2 = (a + 1) % 3, e3 = (a + 2) % 3;
    const s = p[a];
    const k = findInterval(f.stations, s);
    const s0 = f.stations[k], s1 = f.stations[Math.min(k + 1, f.stations.length - 1)];
    const L = Math.max(1e-9, s1 - s0);
    const xi = Math.max(0, Math.min(1, (s - s0) / L));
    const i0 = 3 * k, i1 = 3 * Math.min(k + 1, f.stations.length - 1);
    const H1 = 1 - 3 * xi * xi + 2 * xi ** 3, H2 = xi - 2 * xi * xi + xi ** 3, H3 = 3 * xi * xi - 2 * xi ** 3, H4 = -xi * xi + xi ** 3;
    const ax = (1 - xi) * d[i0 + a] + xi * d[i1 + a];
    const v = H1 * d[i0 + e2] + H2 * L * r[i0 + e3] + H3 * d[i1 + e2] + H4 * L * r[i1 + e3];
    const w = H1 * d[i0 + e3] - H2 * L * r[i0 + e2] + H3 * d[i1 + e3] - H4 * L * r[i1 + e2];
    const th = [(1 - xi) * r[i0] + xi * r[i1], (1 - xi) * r[i0 + 1] + xi * r[i1 + 1], (1 - xi) * r[i0 + 2] + xi * r[i1 + 2]];
    const off = [px, py, pz];
    off[a] = 0;
    const res = [0, 0, 0];
    res[a] = ax;
    res[e2] = v;
    res[e3] = w;
    out[0] = res[0] + (th[1] * off[2] - th[2] * off[1]);
    out[1] = res[1] + (th[2] * off[0] - th[0] * off[2]);
    out[2] = res[2] + (th[0] * off[1] - th[1] * off[0]);
    return;
  }
  // plate: bilinear in the grid
  const u = p[f.uAxis], v = p[f.vAxis];
  const i = findInterval(f.gridU, u), j = findInterval(f.gridV, v);
  const NV = f.gridV.length;
  const u0 = f.gridU[i], u1 = f.gridU[Math.min(i + 1, f.gridU.length - 1)];
  const v0 = f.gridV[j], v1 = f.gridV[Math.min(j + 1, NV - 1)];
  const tu = Math.max(0, Math.min(1, (u - u0) / Math.max(1e-9, u1 - u0)));
  const tv = Math.max(0, Math.min(1, (v - v0) / Math.max(1e-9, v1 - v0)));
  const corners: [number, number, number][] = [
    [i, j, (1 - tu) * (1 - tv)],
    [i + 1, j, tu * (1 - tv)],
    [i, j + 1, (1 - tu) * tv],
    [i + 1, j + 1, tu * tv],
  ];
  let wsum = 0;
  const acc = [0, 0, 0], th = [0, 0, 0];
  for (const [ci, cj, w] of corners) {
    if (ci >= f.gridU.length || cj >= NV) continue;
    const n = f.grid[ci * NV + cj];
    if (n < 0) continue;
    wsum += w;
    for (let c = 0; c < 3; c++) {
      acc[c] += w * d[3 * n + c];
      th[c] += w * r[3 * n + c];
    }
  }
  if (wsum < 1e-9) {
    // nearest existing node (disk edge)
    let best = 0, bd = Infinity;
    for (let a = 0; a < f.gridU.length; a++)
      for (let b = 0; b < NV; b++) {
        const n = f.grid[a * NV + b];
        if (n < 0) continue;
        const dd = (f.gridU[a] - u) ** 2 + (f.gridV[b] - v) ** 2;
        if (dd < bd) {
          bd = dd;
          best = n;
        }
      }
    for (let c = 0; c < 3; c++) {
      acc[c] = d[3 * best + c];
      th[c] = r[3 * best + c];
    }
    wsum = 1;
  }
  for (let c = 0; c < 3; c++) {
    acc[c] /= wsum;
    th[c] /= wsum;
  }
  const off = [0, 0, 0];
  const wAxis = 3 - f.uAxis - f.vAxis;
  off[wAxis] = p[wAxis];
  out[0] = acc[0] + (th[1] * off[2] - th[2] * off[1]);
  out[1] = acc[1] + (th[2] * off[0] - th[0] * off[2]);
  out[2] = acc[2] + (th[0] * off[1] - th[1] * off[0]);
}

/** utilisation near a local point (for stress colouring) */
export function utilAt(f: DeformField, px: number, py: number, pz: number): number {
  if (f.kind === 'block' || f.eU.length === 0) return f.U;
  const p = [px, py, pz];
  if (f.kind === 'beam') {
    const s = p[f.axis];
    for (let k = 0; k < f.eU.length; k++) {
      if (s >= f.eA1[k] - 1e-9 && s <= f.eA2[k] + 1e-9) return Math.max(f.eU[k], k + 1 < f.eU.length && Math.abs(s - f.eA2[k]) < 1e-6 ? f.eU[k + 1] : 0);
    }
    return f.U;
  }
  const u = p[f.uAxis], v = p[f.vAxis];
  let best = 0, bd = Infinity;
  for (let k = 0; k < f.eU.length; k++) {
    const cu = (f.eA1[k] + f.eA2[k]) / 2, cv = (f.eB1[k] + f.eB2[k]) / 2;
    const d = (cu - u) ** 2 + (cv - v) ** 2;
    if (d < bd - 1e-12) {
      bd = d;
      best = f.eU[k];
    } else if (Math.abs(d - bd) < 1e-12) best = Math.max(best, f.eU[k]);
  }
  return best;
}
