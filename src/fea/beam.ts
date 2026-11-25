// 3D Timoshenko frame element: local stiffness, geometric stiffness, transformations.
// DOF order per node: ux uy uz rx ry rz ; element = [node1(6), node2(6)].

export function beamLocalK(
  E: number, G: number, A: number, Iy: number, Iz: number, J: number, L: number,
  Asy: number, Asz: number, out = new Float64Array(144),
): Float64Array {
  out.fill(0);
  const k = (i: number, j: number, v: number) => {
    out[i * 12 + j] += v;
    if (i !== j) out[j * 12 + i] += v;
  };
  const phiY = (12 * E * Iz) / (G * Asy * L * L); // shear flexibility, bending in x-y plane
  const phiZ = (12 * E * Iy) / (G * Asz * L * L);
  const EA = (E * A) / L;
  const GJ = (G * J) / L;
  // axial
  k(0, 0, EA); k(6, 6, EA); k(0, 6, -EA);
  // torsion
  k(3, 3, GJ); k(9, 9, GJ); k(3, 9, -GJ);
  // bending in x-y plane (v, rz)
  {
    const c = (E * Iz) / (1 + phiY);
    const a = (12 * c) / L ** 3, b = (6 * c) / L ** 2, d1 = ((4 + phiY) * c) / L, d2 = ((2 - phiY) * c) / L;
    k(1, 1, a); k(7, 7, a); k(1, 7, -a);
    k(1, 5, b); k(1, 11, b); k(7, 5, -b); k(7, 11, -b);
    k(5, 5, d1); k(11, 11, d1); k(5, 11, d2);
  }
  // bending in x-z plane (w, ry)
  {
    const c = (E * Iy) / (1 + phiZ);
    const a = (12 * c) / L ** 3, b = (6 * c) / L ** 2, d1 = ((4 + phiZ) * c) / L, d2 = ((2 - phiZ) * c) / L;
    k(2, 2, a); k(8, 8, a); k(2, 8, -a);
    k(2, 4, -b); k(2, 10, -b); k(8, 4, b); k(8, 10, b);
    k(4, 4, d1); k(10, 10, d1); k(4, 10, d2);
  }
  return out;
}

/** Consistent geometric stiffness for axial force N (tension positive). */
export function beamLocalKG(N: number, L: number, A: number, Iy: number, Iz: number, out = new Float64Array(144)): Float64Array {
  out.fill(0);
  const k = (i: number, j: number, v: number) => {
    out[i * 12 + j] += v;
    if (i !== j) out[j * 12 + i] += v;
  };
  const a = (6 * N) / (5 * L), b = N / 10, c = (2 * N * L) / 15, d = -(N * L) / 30;
  // x-y plane
  k(1, 1, a); k(7, 7, a); k(1, 7, -a);
  k(1, 5, b); k(1, 11, b); k(7, 5, -b); k(7, 11, -b);
  k(5, 5, c); k(11, 11, c); k(5, 11, d);
  // x-z plane
  k(2, 2, a); k(8, 8, a); k(2, 8, -a);
  k(2, 4, -b); k(2, 10, -b); k(8, 4, b); k(8, 10, b);
  k(4, 4, c); k(10, 10, c); k(4, 10, d);
  // torsion (Wagner term, minor)
  const t = (N * (Iy + Iz)) / (A * L);
  k(3, 3, t); k(9, 9, t); k(3, 9, -t);
  return out;
}

/**
 * Transform a local 12x12 matrix to global: Kg = T^T Kl T with T = diag(R,R,R,R),
 * R rows = local axes (e1,e2,e3) expressed in global coordinates.
 */
export function toGlobal12(kl: Float64Array, R: Float64Array, out = new Float64Array(144)): Float64Array {
  const tmp = new Float64Array(9);
  for (let bi = 0; bi < 4; bi++)
    for (let bj = 0; bj < 4; bj++) {
      // block B = kl[bi,bj] (3x3); result = R^T B R
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          let s = 0;
          for (let m = 0; m < 3; m++) s += kl[(bi * 3 + i) * 12 + bj * 3 + m] * R[m * 3 + j];
          tmp[i * 3 + j] = s;
        }
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          let s = 0;
          for (let m = 0; m < 3; m++) s += R[m * 3 + i] * tmp[m * 3 + j];
          out[(bi * 3 + i) * 12 + bj * 3 + j] = s;
        }
    }
  return out;
}

/** global 12-vector -> local */
export function vecToLocal12(R: Float64Array, g: ArrayLike<number>, out = new Float64Array(12)): Float64Array {
  for (let b = 0; b < 4; b++)
    for (let i = 0; i < 3; i++) {
      let s = 0;
      for (let m = 0; m < 3; m++) s += R[i * 3 + m] * g[b * 3 + m];
      out[b * 3 + i] = s;
    }
  return out;
}

export function matVec12(K: Float64Array, x: ArrayLike<number>, out = new Float64Array(12)): Float64Array {
  for (let i = 0; i < 12; i++) {
    let s = 0;
    for (let j = 0; j < 12; j++) s += K[i * 12 + j] * x[j];
    out[i] = s;
  }
  return out;
}
