// Symmetric skyline (profile) matrix with in-place LDL^T factorisation.
// Column j stores rows top[j]..j. Classic active-column solver (Bathe, COLSOL).

export class SkylineMatrix {
  readonly n: number;
  readonly top: Int32Array;
  readonly ptr: Int32Array; // start offset of each column
  vals: Float64Array;
  factored = false;
  /** DOFs whose pivot collapsed (mechanisms) and the forward-reduced load seen there */
  singular: number[] = [];
  private diag0: Float64Array;

  constructor(n: number, top: Int32Array) {
    this.n = n;
    this.top = top;
    this.ptr = new Int32Array(n + 1);
    let off = 0;
    for (let j = 0; j < n; j++) {
      this.ptr[j] = off;
      off += j - top[j] + 1;
    }
    this.ptr[n] = off;
    this.vals = new Float64Array(off);
    this.diag0 = new Float64Array(n);
  }

  get size(): number {
    return this.ptr[this.n];
  }

  /** add v to K(i,j) (and K(j,i)) */
  add(i: number, j: number, v: number): void {
    if (i > j) {
      const t = i;
      i = j;
      j = t;
    }
    const t = this.top[j];
    if (i < t) throw new Error(`skyline: (${i},${j}) outside profile (top ${t})`);
    this.vals[this.ptr[j] + i - t] += v;
  }

  get(i: number, j: number): number {
    if (i > j) {
      const t = i;
      i = j;
      j = t;
    }
    const t = this.top[j];
    if (i < t) return 0;
    return this.vals[this.ptr[j] + i - t];
  }

  clone(): SkylineMatrix {
    const m = new SkylineMatrix(this.n, this.top);
    m.vals.set(this.vals);
    return m;
  }

  diagonal(j: number): number {
    return this.vals[this.ptr[j + 1] - 1];
  }

  /**
   * In-place LDL^T. Pivots that collapse relative to their original diagonal are
   * recorded as singular (mechanism) and replaced by a tiny stiffness so the solve
   * can proceed; the caller inspects `singular`.
   */
  factor(relTol = 1e-10): void {
    const { n, top, ptr, vals } = this;
    let maxDiag = 0;
    for (let j = 0; j < n; j++) {
      const d = vals[ptr[j + 1] - 1];
      this.diag0[j] = d;
      if (d > maxDiag) maxDiag = d;
    }
    const absFloor = maxDiag * 1e-14 + 1e-30;
    this.singular = [];
    for (let j = 0; j < n; j++) {
      const tj = top[j];
      const pj = ptr[j];
      // reduce column j: g_ij = k_ij - sum_r L(i,r) g_rj
      for (let i = tj + 1; i < j; i++) {
        const ti = top[i];
        const r0 = ti > tj ? ti : tj;
        if (r0 >= i) continue;
        const pi = ptr[i];
        let s = 0;
        let a = pi + (r0 - ti);
        let b = pj + (r0 - tj);
        for (let r = r0; r < i; r++) s += vals[a++] * vals[b++];
        vals[pj + i - tj] -= s;
      }
      // L(j,i) = g_ij / d_i ; d_j = k_jj - sum L(j,i) g_ij
      let dj = vals[pj + j - tj];
      for (let i = tj; i < j; i++) {
        const g = vals[pj + i - tj];
        if (g === 0) continue;
        const l = g / vals[ptr[i + 1] - 1];
        vals[pj + i - tj] = l;
        dj -= l * g;
      }
      const d0 = this.diag0[j];
      if (!(dj > relTol * d0) || dj <= absFloor) {
        this.singular.push(j);
        dj = Math.max(d0, maxDiag * 1e-6, 1e-12) * 1e-12;
      }
      vals[pj + j - tj] = dj;
    }
    this.factored = true;
  }

  /** Solve K x = b using the factorisation. Optionally reports forward-reduced loads at singular pivots. */
  solve(b: Float64Array, out?: Float64Array, singularLoad?: Float64Array): Float64Array {
    const { n, top, ptr, vals } = this;
    const x = out ?? new Float64Array(n);
    if (x !== b) x.set(b);
    // forward: L y = b
    for (let j = 0; j < n; j++) {
      const tj = top[j];
      const pj = ptr[j];
      let s = 0;
      for (let r = tj; r < j; r++) s += vals[pj + r - tj] * x[r];
      x[j] -= s;
    }
    if (singularLoad) for (let k = 0; k < this.singular.length; k++) singularLoad[k] = x[this.singular[k]];
    // diagonal
    for (let j = 0; j < n; j++) x[j] /= vals[ptr[j + 1] - 1];
    // backward: L^T x = z
    for (let j = n - 1; j >= 0; j--) {
      const tj = top[j];
      const pj = ptr[j];
      const xj = x[j];
      if (xj === 0) continue;
      for (let r = tj; r < j; r++) x[r] -= vals[pj + r - tj] * xj;
    }
    return x;
  }
}

/**
 * Reverse Cuthill-McKee ordering of graph nodes to reduce the profile.
 * adj: adjacency lists. Returns perm[newIndex] = oldIndex and inv[oldIndex] = newIndex.
 */
export function rcmOrder(nNodes: number, adj: number[][]): { perm: Int32Array; inv: Int32Array } {
  const visited = new Uint8Array(nNodes);
  const order: number[] = [];
  const degree = adj.map((a) => a.length);
  const bfs = (start: number): number[] => {
    const comp: number[] = [start];
    visited[start] = 1;
    for (let h = 0; h < comp.length; h++) {
      const v = comp[h];
      const nb = adj[v].filter((w) => !visited[w]).sort((p, q) => degree[p] - degree[q]);
      for (const w of nb) {
        if (!visited[w]) {
          visited[w] = 1;
          comp.push(w);
        }
      }
    }
    return comp;
  };
  for (;;) {
    // pick the unvisited node of minimum degree as a pseudo-peripheral start
    let start = -1;
    for (let i = 0; i < nNodes; i++) if (!visited[i] && (start < 0 || degree[i] < degree[start])) start = i;
    if (start < 0) break;
    // one refinement pass: restart from the last node of a BFS
    const trial = bfs(start);
    for (const v of trial) visited[v] = 0;
    const far = trial[trial.length - 1];
    const comp = bfs(far);
    order.push(...comp);
  }
  order.reverse();
  const perm = Int32Array.from(order);
  const inv = new Int32Array(nNodes);
  for (let i = 0; i < nNodes; i++) inv[perm[i]] = i;
  return { perm, inv };
}
