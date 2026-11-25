import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { getMaterial } from '../core/materials';
import { texturesFor } from './textures';

export type ViewPreset = 'iso' | 'top' | 'front' | 'back' | 'left' | 'right' | 'bottom';

export interface PickHit {
  partId: string | null;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  object: THREE.Object3D | null;
}

function gridMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uMinor: { value: 0.1 },
      uMajor: { value: 1.0 },
      uColor: { value: new THREE.Color(0x2b3442) },
      uMajorColor: { value: new THREE.Color(0x1c2330) },
      uFade: { value: 18.0 },
      uOpacity: { value: 0.55 },
      uCenter: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vLocal;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vLocal = position.xy;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uMinor, uMajor, uFade, uOpacity;
      uniform vec3 uColor, uMajorColor, uCenter;
      varying vec3 vWorld;
      varying vec2 vLocal;
      float lineAA(vec2 p, float s) {
        vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = lineAA(vLocal, uMinor);
        float major = lineAA(vLocal, uMajor);
        float d = distance(vWorld, uCenter);
        float fade = 1.0 - smoothstep(uFade * 0.35, uFade, d);
        float a = max(minor * 0.45, major) * fade * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(uColor, uMajorColor, major), a);
      }`,
  });
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly persp: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  camera: THREE.Camera;
  readonly controls: OrbitControls;
  readonly transform: TransformControls;
  /** rotation rings, shown together with the move arrows */
  readonly rotator: TransformControls;
  readonly composer: EffectComposer;
  readonly labels: CSS2DRenderer;
  readonly partsRoot = new THREE.Group();
  readonly fxRoot = new THREE.Group();
  readonly overlayRoot = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly ground: THREE.Mesh;
  readonly grid: THREE.Mesh;
  readonly workGrid: THREE.Mesh;
  private renderPass: RenderPass;
  private gtao: GTAOPass | null = null;
  private raycaster = new THREE.Raycaster();
  private tween: { t: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3 } | null = null;
  private shake = 0;
  isOrtho = false;
  private container: HTMLElement;
  quality: 'high' | 'low' = 'high';

  constructor(container: HTMLElement) {
    this.container = container;
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    this.renderer = r;

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels-layer';
    container.appendChild(this.labels.domElement);

    // ---- cameras
    this.persp = new THREE.PerspectiveCamera(42, 1, 0.01, 600);
    this.persp.position.set(2.6, 2.0, 3.2);
    this.ortho = new THREE.OrthographicCamera(-2, 2, 2, -2, -200, 400);
    this.camera = this.persp;

    // ---- environment & sky
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    const skyGeo = new THREE.SphereGeometry(300, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { top: { value: new THREE.Color(0x6f8fb4) }, horizon: { value: new THREE.Color(0xd9dfe6) }, bottom: { value: new THREE.Color(0xb9b6ae) } },
      vertexShader: /* glsl */ `
        varying vec3 vP;
        void main() {
          vP = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top, horizon, bottom;
        varying vec3 vP;
        void main() {
          float h = vP.y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, bottom, pow(-h, 0.4));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.scene.add(sky);
    this.scene.fog = new THREE.Fog(0xd5dbe2, 40, 160);

    // ---- lights
    const hemi = new THREE.HemisphereLight(0xdfe8f5, 0x8a7f70, 0.55);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1df, 2.6);
    sun.position.set(6, 10, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = 0.015;
    sun.shadow.radius = 3;
    const sc = sun.shadow.camera;
    sc.left = -6; sc.right = 6; sc.top = 6; sc.bottom = -6; sc.near = 0.5; sc.far = 40;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.35);
    fill.position.set(-5, 4, -6);
    this.scene.add(fill);

    // ---- ground
    const concrete = texturesFor(getMaterial('concrete')).side!;
    const gmap = concrete.map.clone();
    gmap.repeat.set(1 / 1.6, 1 / 1.6);
    gmap.needsUpdate = true;
    const gbump = concrete.bump!.clone();
    gbump.repeat.copy(gmap.repeat);
    gbump.needsUpdate = true;
    const groundMat = new THREE.MeshStandardMaterial({ map: gmap, bumpMap: gbump, bumpScale: 0.8, roughness: 0.95, metalness: 0, color: 0xc9c6bf });
    const gGeo = new THREE.PlaneGeometry(400, 400);
    const guv = gGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < guv.count; i++) guv.setXY(i, (guv.getX(i) - 0.5) * 400, (guv.getY(i) - 0.5) * 400);
    this.ground = new THREE.Mesh(gGeo, groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.userData.ground = true;
    this.scene.add(this.ground);

    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), gridMaterial());
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.position.y = 0.0008;
    this.grid.renderOrder = 1;
    this.grid.raycast = () => {};
    this.scene.add(this.grid);

    this.workGrid = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), gridMaterial());
    (this.workGrid.material as THREE.ShaderMaterial).uniforms.uColor.value = new THREE.Color(0x3d7bd9);
    (this.workGrid.material as THREE.ShaderMaterial).uniforms.uMajorColor.value = new THREE.Color(0x2a5cb0);
    (this.workGrid.material as THREE.ShaderMaterial).uniforms.uFade.value = 6;
    this.workGrid.visible = false;
    this.workGrid.raycast = () => {};
    this.workGrid.renderOrder = 2;
    this.scene.add(this.workGrid);

    this.scene.add(this.partsRoot, this.fxRoot, this.overlayRoot);

    // ---- controls
    this.controls = new OrbitControls(this.persp, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 0.5, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.05;
    this.controls.maxDistance = 120;
    this.controls.zoomToCursor = true;
    this.setLeftButtonOrbit(true);

    this.transform = new TransformControls(this.persp, r.domElement);
    this.transform.setSize(0.85);
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.rotator = new TransformControls(this.persp, r.domElement);
    this.rotator.setMode('rotate');
    // the rings sit just outside the arrow tips so both can be grabbed
    this.rotator.setSize(1.2);
    this.scene.add(this.rotator.getHelper());
    this.rotator.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    // one press drives one gizmo: where an arrow and a ring overlap, the arrow wins
    let saved: [boolean, boolean] | null = null;
    const axisOf = (c: TransformControls) => (c as unknown as { axis: string | null }).axis;
    r.domElement.addEventListener('pointerdown', () => {
      if (this.transform.enabled && this.rotator.enabled && axisOf(this.transform) && axisOf(this.rotator)) {
        saved = [this.transform.enabled, this.rotator.enabled];
        this.rotator.enabled = false;
      }
    }, true);
    window.addEventListener('pointerup', () => {
      if (!saved) return;
      [this.transform.enabled, this.rotator.enabled] = saved;
      saved = null;
    }, true);

    // ---- post
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    try {
      this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
      this.gtao.blendIntensity = 0.85;
      this.gtao.updateGtaoMaterial({ radius: 0.25, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: 12 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      this.composer.addPass(this.gtao);
    } catch (e) {
      console.warn('GTAO unavailable', e);
      this.gtao = null;
    }
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  setLeftButtonOrbit(on: boolean) {
    this.controls.mouseButtons = {
      LEFT: on ? THREE.MOUSE.ROTATE : (null as unknown as THREE.MOUSE),
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
    };
  }

  setQuality(q: 'high' | 'low') {
    this.quality = q;
    if (this.gtao) this.gtao.enabled = q === 'high';
    this.renderer.setPixelRatio(q === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.labels.setSize(w, h);
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    if (this.gtao) this.gtao.setSize(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateOrthoFrustum() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const dist = this.persp.position.distanceTo(this.controls.target);
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) * dist;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.left = (-halfH * w) / h;
    this.ortho.right = (halfH * w) / h;
    this.ortho.updateProjectionMatrix();
  }

  setOrtho(on: boolean) {
    if (on === this.isOrtho) return;
    this.isOrtho = on;
    if (on) {
      this.updateOrthoFrustum();
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
      this.camera = this.ortho;
    } else {
      this.persp.position.copy(this.ortho.position);
      this.persp.quaternion.copy(this.ortho.quaternion);
      // keep apparent size: distance scales with 1/zoom
      const dir = new THREE.Vector3().subVectors(this.persp.position, this.controls.target);
      dir.multiplyScalar(1 / this.ortho.zoom);
      this.persp.position.copy(this.controls.target).add(dir);
      this.camera = this.persp;
    }
    this.controls.object = this.camera;
    this.transform.camera = this.camera;
    this.rotator.camera = this.camera;
    this.renderPass.camera = this.camera;
    if (this.gtao) this.gtao.camera = this.camera;
    this.controls.maxPolarAngle = on ? Math.PI : Math.PI * 0.495;
    this.controls.update();
  }

  viewPreset(v: ViewPreset, center?: THREE.Vector3, radius?: number) {
    const target = center ? center.clone() : this.controls.target.clone();
    const dist = radius ? Math.max(1.2, radius * 2.6) : this.camera.position.distanceTo(this.controls.target);
    const dirs: Record<ViewPreset, THREE.Vector3> = {
      iso: new THREE.Vector3(1, 0.75, 1.25).normalize(),
      top: new THREE.Vector3(0, 1, 0.0001).normalize(),
      bottom: new THREE.Vector3(0, -1, 0.0001).normalize(),
      front: new THREE.Vector3(0, 0.0001, 1),
      back: new THREE.Vector3(0, 0.0001, -1),
      left: new THREE.Vector3(-1, 0.0001, 0),
      right: new THREE.Vector3(1, 0.0001, 0),
    };
    const p1 = target.clone().add(dirs[v].multiplyScalar(dist));
    if (v === 'bottom' && !this.isOrtho) this.setOrtho(true);
    this.tween = { t: 0, dur: 0.45, p0: this.camera.position.clone(), p1, t0: this.controls.target.clone(), t1: target };
  }

  frame(box: THREE.Box3 | null) {
    if (!box || box.isEmpty()) {
      this.tween = { t: 0, dur: 0.45, p0: this.camera.position.clone(), p1: new THREE.Vector3(2.6, 2, 3.2), t0: this.controls.target.clone(), t1: new THREE.Vector3(0, 0.5, 0) };
      return;
    }
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(0.3, box.getSize(new THREE.Vector3()).length() / 2);
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const fov = THREE.MathUtils.degToRad(this.persp.fov);
    const dist = r / Math.sin(fov / 2) * 1.05;
    this.tween = { t: 0, dur: 0.45, p0: this.camera.position.clone(), p1: c.clone().add(dir.multiplyScalar(dist)), t0: this.controls.target.clone(), t1: c };
    if (this.isOrtho) this.ortho.zoom = 1;
  }

  addShake(amount: number) {
    this.shake = Math.min(0.08, this.shake + amount);
  }

  /** fit the sun's shadow camera around the content */
  fitShadows(box: THREE.Box3) {
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const r = box.isEmpty() ? 3 : Math.max(2, box.getSize(new THREE.Vector3()).length() * 0.75 + 1);
    const sc = this.sun.shadow.camera;
    sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r;
    sc.near = 0.5;
    sc.far = 40 + r * 2;
    sc.updateProjectionMatrix();
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).add(new THREE.Vector3(6, 10, 4).normalize().multiplyScalar(14 + r));
    const gm = this.grid.material as THREE.ShaderMaterial;
    gm.uniforms.uFade.value = Math.max(10, r * 5);
  }

  pick(clientX: number, clientY: number, objects?: THREE.Object3D[]): PickHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(objects ?? this.partsRoot.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && o.userData.partId === undefined) o = o.parent;
      if (!o || !(h.object as THREE.Mesh).isMesh) continue;
      const n = h.face ? h.face.normal.clone() : new THREE.Vector3(0, 1, 0);
      n.transformDirection(h.object.matrixWorld);
      return { partId: o.userData.partId as string, point: h.point.clone(), normal: n, object: h.object };
    }
    return null;
  }

  ray(clientX: number, clientY: number): THREE.Ray {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.clone();
  }

  /** pixels per metre at a world point (for screen-space snapping tolerances) */
  pixelsPerMetre(p: THREE.Vector3): number {
    const h = this.container.clientHeight;
    if (this.isOrtho) return (h * this.ortho.zoom) / (this.ortho.top - this.ortho.bottom);
    const d = p.distanceTo(this.camera.position);
    return h / (2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) * d);
  }

  render(dt: number) {
    if (this.tween) {
      this.tween.t += dt;
      const k = Math.min(1, this.tween.t / this.tween.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, e);
      this.controls.target.lerpVectors(this.tween.t0, this.tween.t1, e);
      if (k >= 1) this.tween = null;
    }
    this.controls.update();
    let shaken = false;
    const saved = this.camera.position.clone();
    if (this.shake > 0.0005) {
      const s = this.shake * this.camera.position.distanceTo(this.controls.target) * 0.25;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      this.shake *= Math.pow(0.02, dt);
      shaken = true;
    }
    const gm = this.grid.material as THREE.ShaderMaterial;
    gm.uniforms.uCenter.value.copy(this.controls.target);
    (this.workGrid.material as THREE.ShaderMaterial).uniforms.uCenter.value.copy(this.workGrid.position);
    this.composer.render(dt);
    this.labels.render(this.scene, this.camera);
    if (shaken) this.camera.position.copy(saved);
  }

  screenshot(): string {
    return this.renderer.domElement.toDataURL('image/png');
  }
}
