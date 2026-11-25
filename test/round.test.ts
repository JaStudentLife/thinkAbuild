import { describe, expect, it } from 'vitest';
import { cutPart } from '../src/core/cut';
import { jointFor, type Design, type PartDef } from '../src/core/design';
import { geomOf, nearestEdge, roundProject, sectionFactors, withEdge } from '../src/core/rounding';
import { clippedPolytope, lowestPoint, sdfLocal, surfaceArea, volume } from '../src/core/shapes';
import { analyzeStructure } from '../src/fea/structure';
import { PRESETS } from '../src/presets';

function part(kind: PartDef['kind'], size: [number, number, number], extra: Partial<PartDef> = {}): PartDef {
  return { id: 'p', name: 'Part', kind, size, pos: [0, 0, 0], quat: [0, 0, 0, 1], material: 'oak', ...extra };
}

const near = (v: number, want: number, tol: number) => {
  expect(v).toBeGreaterThan(want * (1 - tol));
  expect(v).toBeLessThan(want * (1 + tol));
};

describe('rounded edges', () => {
  it('rounding all four corners of a square top fully makes a disc', () => {
    const top = part('box', [1, 0.04, 1], { edge: { up: 1, corners: [0.5, 0.5, 0.5, 0.5] } });
    near(volume(top), Math.PI * 0.25 * 0.04, 0.03);
    near(surfaceArea(top), 2 * Math.PI * 0.25 + 2 * Math.PI * 0.5 * 0.04, 0.06);
    // the corner of the old square is gone, the edge midpoint is still there
    expect(sdfLocal(top, 0.45, 0, 0.45)).toBeGreaterThan(0);
    expect(sdfLocal(top, 0.49, 0, 0)).toBeLessThan(0);
  });

  it('rounds over the top rim of a block, following the outline', () => {
    const r = 0.05;
    const block = part('box', [0.2, 0.2, 0.2], { edge: { up: 1, top: r } });
    // the top edge is rounded away, the bottom edge is still square
    expect(sdfLocal(block, 0.099, 0.099, 0)).toBeGreaterThan(0);
    expect(sdfLocal(block, 0.099, -0.099, 0)).toBeLessThan(0);
    // removed: a quarter-round strip along four edges (corners overlap a little)
    const removed = 4 * 0.2 * (r * r - (Math.PI * r * r) / 4);
    const v = volume(block);
    expect(v).toBeLessThan(0.008 - removed * 0.8);
    expect(v).toBeGreaterThan(0.008 - removed * 1.2);
    // it still sits flat on its bottom
    expect(lowestPoint({ ...block, pos: [0, 0.1, 0] })).toBeCloseTo(0, 6);
  });

  it('bevels: a 45° chamfer removes a triangular strip', () => {
    const c = 0.02;
    const block = part('box', [0.2, 0.1, 0.2], { edge: { up: 1, top: -c } });
    const removed = 4 * 0.2 * (c * c) / 2;
    near(0.2 * 0.1 * 0.2 - volume(block), removed, 0.25);
  });

  it('projects a box surface onto the rounded surface', () => {
    const top = part('box', [1, 0.04, 1], { edge: { up: 1, corners: [0.2, 0.2, 0.2, 0.2], top: 0.01 } });
    const g = geomOf(top);
    const q = [0, 0, 0], n = [0, 0, 0];
    roundProject(g, [0.5, 0, 0.5], q, n);
    expect(Math.abs(sdfLocal(top, q[0], q[1], q[2]))).toBeLessThan(1e-6);
    // a corner point lands on the corner arc, facing diagonally outwards
    expect(n[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(n[2]).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('keeps physics hulls and bounds inside the original box', () => {
    const p = part('box', [0.6, 0.05, 0.4], { edge: { up: 1, corners: [0.1, 0, 0.1, 0], top: 0.02, bottom: -0.01 } });
    const P = clippedPolytope(p);
    for (let i = 0; i < P.v.length; i += 3) {
      expect(Math.abs(P.v[i])).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(Math.abs(P.v[i + 1])).toBeLessThanOrEqual(0.025 + 1e-9);
      expect(Math.abs(P.v[i + 2])).toBeLessThanOrEqual(0.2 + 1e-9);
      expect(sdfLocal(p, P.v[i], P.v[i + 1], P.v[i + 2])).toBeLessThan(2e-3);
    }
  });

  it('a fully rounded square section has the area and stiffness of a round one', () => {
    const leg = part('box', [0.04, 0.75, 0.04], { edge: { up: 1, corners: [0.02, 0.02, 0.02, 0.02] } });
    const f = sectionFactors(geomOf(leg));
    near(f.kA, Math.PI / 4, 0.02);
    near(f.kIu, (3 * Math.PI) / 16, 0.03);
  });

  it('picks corner and rim edges, and edits them', () => {
    const top = part('box', [1, 0.04, 0.8]);
    const c = nearestEdge(top, [0.49, 0, 0.39]);
    expect(c.target).toEqual({ kind: 'corner', index: 3 });
    const r = nearestEdge(top, [0.2, 0.02, 0.39]);
    expect(r.target).toEqual({ kind: 'rim', side: 'top' });
    const e = withEdge(top, c.target, c.up, 0.1, true);
    expect(e.corners).toEqual([0.1, 0.1, 0.1, 0.1]);
  });

  it('a rounded top sawn in half keeps its rounded corners and gets a square cut', () => {
    const top = part('box', [1, 0.04, 1], { edge: { up: 1, corners: [0.5, 0.5, 0.5, 0.5] } });
    const halves = cutPart(top, [1, 0, 0], 0, 0)!;
    near(volume(halves.neg), (Math.PI * 0.25 * 0.04) / 2, 0.04);
    expect(halves.neg.edge?.corners).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe('rounded parts in the structural solver', () => {
  it('a table with rounded legs, corners and edges still stands, slightly weaker', () => {
    const base = PRESETS.find((p) => p.id === 'tungsten-steel')!.make();
    const d: Design = JSON.parse(JSON.stringify(base));
    for (const p of d.parts) {
      if (p.name.startsWith('Leg')) p.edge = { up: 1, corners: [0.006, 0.006, 0.006, 0.006] };
      else p.edge = { up: 1, corners: [0.1, 0.1, 0.1, 0.1], top: 0.01 };
    }
    const r0 = analyzeStructure({ parts: base.parts, jointOf: (a, b, bd) => jointFor(base, a, b, bd) });
    const r1 = analyzeStructure({ parts: d.parts, jointOf: (a, b, bd) => jointFor(d, a, b, bd) });
    expect(['ok', 'warn']).toContain(r1.status);
    // rounded legs lose a little section: a little more utilised
    const u0 = Math.max(...[...r0.byPart.values()].map((r) => r.U));
    const u1 = Math.max(...[...r1.byPart.values()].map((r) => r.U));
    expect(u1).toBeGreaterThan(u0 * 0.98);
    expect(u1).toBeLessThan(u0 * 1.4);
  });
});
