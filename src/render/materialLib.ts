import * as THREE from 'three';
import { getMaterial, type Material } from '../core/materials';
import { texturesFor, type TextureSet } from './textures';

export interface PartMaterials {
  side: THREE.Material;
  end: THREE.Material;
  edge: THREE.Material;
  transparent: boolean;
}

const cache = new Map<string, PartMaterials>();

function physical(m: Material, t: TextureSet | null): THREE.MeshPhysicalMaterial {
  const v = m.visual;
  const mat = new THREE.MeshPhysicalMaterial({
    color: t ? 0xffffff : new THREE.Color(v.color),
    map: t?.map ?? null,
    roughness: v.roughness,
    metalness: v.metalness,
    envMapIntensity: v.metalness > 0.5 ? 1.15 : 0.85,
  });
  if (t?.bump) {
    mat.bumpMap = t.bump;
    mat.bumpScale = v.metalness > 0.5 ? 0.6 : 1.6;
  }
  if (t?.rough) mat.roughnessMap = t.rough;
  if (v.clearcoat) {
    mat.clearcoat = v.clearcoat;
    mat.clearcoatRoughness = 0.12;
  }
  if (v.transmission) {
    mat.transmission = v.transmission;
    mat.ior = v.ior ?? 1.5;
    mat.thickness = v.thickness ?? 0.02;
    mat.specularIntensity = 1;
    mat.attenuationColor = new THREE.Color(m.id === 'ice' ? '#bfe3f2' : '#cfeee4');
    mat.attenuationDistance = m.id === 'ice' ? 0.35 : 0.6;
    mat.color = new THREE.Color(v.color);
    if (m.id === 'ice' && t) mat.map = t.map;
    mat.envMapIntensity = 1.2;
  }
  return mat;
}

export function partMaterials(id: string): PartMaterials {
  const hit = cache.get(id);
  if (hit) return hit;
  const m = getMaterial(id);
  const tx = texturesFor(m);
  const side = physical(m, tx.side);
  const end = tx.end ? physical(m, tx.end) : side;
  const edge = tx.edge ? physical(m, tx.edge) : side;
  const out = { side, end, edge, transparent: !!m.visual.transmission };
  cache.set(id, out);
  return out;
}

export const stressMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.55,
  metalness: 0.0,
  envMapIntensity: 0.6,
});

export const ghostMaterial = new THREE.MeshStandardMaterial({
  color: 0x7cc4ff,
  transparent: true,
  opacity: 0.35,
  roughness: 0.4,
  depthWrite: false,
});

/** utilisation -> colour: green, yellow, orange, red, magenta when failed */
export function utilColor(U: number, out = new THREE.Color()): THREE.Color {
  const stops: [number, [number, number, number]][] = [
    [0, [0.12, 0.62, 0.38]],
    [0.35, [0.35, 0.78, 0.3]],
    [0.6, [0.95, 0.85, 0.2]],
    [0.85, [0.98, 0.52, 0.12]],
    [1.0, [0.92, 0.16, 0.12]],
    [2.0, [0.75, 0.1, 0.55]],
  ];
  const u = Math.max(0, Math.min(2, U));
  for (let i = 1; i < stops.length; i++) {
    if (u <= stops[i][0]) {
      const [a0, ca] = stops[i - 1];
      const [a1, cb] = stops[i];
      const t = (u - a0) / (a1 - a0);
      return out.setRGB(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t, THREE.SRGBColorSpace);
    }
  }
  const c = stops[stops.length - 1][1];
  return out.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
}
