import * as THREE from 'three';
import type { Material } from '../core/materials';

// ------------------------------------------------------------------ tileable value noise

function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

/** periodic value noise; px, py = period in lattice cells */
function vnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = smooth(x - xi), fy = smooth(y - yi);
  const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(x: number, y: number, px: number, py: number, oct: number, seed: number): number {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    s += amp * vnoise(x * f, y * f, px * f, py * f, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

function hexToRgb(h: string): [number, number, number] {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mixc(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export interface TextureSet {
  map: THREE.Texture;
  bump?: THREE.Texture;
  rough?: THREE.Texture;
  /** metres covered by one tile [u, v] */
  world: [number, number];
  /** canvas for UI swatches */
  canvas: HTMLCanvasElement;
}

type Pixel = (u: number, v: number) => { c: [number, number, number]; h?: number; r?: number };

function makeCanvas(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function render(size: number, fn: Pixel, wantBump: boolean, wantRough: boolean, world: [number, number]): TextureSet {
  const cc = makeCanvas(size);
  const ctx = cc.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const bc = wantBump ? makeCanvas(size) : null;
  const bimg = bc ? bc.getContext('2d')!.createImageData(size, size) : null;
  const rc = wantRough ? makeCanvas(size) : null;
  const rimg = rc ? rc.getContext('2d')!.createImageData(size, size) : null;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = fn(x / size, y / size);
      const i = (y * size + x) * 4;
      img.data[i] = px.c[0];
      img.data[i + 1] = px.c[1];
      img.data[i + 2] = px.c[2];
      img.data[i + 3] = 255;
      if (bimg) {
        const h = Math.round(clamp01(px.h ?? 0.5) * 255);
        bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = h;
        bimg.data[i + 3] = 255;
      }
      if (rimg) {
        const r = Math.round(clamp01(px.r ?? 1) * 255);
        rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = r;
        rimg.data[i + 3] = 255;
      }
    }
  ctx.putImageData(img, 0, 0);
  const tex = (canvas: HTMLCanvasElement, color: boolean) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.repeat.set(1 / world[0], 1 / world[1]);
    t.needsUpdate = true;
    return t;
  };
  let bump: THREE.Texture | undefined, rough: THREE.Texture | undefined;
  if (bc && bimg) {
    bc.getContext('2d')!.putImageData(bimg, 0, 0);
    bump = tex(bc, false);
  }
  if (rc && rimg) {
    rc.getContext('2d')!.putImageData(rimg, 0, 0);
    rough = tex(rc, false);
  }
  return { map: tex(cc, true), bump, rough, world, canvas: cc };
}

// ------------------------------------------------------------------ generators

function woodSide(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color), c2 = hexToRgb(m.visual.color2 ?? m.visual.color);
  const rings = 9;
  return (u, v) => {
    const warp = fbm(u * 2, v * 3, 2, 3, 4, seed) * 2.2 + Math.sin(u * Math.PI * 2) * 0.15;
    const phase = v * rings + warp;
    const f = phase - Math.floor(phase);
    const late = Math.pow(f, 3.2);
    const fiber = vnoise(u * 160, v * 900, 160, 900, seed + 5);
    const mottle = fbm(u * 4, v * 4, 4, 4, 3, seed + 9);
    const t = clamp01(late * 0.75 + (fiber - 0.5) * 0.18 + (mottle - 0.5) * 0.25);
    const c = mixc(c1, c2, t);
    return { c, h: 0.5 - late * 0.35 + (fiber - 0.5) * 0.25, r: 0.75 + late * 0.15 };
  };
}

function woodEnd(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color), c2 = hexToRgb(m.visual.color2 ?? m.visual.color);
  const cl = mixc(c1, c2, 0.25);
  return (u, v) => {
    const dx = u - 0.5 + 0.9, dy = v - 0.5 - 0.6;
    const r = Math.hypot(dx, dy) * 26 + fbm(u * 3, v * 3, 3, 3, 3, seed) * 1.6;
    const f = r - Math.floor(r);
    const late = Math.pow(f, 4);
    const pores = vnoise(u * 300, v * 300, 300, 300, seed + 3);
    const c = mixc(cl, c2, clamp01(late * 0.8 + (pores - 0.5) * 0.25));
    return { c, h: 0.45 + (pores - 0.5) * 0.6 - late * 0.2, r: 0.85 };
  };
}

function plyEdge(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color), c2 = hexToRgb(m.visual.color2 ?? m.visual.color);
  return (u, v) => {
    const ply = Math.floor(v * 20);
    const shade = (ply % 2 === 0 ? 0.15 : 0.55) + (hash2(ply, 3, seed) - 0.5) * 0.2;
    const glue = Math.abs((v * 20) % 1 - 0.0) < 0.06 ? 0.9 : 0;
    const fiber = vnoise(u * 200, v * 400, 200, 400, seed);
    const c = mixc(c1, c2, clamp01(shade + glue * 0.4 + (fiber - 0.5) * 0.2));
    return { c, h: 0.5 - glue * 0.3, r: 0.8 };
  };
}

function bamboo(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color), c2 = hexToRgb(m.visual.color2 ?? m.visual.color);
  return (u, v) => {
    const strand = vnoise(u * 6, v * 120, 6, 120, seed);
    const node = Math.exp(-((((u * 2) % 1) - 0.5) ** 2) * 900);
    const c = mixc(c1, c2, clamp01((strand - 0.4) * 0.8 + node * 0.6));
    return { c, h: 0.5 + (strand - 0.5) * 0.4 - node * 0.3, r: 0.6 };
  };
}

function metal(m: Material, seed: number, brushed: boolean): Pixel {
  const c1 = hexToRgb(m.visual.color);
  const dark = mixc(c1, [0, 0, 0], 0.18);
  return (u, v) => {
    const n = brushed ? vnoise(u * 3, v * 700, 3, 700, seed) * 0.7 + vnoise(u * 40, v * 1400, 40, 1400, seed + 1) * 0.3 : fbm(u * 8, v * 8, 8, 8, 4, seed);
    const blotch = fbm(u * 3, v * 3, 3, 3, 3, seed + 7);
    const c = mixc(c1, dark, clamp01((n - 0.5) * 0.25 + (blotch - 0.5) * 0.08 + 0.08));
    return { c, h: 0.5 + (n - 0.5) * 0.15, r: clamp01(0.85 + (n - 0.5) * 0.3 + (blotch - 0.5) * 0.08) };
  };
}

function castIron(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color);
  return (u, v) => {
    const n = fbm(u * 24, v * 24, 24, 24, 5, seed);
    const rust = Math.max(0, fbm(u * 4, v * 4, 4, 4, 4, seed + 3) - 0.62) * 2.5;
    const c = mixc(mixc(c1, [20, 20, 22], (n - 0.5) * 0.8 + 0.2), [110, 60, 35], clamp01(rust));
    return { c, h: n, r: 0.9 };
  };
}

function concrete(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color), c2 = hexToRgb(m.visual.color2 ?? m.visual.color);
  return (u, v) => {
    const big = fbm(u * 3, v * 3, 3, 3, 4, seed);
    const fine = fbm(u * 64, v * 64, 64, 64, 3, seed + 2);
    const pore = vnoise(u * 180, v * 180, 180, 180, seed + 4);
    const isPore = pore > 0.9 ? (pore - 0.9) * 10 : 0;
    const t = clamp01((big - 0.5) * 0.9 + (fine - 0.5) * 0.5 + 0.35 + isPore * 0.6);
    const c = mixc(c1, c2, t);
    return { c, h: 0.55 + (fine - 0.5) * 0.4 - isPore * 0.6, r: 0.95 };
  };
}

function brick(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color), mortar = hexToRgb(m.visual.color2 ?? '#c9c2b4');
  // tile = 2 bricks wide (0.45 m) x 4 courses (0.3 m)
  return (u, v) => {
    const course = Math.floor(v * 4);
    const off = course % 2 === 0 ? 0 : 0.25;
    const bu = (u + off) * 2;
    const bi = Math.floor(bu);
    const fu = bu - bi, fv = v * 4 - course;
    const jointU = Math.min(fu, 1 - fu) * 0.225, jointV = Math.min(fv, 1 - fv) * 0.075;
    const isMortar = jointU < 0.005 || jointV < 0.005;
    if (isMortar) {
      const n = fbm(u * 60, v * 60, 60, 60, 2, seed);
      return { c: mixc(mortar, [90, 88, 82], n * 0.3), h: 0.2, r: 1 };
    }
    const tint = hash2(bi + course * 7, course, seed);
    const n = fbm(u * 40, v * 40, 40, 40, 3, seed + 1);
    const c = mixc(mixc(c1, [70, 30, 20], tint * 0.45), [210, 140, 110], (n - 0.5) * 0.5 + 0.1);
    return { c, h: 0.75 + (n - 0.5) * 0.3, r: 0.9 };
  };
}

function granite(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color), c2 = hexToRgb(m.visual.color2 ?? '#333333');
  return (u, v) => {
    const a = vnoise(u * 90, v * 90, 90, 90, seed);
    const b = vnoise(u * 140, v * 140, 140, 140, seed + 1);
    let c = c1;
    if (a > 0.72) c = c2;
    else if (b > 0.8) c = [225, 220, 214];
    else if (a < 0.18) c = [150, 120, 110];
    c = mixc(c, [128, 128, 128], fbm(u * 6, v * 6, 6, 6, 3, seed + 2) * 0.2);
    return { c, h: 0.5, r: 0.45 };
  };
}

function marble(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color), c2 = hexToRgb(m.visual.color2 ?? '#999999');
  return (u, v) => {
    const t = fbm(u * 4, v * 4, 4, 4, 6, seed) * 7;
    const vein = Math.pow(1 - Math.abs(Math.sin((u + v) * Math.PI * 3 + t)), 12);
    const c = mixc(c1, c2, clamp01(vein * 0.8 + fbm(u * 20, v * 20, 20, 20, 2, seed + 1) * 0.08));
    return { c, h: 0.5, r: 0.3 + vein * 0.2 };
  };
}

function plain(m: Material, seed: number, amount = 0.04): Pixel {
  const c1 = hexToRgb(m.visual.color);
  return (u, v) => {
    const n = fbm(u * 30, v * 30, 30, 30, 3, seed);
    return { c: mixc(c1, [0, 0, 0], (n - 0.5) * amount + amount / 2), h: 0.5 + (n - 0.5) * 0.1, r: 0.8 + (n - 0.5) * 0.3 };
  };
}

function carbon(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color);
  return (u, v) => {
    const cells = 24;
    const cu = Math.floor(u * cells), cv = Math.floor(v * cells);
    const twill = ((cu + cv) >> 1) % 2 === 0;
    const fu = u * cells - cu, fv = v * cells - cv;
    const along = twill ? fu : fv;
    const sheen = 0.5 + 0.5 * Math.sin(along * Math.PI);
    const n = vnoise(u * 300, v * 300, 300, 300, seed);
    const c = mixc(c1, [70, 72, 76], clamp01(sheen * 0.35 + (n - 0.5) * 0.1));
    return { c, h: sheen * 0.6, r: 0.35 + (1 - sheen) * 0.2 };
  };
}

function foam(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color);
  const N = 40;
  return (u, v) => {
    // cellular noise: distance to nearest bead centre
    const gx = Math.floor(u * N), gy = Math.floor(v * N);
    let d1 = 9;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const cx = gx + ox, cy = gy + oy;
        const wx = ((cx % N) + N) % N, wy = ((cy % N) + N) % N;
        const px = cx + hash2(wx, wy, seed), py = cy + hash2(wx, wy, seed + 1);
        d1 = Math.min(d1, Math.hypot(u * N - px, v * N - py));
      }
    const rim = clamp01(d1 * 1.6);
    const c = mixc(c1, [200, 200, 192], rim * 0.35);
    return { c, h: 1 - rim * 0.6, r: 1 };
  };
}

function ice(m: Material, seed: number): Pixel {
  const c1 = hexToRgb(m.visual.color);
  return (u, v) => {
    const cloud = fbm(u * 5, v * 5, 5, 5, 5, seed);
    const bub = vnoise(u * 120, v * 120, 120, 120, seed + 3) > 0.93 ? 1 : 0;
    const c = mixc(c1, [255, 255, 255], clamp01((cloud - 0.45) * 0.8 + bub * 0.7));
    return { c, h: 0.5 + (cloud - 0.5) * 0.3, r: 0.1 + cloud * 0.25 };
  };
}

// ------------------------------------------------------------------ public

export interface MaterialTextures {
  side: TextureSet | null;
  end: TextureSet | null;
  edge: TextureSet | null;
}

const cache = new Map<string, MaterialTextures>();

function seedOf(id: string) {
  let s = 7;
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(s) % 10007;
}

export function texturesFor(m: Material): MaterialTextures {
  const hit = cache.get(m.id);
  if (hit) return hit;
  const seed = seedOf(m.id);
  const S = 512;
  let side: TextureSet | null = null, end: TextureSet | null = null, edge: TextureSet | null = null;
  switch (m.visual.texture) {
    case 'wood':
      side = render(S, woodSide(m, seed), true, true, [0.9, 0.3]);
      end = render(256, woodEnd(m, seed), true, false, [0.12, 0.12]);
      break;
    case 'plywood':
      side = render(S, woodSide({ ...m, visual: { ...m.visual, color2: m.visual.color2 } }, seed + 1), true, true, [1.2, 0.6]);
      end = render(256, plyEdge(m, seed), true, false, [0.3, 0.05]);
      edge = end;
      break;
    case 'bamboo':
      side = render(S, bamboo(m, seed), true, true, [0.5, 0.25]);
      end = render(256, woodEnd(m, seed), true, false, [0.1, 0.1]);
      break;
    case 'metal':
      side = render(S, metal(m, seed, false), true, true, [0.4, 0.4]);
      break;
    case 'brushed':
      side = render(S, metal(m, seed, true), true, true, [0.6, 0.3]);
      break;
    case 'castiron':
      side = render(S, castIron(m, seed), true, false, [0.4, 0.4]);
      break;
    case 'concrete':
      side = render(S, concrete(m, seed), true, false, [0.8, 0.8]);
      break;
    case 'brick':
      side = render(S, brick(m, seed), true, false, [0.45, 0.3]);
      break;
    case 'granite':
      side = render(S, granite(m, seed), false, false, [0.35, 0.35]);
      break;
    case 'marble':
      side = render(S, marble(m, seed), false, true, [0.8, 0.8]);
      break;
    case 'carbon':
      side = render(S, carbon(m, seed), true, true, [0.12, 0.12]);
      break;
    case 'foam':
      side = render(256, foam(m, seed), true, false, [0.1, 0.1]);
      break;
    case 'ice':
      side = render(256, ice(m, seed), true, true, [0.4, 0.4]);
      break;
    case 'rubber':
      side = render(256, plain(m, seed, 0.1), true, true, [0.1, 0.1]);
      break;
    case 'ceramic':
    case 'plastic':
      side = render(256, plain(m, seed, 0.03), true, false, [0.3, 0.3]);
      break;
    case 'glass':
      side = null;
      break;
  }
  const out = { side, end, edge };
  cache.set(m.id, out);
  return out;
}

/** small swatch image for the UI */
export function swatchDataURL(m: Material, size = 56): string {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  const t = texturesFor(m).side;
  if (t) {
    ctx.drawImage(t.canvas, 0, 0, t.canvas.width / 3, t.canvas.height / 3, 0, 0, size, size);
  } else {
    ctx.fillStyle = m.visual.color;
    ctx.fillRect(0, 0, size, size);
  }
  // spherical shading
  const g = ctx.createRadialGradient(size * 0.35, size * 0.3, size * 0.05, size * 0.5, size * 0.5, size * 0.75);
  const metallic = m.visual.metalness > 0.5;
  g.addColorStop(0, `rgba(255,255,255,${metallic ? 0.55 : 0.28})`);
  g.addColorStop(0.45, 'rgba(255,255,255,0)');
  g.addColorStop(1, `rgba(0,0,0,${metallic ? 0.55 : 0.35})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  if (m.visual.transmission) {
    ctx.fillStyle = 'rgba(170,210,220,0.35)';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size * 0.2, size * 0.75);
    ctx.lineTo(size * 0.55, size * 0.2);
    ctx.stroke();
  }
  return c.toDataURL();
}
