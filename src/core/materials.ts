// Material database. All values SI (kg/m^3, Pa). Typical values for real-world
// stock (not lab-perfect specimens). Wood values are along the grain unless noted.

export type FailureStyle =
  | 'splinter' // fibrous brittle: wood, bamboo, carbon fibre -> snaps with splinters
  | 'shatter' // brittle glassy: glass, ice, acrylic, ceramic -> shards
  | 'dice' // tempered glass -> many small cubes
  | 'crumble' // quasi-brittle: concrete, brick, stone, cast iron, tungsten -> chunks + dust
  | 'bend' // ductile: steel, aluminium, copper, plastics -> plastic hinge, folds
  | 'crush' // cellular: foam -> squashes
  | 'tear'; // elastomer: rubber

export type TextureKind =
  | 'wood'
  | 'plywood'
  | 'bamboo'
  | 'metal'
  | 'brushed'
  | 'castiron'
  | 'concrete'
  | 'brick'
  | 'granite'
  | 'marble'
  | 'glass'
  | 'ice'
  | 'ceramic'
  | 'plastic'
  | 'carbon'
  | 'rubber'
  | 'foam';

export type SoundKind = 'wood' | 'metal' | 'glass' | 'stone' | 'plastic' | 'soft';

export type Category = 'Wood' | 'Metal' | 'Stone & Masonry' | 'Glass & Ceramic' | 'Plastic & Composite' | 'Soft';

export interface Material {
  id: string;
  name: string;
  category: Category;
  density: number; // kg/m^3
  E: number; // Young's modulus (along grain for wood)
  Eperp?: number; // modulus across grain (wood)
  G: number; // shear modulus
  nu: number; // Poisson ratio
  ft: number; // tensile strength (along grain)
  fc: number; // compressive strength (along grain)
  fm: number; // flexural strength / modulus of rupture
  fv: number; // shear strength
  fcPerp?: number; // compression perpendicular to grain (bearing)
  ftPerp?: number; // tension perpendicular to grain (splitting)
  fy?: number; // yield strength (ductile)
  fu?: number; // ultimate strength (ductile)
  ductile: boolean;
  grain?: 'solid' | 'panel'; // wood-like anisotropy: solid = grain along longest axis, panel = in-plane isotropic
  failure: FailureStyle;
  friction: number;
  restitution: number;
  imperfection: number; // initial out-of-straightness as L / imperfection
  sound: SoundKind;
  visual: {
    color: string;
    color2?: string; // secondary colour for procedural texture
    roughness: number;
    metalness: number;
    texture: TextureKind;
    transmission?: number;
    ior?: number;
    clearcoat?: number;
    thickness?: number;
  };
  blurb: string;
}

const MPa = 1e6;
const GPa = 1e9;

export const MATERIALS: Material[] = [
  // ---------------------------------------------------------------- Wood
  {
    id: 'pine', name: 'Pine', category: 'Wood', density: 510,
    E: 9 * GPa, Eperp: 0.45 * GPa, G: 0.56 * GPa, nu: 0.37,
    ft: 40 * MPa, fc: 30 * MPa, fm: 50 * MPa, fv: 6 * MPa, fcPerp: 4 * MPa, ftPerp: 1.8 * MPa,
    ductile: false, grain: 'solid', failure: 'splinter', friction: 0.5, restitution: 0.35, imperfection: 300, sound: 'wood',
    visual: { color: '#d9b27a', color2: '#a9783f', roughness: 0.62, metalness: 0, texture: 'wood' },
    blurb: 'Common softwood. Light and fairly strong along the grain, weak across it. Slender pine legs fail by buckling long before the wood crushes.',
  },
  {
    id: 'oak', name: 'Oak', category: 'Wood', density: 750,
    E: 12 * GPa, Eperp: 0.8 * GPa, G: 0.75 * GPa, nu: 0.37,
    ft: 70 * MPa, fc: 45 * MPa, fm: 85 * MPa, fv: 11 * MPa, fcPerp: 7 * MPa, ftPerp: 4 * MPa,
    ductile: false, grain: 'solid', failure: 'splinter', friction: 0.5, restitution: 0.35, imperfection: 300, sound: 'wood',
    visual: { color: '#a8784a', color2: '#6e4724', roughness: 0.58, metalness: 0, texture: 'wood' },
    blurb: 'Dense hardwood. About 40% stiffer and much stronger than pine, so it makes good posts and beams.',
  },
  {
    id: 'balsa', name: 'Balsa', category: 'Wood', density: 160,
    E: 3.4 * GPa, Eperp: 0.1 * GPa, G: 0.15 * GPa, nu: 0.3,
    ft: 19 * MPa, fc: 11 * MPa, fm: 20 * MPa, fv: 2 * MPa, fcPerp: 0.8 * MPa, ftPerp: 0.7 * MPa,
    ductile: false, grain: 'solid', failure: 'splinter', friction: 0.5, restitution: 0.3, imperfection: 250, sound: 'wood',
    visual: { color: '#ecd9ad', color2: '#cdb27c', roughness: 0.78, metalness: 0, texture: 'wood' },
    blurb: 'Ultralight model-making wood. Excellent strength for its weight, but crushes easily across the grain.',
  },
  {
    id: 'plywood', name: 'Plywood', category: 'Wood', density: 680,
    E: 9 * GPa, Eperp: 6 * GPa, G: 0.6 * GPa, nu: 0.3,
    ft: 40 * MPa, fc: 30 * MPa, fm: 50 * MPa, fv: 4 * MPa, fcPerp: 8 * MPa, ftPerp: 1.5 * MPa,
    ductile: false, grain: 'panel', failure: 'splinter', friction: 0.5, restitution: 0.35, imperfection: 300, sound: 'wood',
    visual: { color: '#dcbb8c', color2: '#b8925e', roughness: 0.66, metalness: 0, texture: 'plywood' },
    blurb: 'Cross-laminated veneers, roughly equally strong in both in-plane directions. Ideal for shelves and table tops.',
  },
  {
    id: 'bamboo', name: 'Bamboo (laminated)', category: 'Wood', density: 700,
    E: 12 * GPa, Eperp: 1 * GPa, G: 0.9 * GPa, nu: 0.3,
    ft: 90 * MPa, fc: 50 * MPa, fm: 80 * MPa, fv: 10 * MPa, fcPerp: 8 * MPa, ftPerp: 3 * MPa,
    ductile: false, grain: 'solid', failure: 'splinter', friction: 0.5, restitution: 0.35, imperfection: 300, sound: 'wood',
    visual: { color: '#cfae6c', color2: '#9c7a3c', roughness: 0.5, metalness: 0, texture: 'bamboo' },
    blurb: 'Very high tensile strength along the fibres. Splits along the grain when overloaded.',
  },
  // ---------------------------------------------------------------- Metal
  {
    id: 'steel', name: 'Structural steel', category: 'Metal', density: 7850,
    E: 200 * GPa, G: 77 * GPa, nu: 0.3,
    ft: 355 * MPa, fc: 355 * MPa, fm: 355 * MPa, fv: 205 * MPa, fy: 355 * MPa, fu: 510 * MPa,
    ductile: true, failure: 'bend', friction: 0.5, restitution: 0.45, imperfection: 500, sound: 'metal',
    visual: { color: '#8b9097', roughness: 0.38, metalness: 1, texture: 'brushed' },
    blurb: 'S355 structural steel. Stiff, strong and ductile, so it yields and bends long before it breaks.',
  },
  {
    id: 'stainless', name: 'Stainless steel', category: 'Metal', density: 8000,
    E: 193 * GPa, G: 75 * GPa, nu: 0.3,
    ft: 215 * MPa, fc: 215 * MPa, fm: 215 * MPa, fv: 125 * MPa, fy: 215 * MPa, fu: 505 * MPa,
    ductile: true, failure: 'bend', friction: 0.5, restitution: 0.45, imperfection: 500, sound: 'metal',
    visual: { color: '#c4c8cc', roughness: 0.2, metalness: 1, texture: 'brushed' },
    blurb: '304 stainless. Corrosion-proof and very ductile, but it yields at a lower stress than structural steel.',
  },
  {
    id: 'aluminum', name: 'Aluminium 6061', category: 'Metal', density: 2700,
    E: 69 * GPa, G: 26 * GPa, nu: 0.33,
    ft: 276 * MPa, fc: 276 * MPa, fm: 276 * MPa, fv: 160 * MPa, fy: 276 * MPa, fu: 310 * MPa,
    ductile: true, failure: 'bend', friction: 0.6, restitution: 0.45, imperfection: 500, sound: 'metal',
    visual: { color: '#c9cdd2', roughness: 0.3, metalness: 1, texture: 'brushed' },
    blurb: 'A third of the weight of steel and a third of its stiffness, so it buckles sooner at the same size.',
  },
  {
    id: 'titanium', name: 'Titanium Ti-6Al-4V', category: 'Metal', density: 4430,
    E: 114 * GPa, G: 44 * GPa, nu: 0.34,
    ft: 880 * MPa, fc: 880 * MPa, fm: 880 * MPa, fv: 510 * MPa, fy: 880 * MPa, fu: 950 * MPa,
    ductile: true, failure: 'bend', friction: 0.45, restitution: 0.45, imperfection: 500, sound: 'metal',
    visual: { color: '#9b968b', roughness: 0.32, metalness: 1, texture: 'brushed' },
    blurb: 'Aerospace alloy. Very high strength for its weight.',
  },
  {
    id: 'copper', name: 'Copper', category: 'Metal', density: 8960,
    E: 117 * GPa, G: 44 * GPa, nu: 0.34,
    ft: 70 * MPa, fc: 70 * MPa, fm: 70 * MPa, fv: 40 * MPa, fy: 70 * MPa, fu: 220 * MPa,
    ductile: true, failure: 'bend', friction: 0.5, restitution: 0.35, imperfection: 500, sound: 'metal',
    visual: { color: '#c97b52', roughness: 0.28, metalness: 1, texture: 'metal' },
    blurb: 'Annealed copper. Heavy, soft and very ductile, so it bends easily.',
  },
  {
    id: 'lead', name: 'Lead', category: 'Metal', density: 11340,
    E: 16 * GPa, G: 5.6 * GPa, nu: 0.44,
    ft: 5.5 * MPa, fc: 5.5 * MPa, fm: 5.5 * MPa, fv: 3.2 * MPa, fy: 5.5 * MPa, fu: 17 * MPa,
    ductile: true, failure: 'bend', friction: 0.6, restitution: 0.08, imperfection: 400, sound: 'soft',
    visual: { color: '#6f7479', roughness: 0.62, metalness: 0.85, texture: 'metal' },
    blurb: 'Very dense and extremely soft. Useful as dead weight, but useless as a structure because it sags under its own weight.',
  },
  {
    id: 'gold', name: 'Gold', category: 'Metal', density: 19300,
    E: 79 * GPa, G: 27 * GPa, nu: 0.42,
    ft: 100 * MPa, fc: 100 * MPa, fm: 100 * MPa, fv: 58 * MPa, fy: 100 * MPa, fu: 125 * MPa,
    ductile: true, failure: 'bend', friction: 0.5, restitution: 0.2, imperfection: 500, sound: 'metal',
    visual: { color: '#e9b949', roughness: 0.17, metalness: 1, texture: 'metal' },
    blurb: 'About as dense as tungsten but soft and ductile. A gold bar weighs as much as a tungsten one of the same size.',
  },
  {
    id: 'tungsten', name: 'Tungsten', category: 'Metal', density: 19250,
    E: 411 * GPa, G: 161 * GPa, nu: 0.28,
    ft: 750 * MPa, fc: 1500 * MPa, fm: 900 * MPa, fv: 450 * MPa,
    ductile: false, failure: 'crumble', friction: 0.5, restitution: 0.4, imperfection: 1000, sound: 'metal',
    visual: { color: '#5f6267', roughness: 0.34, metalness: 1, texture: 'metal' },
    blurb: 'Among the densest metals (19.3 g/cm³, 2.5× steel). A 1 m × 1 m slab only 10 cm thick weighs almost 2 tonnes. Extremely stiff, and brittle at room temperature.',
  },
  {
    id: 'castiron', name: 'Cast iron', category: 'Metal', density: 7200,
    E: 110 * GPa, G: 45 * GPa, nu: 0.26,
    ft: 200 * MPa, fc: 750 * MPa, fm: 350 * MPa, fv: 230 * MPa,
    ductile: false, failure: 'crumble', friction: 0.5, restitution: 0.3, imperfection: 750, sound: 'metal',
    visual: { color: '#4b4d50', roughness: 0.78, metalness: 0.75, texture: 'castiron' },
    blurb: 'Grey cast iron. Very strong in compression but brittle in tension, so it cracks rather than bends.',
  },
  // ---------------------------------------------------------------- Stone & masonry
  {
    id: 'concrete', name: 'Concrete (plain)', category: 'Stone & Masonry', density: 2400,
    E: 30 * GPa, G: 12.5 * GPa, nu: 0.2,
    ft: 2.9 * MPa, fc: 30 * MPa, fm: 4.5 * MPa, fv: 4 * MPa,
    ductile: false, failure: 'crumble', friction: 0.65, restitution: 0.15, imperfection: 750, sound: 'stone',
    visual: { color: '#a9a7a1', color2: '#7d7b76', roughness: 0.93, metalness: 0, texture: 'concrete' },
    blurb: 'C30 concrete. Strong in compression but about 10× weaker in tension, so an unreinforced beam cracks on its underside.',
  },
  {
    id: 'rconcrete', name: 'Reinforced concrete', category: 'Stone & Masonry', density: 2500,
    E: 32 * GPa, G: 13 * GPa, nu: 0.2,
    ft: 5 * MPa, fc: 30 * MPa, fm: 20 * MPa, fv: 4 * MPa,
    ductile: false, failure: 'crumble', friction: 0.65, restitution: 0.15, imperfection: 750, sound: 'stone',
    visual: { color: '#9fa1a1', color2: '#747676', roughness: 0.9, metalness: 0, texture: 'concrete' },
    blurb: 'Concrete with about 1% steel rebar. The steel carries the tension, so it can span where plain concrete cannot.',
  },
  {
    id: 'brick', name: 'Brick masonry', category: 'Stone & Masonry', density: 1900,
    E: 15 * GPa, G: 6 * GPa, nu: 0.2,
    ft: 1.5 * MPa, fc: 20 * MPa, fm: 3 * MPa, fv: 2 * MPa,
    ductile: false, failure: 'crumble', friction: 0.7, restitution: 0.12, imperfection: 600, sound: 'stone',
    visual: { color: '#a8533b', color2: '#c9c2b4', roughness: 0.88, metalness: 0, texture: 'brick' },
    blurb: 'Solid clay brick with mortar. Fine for walls and piers that only carry compression.',
  },
  {
    id: 'granite', name: 'Granite', category: 'Stone & Masonry', density: 2700,
    E: 50 * GPa, G: 20 * GPa, nu: 0.25,
    ft: 10 * MPa, fc: 200 * MPa, fm: 15 * MPa, fv: 20 * MPa,
    ductile: false, failure: 'crumble', friction: 0.6, restitution: 0.25, imperfection: 1000, sound: 'stone',
    visual: { color: '#8e8b88', color2: '#3d3a38', roughness: 0.42, metalness: 0, texture: 'granite' },
    blurb: 'Hard igneous stone with enormous compressive strength. Brittle in bending.',
  },
  {
    id: 'marble', name: 'Marble', category: 'Stone & Masonry', density: 2700,
    E: 55 * GPa, G: 22 * GPa, nu: 0.25,
    ft: 7 * MPa, fc: 100 * MPa, fm: 12 * MPa, fv: 12 * MPa,
    ductile: false, failure: 'crumble', friction: 0.5, restitution: 0.25, imperfection: 1000, sound: 'stone',
    visual: { color: '#eeeae4', color2: '#9a9690', roughness: 0.24, metalness: 0, texture: 'marble' },
    blurb: 'Polished metamorphic stone. Heavy, beautiful, and brittle in bending.',
  },
  // ---------------------------------------------------------------- Glass & ceramic
  {
    id: 'glass', name: 'Glass (annealed)', category: 'Glass & Ceramic', density: 2500,
    E: 70 * GPa, G: 29 * GPa, nu: 0.22,
    ft: 40 * MPa, fc: 1000 * MPa, fm: 45 * MPa, fv: 40 * MPa,
    ductile: false, failure: 'shatter', friction: 0.4, restitution: 0.5, imperfection: 1000, sound: 'glass',
    visual: { color: '#eaf6f3', roughness: 0.03, metalness: 0, texture: 'glass', transmission: 1, ior: 1.52, thickness: 0.02 },
    blurb: 'Ordinary float glass. Huge compressive strength, but tiny surface flaws make it fail suddenly in tension and break into sharp shards.',
  },
  {
    id: 'tglass', name: 'Glass (tempered)', category: 'Glass & Ceramic', density: 2500,
    E: 70 * GPa, G: 29 * GPa, nu: 0.22,
    ft: 120 * MPa, fc: 1000 * MPa, fm: 120 * MPa, fv: 80 * MPa,
    ductile: false, failure: 'dice', friction: 0.4, restitution: 0.5, imperfection: 1000, sound: 'glass',
    visual: { color: '#e2f2ef', roughness: 0.03, metalness: 0, texture: 'glass', transmission: 1, ior: 1.52, thickness: 0.02 },
    blurb: 'Heat-strengthened safety glass, about 3× stronger than annealed. When it fails it bursts into thousands of small cubes.',
  },
  {
    id: 'ceramic', name: 'Ceramic (porcelain)', category: 'Glass & Ceramic', density: 2400,
    E: 70 * GPa, G: 29 * GPa, nu: 0.22,
    ft: 40 * MPa, fc: 400 * MPa, fm: 60 * MPa, fv: 40 * MPa,
    ductile: false, failure: 'shatter', friction: 0.5, restitution: 0.4, imperfection: 1000, sound: 'glass',
    visual: { color: '#f4f1ea', roughness: 0.18, metalness: 0, texture: 'ceramic', clearcoat: 0.7 },
    blurb: 'Glazed porcelain. Hard and brittle.',
  },
  {
    id: 'ice', name: 'Ice', category: 'Glass & Ceramic', density: 917,
    E: 9 * GPa, G: 3.4 * GPa, nu: 0.33,
    ft: 1.0 * MPa, fc: 5 * MPa, fm: 1.7 * MPa, fv: 1 * MPa,
    ductile: false, failure: 'shatter', friction: 0.05, restitution: 0.3, imperfection: 1000, sound: 'glass',
    visual: { color: '#d4ebf5', roughness: 0.12, metalness: 0, texture: 'ice', transmission: 0.85, ior: 1.31, thickness: 0.15 },
    blurb: 'Frozen water. Brittle, weak in tension, and very slippery (μ ≈ 0.05).',
  },
  // ---------------------------------------------------------------- Plastic & composite
  {
    id: 'acrylic', name: 'Acrylic (PMMA)', category: 'Plastic & Composite', density: 1180,
    E: 3.2 * GPa, G: 1.2 * GPa, nu: 0.37,
    ft: 70 * MPa, fc: 110 * MPa, fm: 100 * MPa, fv: 60 * MPa,
    ductile: false, failure: 'shatter', friction: 0.5, restitution: 0.5, imperfection: 500, sound: 'plastic',
    visual: { color: '#f2f7ff', roughness: 0.04, metalness: 0, texture: 'glass', transmission: 0.95, ior: 1.49, thickness: 0.02 },
    blurb: 'Clear plastic. Fairly strong, but 20× more flexible than glass, so it sags.',
  },
  {
    id: 'abs', name: 'ABS plastic', category: 'Plastic & Composite', density: 1050,
    E: 2.3 * GPa, G: 0.85 * GPa, nu: 0.35,
    ft: 40 * MPa, fc: 40 * MPa, fm: 40 * MPa, fv: 23 * MPa, fy: 40 * MPa, fu: 44 * MPa,
    ductile: true, failure: 'bend', friction: 0.5, restitution: 0.5, imperfection: 400, sound: 'plastic',
    visual: { color: '#e0b43c', roughness: 0.42, metalness: 0, texture: 'plastic' },
    blurb: 'Tough injection-moulded plastic. Bends and deforms rather than shattering.',
  },
  {
    id: 'pvc', name: 'PVC (rigid)', category: 'Plastic & Composite', density: 1400,
    E: 3.0 * GPa, G: 1.1 * GPa, nu: 0.38,
    ft: 50 * MPa, fc: 50 * MPa, fm: 50 * MPa, fv: 29 * MPa, fy: 50 * MPa, fu: 52 * MPa,
    ductile: true, failure: 'bend', friction: 0.5, restitution: 0.4, imperfection: 400, sound: 'plastic',
    visual: { color: '#e9e9e6', roughness: 0.5, metalness: 0, texture: 'plastic' },
    blurb: 'Pipe and profile plastic. Flexible, so slender PVC columns buckle readily.',
  },
  {
    id: 'hdpe', name: 'HDPE', category: 'Plastic & Composite', density: 950,
    E: 0.9 * GPa, G: 0.33 * GPa, nu: 0.42,
    ft: 25 * MPa, fc: 25 * MPa, fm: 25 * MPa, fv: 14 * MPa, fy: 25 * MPa, fu: 30 * MPa,
    ductile: true, failure: 'bend', friction: 0.2, restitution: 0.4, imperfection: 300, sound: 'plastic',
    visual: { color: '#f3f2ec', roughness: 0.55, metalness: 0, texture: 'plastic' },
    blurb: 'Waxy, slippery polyethylene. Very flexible.',
  },
  {
    id: 'carbon', name: 'Carbon fibre (CFRP)', category: 'Plastic & Composite', density: 1600,
    E: 70 * GPa, G: 5 * GPa, nu: 0.3,
    ft: 600 * MPa, fc: 500 * MPa, fm: 700 * MPa, fv: 70 * MPa,
    ductile: false, failure: 'splinter', friction: 0.4, restitution: 0.45, imperfection: 700, sound: 'plastic',
    visual: { color: '#26272a', roughness: 0.3, metalness: 0.2, texture: 'carbon', clearcoat: 1 },
    blurb: 'Quasi-isotropic carbon/epoxy laminate. Steel-like strength at a fifth of the weight, but it fails suddenly.',
  },
  // ---------------------------------------------------------------- Soft
  {
    id: 'rubber', name: 'Rubber', category: 'Soft', density: 1100,
    E: 5 * MPa, G: 1.7 * MPa, nu: 0.49,
    ft: 20 * MPa, fc: 50 * MPa, fm: 20 * MPa, fv: 10 * MPa,
    ductile: false, failure: 'tear', friction: 1.0, restitution: 0.85, imperfection: 300, sound: 'soft',
    visual: { color: '#2c2c2d', roughness: 0.92, metalness: 0, texture: 'rubber' },
    blurb: 'Natural rubber. Very soft and very bouncy. It deforms enormously before it tears.',
  },
  {
    id: 'foam', name: 'Styrofoam (EPS)', category: 'Soft', density: 25,
    E: 5 * MPa, G: 2 * MPa, nu: 0.1,
    ft: 0.3 * MPa, fc: 0.15 * MPa, fm: 0.3 * MPa, fv: 0.12 * MPa,
    ductile: false, failure: 'crush', friction: 0.6, restitution: 0.1, imperfection: 300, sound: 'soft',
    visual: { color: '#f6f6f1', roughness: 1, metalness: 0, texture: 'foam' },
    blurb: 'Expanded polystyrene. Almost weightless, but it crushes under about 15 tonnes per m² (0.15 MPa).',
  },
];

const byId = new Map(MATERIALS.map((m) => [m.id, m]));

export function getMaterial(id: string): Material {
  return byId.get(id) ?? byId.get('pine')!;
}

export const CATEGORIES: Category[] = ['Wood', 'Metal', 'Stone & Masonry', 'Glass & Ceramic', 'Plastic & Composite', 'Soft'];

/** The ground: a concrete floor slab. */
export const GROUND_MATERIAL: Material = {
  ...getMaterial('concrete'),
  id: 'ground',
  name: 'Concrete floor',
  fc: 40 * MPa,
};

/** Effective strengths of a material for a member whose axis is parallel or perpendicular to the grain. */
export interface Strengths {
  E: number;
  G: number;
  ft: number;
  fc: number;
  fm: number;
  fv: number;
}

export function strengthsFor(m: Material, alongGrain: boolean): Strengths {
  if (m.ductile) {
    const fy = m.fy ?? m.ft;
    return { E: m.E, G: m.G, ft: fy, fc: fy, fm: fy, fv: 0.577 * fy };
  }
  if (!m.grain || m.grain === 'panel' || alongGrain) {
    return { E: m.E, G: m.G, ft: m.ft, fc: m.fc, fm: m.fm, fv: m.fv };
  }
  // across the grain of solid wood: weak and floppy
  const ftp = m.ftPerp ?? m.ft * 0.05;
  return {
    E: m.Eperp ?? m.E / 20,
    G: m.G * 0.1,
    ft: ftp,
    fc: m.fcPerp ?? m.fc * 0.15,
    fm: ftp * 1.4,
    fv: m.fv * 0.4,
  };
}

/** Bearing (crushing) strength of a material's surface for a load at angle to the grain. */
export function bearingStrength(m: Material, loadAlongGrain: boolean): number {
  if (m.ductile) return 1.5 * (m.fy ?? m.ft); // local yielding under confined bearing
  if (m.grain === 'solid' && !loadAlongGrain) return m.fcPerp ?? m.fc * 0.15;
  if (m.grain === 'panel' && !loadAlongGrain) return m.fcPerp ?? m.fc * 0.3;
  return m.fc;
}

export function formatPa(p: number): string {
  if (p >= 1e9) return (p / 1e9).toFixed(p >= 1e10 ? 0 : 1) + ' GPa';
  if (p >= 1e6) return (p / 1e6).toFixed(p >= 1e8 ? 0 : 1) + ' MPa';
  if (p >= 1e3) return (p / 1e3).toFixed(1) + ' kPa';
  return p.toFixed(0) + ' Pa';
}
