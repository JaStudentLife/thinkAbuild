import type { JointType } from './design';
import type { Material } from './materials';

export interface JointCapacity {
  /** total tensile (pull-apart) capacity of the connection, N */
  tension: number;
  /** total shear (sliding) capacity, N */
  shear: number;
  /** effective type after fallbacks (weld on wood -> glue) */
  type: JointType;
  /** number of fasteners, if any */
  fasteners?: number;
}

const MPa = 1e6;

function weakTension(m: Material): number {
  // glue fails in the weaker substrate across its grain (wood) or at the glue line
  return m.grain ? m.ftPerp ?? m.ft * 0.05 : m.ft;
}

/** Capacity of a joint over a contact patch of `area` m^2 between materials a and b. */
export function jointCapacity(type: JointType, area: number, a: Material, b: Material): JointCapacity {
  switch (type) {
    case 'rest':
      return { tension: 0, shear: Infinity, type };
    case 'rigid':
      return { tension: Infinity, shear: Infinity, type };
    case 'glue': {
      const ft = Math.min(3 * MPa, weakTension(a), weakTension(b));
      const fv = Math.min(6 * MPa, a.fv, b.fv);
      return { tension: ft * area, shear: fv * area, type };
    }
    case 'screw': {
      const n = Math.max(2, Math.min(12, Math.round(area / 25e-4)));
      const mf = materialFactor(a, b);
      return { tension: n * 1500 * mf, shear: n * 2200 * mf, type, fasteners: n };
    }
    case 'bolt': {
      const n = Math.max(1, Math.min(8, Math.round(area / 0.01)));
      const mf = materialFactor(a, b);
      return { tension: n * 25000 * mf, shear: n * 18000 * mf, type, fasteners: n };
    }
    case 'weld': {
      const metalA = a.category === 'Metal';
      const metalB = b.category === 'Metal';
      if (!metalA || !metalB) return jointCapacity('glue', area, a, b);
      const fu = Math.min(a.fu ?? a.ft, b.fu ?? b.ft);
      const cap = 0.35 * fu * area;
      return { tension: cap, shear: cap, type };
    }
  }
}

/** Fasteners in soft or brittle materials hold far less. */
function materialFactor(a: Material, b: Material): number {
  const ft = Math.min(a.ft, b.ft);
  return Math.max(0.03, Math.min(1, ft / 20e6));
}
