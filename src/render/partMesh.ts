import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import type { PartDef } from '../core/design';
import { getMaterial, type FailureStyle } from '../core/materials';
import { edgeKey, hasRound, roundGeom, roundProject } from '../core/rounding';
import { hasCuts, innerRadius } from '../core/shapes';
import { classifyPart, grainAxisOf } from '../fea/model';
import { clipGeometry } from './clip';
import { displacementAt, utilAt, type DeformField } from './deform';
import { partMaterials, stressMaterial, utilColor, type PartMaterials } from './materialLib';

// ------------------------------------------------------------------ helpers

function hash(i: number, j: number, seed: number) {
  let h = (i * 73856093) ^ (j * 19349663) ^ (seed * 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

interface Break {
  axis: number;
  side: number;
  seed: number;
  style: FailureStyle;
}

/** inward displacement of a fracture surface at normalised cross-section coords (a, b in -1..1) */
function fractureDepth(style: FailureStyle, a: number, b: number, seed: number, depth: number): number {
  switch (style) {
    case 'splinter': {
      // fibrous: columns of different length, with a long tongue on one side
      const ci = Math.floor((a + 1) * 6), cj = Math.floor((b + 1) * 2.5);
      const col = hash(ci, cj, seed);
      const tongue = 0.5 + 0.5 * Math.sin(a * 1.2 + seed);
      return depth * Math.min(1, 0.15 + 0.55 * tongue * col + 0.35 * hash(ci * 3 + 1, cj, seed + 7));
    }
    case 'crumble': {
      const n = hash(Math.floor((a + 1) * 5), Math.floor((b + 1) * 5), seed);
      return depth * (0.15 + 0.35 * (0.5 + 0.5 * a * Math.cos(seed)) + 0.3 * n);
    }
    case 'shatter':
    case 'dice': {
      return depth * (0.25 + 0.35 * (a * Math.cos(seed) + b * Math.sin(seed)) * 0.5 + 0.08 * Math.sin(a * 9 + b * 7));
    }
    case 'tear':
      return depth * (0.2 + 0.3 * hash(Math.floor((a + 1) * 4), Math.floor((b + 1) * 4), seed));
    default:
      return depth * 0.05 * (1 + a);
  }
}

// ------------------------------------------------------------------ box with rounded edges

function axisCoords(h: number, r: number, seg: number): number[] {
  if (r <= 1e-6) {
    const out: number[] = [];
    for (let i = 0; i <= seg; i++) out.push(-h + (2 * h * i) / seg);
    return out;
  }
  const inner = h - r;
  const out: number[] = [-h, -h + 0.4 * r, -inner];
  for (let i = 1; i < seg; i++) out.push(-inner + (2 * inner * i) / seg);
  out.push(inner, h - 0.4 * r, h);
  return out;
}

export interface BuiltGeometry {
  geometry: THREE.BufferGeometry;
  base: Float32Array;
}

function buildBox(def: PartDef): BuiltGeometry {
  const he = [def.size[0] / 2, def.size[1] / 2, def.size[2] / 2];
  const minH = Math.min(...he);
  const r = Math.min(0.004, minH * 0.18);
  const mat = getMaterial(def.material);
  const cls = classifyPart(def);
  const grain = grainAxisOf(def);
  const panel = mat.grain === 'panel' && cls.kind === 'plate';
  const thin = cls.kind === 'plate' ? cls.axis : -1;
  const breaks = def.breaks ?? [];
  const seg = [0, 1, 2].map((a) => {
    let s = Math.max(1, Math.min(40, Math.ceil((2 * he[a]) / 0.04)));
    if (breaks.some((b) => b.axis !== a)) s = Math.max(s, 12);
    return s;
  });
  const coords = [0, 1, 2].map((a) => axisCoords(he[a], r, seg[a]));
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const idx: number[] = [];
  const geo = new THREE.BufferGeometry();
  const p = [0, 0, 0], inner = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const j = (a + 1) % 3, k = (a + 2) % 3;
    let uA: number, vA: number;
    if (panel) {
      if (a === thin) {
        uA = grain === j || grain === k ? grain : j;
        vA = uA === j ? k : j;
      } else {
        vA = thin;
        uA = j === thin ? k : j;
      }
    } else if (grain === j || grain === k) {
      uA = grain;
      vA = grain === j ? k : j;
    } else {
      uA = j;
      vA = k;
    }
    const group = panel ? (a === thin ? 0 : 1) : a === grain && mat.grain ? 1 : 0;
    for (const s of [-1, 1]) {
      const start = idx.length;
      const v0 = pos.length / 3;
      const cj = coords[j], ck = coords[k];
      for (let ii = 0; ii < cj.length; ii++)
        for (let kk = 0; kk < ck.length; kk++) {
          p[a] = s * he[a];
          p[j] = cj[ii];
          p[k] = ck[kk];
          let len = 0;
          for (let c = 0; c < 3; c++) {
            const lim = he[c] - r;
            inner[c] = Math.max(-lim, Math.min(lim, p[c]));
          }
          const d = [p[0] - inner[0], p[1] - inner[1], p[2] - inner[2]];
          len = Math.hypot(d[0], d[1], d[2]) || 1;
          const n = [d[0] / len, d[1] / len, d[2] / len];
          const q = r > 0 ? [inner[0] + n[0] * r, inner[1] + n[1] * r, inner[2] + n[2] * r] : [p[0], p[1], p[2]];
          if (r <= 0) {
            n[0] = n[1] = n[2] = 0;
            n[a] = s;
          }
          pos.push(q[0], q[1], q[2]);
          nor.push(n[0], n[1], n[2]);
          uv.push(q[uA], q[vA]);
        }
      const nk = coords[k].length;
      for (let ii = 0; ii + 1 < cj.length; ii++)
        for (let kk = 0; kk + 1 < nk; kk++) {
          const a00 = v0 + ii * nk + kk, a10 = v0 + (ii + 1) * nk + kk, a01 = a00 + 1, a11 = a10 + 1;
          if (s > 0) idx.push(a00, a10, a11, a00, a11, a01);
          else idx.push(a00, a11, a10, a00, a01, a11);
        }
      geo.addGroup(start, idx.length - start, group);
    }
  }
  // fracture surfaces
  for (const b of breaks) {
    const a = b.axis;
    const j = (a + 1) % 3, k = (a + 2) % 3;
    const depth = Math.min(2 * he[a] * 0.45, Math.max(he[j], he[k]) * (b.style === 'splinter' ? 2.2 : 0.9));
    for (let i = 0; i < pos.length; i += 3) {
      const along = pos[i + a] * b.side;
      if (along < he[a] - r - 1e-6) continue;
      const na = pos[i + j] / he[j], nb = pos[i + k] / he[k];
      const dd = fractureDepth(b.style, na, nb, b.seed, depth);
      pos[i + a] -= b.side * dd;
      // rough normal
      nor[i + a] *= 0.6;
      nor[i + j] += (hash(i, 1, b.seed) - 0.5) * 0.8;
      nor[i + k] += (hash(i, 2, b.seed) - 0.5) * 0.8;
    }
  }
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (breaks.length) {
    const n = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < n.count; i++) {
      const v = new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i)).normalize();
      n.setXYZ(i, v.x, v.y, v.z);
    }
  }
  return { geometry: geo, base: Float32Array.from(pos) };
}

// ------------------------------------------------------------------ cylinders / tubes

function buildCylinder(def: PartDef): BuiltGeometry {
  const r = def.size[0] / 2, h = def.size[1] / 2;
  const tube = def.kind === 'tube';
  const ri = tube ? innerRadius(def) : 0;
  const breaks = def.breaks ?? [];
  const R = 40;
  const ny = Math.max(1, Math.min(48, Math.ceil((2 * h) / 0.04)));
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const geo = new THREE.BufferGeometry();
  const side = (rad: number, out: number) => {
    const start = idx.length;
    const v0 = pos.length / 3;
    for (let i = 0; i <= R; i++) {
      const t = (i / R) * Math.PI * 2;
      const c = Math.cos(t), s = Math.sin(t);
      for (let j = 0; j <= ny; j++) {
        const y = -h + (2 * h * j) / ny;
        pos.push(rad * c, y, rad * s);
        nor.push(out * c, 0, out * s);
        uv.push(y, t * rad);
      }
    }
    for (let i = 0; i < R; i++)
      for (let j = 0; j < ny; j++) {
        const a = v0 + i * (ny + 1) + j, b = v0 + (i + 1) * (ny + 1) + j;
        if (out > 0) idx.push(a, a + 1, b + 1, a, b + 1, b);
        else idx.push(a, b + 1, a + 1, a, b, b + 1);
      }
    geo.addGroup(start, idx.length - start, 0);
  };
  const cap = (s: number) => {
    const start = idx.length;
    const v0 = pos.length / 3;
    const rings = breaks.length ? 7 : 3;
    for (let k = 0; k <= rings; k++) {
      const rad = ri + ((r - ri) * k) / rings;
      for (let i = 0; i <= R; i++) {
        const t = (i / R) * Math.PI * 2;
        const x = rad * Math.cos(t), z = rad * Math.sin(t);
        pos.push(x, s * h, z);
        nor.push(0, s, 0);
        uv.push(x, z);
      }
    }
    for (let k = 0; k < rings; k++)
      for (let i = 0; i < R; i++) {
        const a = v0 + k * (R + 1) + i, b = v0 + (k + 1) * (R + 1) + i;
        if (s > 0) idx.push(a, b + 1, b, a, a + 1, b + 1);
        else idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
    geo.addGroup(start, idx.length - start, getMaterial(def.material).grain ? 1 : 0);
  };
  side(r, 1);
  if (tube) side(ri, -1);
  cap(1);
  cap(-1);
  for (const b of breaks) {
    if (b.axis !== 1) continue;
    const depth = Math.min(h * 0.9, r * (b.style === 'splinter' ? 2.2 : 0.9));
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] * b.side < h - 1e-6) continue;
      const dd = fractureDepth(b.style, pos[i] / r, pos[i + 2] / r, b.seed, depth);
      pos[i + 1] -= b.side * dd;
    }
  }
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return { geometry: geo, base: Float32Array.from(pos) };
}

function buildSphere(def: PartDef): BuiltGeometry {
  const r = def.size[0] / 2;
  const geo = new THREE.SphereGeometry(r, 40, 28);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * Math.PI * r);
  geo.clearGroups();
  geo.addGroup(0, geo.getIndex()!.count, 0);
  return { geometry: geo, base: Float32Array.from((geo.getAttribute('position') as THREE.BufferAttribute).array) };
}

function buildHull(def: PartDef): BuiltGeometry {
  const pts: THREE.Vector3[] = [];
  const h = def.hull ?? [];
  for (let i = 0; i < h.length; i += 3) pts.push(new THREE.Vector3(h[i], h[i + 1], h[i + 2]));
  let geo: THREE.BufferGeometry;
  try {
    geo = new ConvexGeometry(pts);
  } catch {
    geo = new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);
  }
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    if (nx >= ny && nx >= nz) {
      uvs[2 * i] = pos.getZ(i);
      uvs[2 * i + 1] = pos.getY(i);
    } else if (ny >= nz) {
      uvs[2 * i] = pos.getX(i);
      uvs[2 * i + 1] = pos.getZ(i);
    } else {
      uvs[2 * i] = pos.getX(i);
      uvs[2 * i + 1] = pos.getY(i);
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.clearGroups();
  geo.addGroup(0, pos.count, 1);
  return { geometry: geo, base: Float32Array.from(pos.array as Float32Array) };
}

// ------------------------------------------------------------------ rounded / bevelled edges

/** grid lines along one axis, packed into the zones z0 / z1 at either end where an edge is treated */
function treatedCoords(h: number, z0: number, z1: number, base: number): number[] {
  const out: number[] = [];
  const seg = Math.max(1, Math.min(40, Math.ceil((2 * h) / base)));
  for (let i = 0; i <= seg; i++) out.push(-h + (2 * h * i) / seg);
  const pack = (end: number, dir: number, z: number) => {
    z = Math.min(z, 2 * h);
    if (z <= 1e-6) return;
    const n = Math.max(4, Math.min(16, Math.ceil(z / 0.004)));
    for (let i = 1; i <= n; i++) out.push(end + (dir * z * i) / n);
  };
  pack(-h, 1, z0);
  pack(h, -1, z1);
  out.sort((a, b) => a - b);
  return out.filter((v, i) => i === 0 || v - out[i - 1] > 1e-7).map((v) => Math.max(-h, Math.min(h, v)));
}

/**
 * A box whose edges are rounded or bevelled: each face's grid is wrapped onto the true shape by a
 * closest-point projection, so curved edges get smooth, exact normals.
 */
function buildRoundedBox(def: PartDef, cosmetic: boolean, base = 0.04): BuiltGeometry {
  const he = [def.size[0] / 2, def.size[1] / 2, def.size[2] / 2];
  const r0 = cosmetic ? Math.min(0.004, Math.min(...he) * 0.18) : 0;
  const g = roundGeom(def, r0);
  const mat = getMaterial(def.material);
  const cls = classifyPart(def);
  const grain = grainAxisOf(def);
  const panel = mat.grain === 'panel' && cls.kind === 'plate';
  const thin = cls.kind === 'plate' ? cls.axis : -1;
  const rim = Math.max(Math.abs(g.rt), Math.abs(g.rb));
  const zone = (axis: number): [number, number] => {
    if (axis === g.up) return [Math.abs(g.rb), Math.abs(g.rt)];
    const bit = axis === g.ua ? 1 : 2;
    let lo = 0, hi = 0;
    for (let i = 0; i < 4; i++) {
      if (i & bit) hi = Math.max(hi, Math.abs(g.R[i]));
      else lo = Math.max(lo, Math.abs(g.R[i]));
    }
    return [Math.max(lo, rim), Math.max(hi, rim)];
  };
  const coords = [0, 1, 2].map((a) => {
    const [z0, z1] = zone(a);
    return treatedCoords(he[a], z0, z1, base);
  });
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const idx: number[] = [];
  const geo = new THREE.BufferGeometry();
  const p = [0, 0, 0], q = [0, 0, 0], n = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const j = (a + 1) % 3, k = (a + 2) % 3;
    let uA: number, vA: number;
    if (panel) {
      if (a === thin) {
        uA = grain === j || grain === k ? grain : j;
        vA = uA === j ? k : j;
      } else {
        vA = thin;
        uA = j === thin ? k : j;
      }
    } else if (grain === j || grain === k) {
      uA = grain;
      vA = grain === j ? k : j;
    } else {
      uA = j;
      vA = k;
    }
    const group = panel ? (a === thin ? 0 : 1) : a === grain && mat.grain ? 1 : 0;
    for (const s of [-1, 1]) {
      const start = idx.length;
      const v0 = pos.length / 3;
      const cj = coords[j], ck = coords[k];
      for (let ii = 0; ii < cj.length; ii++)
        for (let kk = 0; kk < ck.length; kk++) {
          p[a] = s * he[a];
          p[j] = cj[ii];
          p[k] = ck[kk];
          roundProject(g, p, q, n);
          pos.push(q[0], q[1], q[2]);
          nor.push(n[0], n[1], n[2]);
          uv.push(q[uA], q[vA]);
        }
      const nk = ck.length;
      for (let ii = 0; ii + 1 < cj.length; ii++)
        for (let kk = 0; kk + 1 < nk; kk++) {
          const a00 = v0 + ii * nk + kk, a10 = v0 + (ii + 1) * nk + kk, a01 = a00 + 1, a11 = a10 + 1;
          if (s > 0) idx.push(a00, a10, a11, a00, a11, a01);
          else idx.push(a00, a11, a10, a00, a01, a11);
        }
      geo.addGroup(start, idx.length - start, group);
    }
  }
  // fracture surfaces (break ends are left square by the fracture code)
  for (const b of def.breaks ?? []) {
    const a = b.axis;
    const j = (a + 1) % 3, k = (a + 2) % 3;
    const depth = Math.min(2 * he[a] * 0.45, Math.max(he[j], he[k]) * (b.style === 'splinter' ? 2.2 : 0.9));
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + a] * b.side < he[a] - r0 - 1e-6) continue;
      const dd = fractureDepth(b.style, pos[i + j] / he[j], pos[i + k] / he[k], b.seed, depth);
      pos[i + a] -= b.side * dd;
    }
  }
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return { geometry: geo, base: Float32Array.from(pos) };
}

/** a cylinder with rounded / bevelled rims: its profile turned like on a lathe */
function buildRoundedCylinder(def: PartDef, R = 48): BuiltGeometry {
  const g = roundGeom(def);
  const Rc = g.Rc, h = g.h;
  const mat = getMaterial(def.material);
  type Row = { r: number; t: number; nr: number; nt: number; cap: boolean };
  const rows: Row[] = [];
  const cap = (t: number, sg: number, rOut: number, outward: boolean): Row[] => {
    const list: Row[] = [];
    for (let k = 0; k <= 4; k++) list.push({ r: (Math.max(0, rOut) * k) / 4, t, nr: 0, nt: sg, cap: true });
    return outward ? list : list.reverse();
  };
  const d = Math.SQRT1_2;
  rows.push(...cap(-h, -1, Rc - Math.abs(g.rb), true));
  if (g.rb > 0) {
    const r = g.rb;
    for (let i = 0; i <= 8; i++) {
      const f = -Math.PI / 2 + ((i / 8) * Math.PI) / 2;
      rows.push({ r: Rc - r + r * Math.cos(f), t: -h + r + r * Math.sin(f), nr: Math.cos(f), nt: Math.sin(f), cap: false });
    }
  } else if (g.rb < 0) {
    const c = -g.rb;
    rows.push({ r: Rc - c, t: -h, nr: d, nt: -d, cap: false }, { r: Rc, t: -h + c, nr: d, nt: -d, cap: false }, { r: Rc, t: -h + c, nr: 1, nt: 0, cap: false });
  } else rows.push({ r: Rc, t: -h, nr: 1, nt: 0, cap: false });
  if (g.rt > 0) {
    const r = g.rt;
    for (let i = 0; i <= 8; i++) {
      const f = ((i / 8) * Math.PI) / 2;
      rows.push({ r: Rc - r + r * Math.cos(f), t: h - r + r * Math.sin(f), nr: Math.cos(f), nt: Math.sin(f), cap: false });
    }
  } else if (g.rt < 0) {
    const c = -g.rt;
    rows.push({ r: Rc, t: h - c, nr: 1, nt: 0, cap: false }, { r: Rc, t: h - c, nr: d, nt: d, cap: false }, { r: Rc - c, t: h, nr: d, nt: d, cap: false });
  } else rows.push({ r: Rc, t: h, nr: 1, nt: 0, cap: false });
  rows.push(...cap(h, 1, Rc - Math.abs(g.rt), false));
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const geo = new THREE.BufferGeometry();
  for (const row of rows)
    for (let i = 0; i <= R; i++) {
      const th = (i / R) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      pos.push(row.r * c, row.t, row.r * sn);
      nor.push(row.nr * c, row.nt, row.nr * sn);
      if (row.cap) uv.push(row.r * c, row.r * sn);
      else uv.push(row.t, th * Rc);
    }
  const capGroup = mat.grain ? 1 : 0;
  let start = 0, curGroup = -1;
  for (let j = 0; j + 1 < rows.length; j++) {
    const grp = rows[j].cap && rows[j + 1].cap ? capGroup : 0;
    if (grp !== curGroup) {
      if (curGroup >= 0) geo.addGroup(start, idx.length - start, curGroup);
      start = idx.length;
      curGroup = grp;
    }
    for (let i = 0; i < R; i++) {
      const A = j * (R + 1) + i, B = (j + 1) * (R + 1) + i, C = A + 1, D = B + 1;
      idx.push(A, B, C, C, B, D);
    }
  }
  if (curGroup >= 0) geo.addGroup(start, idx.length - start, curGroup);
  for (const b of def.breaks ?? []) {
    if (b.axis !== 1) continue;
    const depth = Math.min(h * 0.9, Rc * (b.style === 'splinter' ? 2.2 : 0.9));
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] * b.side < h - 1e-6) continue;
      pos[i + 1] -= b.side * fractureDepth(b.style, pos[i] / Rc, pos[i + 2] / Rc, b.seed, depth);
    }
  }
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return { geometry: geo, base: Float32Array.from(pos) };
}

/** non-indexed copy without zero-area triangles (they confuse edge detection) */
function dropDegenerate(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const keep: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i + 2 < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    const area = b.clone().sub(a).cross(c.clone().sub(a)).length();
    if (area > 1e-11) keep.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  return out;
}

/** selection outline of a part with treated edges: its sharp creases only */
function roundOutline(def: PartDef): THREE.BufferGeometry {
  let geo = def.kind === 'cylinder' ? buildRoundedCylinder(def, 32).geometry : buildRoundedBox(def, false, 0.08).geometry;
  if (hasCuts(def)) {
    const c = clipGeometry(geo, def.cuts!, () => 0);
    geo.dispose();
    geo = c.geometry;
  }
  const clean = dropDegenerate(geo);
  geo.dispose();
  const edges = new THREE.EdgesGeometry(clean, 30);
  clean.dispose();
  return edges;
}

function buildUncut(def: PartDef): BuiltGeometry {
  if (hasRound(def)) return def.kind === 'cylinder' ? buildRoundedCylinder(def) : buildRoundedBox(def, true);
  switch (def.kind) {
    case 'cylinder':
    case 'tube':
      return buildCylinder(def);
    case 'sphere':
      return buildSphere(def);
    case 'hull':
      return buildHull(def);
    default:
      return buildBox(def);
  }
}

/** which material slot a saw-cut face gets: end grain when it cuts across the grain */
function capGroupFor(def: PartDef): (n: number[]) => number {
  const mat = getMaterial(def.material);
  if (!mat.grain) return () => 0;
  if (def.kind === 'cylinder' || def.kind === 'tube') return (n) => (Math.abs(n[1]) > 0.5 ? 1 : 0);
  if (def.kind === 'sphere') return () => 0;
  const cls = classifyPart(def);
  if (mat.grain === 'panel' && cls.kind === 'plate') return (n) => (Math.abs(n[cls.axis]) > 0.7 ? 0 : 1);
  const g = grainAxisOf(def);
  return (n) => (Math.abs(n[g]) > 0.5 ? 1 : 0);
}

export function buildPartGeometry(def: PartDef): BuiltGeometry {
  const built = buildUncut(def);
  if (!hasCuts(def)) return built;
  const { geometry } = clipGeometry(built.geometry, def.cuts!, capGroupFor(def));
  built.geometry.dispose();
  return { geometry, base: Float32Array.from((geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array) };
}

function cutOutline(def: PartDef): THREE.BufferGeometry {
  const planes = def.cuts!;
  if (def.kind === 'sphere') {
    const r = (def.size[0] / 2) * 1.002;
    const pts: number[] = [];
    const ok = (v: number[]) => {
      for (let i = 0; i + 3 < planes.length; i += 4) if (planes[i] * v[0] + planes[i + 1] * v[1] + planes[i + 2] * v[2] > planes[i + 3] + 1e-6) return false;
      return true;
    };
    for (const plane of [0, 1, 2])
      for (let i = 0; i < 64; i++) {
        const t0 = (i / 64) * Math.PI * 2, t1 = ((i + 1) / 64) * Math.PI * 2;
        const P = (t: number) => {
          const a = Math.cos(t) * r, b = Math.sin(t) * r;
          return plane === 0 ? [0, a, b] : plane === 1 ? [a, 0, b] : [a, b, 0];
        };
        const a = P(t0), b = P(t1);
        if (ok(a) && ok(b)) pts.push(...a, ...b);
      }
    const { rims } = clipGeometry(new THREE.SphereGeometry(def.size[0] / 2, 32, 20), planes, () => 0);
    for (const loop of rims)
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }
  const plain = def.kind === 'cylinder' || def.kind === 'tube'
    ? new THREE.CylinderGeometry(def.size[0] / 2, def.size[0] / 2, def.size[1], 32)
    : new THREE.BoxGeometry(def.size[0] * 1.002, def.size[1] * 1.002, def.size[2] * 1.002);
  const { geometry } = clipGeometry(plain, planes, () => 0);
  plain.dispose();
  const edges = new THREE.EdgesGeometry(geometry, 20);
  geometry.dispose();
  return edges;
}

function outlineGeometry(def: PartDef): THREE.BufferGeometry {
  if (hasRound(def)) return roundOutline(def);
  if (hasCuts(def)) return cutOutline(def);
  if (def.kind === 'cylinder' || def.kind === 'tube') {
    return new THREE.EdgesGeometry(new THREE.CylinderGeometry(def.size[0] / 2, def.size[0] / 2, def.size[1], 32), 20);
  }
  if (def.kind === 'sphere') {
    const g = new THREE.BufferGeometry();
    const r = def.size[0] / 2 * 1.002;
    const pts: number[] = [];
    for (const plane of [0, 1, 2])
      for (let i = 0; i < 64; i++) {
        const t0 = (i / 64) * Math.PI * 2, t1 = ((i + 1) / 64) * Math.PI * 2;
        const a = [Math.cos(t0) * r, Math.sin(t0) * r], b = [Math.cos(t1) * r, Math.sin(t1) * r];
        const P = (v: number[]) => (plane === 0 ? [0, v[0], v[1]] : plane === 1 ? [v[0], 0, v[1]] : [v[0], v[1], 0]);
        pts.push(...P(a), ...P(b));
      }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }
  if (def.kind === 'hull') {
    const h = def.hull ?? [];
    const v: THREE.Vector3[] = [];
    for (let i = 0; i < h.length; i += 3) v.push(new THREE.Vector3(h[i], h[i + 1], h[i + 2]));
    try {
      return new THREE.EdgesGeometry(new ConvexGeometry(v), 25);
    } catch {
      /* fall through */
    }
  }
  return new THREE.EdgesGeometry(new THREE.BoxGeometry(def.size[0] * 1.002, def.size[1] * 1.002, def.size[2] * 1.002));
}

function shapeKey(def: PartDef): string {
  return [def.kind, def.size.map((v) => v.toFixed(5)).join(','), def.wall ?? 0, def.material, JSON.stringify(def.breaks ?? []), def.crushed ?? 0, (def.hull ?? []).length, (def.cuts ?? []).map((v) => v.toFixed(6)).join(','), def.grain ?? -1, edgeKey(def)].join('|');
}

// ------------------------------------------------------------------ PartView

const outlineMat = new THREE.LineBasicMaterial({ color: 0x4fb3ff, transparent: true, opacity: 0.95, depthTest: true });
const hoverMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: true });

export class PartView {
  readonly group = new THREE.Group();
  mesh!: THREE.Mesh;
  private base!: Float32Array;
  private key = '';
  def: PartDef;
  private mats!: PartMaterials;
  private outline: THREE.LineSegments | null = null;
  private selected = false;
  private hovered = false;
  private stress = false;
  private field: DeformField | null = null;
  private deformScale = 0;
  private colors: THREE.BufferAttribute | null = null;

  constructor(def: PartDef) {
    this.def = def;
    this.rebuild(def);
  }

  private rebuild(def: PartDef) {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    if (this.outline) {
      this.group.remove(this.outline);
      this.outline.geometry.dispose();
      this.outline = null;
    }
    const built = buildPartGeometry(def);
    this.base = built.base;
    this.mats = partMaterials(def.material);
    this.mesh = new THREE.Mesh(built.geometry, this.materialArray());
    this.mesh.castShadow = !this.mats.transparent;
    this.mesh.receiveShadow = true;
    this.mesh.userData.partId = def.id;
    this.group.add(this.mesh);
    this.key = shapeKey(def);
    this.colors = null;
    this.applySelection();
    this.applyField();
  }

  private materialArray(): THREE.Material | THREE.Material[] {
    if (this.stress) return stressMaterial;
    return [this.mats.side, this.mats.end, this.mats.edge];
  }

  update(def: PartDef) {
    this.def = def;
    if (shapeKey(def) !== this.key) this.rebuild(def);
    this.group.position.set(def.pos[0], def.pos[1], def.pos[2]);
    this.group.quaternion.set(def.quat[0], def.quat[1], def.quat[2], def.quat[3]);
  }

  setPose(pos: THREE.Vector3 | number[], quat: THREE.Quaternion | number[]) {
    if (Array.isArray(pos)) this.group.position.set(pos[0], pos[1], pos[2]);
    else this.group.position.copy(pos);
    if (Array.isArray(quat)) this.group.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    else this.group.quaternion.copy(quat);
  }

  setHighlight(selected: boolean, hovered: boolean) {
    if (selected === this.selected && hovered === this.hovered) return;
    this.selected = selected;
    this.hovered = hovered;
    this.applySelection();
  }

  private applySelection() {
    const show = this.selected || this.hovered;
    if (show && !this.outline) {
      this.outline = new THREE.LineSegments(outlineGeometry(this.def), this.selected ? outlineMat : hoverMat);
      this.outline.raycast = () => {};
      this.group.add(this.outline);
    }
    if (this.outline) {
      this.outline.visible = show;
      this.outline.material = this.selected ? outlineMat : hoverMat;
    }
  }

  setStressView(on: boolean) {
    if (on === this.stress) return;
    this.stress = on;
    this.mesh.material = this.materialArray();
    this.applyField();
  }

  /** set the analysis field and how much to exaggerate its deformation (0 = none, 1 = true scale) */
  setField(field: DeformField | null, deformScale: number) {
    this.field = field;
    this.deformScale = deformScale;
    this.applyField();
  }

  setDeformScale(s: number) {
    if (s === this.deformScale) return;
    this.deformScale = s;
    this.applyField();
  }

  private applyField() {
    const geo = this.mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const f = this.field;
    const b = this.base;
    const out = [0, 0, 0];
    if (f && this.deformScale > 0 && f.maxDisp > 0) {
      const s = this.deformScale;
      for (let i = 0; i < arr.length; i += 3) {
        displacementAt(f, b[i], b[i + 1], b[i + 2], out);
        arr[i] = b[i] + s * out[0];
        arr[i + 1] = b[i + 1] + s * out[1];
        arr[i + 2] = b[i + 2] + s * out[2];
      }
    } else arr.set(b);
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    if (this.stress) {
      if (!this.colors || this.colors.count !== pos.count) {
        this.colors = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
        geo.setAttribute('color', this.colors);
      }
      const c = new THREE.Color();
      const ca = this.colors.array as Float32Array;
      for (let i = 0, v = 0; i < b.length; i += 3, v += 3) {
        const U = f ? utilAt(f, b[i], b[i + 1], b[i + 2]) : 0;
        utilColor(U, c);
        ca[v] = c.r;
        ca[v + 1] = c.g;
        ca[v + 2] = c.b;
      }
      this.colors.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    if (this.outline) this.outline.geometry.dispose();
  }
}
