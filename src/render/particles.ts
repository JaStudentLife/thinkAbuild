import * as THREE from 'three';

interface Chunk {
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  s: THREE.Vector3;
  life: number;
  max: number;
  color: THREE.Color;
  rest: boolean;
}

interface Mote {
  p: THREE.Vector3;
  v: THREE.Vector3;
  size: number;
  grow: number;
  life: number;
  max: number;
  alpha: number;
  color: THREE.Color;
  drag: number;
  g: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

function dustTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class MoteLayer {
  readonly points: THREE.Points;
  private motes: Mote[] = [];
  private cap: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;

  constructor(cap: number, additive: boolean) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: dustTexture() }, scale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float scale;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / max(0.05, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor, t.a * vAlpha);
          if (gl_FragColor.a < 0.003) discard;
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
  }

  add(m: Mote) {
    if (this.motes.length >= this.cap) this.motes.shift();
    this.motes.push(m);
  }

  update(dt: number, viewportH: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = viewportH * 0.9;
    const alive: Mote[] = [];
    for (const m of this.motes) {
      m.life += dt;
      if (m.life >= m.max) continue;
      m.v.y -= m.g * dt;
      m.v.multiplyScalar(Math.exp(-m.drag * dt));
      m.p.addScaledVector(m.v, dt);
      if (m.p.y < 0.01) {
        m.p.y = 0.01;
        m.v.y = Math.abs(m.v.y) * 0.2;
      }
      m.size += m.grow * dt;
      alive.push(m);
    }
    this.motes = alive;
    const n = alive.length;
    for (let i = 0; i < this.cap; i++) {
      if (i < n) {
        const m = alive[i];
        this.pos[3 * i] = m.p.x;
        this.pos[3 * i + 1] = m.p.y;
        this.pos[3 * i + 2] = m.p.z;
        this.col[3 * i] = m.color.r;
        this.col[3 * i + 1] = m.color.g;
        this.col[3 * i + 2] = m.color.b;
        this.size[i] = m.size;
        const k = m.life / m.max;
        this.alpha[i] = m.alpha * Math.min(1, m.life * 12) * (1 - k) * (1 - k);
      } else this.alpha[i] = 0;
    }
    const g = this.points.geometry;
    for (const a of ['position', 'color', 'size', 'alpha']) (g.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
    g.setDrawRange(0, n);
  }

  clear() {
    this.motes = [];
  }
}

export type DebrisStyle = 'splinter' | 'chip' | 'shard' | 'chunk' | 'cube';

export class Particles {
  readonly root = new THREE.Group();
  private chunks: Chunk[] = [];
  private mesh: THREE.InstancedMesh;
  private glass: THREE.InstancedMesh;
  private glassChunks: Chunk[] = [];
  private dust: MoteLayer;
  private sparks: MoteLayer;
  private cap = 1400;

  constructor() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.05 }), this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.4, 0.5, 0, -0.2, 0, 0, 0.6, -0.5, 0.08, -0.4, 0.5, 0.08, -0.2, 0, 0.08, 0.6], 3));
    tri.setIndex([0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5]);
    tri.computeVertexNormals();
    this.glass = new THREE.InstancedMesh(
      tri,
      new THREE.MeshPhysicalMaterial({ color: 0xd8f0ea, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.55, envMapIntensity: 1.5, side: THREE.DoubleSide }),
      600,
    );
    this.glass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glass.count = 0;
    this.glass.frustumCulled = false;
    this.dust = new MoteLayer(900, false);
    this.sparks = new MoteLayer(400, true);
    this.root.add(this.mesh, this.glass, this.dust.points, this.sparks.points);
  }

  /** solid debris pieces flying from a break */
  debris(origin: THREE.Vector3, count: number, color: THREE.Color | string, style: DebrisStyle, size: number, speed: number, dir?: THREE.Vector3) {
    const col = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      if (dir) v.addScaledVector(dir, speed * 0.6);
      const k = size * (0.4 + Math.random());
      let s: THREE.Vector3;
      switch (style) {
        case 'splinter':
          s = new THREE.Vector3(k * 0.12, k * 0.12, k * (1.5 + Math.random() * 2.5));
          break;
        case 'shard':
          s = new THREE.Vector3(k, k, k);
          break;
        case 'cube':
          s = new THREE.Vector3(k * 0.35, k * 0.35, k * 0.35);
          break;
        case 'chip':
          s = new THREE.Vector3(k * 0.6, k * 0.25, k * 0.5);
          break;
        default:
          s = new THREE.Vector3(k * (0.6 + Math.random() * 0.6), k * (0.5 + Math.random() * 0.5), k * (0.6 + Math.random() * 0.6));
      }
      const c: Chunk = {
        p: origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * size, (Math.random() - 0.5) * size, (Math.random() - 0.5) * size)),
        v,
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
        w: new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30),
        s,
        life: 0,
        max: 4 + Math.random() * 3,
        color: col.clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.12),
        rest: false,
      };
      if (style === 'shard' || style === 'cube') {
        if (this.glassChunks.length >= 600) this.glassChunks.shift();
        this.glassChunks.push(c);
      } else {
        if (this.chunks.length >= this.cap) this.chunks.shift();
        this.chunks.push(c);
      }
    }
  }

  dustCloud(origin: THREE.Vector3, count: number, color: THREE.Color | string, spread: number, strength = 1) {
    const col = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(2.2 * strength);
      this.dust.add({
        p: origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread, Math.random() * spread * 0.3, (Math.random() - 0.5) * spread)),
        v,
        size: 0.04 + Math.random() * 0.06 * strength,
        grow: 0.25 + Math.random() * 0.3,
        life: 0,
        max: 1.4 + Math.random() * 1.6,
        alpha: 0.35 + Math.random() * 0.25,
        color: col.clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.08),
        drag: 2.5,
        g: -0.15,
      });
    }
  }

  /** hot sparks; `dir` makes them a stream (a grinder), `color` tints them (titanium burns white) */
  sparksAt(origin: THREE.Vector3, count: number, opts: { color?: string; dir?: THREE.Vector3; speed?: number; life?: number } = {}) {
    const base = opts.color ? new THREE.Color(opts.color) : null;
    for (let i = 0; i < count; i++) {
      let v: THREE.Vector3;
      if (opts.dir) {
        v = opts.dir.clone().normalize().add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(0.45)).normalize();
        v.multiplyScalar((opts.speed ?? 6) * (0.6 + Math.random() * 0.7));
      } else v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 5);
      this.sparks.add({
        p: origin.clone(),
        v,
        size: 0.008 + Math.random() * 0.01,
        grow: -0.004,
        life: 0,
        max: (opts.life ?? 1) * (0.25 + Math.random() * 0.45),
        alpha: 1,
        color: base ? base.clone().offsetHSL(0, 0, (Math.random() - 0.3) * 0.15) : new THREE.Color().setHSL(0.08 + Math.random() * 0.05, 1, 0.6 + Math.random() * 0.2),
        drag: 1.2,
        g: 9.81,
      });
    }
  }

  private step(list: Chunk[], dt: number): Chunk[] {
    const out: Chunk[] = [];
    for (const c of list) {
      c.life += dt;
      if (c.life >= c.max) continue;
      if (!c.rest) {
        c.v.y -= 9.81 * dt;
        c.p.addScaledVector(c.v, dt);
        tmpQ.setFromAxisAngle(tmpV.copy(c.w).normalize(), c.w.length() * dt);
        if (c.w.lengthSq() > 1e-8) c.q.premultiply(tmpQ);
        const half = Math.min(c.s.x, c.s.y, c.s.z) * 0.5;
        if (c.p.y < half) {
          c.p.y = half;
          if (Math.abs(c.v.y) < 0.4) {
            c.v.set(0, 0, 0);
            c.w.multiplyScalar(0);
            c.rest = true;
          } else {
            c.v.y = -c.v.y * 0.28;
            c.v.x *= 0.55;
            c.v.z *= 0.55;
            c.w.multiplyScalar(0.6);
          }
        }
      }
      out.push(c);
    }
    return out;
  }

  private write(mesh: THREE.InstancedMesh, list: Chunk[]) {
    const n = Math.min(list.length, mesh.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      const c = list[i];
      const fade = c.max - c.life < 0.6 ? Math.max(0.01, (c.max - c.life) / 0.6) : 1;
      tmpV.copy(c.s).multiplyScalar(fade);
      tmpM.compose(c.p, c.q, tmpV);
      mesh.setMatrixAt(i, tmpM);
      mesh.setColorAt(i, c.color);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number, viewportH: number) {
    this.chunks = this.step(this.chunks, dt);
    this.glassChunks = this.step(this.glassChunks, dt);
    this.write(this.mesh, this.chunks);
    this.write(this.glass, this.glassChunks);
    this.dust.update(dt, viewportH);
    this.sparks.update(dt, viewportH);
  }

  clear() {
    this.chunks = [];
    this.glassChunks = [];
    this.dust.clear();
    this.sparks.clear();
    this.mesh.count = 0;
    this.glass.count = 0;
  }
}
