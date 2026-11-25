import * as THREE from 'three';
import type { CutterKind } from '../core/cut';

// ------------------------------------------------------------------ materials

function mat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

function extrude(shape: THREE.Shape, depth: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  return g;
}

function roundRect(x0: number, y0: number, x1: number, y1: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + r);
  s.lineTo(x1, y1 - r);
  s.quadraticCurveTo(x1, y1, x1 - r, y1);
  s.lineTo(x0 + r, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  return s;
}

/** a toothed blade plate: cutting edge along y = 0 from x0 to x1, back edge rising to h0..h1 */
function bladeShape(x0: number, x1: number, h0: number, h1: number, pitch: number, depth: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(x0, 0);
  for (let x = x0; x < x1 - pitch; x += pitch) {
    s.lineTo(x + pitch * 0.7, depth);
    s.lineTo(x + pitch, 0);
  }
  s.lineTo(x1, 0);
  s.lineTo(x1, h1);
  s.lineTo(x0, h0);
  s.lineTo(x0, 0);
  return s;
}

// ------------------------------------------------------------------ saws

/**
 * A cutting tool model. Its frame: origin = the cutting edge at the bottom of the kerf, +x = the
 * stroke direction, +y = back out of the cut (towards the face the blade went in through),
 * +z = the cut plane's normal.
 */
export class SawRig {
  readonly group = new THREE.Group();
  private stroke = new THREE.Group();
  private spinner: THREE.Object3D | null = null;
  private t = 0;
  private mats: THREE.Material[] = [];
  readonly kind: CutterKind;
  /** how far the blade sweeps each way */
  private amp = 0.06;

  constructor(kind: CutterKind) {
    this.kind = kind;
    this.group.add(this.stroke);
    this.build();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.raycast = () => {};
      }
    });
  }

  private add(geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = this.stroke): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, m);
    parent.add(mesh);
    if (!this.mats.includes(m)) this.mats.push(m);
    return mesh;
  }

  private build() {
    const steel = mat(0xd5dae1, 0.95, 0.28);
    switch (this.kind) {
      case 'handsaw':
      case 'finesaw': {
        const fine = this.kind === 'finesaw';
        const L = fine ? 0.26 : 0.4;
        this.add(extrude(bladeShape(-L * 0.78, L * 0.22, fine ? 0.04 : 0.055, fine ? 0.06 : 0.115, fine ? 0.0025 : 0.0045, fine ? 0.0015 : 0.003), 0.0009), steel);
        const handle = roundRect(L * 0.2, 0.012, L * 0.2 + 0.13, 0.13, 0.03);
        handle.holes.push(roundRect(L * 0.2 + 0.035, 0.045, L * 0.2 + 0.1, 0.1, 0.018));
        const wood = mat(fine ? 0x222428 : 0x8a5a35, 0.05, 0.55);
        this.add(extrude(handle, 0.024), wood);
        const brass = mat(0xc9a13c, 1, 0.3);
        for (const [x, y] of [[L * 0.2 + 0.02, 0.03], [L * 0.2 + 0.02, 0.11]]) {
          const r = this.add(new THREE.CylinderGeometry(0.0045, 0.0045, 0.027, 12), brass);
          r.rotation.x = Math.PI / 2;
          r.position.set(x, y, 0);
        }
        this.amp = fine ? 0.045 : 0.075;
        break;
      }
      case 'hacksaw': {
        this.add(extrude(bladeShape(-0.17, 0.13, 0.012, 0.012, 0.0018, 0.001), 0.0007), steel);
        const paint = mat(0xc8372d, 0.4, 0.45);
        const bar = this.add(new THREE.BoxGeometry(0.31, 0.01, 0.012), paint);
        bar.position.set(-0.02, 0.1, 0);
        for (const x of [-0.17, 0.13]) {
          const post = this.add(new THREE.BoxGeometry(0.01, 0.1, 0.012), paint);
          post.position.set(x, 0.055, 0);
        }
        const grip = this.add(new THREE.BoxGeometry(0.03, 0.11, 0.026), mat(0x1d1f22, 0.05, 0.7));
        grip.position.set(0.17, 0.06, 0);
        grip.rotation.z = -0.35;
        this.amp = 0.06;
        break;
      }
      case 'knife': {
        const blade = new THREE.Shape();
        blade.moveTo(-0.035, 0);
        blade.lineTo(0.01, 0);
        blade.lineTo(0.01, 0.018);
        blade.lineTo(-0.012, 0.018);
        blade.lineTo(-0.035, 0);
        this.add(extrude(blade, 0.0006), steel);
        const h = this.add(new THREE.BoxGeometry(0.12, 0.022, 0.016), mat(0xf2c21b, 0.1, 0.45));
        h.position.set(0.07, 0.03, 0);
        h.rotation.z = 0.25;
        this.amp = 0.03;
        break;
      }
      case 'glasscutter': {
        const wheel = this.add(new THREE.CylinderGeometry(0.003, 0.003, 0.0016, 16), steel);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.y = 0.003;
        const body = new THREE.Group();
        body.position.set(0.0, 0.006, 0);
        body.rotation.z = -0.5;
        this.stroke.add(body);
        const ferrule = this.add(new THREE.CylinderGeometry(0.0045, 0.003, 0.02, 14), mat(0xb59a5a, 1, 0.3), body);
        ferrule.position.y = 0.012;
        const grip = this.add(new THREE.CylinderGeometry(0.007, 0.0055, 0.11, 16), mat(0x2b5fa8, 0.2, 0.4), body);
        grip.position.y = 0.075;
        this.amp = 0;
        break;
      }
      case 'grinder':
      case 'diamond': {
        const R = 0.0575;
        const disc = new THREE.Group();
        disc.position.set(0, R, 0);
        this.stroke.add(disc);
        const rim = this.add(new THREE.CylinderGeometry(R, R, 0.0022, 48), mat(this.kind === 'diamond' ? 0x55585e : 0x34373c, this.kind === 'diamond' ? 0.7 : 0.1, 0.85), disc);
        rim.rotation.x = Math.PI / 2;
        const hub = this.add(new THREE.CylinderGeometry(R * 0.35, R * 0.35, 0.0032, 24), this.kind === 'diamond' ? steel : mat(0x2f6fbe, 0.2, 0.5), disc);
        hub.rotation.x = Math.PI / 2;
        // notches so the spin is visible
        for (let i = 0; i < 8; i++) {
          const n = this.add(new THREE.BoxGeometry(0.003, R * 0.25, 0.0026), mat(0x9aa0a8, 0.8, 0.4), disc);
          const a = (i / 8) * Math.PI * 2;
          n.position.set(Math.cos(a) * R * 0.82, Math.sin(a) * R * 0.82, 0);
          n.rotation.z = a + Math.PI / 2;
        }
        this.spinner = disc;
        const body = mat(0x3a3f45, 0.3, 0.5);
        const accent = mat(0xe2762b, 0.2, 0.5);
        const guard = this.add(new THREE.CylinderGeometry(R + 0.006, R + 0.006, 0.014, 32, 1, true, Math.PI, Math.PI), mat(0x9aa0a8, 0.85, 0.35));
        (guard.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
        guard.rotation.x = Math.PI / 2;
        guard.position.set(0, R, 0.004);
        const head = this.add(new THREE.BoxGeometry(0.055, 0.05, 0.045), body);
        head.position.set(0, R, 0.03);
        const motor = this.add(new THREE.CylinderGeometry(0.031, 0.031, 0.21, 20), accent);
        motor.rotation.z = Math.PI / 2;
        motor.position.set(0.13, R, 0.03);
        const tail = this.add(new THREE.CylinderGeometry(0.026, 0.031, 0.06, 20), body);
        tail.rotation.z = Math.PI / 2;
        tail.position.set(0.265, R, 0.03);
        const side = this.add(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 12), body);
        side.position.set(0, R + 0.075, 0.03);
        this.amp = 0;
        break;
      }
    }
  }

  /** put the cutting edge at `origin` with the given frame (unit vectors) */
  place(origin: THREE.Vector3, line: THREE.Vector3, up: THREE.Vector3, normal: THREE.Vector3) {
    this.group.position.copy(origin);
    this.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(line, up, normal));
  }

  /**
   * advance the animation. `width` is the cut's width along the stroke direction and `progress`
   * how far through the job is (glass cutters run along the score line once).
   */
  animate(dt: number, width: number, progress: number, running = true) {
    if (running) this.t += dt;
    switch (this.kind) {
      case 'grinder':
      case 'diamond': {
        if (this.spinner) this.spinner.rotation.z -= dt * (running ? 90 : 0);
        // walk the disc back and forth across the cut
        this.stroke.position.x = Math.sin(this.t * 2 * Math.PI * 0.7) * Math.max(0, width / 2 - 0.01) * 0.8;
        break;
      }
      case 'glasscutter':
        this.stroke.position.x = (-0.5 + Math.min(1, progress * 1.25)) * width;
        break;
      default:
        this.stroke.position.x = Math.sin(this.t * 2 * Math.PI * 2.2) * this.amp;
    }
  }

  /** which way the current stroke goes (+1 push / -1 pull) */
  strokePhase(): number {
    return Math.cos(this.t * 2 * Math.PI * 2.2) >= 0 ? 1 : -1;
  }

  setOpacity(a: number) {
    for (const m of this.mats) {
      m.transparent = a < 1;
      m.opacity = a;
      m.depthWrite = a >= 1;
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const m of this.mats) m.dispose();
  }
}

// ------------------------------------------------------------------ hammers

export type HammerKind = 'claw' | 'club' | 'sledge';

export interface HammerSpec {
  name: string;
  /** head mass (kg) */
  mass: number;
  /** head speed at impact (m/s) */
  speed: number;
  handle: number;
}

export const HAMMERS: Record<HammerKind, HammerSpec> = {
  claw: { name: 'Claw hammer', mass: 0.6, speed: 11, handle: 0.33 },
  club: { name: 'Club hammer', mass: 1.8, speed: 8, handle: 0.27 },
  sledge: { name: 'Sledgehammer', mass: 5, speed: 8.5, handle: 0.86 },
};

/**
 * A hammer whose striking face is at the origin facing -y (it moves along -y at impact). The
 * handle runs along +z from the middle of the head; the hand is near its end.
 */
export class HammerRig {
  readonly group = new THREE.Group();
  private inner = new THREE.Group();
  private mats: THREE.Material[] = [];
  readonly spec: HammerSpec;
  readonly pivot: THREE.Vector3;

  constructor(kind: HammerKind) {
    this.spec = HAMMERS[kind];
    this.group.add(this.inner);
    const headMat = mat(kind === 'sledge' ? 0x26282c : 0x5c6066, 0.85, 0.35);
    const face = mat(0xc9ced6, 1, 0.22);
    const add = (g: THREE.BufferGeometry, m: THREE.Material) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.raycast = () => {};
      this.inner.add(mesh);
      if (!this.mats.includes(m)) this.mats.push(m);
      return mesh;
    };
    let headLen: number;
    if (kind === 'claw') {
      headLen = 0.075;
      const h = add(new THREE.CylinderGeometry(0.014, 0.016, headLen, 20), headMat);
      h.position.y = headLen / 2 + 0.003;
      const f = add(new THREE.CylinderGeometry(0.0155, 0.0155, 0.006, 20), face);
      f.position.y = 0.003;
      // the claw
      const claw = add(new THREE.BoxGeometry(0.02, 0.07, 0.012), headMat);
      claw.position.set(0, headLen + 0.03, -0.01);
      claw.rotation.x = 0.5;
      const handle = add(new THREE.BoxGeometry(0.026, 0.03, this.spec.handle), mat(0xe8b923, 0.1, 0.5));
      handle.position.set(0, headLen * 0.55, this.spec.handle / 2 + 0.01);
      const grip = add(new THREE.BoxGeometry(0.03, 0.034, 0.12), mat(0x1c1d20, 0.05, 0.8));
      grip.position.set(0, headLen * 0.55, this.spec.handle - 0.05);
    } else if (kind === 'club') {
      headLen = 0.12;
      const h = add(new THREE.BoxGeometry(0.045, headLen, 0.045), headMat);
      h.position.y = headLen / 2;
      const f = add(new THREE.BoxGeometry(0.047, 0.006, 0.047), face);
      f.position.y = 0.003;
      const handle = add(new THREE.CylinderGeometry(0.014, 0.016, this.spec.handle, 12), mat(0xb07a46, 0.05, 0.55));
      handle.rotation.x = Math.PI / 2;
      handle.position.set(0, headLen / 2, this.spec.handle / 2 + 0.02);
    } else {
      headLen = 0.19;
      const h = add(new THREE.BoxGeometry(0.068, headLen, 0.068), headMat);
      h.position.y = headLen / 2;
      const f = add(new THREE.BoxGeometry(0.07, 0.008, 0.07), face);
      f.position.y = 0.004;
      const handle = add(new THREE.CylinderGeometry(0.017, 0.02, this.spec.handle, 14), mat(0xc8a06a, 0.05, 0.55));
      handle.rotation.x = Math.PI / 2;
      handle.position.set(0, headLen / 2, this.spec.handle / 2 + 0.03);
    }
    this.pivot = new THREE.Vector3(0, headLen / 2, this.spec.handle * 0.88);
  }

  /**
   * place the hammer so that, at swing angle `phi` = 0, its face sits on `point` striking along
   * `dir` with the handle towards `handleDir`. Positive phi lifts it back.
   */
  pose(point: THREE.Vector3, dir: THREE.Vector3, handleDir: THREE.Vector3, phi: number) {
    const y = dir.clone().negate().normalize();
    const z = handleDir.clone().addScaledVector(y, -handleDir.dot(y)).normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    this.group.position.copy(point);
    this.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    // rotate the hammer about the hand (x axis through the pivot)
    const p = this.pivot;
    this.inner.position.set(0, 0, 0);
    this.inner.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), phi);
    const rp = p.clone().applyQuaternion(this.inner.quaternion);
    this.inner.position.copy(p).sub(rp);
  }

  setOpacity(a: number) {
    for (const m of this.mats) {
      m.transparent = a < 1;
      m.opacity = a;
      m.depthWrite = a >= 1;
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const m of this.mats) m.dispose();
  }
}
