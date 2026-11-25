import * as THREE from 'three';

/** vertex record: position, normal, uv */
type Vx = [number, number, number, number, number, number, number, number];

interface Tri {
  v: [Vx, Vx, Vx];
  g: number;
}

export interface ClipResult {
  geometry: THREE.BufferGeometry;
  /** the outlines of the cut faces (local coordinates) */
  rims: THREE.Vector3[][];
}

function lerpV(a: Vx, b: Vx, t: number): Vx {
  const o = new Array(8) as Vx;
  for (let i = 0; i < 8; i++) o[i] = a[i] + (b[i] - a[i]) * t;
  const l = Math.hypot(o[3], o[4], o[5]) || 1;
  o[3] /= l;
  o[4] /= l;
  o[5] /= l;
  return o;
}

function readTris(geo: THREE.BufferGeometry): Tri[] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const index = geo.getIndex();
  const count = index ? index.count : pos.count;
  const vx = (i: number): Vx => [
    pos.getX(i), pos.getY(i), pos.getZ(i),
    nor ? nor.getX(i) : 0, nor ? nor.getY(i) : 1, nor ? nor.getZ(i) : 0,
    uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0,
  ];
  const groupOf = new Int32Array(Math.ceil(count / 3));
  if (geo.groups.length) {
    for (const g of geo.groups) for (let k = g.start; k < g.start + g.count; k += 3) groupOf[Math.floor(k / 3)] = g.materialIndex ?? 0;
  }
  const out: Tri[] = [];
  for (let k = 0; k + 2 < count; k += 3) {
    const a = index ? index.getX(k) : k, b = index ? index.getX(k + 1) : k + 1, c = index ? index.getX(k + 2) : k + 2;
    out.push({ v: [vx(a), vx(b), vx(c)], g: groupOf[k / 3] });
  }
  return out;
}

function basis(n: number[]): [THREE.Vector3, THREE.Vector3] {
  const nv = new THREE.Vector3(n[0], n[1], n[2]);
  const ref = Math.abs(n[1]) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(ref, nv).normalize();
  const t2 = new THREE.Vector3().crossVectors(nv, t1);
  return [t1, t2];
}

/** chain undirected segments into closed loops */
function chain(segs: THREE.Vector3[][], tol: number): THREE.Vector3[][] {
  const key = (p: THREE.Vector3) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)},${Math.round(p.z / tol)}`;
  const adj = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of s) {
      const k = key(p);
      const arr = adj.get(k) ?? [];
      arr.push(i);
      adj.set(k, arr);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops: THREE.Vector3[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i][0], segs[i][1]];
    const startKey = key(segs[i][0]);
    let cur = segs[i][1];
    for (let guard = 0; guard < segs.length + 2; guard++) {
      const k = key(cur);
      if (k === startKey) break;
      const next = (adj.get(k) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      cur = key(s[0]) === k ? s[1] : s[0];
      if (key(cur) !== startKey) loop.push(cur);
      else break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function area2(p: THREE.Vector2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function inside2(p: THREE.Vector2, poly: THREE.Vector2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y + 1e-30) + a.x) c = !c;
  }
  return c;
}

function hull2(pts: THREE.Vector2[]): THREE.Vector2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cr = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: THREE.Vector2[] = [], up: THREE.Vector2[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/**
 * Clip a closed triangle mesh to the region n.x <= d of every plane ([nx, ny, nz, d, ...], local
 * coordinates) and close each opening with a flat cap. Positions, normals, uvs and material groups
 * are kept; caps get `capGroup(n)` and planar uvs in metres.
 */
export function clipGeometry(src: THREE.BufferGeometry, planes: number[], capGroup: (n: number[]) => number): ClipResult {
  let tris = readTris(src);
  src.computeBoundingSphere();
  const size = src.boundingSphere ? src.boundingSphere.radius : 1;
  const tol = Math.max(1e-7, size * 2e-6);
  const rims: THREE.Vector3[][] = [];
  for (let pi = 0; pi + 3 < planes.length; pi += 4) {
    const n = [planes[pi], planes[pi + 1], planes[pi + 2]];
    const d = planes[pi + 3];
    const out: Tri[] = [];
    const segs: THREE.Vector3[][] = [];
    const dist = (v: Vx) => v[0] * n[0] + v[1] * n[1] + v[2] * n[2] - d;
    for (const t of tris) {
      const ds = [dist(t.v[0]), dist(t.v[1]), dist(t.v[2])];
      const inn = ds.map((x) => x <= 0);
      const k = inn.filter(Boolean).length;
      if (k === 3) {
        out.push(t);
        continue;
      }
      if (k === 0) continue;
      const poly: Vx[] = [];
      const cutPts: Vx[] = [];
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        const a = t.v[i], b = t.v[j];
        if (inn[i]) poly.push(a);
        if (inn[i] !== inn[j]) {
          const p = lerpV(a, b, ds[i] / (ds[i] - ds[j]));
          poly.push(p);
          cutPts.push(p);
        }
      }
      for (let i = 1; i + 1 < poly.length; i++) out.push({ v: [poly[0], poly[i], poly[i + 1]], g: t.g });
      if (cutPts.length === 2) {
        const a = new THREE.Vector3(cutPts[0][0], cutPts[0][1], cutPts[0][2]);
        const b = new THREE.Vector3(cutPts[1][0], cutPts[1][1], cutPts[1][2]);
        if (a.distanceTo(b) > tol * 0.1) segs.push([a, b]);
      }
    }
    // cap the opening
    const [t1, t2] = basis(n);
    const capG = capGroup(n);
    const to2 = (p: THREE.Vector3) => new THREE.Vector2(p.dot(t1), p.dot(t2));
    const mk = (p: THREE.Vector3): Vx => [p.x, p.y, p.z, n[0], n[1], n[2], p.dot(t1), p.dot(t2)];
    const nv = new THREE.Vector3(n[0], n[1], n[2]);
    const pushCap = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
      const nn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (nn.lengthSq() < 1e-30) return;
      if (nn.dot(nv) < 0) out.push({ v: [mk(a), mk(c), mk(b)], g: capG });
      else out.push({ v: [mk(a), mk(b), mk(c)], g: capG });
    };
    let loops = chain(segs, tol);
    let closedOk = loops.length > 0;
    // all segments should be used by closed loops; otherwise fall back to a convex cap
    const used = loops.reduce((s, l) => s + l.length, 0);
    if (used < segs.length * 0.9) closedOk = false;
    if (closedOk) {
      const l2 = loops.map((l) => l.map(to2));
      const order = l2.map((l, i) => ({ i, a: Math.abs(area2(l)) })).sort((a, b) => b.a - a.a);
      const depth = new Array(loops.length).fill(0);
      const parent = new Array(loops.length).fill(-1);
      for (let x = 0; x < order.length; x++) {
        const li = order[x].i;
        for (let y = x - 1; y >= 0; y--) {
          const lj = order[y].i;
          if (inside2(l2[li][0], l2[lj])) {
            depth[li] = depth[lj] + 1;
            parent[li] = lj;
            break;
          }
        }
      }
      for (let li = 0; li < loops.length; li++) {
        if (depth[li] % 2) continue;
        const holesIdx = loops.map((_, i) => i).filter((i) => parent[i] === li && depth[i] % 2 === 1);
        const contour = l2[li];
        const holes = holesIdx.map((i) => l2[i]);
        const all3 = [...loops[li], ...holesIdx.flatMap((i) => loops[i])];
        let faces: number[][] = [];
        try {
          faces = THREE.ShapeUtils.triangulateShape(contour, holes);
        } catch {
          faces = [];
        }
        for (const f of faces) pushCap(all3[f[0]], all3[f[1]], all3[f[2]]);
        rims.push(loops[li], ...holesIdx.map((i) => loops[i]));
      }
    } else if (segs.length) {
      const pts = segs.flat();
      const h = hull2(pts.map(to2));
      const back = (q: THREE.Vector2) => new THREE.Vector3().addScaledVector(t1, q.x).addScaledVector(t2, q.y).addScaledVector(nv, d);
      const h3 = h.map(back);
      for (let i = 1; i + 1 < h3.length; i++) pushCap(h3[0], h3[i], h3[i + 1]);
      rims.push(h3);
      loops = [h3];
    }
    tris = out;
  }
  // assemble, grouped by material
  const byGroup = new Map<number, Tri[]>();
  for (const t of tris) {
    const arr = byGroup.get(t.g) ?? [];
    arr.push(t);
    byGroup.set(t.g, arr);
  }
  const P: number[] = [], N: number[] = [], U: number[] = [];
  const geo = new THREE.BufferGeometry();
  let start = 0;
  for (const g of [...byGroup.keys()].sort((a, b) => a - b)) {
    const list = byGroup.get(g)!;
    for (const t of list)
      for (const v of t.v) {
        P.push(v[0], v[1], v[2]);
        N.push(v[3], v[4], v[5]);
        U.push(v[6], v[7]);
      }
    geo.addGroup(start, list.length * 3, g);
    start += list.length * 3;
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  return { geometry: geo, rims };
}
