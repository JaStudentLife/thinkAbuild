import type { FailureStyle } from './materials';

export type ShapeKind = 'box' | 'cylinder' | 'sphere' | 'tube' | 'hull';

export type Vec3T = [number, number, number];
export type QuatT = [number, number, number, number];

/** A part as authored by the user (or created by fracture at runtime). Units: metres. */
export interface PartDef {
  id: string;
  name: string;
  kind: ShapeKind;
  /** box: full extents [x,y,z]; cylinder/tube: [diameter, length, diameter] (axis = local Y); sphere: [d,d,d] */
  size: Vec3T;
  /** tube wall thickness */
  wall?: number;
  pos: Vec3T;
  quat: QuatT;
  material: string;
  /** fixed to the world (a wall / foundation). Not stress-checked. */
  anchored?: boolean;
  /**
   * Saw cuts that are not square to the part: planes in local coordinates, flattened as
   * [nx, ny, nz, d, ...]. The part keeps only the material where n.x <= d.
   */
  cuts?: number[];
  /** wood grain direction as a local axis index, kept when a part is cut (otherwise: the longest axis) */
  grain?: number;
  /** rounded or bevelled edges (boxes and cylinders) */
  edge?: EdgeSpec;

  // ---- runtime-only (fragments) ----
  /** convex hull points (local) for kind = 'hull' */
  hull?: number[];
  hullVolume?: number;
  /** debris pieces are simulated but not structurally analysed */
  debris?: boolean;
  parentId?: string;
  /** how many times this lineage has fractured */
  gen?: number;
  /** fractured faces for rendering: local axis index, side (-1|1), seed, style */
  breaks?: { axis: number; side: number; seed: number; style: FailureStyle }[];
  /** fraction the part has been squashed (foam crush) */
  crushed?: number;
}

/**
 * Edge treatment of a part, like a router run around it. The "plan" is the cross-section
 * perpendicular to the `up` axis (a table top: seen from above; a leg: its cross-section).
 * Values are radii in metres; a negative value is a 45° bevel (chamfer) of that size.
 */
export interface EdgeSpec {
  /** local axis the plan is perpendicular to (cylinders: always 1) */
  up: number;
  /** the four plan corners (boxes): index = (+u side ? 1 : 0) + (+v side ? 2 : 0) */
  corners?: number[];
  /** the edge all the way round the +up face */
  top?: number;
  /** the edge all the way round the -up face */
  bottom?: number;
}

export type JointType = 'rest' | 'glue' | 'screw' | 'bolt' | 'weld' | 'rigid';

export interface Design {
  version: 1;
  name: string;
  parts: PartDef[];
  /** per-contact overrides keyed by pairKey(a, b); b may be 'ground' */
  joints: Record<string, JointType>;
  /** default joint for parts that touch each other */
  defaultJoint: JointType;
}

export const GROUND_ID = 'ground';

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function emptyDesign(): Design {
  return { version: 1, name: 'Untitled', parts: [], joints: {}, defaultJoint: 'glue' };
}

let idCounter = 1;
export function newId(prefix = 'p'): string {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function cloneDesign(d: Design): Design {
  return JSON.parse(JSON.stringify(d));
}

export function jointFor(design: Design, a: PartDef, bId: string, bDef?: PartDef): JointType {
  const key = pairKey(a.id, bId);
  const o = design.joints[key];
  if (o) return o;
  if (bId === GROUND_ID) return 'rest';
  // a whole ball only touches at a point; a cut one has a flat face that can be glued
  if ((a.kind === 'sphere' && !a.cuts?.length) || (bDef?.kind === 'sphere' && !bDef.cuts?.length)) return 'rest';
  return design.defaultJoint;
}

export interface JointInfo {
  id: JointType;
  name: string;
  blurb: string;
}

export const JOINT_TYPES: JointInfo[] = [
  { id: 'rest', name: 'Resting', blurb: 'Just sitting there. Carries compression and friction only, and lifts off or slides if pulled.' },
  { id: 'glue', name: 'Glued', blurb: 'Adhesive bond (wood glue or epoxy). Limited by the glue and by the materials’ strength across the grain.' },
  { id: 'screw', name: 'Screwed', blurb: 'Wood screws, about one per 25 cm². Each holds roughly 1.5 kN of pull-out and 2.2 kN of shear.' },
  { id: 'bolt', name: 'Bolted', blurb: 'M12 through-bolts. Each holds roughly 25 kN of tension and 18 kN of shear.' },
  { id: 'weld', name: 'Welded', blurb: 'Fillet-welded (metals only; anything else falls back to glue). About 35% of the weaker metal’s strength over the contact area.' },
  { id: 'rigid', name: 'Unbreakable', blurb: 'An idealised joint that never fails.' },
];

export function jointName(t: JointType): string {
  return JOINT_TYPES.find((j) => j.id === t)?.name ?? t;
}
