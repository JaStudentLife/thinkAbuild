import { describe, expect, it } from 'vitest';
import { detectContacts } from '../src/core/contacts';
import { aimCut, cutPart, cutterFor, ligament } from '../src/core/cut';
import { jointFor, pairKey, type Design, type PartDef } from '../src/core/design';
import { getMaterial } from '../src/core/materials';
import { lowestPoint, sdfLocal, surfaceArea, volume } from '../src/core/shapes';
import { analyzeStructure } from '../src/fea/structure';
import { PRESETS } from '../src/presets';

function part(kind: PartDef['kind'], size: [number, number, number], extra: Partial<PartDef> = {}): PartDef {
  return { id: 'p', name: 'Part', kind, size, pos: [0, 0, 0], quat: [0, 0, 0, 1], material: 'pine', ...extra };
}

const S = Math.SQRT1_2;

describe('cutting parts', () => {
  it('cross-cuts a leg into two plain boxes, minus the kerf', () => {
    const leg = part('box', [0.03, 0.75, 0.03]);
    const r = cutPart(leg, [0, 1, 0], 0.1, 0.0015)!;
    expect(r.neg.kind).toBe('box');
    expect(r.neg.cuts).toBeUndefined();
    expect(r.pos.cuts).toBeUndefined();
    expect(r.neg.size[1]).toBeCloseTo(0.375 + 0.1 - 0.00075, 9);
    expect(r.pos.size[1]).toBeCloseTo(0.375 - 0.1 - 0.00075, 9);
    expect(r.neg.pos[1]).toBeCloseTo((-0.375 + 0.09925) / 2, 9);
    expect(volume(r.neg) + volume(r.pos)).toBeCloseTo(0.03 * 0.03 * (0.75 - 0.0015), 9);
  });

  it('keeps the grain direction of the original', () => {
    const leg = part('box', [0.03, 0.75, 0.03]);
    const r = cutPart(leg, [0, 1, 0], 0.37, 0.0015)!;
    // a 4 mm "cookie" off the end: still end grain on its big faces
    expect(r.pos.size[1]).toBeLessThan(0.01);
    expect(r.pos.grain).toBe(1);
  });

  it('cuts a cube diagonally into two prisms of half the volume', () => {
    const cube = part('box', [0.2, 0.2, 0.2]);
    const r = cutPart(cube, [S, S, 0], 0, 0)!;
    expect(r.neg.cuts?.length).toBe(4);
    expect(volume(r.neg)).toBeGreaterThan(0.004 * 0.97);
    expect(volume(r.neg)).toBeLessThan(0.004 * 1.03);
    // the half that keeps x + y <= 0
    expect(sdfLocal(r.neg, 0.05, 0.05, 0)).toBeGreaterThan(0);
    expect(sdfLocal(r.neg, -0.05, -0.05, 0)).toBeLessThan(0);
    // surface: two triangles, two full squares, and the diagonal face (sampled on a coarse
    // 5 cm grid whose cell centres sit right on the diagonal, hence the loose tolerance)
    const expected = 2 * 0.02 + 2 * 0.04 + 0.2 * Math.SQRT2 * 0.2;
    expect(surfaceArea(r.neg)).toBeGreaterThan(expected * 0.93);
    expect(surfaceArea(r.neg)).toBeLessThan(expected * 1.07);
  });

  it('shrinks the bounding box to what is left after cutting a corner off', () => {
    const block = part('box', [0.4, 0.2, 0.2]);
    // cut off the +x end at 45 degrees
    const r = cutPart(block, [S, S, 0], 0.15 * S + 0.1 * S, 0)!;
    expect(r.pos.size[0]).toBeLessThan(0.2);
    expect(r.neg.size[0]).toBeCloseTo(0.4, 6);
    expect(r.neg.cuts?.length).toBe(4);
  });

  it('cuts cylinders square (plain cylinders) and lengthwise (cut planes)', () => {
    const rod = part('cylinder', [0.05, 0.6, 0.05]);
    const sq = cutPart(rod, [0, 1, 0], 0.2, 0.002)!;
    expect(sq.neg.kind).toBe('cylinder');
    expect(sq.neg.cuts).toBeUndefined();
    expect(sq.pos.size[1]).toBeCloseTo(0.3 - 0.2 - 0.001, 9);
    const rip = cutPart(rod, [1, 0, 0], 0, 0)!;
    const half = (Math.PI * 0.025 ** 2 * 0.6) / 2;
    expect(volume(rip.neg)).toBeGreaterThan(half * 0.96);
    expect(volume(rip.neg)).toBeLessThan(half * 1.04);
  });

  it('cuts tubes square into shorter tubes', () => {
    const pipe = part('tube', [0.04, 1, 0.04], { wall: 0.003 });
    const r = cutPart(pipe, [0, 1, 0], 0, 0.002)!;
    expect(r.neg.kind).toBe('tube');
    expect(r.neg.wall).toBe(0.003);
    expect(r.neg.size[1]).toBeCloseTo(0.499, 9);
  });

  it('halves a ball', () => {
    const ball = part('sphere', [0.2, 0.2, 0.2]);
    const r = cutPart(ball, [0, 1, 0], 0, 0)!;
    const half = ((4 / 3) * Math.PI * 0.1 ** 3) / 2;
    expect(volume(r.neg)).toBeGreaterThan(half * 0.96);
    expect(volume(r.neg)).toBeLessThan(half * 1.04);
    // the upper half now sits on its flat face
    const up = { ...r.pos, pos: [0, 0, 0] as [number, number, number] };
    expect(lowestPoint(up)).toBeCloseTo(0, 6);
  });

  it('refuses to cut when the plane misses the part', () => {
    const leg = part('box', [0.03, 0.75, 0.03]);
    expect(cutPart(leg, [0, 1, 0], 0.5, 0.0015)).toBeNull();
  });
});

describe('aiming the saw', () => {
  it('cross-cuts a leg when pointing at its side', () => {
    const leg = part('box', [0.03, 0.75, 0.03], { pos: [0, 0.375, 0] });
    const aim = aimCut(leg, [0.015, 0.3, 0], [1, 0, 0], { angle: 0, snap: 0.01, kerf: 0.0015 })!;
    expect(Math.abs(aim.n[1])).toBeCloseTo(1, 9);
    expect(aim.square).toBe(true);
    expect(aim.area).toBeCloseTo(0.0009, 6);
    expect(aim.depth).toBeCloseTo(0.03, 6);
    // snapped to whole centimetres from the end
    expect(Math.abs(aim.s * 100 - Math.round(aim.s * 100))).toBeLessThan(1e-6);
  });

  it('rips along the leg when turned 90 degrees', () => {
    const leg = part('box', [0.03, 0.75, 0.03], { pos: [0, 0.375, 0] });
    const aim = aimCut(leg, [0.015, 0.3, 0], [1, 0, 0], { angle: 90, snap: 0, kerf: 0.0015 })!;
    expect(Math.abs(aim.n[2])).toBeCloseTo(1, 9);
    expect(aim.area).toBeCloseTo(0.03 * 0.75, 4);
  });

  it('picks the right cutter for each material', () => {
    expect(cutterFor(getMaterial('pine')).kind).toBe('handsaw');
    expect(cutterFor(getMaterial('steel')).fx).toBe('sparks');
    expect(cutterFor(getMaterial('aluminum')).fx).toBe('shavings');
    expect(cutterFor(getMaterial('concrete')).kind).toBe('diamond');
    expect(cutterFor(getMaterial('glass')).kerf).toBe(0);
    expect(cutterFor(getMaterial('tglass')).refuse).toBeTruthy();
  });
});

describe('the ligament left while sawing', () => {
  it('shrinks from the full section to nothing as the blade advances', () => {
    const leg = part('box', [0.04, 0.75, 0.04]);
    const aim = aimCut(leg, [0.02, 0, 0], [1, 0, 0], { angle: 0, snap: 0, kerf: 0 })!;
    const qi = (v: number[]) => v as [number, number, number];
    const entry = qi(aim.entry), feed = qi(aim.feed);
    const full = ligament(leg, aim, feed, entry, aim.depth, 0, 2, 0);
    const half = ligament(leg, aim, feed, entry, aim.depth, 0.5, 2, 0);
    const done = ligament(leg, aim, feed, entry, aim.depth, 1, 2, 0);
    expect(full.A).toBeCloseTo(0.0016, 5);
    expect(half.A).toBeCloseTo(0.0008, 5);
    expect(done.A).toBeLessThan(1e-6);
    // sawing in from +x leaves material on the -x side
    expect(half.zc).toBeLessThan(-0.005);
  });
});

describe('a blow to a free-standing structure', () => {
  it('is resisted by the inertia of a glued-up table (not reported as a mechanism)', () => {
    const d = PRESETS.find((p) => p.id === 'pine-table')!.make();
    const patches = detectContacts(d.parts, { tol: 0.004 }).filter((p) => p.b !== 'ground');
    const leg = d.parts.find((p) => p.name === 'Leg 1')!;
    const at: [number, number, number] = [leg.pos[0], leg.pos[1], leg.pos[2] + leg.size[2] / 2];
    const res = analyzeStructure({
      parts: d.parts, jointOf: (a, b, bd) => jointFor(d, a, b, bd), patches,
      loads: [{ part: leg.id, point: at, force: [0, 0, -3000] }],
      probe: { part: leg.id, point: at, dir: [0, 0, -1] },
      inertiaRelief: true,
    });
    expect(res.status).not.toBe('unstable');
    // a 3 kN sideways blow knocks a butt-glued leg off its top
    expect(res.byPart.get(leg.id)!.mode).toBe('joint');
    // flexibility at the blow, relative to the table's own motion: a sensible spring
    expect(res.result.compliance).toBeGreaterThan(1e-6);
    expect(res.result.compliance).toBeLessThan(1e-3);
  });
});

describe('cut structures still make sense to the solver', () => {
  function cutLeg(d: Design, name: string, y: number): Design {
    const leg = d.parts.find((p) => p.name === name)!;
    const r = cutPart(leg, [0, 1, 0], y, 0.0015)!;
    const a: PartDef = { ...r.neg, id: leg.id };
    const b: PartDef = { ...r.pos, id: leg.id + '-top', name: leg.name + ' top' };
    d.parts = d.parts.flatMap((p) => (p.id === leg.id ? [a, b] : [p]));
    d.joints[pairKey(a.id, b.id)] = 'rest';
    for (const [k, v] of Object.entries(d.joints)) {
      const [x, z] = k.split('|');
      if (x === leg.id && z !== b.id) d.joints[pairKey(b.id, z)] = v;
      if (z === leg.id && x !== b.id) d.joints[pairKey(x, b.id)] = v;
    }
    return d;
  }

  it('a table with one leg sawn through (pieces resting on each other) still stands', () => {
    const d = PRESETS.find((p) => p.id === 'tungsten-steel')!.make();
    const leg = d.parts.find((p) => p.name.startsWith('Leg'))!;
    const yMid = leg.pos[1];
    const cut = cutLeg(d, leg.name, yMid);
    const res = analyzeStructure({ parts: cut.parts, jointOf: (a, b, bd) => jointFor(cut, a, b, bd) });
    expect(['ok', 'warn']).toContain(res.status);
  });
});
