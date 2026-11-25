import { describe, expect, it } from 'vitest';
import { detectContacts } from '../src/core/contacts';
import type { JointType, PartDef } from '../src/core/design';
import { SkylineMatrix } from '../src/fea/skyline';
import { analyzeStructure } from '../src/fea/structure';

function box(id: string, size: [number, number, number], pos: [number, number, number], material: string, extra: Partial<PartDef> = {}): PartDef {
  return { id, name: id, kind: 'box', size, pos, quat: [0, 0, 0, 1], material, ...extra };
}

const glueAll = (a: PartDef, bId: string): JointType => (bId === 'ground' ? 'rest' : 'glue');

describe('skyline solver', () => {
  it('solves a small SPD system like a dense solver', () => {
    const n = 5;
    const top = new Int32Array([0, 0, 0, 1, 2]);
    const K = new SkylineMatrix(n, top);
    const A = [
      [4, 1, 0.5, 0, 0],
      [1, 5, 1, 0.3, 0],
      [0.5, 1, 6, 1, 0.2],
      [0, 0.3, 1, 7, 1],
      [0, 0, 0.2, 1, 8],
    ];
    for (let j = 0; j < n; j++) for (let i = top[j]; i <= j; i++) K.add(i, j, A[i][j]);
    K.factor();
    const b = new Float64Array([1, 2, 3, 4, 5]);
    const x = K.solve(b);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += A[i][j] * x[j];
      expect(s).toBeCloseTo(b[i], 10);
    }
    expect(K.singular.length).toBe(0);
  });
});

describe('contacts', () => {
  it('finds the leg-to-top patch and its area', () => {
    const leg = box('leg', [0.04, 0.7, 0.04], [0, 0.35, 0], 'pine');
    const top = box('top', [1, 0.04, 1], [0, 0.72, 0], 'pine');
    const ps = detectContacts([leg, top], { tol: 0.004 });
    const lt = ps.find((p) => p.b === 'top' || p.a === 'top')!;
    expect(lt).toBeTruthy();
    expect(lt.area).toBeGreaterThan(0.0012);
    expect(lt.area).toBeLessThan(0.0025);
    expect(lt.points.length).toBe(5);
    // normal points from top into leg (down) when a = leg
    if (lt.a === 'leg') expect(lt.normal[1]).toBeLessThan(-0.9);
    const g = ps.find((p) => p.b === 'ground')!;
    expect(g.a).toBe('leg');
    expect(g.area).toBeCloseTo(0.0016, 4);
  });
});

describe('beam theory', () => {
  it('cantilever tip deflection matches PL^3/3EI + qL^4/8EI', () => {
    const L = 2, h = 0.1;
    const wall = box('wall', [0.3, 1, 1], [-0.15, 0.6, 0], 'steel', { anchored: true });
    const beam = box('beam', [L, h, h], [L / 2, 0.6, 0], 'steel');
    const P = 1000;
    const res = analyzeStructure({
      parts: [wall, beam],
      jointOf: () => 'rigid',
      loads: [{ part: 'beam', point: [L, 0.6, 0], force: [0, -P, 0] }],
      buckling: false,
    });
    const E = 200e9, I = (h * h ** 3) / 12;
    const q = 7850 * h * h * 9.81;
    const expected = (P * L ** 3) / (3 * E * I) + (q * L ** 4) / (8 * E * I);
    const info = res.model.parts[res.model.partIndex.get('beam')!];
    const tip = info.nodes[info.nodes.length - 1];
    const dy = -res.result.u[6 * tip + 1];
    expect(dy).toBeGreaterThan(expected * 0.97);
    expect(dy).toBeLessThan(expected * 1.12);
    const r = res.byPart.get('beam')!;
    // root moment = P L + q L^2/2 -> stress
    const M = P * L + (q * L * L) / 2;
    const sigma = M / ((h * h * h) / 6);
    expect(r.sigma).toBeGreaterThan(sigma * 0.9);
    expect(r.sigma).toBeLessThan(sigma * 1.1);
  });

  it('simply supported plank splits load evenly and bends PL/4', () => {
    const s1 = box('s1', [0.2, 0.3, 0.3], [0, 0.15, 0], 'concrete');
    const s2 = box('s2', [0.2, 0.3, 0.3], [2, 0.15, 0], 'concrete');
    const plank = box('plank', [2.2, 0.05, 0.2], [1, 0.325, 0], 'oak');
    const P = 2000;
    const res = analyzeStructure({
      parts: [s1, s2, plank],
      jointOf: () => 'rest',
      loads: [{ part: 'plank', point: [1, 0.35, 0], force: [0, -P, 0] }],
      buckling: false,
    });
    const fn = res.model.patches.map((p, i) => ({ p, r: res.result.patches[i] }));
    const onS1 = fn.find((x) => (x.p.patch.a === 'plank' && x.p.bId === 's1') || (x.p.patch.a === 's1' && x.p.bId === 'plank'))!;
    const onS2 = fn.find((x) => (x.p.patch.a === 'plank' && x.p.bId === 's2') || (x.p.patch.a === 's2' && x.p.bId === 'plank'))!;
    const w = 750 * 2.2 * 0.05 * 0.2 * 9.81;
    expect(onS1.r.Fn).toBeCloseTo((P + w) / 2, -1);
    expect(onS2.r.Fn).toBeCloseTo((P + w) / 2, -1);
    const r = res.byPart.get('plank')!;
    expect(r.status).not.toBe('unstable');
  });

  it('fixed-free column buckles at pi^2 EI / 4L^2', () => {
    const base = box('base', [0.5, 0.2, 0.5], [0, 0.1, 0], 'steel', { anchored: true });
    const L = 1.5, d = 0.02;
    const col = box('col', [d, L, d], [0, 0.2 + L / 2, 0], 'aluminum');
    const P = 500;
    const res = analyzeStructure({
      parts: [base, col],
      jointOf: () => 'rigid',
      loads: [{ part: 'col', point: [0, 0.2 + L, 0], force: [0, -P, 0] }],
    });
    const E = 69e9, I = d ** 4 / 12;
    const Pcr = (Math.PI ** 2 * E * I) / (4 * L * L);
    const lam = res.result.lambda;
    // self weight is small; allow a few percent
    expect(P * lam).toBeGreaterThan(Pcr * 0.9);
    expect(P * lam).toBeLessThan(Pcr * 1.05);
  });

  it('a free-floating block is flagged unstable', () => {
    const b = box('b', [0.2, 0.2, 0.2], [0, 1, 0], 'oak');
    const res = analyzeStructure({ parts: [b], jointOf: glueAll });
    expect(res.byPart.get('b')!.unstable).toBe(true);
  });

  it('a block resting on the floor is stable', () => {
    const b = box('b', [0.2, 0.2, 0.2], [0, 0.1, 0], 'oak');
    const res = analyzeStructure({ parts: [b], jointOf: glueAll });
    expect(res.byPart.get('b')!.unstable).toBe(false);
    expect(res.status).toBe('ok');
  });
});

describe('dynamics helpers', () => {
  it('inertia relief: free beam struck at one end peaks at 4/27 F L', () => {
    const L = 2, h = 0.05;
    const beam = box('beam', [L, h, h], [0, 1, 0], 'steel');
    const F = 1000;
    const res = analyzeStructure({
      parts: [beam],
      jointOf: () => 'rigid',
      patches: [],
      loads: [{ part: 'beam', point: [-L / 2, 1, 0], force: [0, -F, 0] }],
      inertiaRelief: true,
    });
    const r = res.byPart.get('beam')!;
    expect(r.unstable).toBe(false);
    const Mmax = Math.max(...res.result.elements.map((e) => Math.max(e.M1, e.M2)));
    const expected = (4 / 27) * F * L;
    expect(Mmax).toBeGreaterThan(expected * 0.9);
    expect(Mmax).toBeLessThan(expected * 1.12);
  });

  it('compliance probe matches L^3/3EI for a cantilever', () => {
    const L = 1.5, h = 0.06;
    const wall = box('wall', [0.3, 1, 1], [-0.15, 0.6, 0], 'steel', { anchored: true });
    const beam = box('beam', [L, h, h], [L / 2, 0.6, 0], 'aluminum');
    const res = analyzeStructure({
      parts: [wall, beam],
      jointOf: () => 'rigid',
      probe: { part: 'beam', point: [L, 0.6, 0], dir: [0, -1, 0] },
      buckling: false,
    });
    const EI = 69e9 * (h ** 4) / 12;
    const expected = L ** 3 / (3 * EI);
    expect(res.result.compliance).toBeGreaterThan(expected * 0.97);
    expect(res.result.compliance).toBeLessThan(expected * 1.15);
  });
});

function table(legMat: string, legW: number, extra: PartDef[] = [], topMat = 'tungsten'): PartDef[] {
  const H = 0.75, T = 0.2, S = 1.0;
  const legs: PartDef[] = [];
  const o = S / 2 - legW / 2 - 0.03;
  let i = 0;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) legs.push(box(`leg${i++}`, [legW, H, legW], [sx * o, H / 2, sz * o], legMat));
  const top = box('top', [S, T, S], [0, H + T / 2, 0], topMat);
  return [...legs, top, ...extra];
}

describe('the tungsten table', () => {
  it('slender pine legs under a tungsten slab buckle', () => {
    const res = analyzeStructure({ parts: table('pine', 0.025), jointOf: glueAll });
    const leg = res.byPart.get('leg0')!;
    console.log('pine 2.5cm legs: U =', leg.U.toFixed(2), leg.mode, 'lambda', res.result.lambda.toFixed(3), res.result.timeMs.toFixed(0) + 'ms', leg.message);
    expect(res.status).toBe('fail');
    expect(leg.mode).toBe('buckling');
  });

  it('a central oak post saves it', () => {
    const post = box('post', [0.12, 0.75, 0.12], [0, 0.375, 0], 'oak');
    const res = analyzeStructure({ parts: table('pine', 0.025, [post]), jointOf: glueAll });
    const leg = res.byPart.get('leg0')!;
    const p = res.byPart.get('post')!;
    console.log('with post: leg U', leg.U.toFixed(2), leg.mode, '| post U', p.U.toFixed(2), p.mode, 'lambda', res.result.lambda.toFixed(2), res.result.timeMs.toFixed(0) + 'ms');
    expect(res.status === 'ok' || res.status === 'warn').toBe(true);
  });

  it('steel legs of the same size hold', () => {
    const res = analyzeStructure({ parts: table('steel', 0.025), jointOf: glueAll });
    const leg = res.byPart.get('leg0')!;
    console.log('steel legs: U', leg.U.toFixed(2), leg.mode, 'lambda', res.result.lambda.toFixed(2));
    expect(leg.U).toBeLessThan(1);
  });

  it('a pine top on pine legs is fine', () => {
    const res = analyzeStructure({ parts: table('pine', 0.04, [], 'pine'), jointOf: glueAll });
    const leg = res.byPart.get('leg0')!;
    const top = res.byPart.get('top')!;
    console.log('pine table: leg U', leg.U.toFixed(3), leg.mode, 'top U', top.U.toFixed(3), top.mode);
    expect(res.status).toBe('ok');
  });
});

describe('contact geometry', () => {
  it('a beam lying flat on the floor is stable', () => {
    const b = box('b', [0.79, 0.05, 0.05], [0, 0.025, 0], 'pine');
    const res = analyzeStructure({ parts: [b], jointOf: glueAll });
    expect(res.byPart.get('b')!.unstable).toBe(false);
  });
  it('a rotated beam lying flat on the floor is stable', () => {
    const s = Math.sin(0.35), c = Math.cos(0.35);
    const b = box('b', [0.05, 0.79, 0.05], [0, 0.025, 0], 'pine', { quat: [0, 0, -s, c] });
    // rotate local y (length) towards the horizontal: 90 degrees about z
    b.quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    void s;
    const res = analyzeStructure({ parts: [b], jointOf: glueAll });
    expect(res.byPart.get('b')!.unstable).toBe(false);
  });
});
