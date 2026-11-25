import type { Design, PartDef, QuatT } from './core/design';

let n = 0;
const id = () => `x${(n++).toString(36)}`;

function box(name: string, size: [number, number, number], pos: [number, number, number], material: string, extra: Partial<PartDef> = {}): PartDef {
  return { id: id(), name, kind: 'box', size, pos, quat: [0, 0, 0, 1], material, ...extra };
}

function beamBetween(name: string, a: [number, number, number], b: [number, number, number], w: number, h: number, material: string, extend = 0): PartDef {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  const y = d.map((v) => v / L);
  // x = y cross up
  let x = [y[1] * 0 - y[2] * 1, y[2] * 0 - y[0] * 0, y[0] * 1 - y[1] * 0];
  let xl = Math.hypot(x[0], x[1], x[2]);
  if (xl < 1e-6) {
    x = [1, 0, 0];
    xl = 1;
  }
  x = x.map((v) => v / xl);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const q = quatFromMatrix(x, y, z);
  return {
    id: id(), name, kind: 'box', size: [w, L + 2 * extend, h],
    pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], quat: q, material,
  };
}

function quatFromMatrix(x: number[], y: number[], z: number[]): QuatT {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  return [qx, qy, qz, qw];
}

function design(name: string, parts: PartDef[], defaultJoint: Design['defaultJoint'] = 'glue'): Design {
  return { version: 1, name, parts, joints: {}, defaultJoint };
}

function table(opts: { legMat: string; legW: number; topMat: string; topT?: number; size?: number; H?: number }): PartDef[] {
  const H = opts.H ?? 0.75, T = opts.topT ?? 0.2, S = opts.size ?? 1.0;
  const o = S / 2 - opts.legW / 2 - 0.03;
  const parts: PartDef[] = [];
  let i = 1;
  for (const sz of [-1, 1])
    for (const sx of [-1, 1]) parts.push(box(`Leg ${i++}`, [opts.legW, H, opts.legW], [sx * o, H / 2, sz * o], opts.legMat));
  parts.push(box('Table top', [S, T, S], [0, H + T / 2, 0], opts.topMat));
  return parts;
}

export interface Preset {
  id: string;
  title: string;
  blurb: string;
  expect: 'fails' | 'holds';
  make: () => Design;
}

export const PRESETS: Preset[] = [
  {
    id: 'tungsten-pine',
    title: 'Tungsten slab on 4 pine legs',
    blurb: 'A 1 m × 1 m × 20 cm tungsten slab (3.9 t) on four 2.5 cm pine legs. Each leg must carry about 9.5 kN, but the frame sways sideways and buckles at about 4.8 kN.',
    expect: 'fails',
    make: () => design('Tungsten on pine legs', table({ legMat: 'pine', legW: 0.025, topMat: 'tungsten' })),
  },
  {
    id: 'tungsten-post',
    title: '… plus a centre oak post',
    blurb: 'The same slab with one 12 cm oak post under the middle. The stiff post takes most of the load and braces the frame, so it stands.',
    expect: 'holds',
    make: () =>
      design('Tungsten + oak post', [...table({ legMat: 'pine', legW: 0.025, topMat: 'tungsten' }), box('Oak post', [0.12, 0.75, 0.12], [0, 0.375, 0], 'oak')]),
  },
  {
    id: 'tungsten-braced',
    title: '… 3 cm legs + diagonal braces',
    blurb: 'On their own, 3 cm pine legs let the frame sway and buckle under 3.9 t. Four diagonal braces stop the sway, so the same legs hold at about 67%. Delete the braces and watch it fail.',
    expect: 'holds',
    make: () => {
      const parts = table({ legMat: 'pine', legW: 0.03, topMat: 'tungsten' });
      const o = 0.5 - 0.015 - 0.03;
      const w = 0.03;
      const lo = 0.06, hi = 0.7;
      let k = 1;
      // a diagonal brace in each side plane
      parts.push(beamBetween(`Brace ${k++}`, [-o, lo, -o], [o, hi, -o], w, w, 'pine', 0.012));
      parts.push(beamBetween(`Brace ${k++}`, [o, lo, o], [-o, hi, o], w, w, 'pine', 0.012));
      parts.push(beamBetween(`Brace ${k++}`, [-o, lo, o], [-o, hi, -o], w, w, 'pine', 0.012));
      parts.push(beamBetween(`Brace ${k++}`, [o, lo, -o], [o, hi, o], w, w, 'pine', 0.012));
      return design('Braced table', parts);
    },
  },
  {
    id: 'tungsten-steel',
    title: 'Tungsten slab on steel legs',
    blurb: 'Same 2.5 cm legs, now in steel. Steel is 22× stiffer than pine, so the critical load rises roughly 20×. It holds comfortably.',
    expect: 'holds',
    make: () => design('Tungsten on steel legs', table({ legMat: 'steel', legW: 0.025, topMat: 'tungsten' })),
  },
  {
    id: 'pine-table',
    title: 'An ordinary pine table',
    blurb: 'A 4 cm thick pine top on 4 cm legs. Barely loaded, with a safety factor in the hundreds.',
    expect: 'holds',
    make: () => design('Pine table', table({ legMat: 'pine', legW: 0.045, topMat: 'plywood', topT: 0.03, size: 1.2 })),
  },
  {
    id: 'plank-bridge',
    title: 'Plank bridge with a tungsten cube',
    blurb: 'A 25 × 4 cm pine plank spans 2 m between concrete blocks with a 40 cm tungsten cube (1.2 t) in the middle. Bending stress exceeds the wood’s strength and it snaps.',
    expect: 'fails',
    make: () =>
      design(
        'Plank bridge',
        [
          box('Support A', [0.3, 0.4, 0.4], [-1.0, 0.2, 0], 'concrete'),
          box('Support B', [0.3, 0.4, 0.4], [1.0, 0.2, 0], 'concrete'),
          box('Plank', [2.3, 0.04, 0.25], [0, 0.42, 0], 'pine'),
          box('Tungsten cube', [0.4, 0.4, 0.4], [0, 0.44 + 0.2, 0], 'tungsten'),
        ],
        'rest',
      ),
  },
  {
    id: 'glass-shelf',
    title: 'Glass shelf and a lead block',
    blurb: 'A 1 cm annealed glass shelf spanning 80 cm between brick piers, with a 25 cm lead block (177 kg) on it. Glass is weak in tension and shatters.',
    expect: 'fails',
    make: () =>
      design(
        'Glass shelf',
        [
          box('Pier A', [0.2, 0.6, 0.3], [-0.5, 0.3, 0], 'brick'),
          box('Pier B', [0.2, 0.6, 0.3], [0.5, 0.3, 0], 'brick'),
          box('Glass shelf', [1.2, 0.01, 0.3], [0, 0.605, 0], 'glass'),
          box('Lead block', [0.25, 0.25, 0.25], [0, 0.61 + 0.125, 0], 'lead'),
        ],
        'rest',
      ),
  },
  {
    id: 'concrete-beams',
    title: 'Plain vs reinforced concrete beam',
    blurb: 'Two 15 cm concrete beams span 7 m. The plain one cracks under its own weight because concrete has almost no tensile strength. The reinforced one is fine.',
    expect: 'fails',
    make: () =>
      design(
        'Concrete beams',
        [
          box('Pier 1', [0.4, 0.5, 1.2], [-3.6, 0.25, 0], 'brick'),
          box('Pier 2', [0.4, 0.5, 1.2], [3.6, 0.25, 0], 'brick'),
          box('Plain concrete beam', [7.5, 0.15, 0.15], [0, 0.575, -0.35], 'concrete'),
          box('Reinforced beam', [7.5, 0.15, 0.15], [0, 0.575, 0.35], 'rconcrete'),
        ],
        'rest',
      ),
  },
  {
    id: 'foam',
    title: 'Tungsten cube on a foam column',
    blurb: 'A 30 cm tungsten cube (520 kg) on a 10 cm styrofoam column. That is 510 kPa on foam rated for about 150 kPa, so it crushes.',
    expect: 'fails',
    make: () =>
      design(
        'Foam column',
        [box('Foam column', [0.1, 0.4, 0.1], [0, 0.2, 0], 'foam'), box('Tungsten cube', [0.3, 0.3, 0.3], [0, 0.55, 0], 'tungsten')],
        'rest',
      ),
  },
  {
    id: 'tower',
    title: 'Stacked block tower',
    blurb: 'Loose oak blocks stacked in alternating layers. It stands; run the simulation and throw a ball at it.',
    expect: 'holds',
    make: () => {
      const parts: PartDef[] = [];
      const bw = 0.075, bh = 0.045, bl = 0.225;
      for (let layer = 0; layer < 12; layer++) {
        for (let i = -1; i <= 1; i++) {
          const y = bh / 2 + layer * bh;
          if (layer % 2 === 0) parts.push(box(`Block ${layer}-${i + 2}`, [bl, bh, bw], [0, y, i * bw], 'oak'));
          else parts.push(box(`Block ${layer}-${i + 2}`, [bw, bh, bl], [i * bw, y, 0], 'oak'));
        }
      }
      return design('Block tower', parts, 'rest');
    },
  },
];
