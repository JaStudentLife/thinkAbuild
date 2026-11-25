// Cross-section properties for frame elements.
// Local element frame: x' = member axis, y' and z' = section principal axes.
// dy = section depth along y', dz = depth along z'.

export type SectionShape = 'rect' | 'circle' | 'tube' | 'strip';

export interface Section {
  shape: SectionShape;
  dy: number;
  dz: number;
  A: number;
  Iy: number; // about y' (bending that bows along z')
  Iz: number; // about z' (bending that bows along y')
  J: number;
  Asy: number; // shear area for shear along y'
  Asz: number;
  Wy: number; // elastic section modulus for My
  Wz: number; // for Mz
  Wt: number; // torsional section modulus (tau = T / Wt)
  kv: number; // peak / average shear stress
  plastic: number; // plastic / elastic modulus ratio
  /** smallest radius of gyration */
  rmin: number;
}

export function rectSection(dy: number, dz: number): Section {
  const A = dy * dz;
  const Iz = (dz * dy ** 3) / 12;
  const Iy = (dy * dz ** 3) / 12;
  const l = Math.max(dy, dz), s = Math.min(dy, dz);
  const beta = 1 / 3 - 0.21 * (s / l) * (1 - (s / l) ** 4 / 12);
  const J = beta * l * s ** 3;
  return {
    shape: 'rect', dy, dz, A, Iy, Iz, J,
    Asy: (5 / 6) * A, Asz: (5 / 6) * A,
    Wy: Iy / (dz / 2), Wz: Iz / (dy / 2),
    Wt: J / s,
    kv: 1.5, plastic: 1.5,
    rmin: Math.sqrt(Math.min(Iy, Iz) / A),
  };
}

/** grillage strip of a plate: width w (along y'), thickness t (along z') */
export function stripSection(w: number, t: number): Section {
  const s = rectSection(w, t);
  s.shape = 'strip';
  // grillage analogy: torsional rigidity per unit width G t^3 / 6
  s.J = (w * t ** 3) / 6;
  s.Wt = (w * t ** 2) / 6;
  return s;
}

export function circleSection(d: number): Section {
  const r = d / 2;
  const A = Math.PI * r * r;
  const I = (Math.PI * r ** 4) / 4;
  return {
    shape: 'circle', dy: d, dz: d, A, Iy: I, Iz: I, J: 2 * I,
    Asy: 0.9 * A, Asz: 0.9 * A,
    Wy: I / r, Wz: I / r, Wt: (2 * I) / r,
    kv: 4 / 3, plastic: 1.7,
    rmin: Math.sqrt(I / A),
  };
}

export function tubeSection(d: number, wall: number): Section {
  const ro = d / 2;
  const ri = Math.max(0, ro - wall);
  const A = Math.PI * (ro * ro - ri * ri);
  const I = (Math.PI * (ro ** 4 - ri ** 4)) / 4;
  return {
    shape: 'tube', dy: d, dz: d, A, Iy: I, Iz: I, J: 2 * I,
    Asy: 0.5 * A, Asz: 0.5 * A,
    Wy: I / ro, Wz: I / ro, Wt: (2 * I) / ro,
    kv: 2, plastic: 1.3,
    rmin: Math.sqrt(I / A),
  };
}
