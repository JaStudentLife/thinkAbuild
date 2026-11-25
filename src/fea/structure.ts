import { detectContacts, type ContactPatch } from '../core/contacts';
import type { JointType, PartDef } from '../core/design';
import { analyze, type AnalysisResult, type FailMode, type PartResult } from './analyze';
import { buildModel, type ExternalLoad, type FEModel, type FEPartInfo } from './model';

export interface StructureInput {
  parts: PartDef[];
  jointOf: (a: PartDef, bId: string, b?: PartDef) => JointType;
  loads?: ExternalLoad[];
  tol?: number;
  /** precomputed contact patches (skip detection) */
  patches?: ContactPatch[];
  buckling?: boolean;
  inertiaRelief?: boolean;
  probe?: { part: string; point: [number, number, number]; dir: [number, number, number] };
  /** joint lookup for precomputed patches keyed by patch index (overrides jointOf) */
  patchJoint?: (patch: ContactPatch) => JointType | undefined;
}

export type Status = 'empty' | 'ok' | 'warn' | 'fail' | 'unstable';

export interface PartReport extends PartResult {
  id: string;
  info: FEPartInfo;
  status: Status;
}

export interface StructureResult {
  model: FEModel;
  result: AnalysisResult;
  patches: ContactPatch[];
  byPart: Map<string, PartReport>;
  status: Status;
  worst: PartReport | null;
  minSafety: number;
  failing: PartReport[];
}

export const MODE_LABEL: Record<FailMode, string> = {
  none: 'OK',
  tension: 'Tension',
  compression: 'Crushing',
  bending: 'Bending',
  shear: 'Shear',
  torsion: 'Twisting',
  buckling: 'Buckling',
  bearing: 'Bearing',
  punching: 'Punching',
  joint: 'Joint failure',
  unstable: 'Unstable',
};

export function statusOf(r: PartResult): Status {
  if (r.unstable) return 'unstable';
  if (r.U >= 1) return 'fail';
  if (r.U >= 0.8) return 'warn';
  return 'ok';
}

export function analyzeStructure(input: StructureInput): StructureResult {
  const defs = input.parts.filter((p) => !p.debris);
  const byId = new Map(defs.map((p) => [p.id, p]));
  const patches = input.patches ?? detectContacts(defs, { tol: input.tol ?? 0.004 });
  const model = buildModel({
    parts: defs,
    patches: patches.map((patch) => {
      const a = byId.get(patch.a)!;
      const b = byId.get(patch.b);
      const pj = input.patchJoint?.(patch);
      return { patch, joint: pj ?? input.jointOf(a, patch.b, b) };
    }),
    loads: input.loads,
    inertiaRelief: input.inertiaRelief,
    probe: input.probe,
  });
  const result = analyze(model, { buckling: input.inertiaRelief ? false : input.buckling });
  const byPart = new Map<string, PartReport>();
  let worst: PartReport | null = null;
  const failing: PartReport[] = [];
  let anyUnstable = false;
  model.parts.forEach((info, i) => {
    const r = result.parts[i];
    const rep: PartReport = { ...r, id: info.def.id, info, status: statusOf(r) };
    byPart.set(info.def.id, rep);
    if (rep.unstable) anyUnstable = true;
    if (rep.status === 'fail') failing.push(rep);
    if (!rep.unstable && (!worst || rep.U > worst.U)) worst = rep;
  });
  failing.sort((a, b) => b.U - a.U);
  const w = worst as PartReport | null;
  let status: Status = 'empty';
  if (model.parts.length) {
    status = failing.length ? 'fail' : anyUnstable ? 'unstable' : w && w.U >= 0.8 ? 'warn' : 'ok';
  }
  return { model, result, patches, byPart, status, worst: w, minSafety: w && w.U > 0 ? 1 / w.U : Infinity, failing };
}
