import { z } from 'zod/v4';
import type { SpineDocument } from './document.js';
import { footBakeSchema } from './stability-schema.js';
import { bakeFootContactData } from './foot-contacts.js';
import { bakeAllConstraints } from './world-animation.js';
import { animationSampler } from './animation-sampler.js';
import { constraintList } from './constraint-data.js';
import { sampleSkeleton } from './runtime.js';

export const constraintRepairFields = { constraintMode: z.enum(['reject', 'bake']).default('reject'), physics: z.boolean().default(false), bakeTolerance: z.number().finite().positive().max(100).default(0.05) };
interface Args { input: string; animation: string; newName: string; skin?: string; fps: number; constraintMode: 'reject' | 'bake'; physics: boolean; bakeTolerance: number; rotations: { bone: string; start: number; end?: number; min: number; max: number }[]; contacts?: { chains: z.output<typeof footBakeSchema>['chains']; constraintMode: 'reject' | 'bake'; physics: boolean; tolerance: number; orientationToleranceDegrees: number } }
export function prepareConstraintRepair(source: SpineDocument, args: Args) {
  const constrained = Boolean((source.constraints as unknown[] | undefined)?.length || ['ik', 'transform', 'path', 'physics'].some(k => (source[k] as unknown[] | undefined)?.length));
  if (args.rotations.length && constrained && args.constraintMode !== 'bake') throw new Error('Rotation repair requires an unconstrained rig or explicit constraintMode=bake.');
  if (args.physics && !constrained) throw new Error('physics capture requires a constrained rig.');
  let data = structuredClone(source), contactVerification: any, constraintBake: unknown;
  if (args.contacts) {
    const result = bakeFootContactData(source, footBakeSchema.parse({ ...args.contacts, constraintMode: args.constraintMode === 'bake' ? 'bake' : args.contacts.constraintMode, physics: args.physics || args.contacts.physics, input: args.input, output: 'candidate.json', animation: args.animation, newName: args.newName, skin: args.skin, fps: args.fps })); data = result.data; contactVerification = result.diagnostics; constraintBake = (result.diagnostics as any)?.constraintBake;
  } else if (constrained && args.constraintMode === 'bake') { const result = bakeAllConstraints(source, args.animation, args.newName, { fps: args.fps, skin: args.skin, physics: args.physics, tolerance: args.bakeTolerance }); data = result.data; constraintBake = result.report; }
  else data.animations![args.newName] = structuredClone(source.animations![args.animation]!);
  const bones = new Set(source.bones.map(b => b.name));
  const order = constraintList(source).map((c, index) => { const refs = [c.bone, c.target, c.source, ...(Array.isArray(c.bones) ? c.bones : [])].filter((s): s is string => typeof s === 'string' && bones.has(s)); return { index, name: c.name, type: c.type, declaredBoneReferences: [...new Set(refs)], fullRigCapture: Boolean(constraintBake) }; });
  return { data, contactVerification, constraintBake, didBake: Boolean(constraintBake), physicsCaptured: Boolean(constraintBake) && (args.physics || Boolean(args.contacts?.physics)), order };
}
export function verifyConstraintRepairWorld(source: SpineDocument, output: SpineDocument, args: Args, windows: { bone: string; start: number; end: number }[], times: number[], physics: boolean) {
  const original = animationSampler(source, args.animation, args.skin), after = animationSampler(output, args.newName, args.skin), descendants = (bone: string) => { const set = new Set([bone]); for (const b of source.bones) if (b.parent && set.has(b.parent)) set.add(b.name); return set; };
  const scopes = [...windows.map(w => ({ ...w, bones: descendants(w.bone) })), ...(args.contacts?.chains.flatMap(c => c.contacts.map(w => ({ ...w, bone: c.upper, bones: descendants(c.upper) }))) ?? [])];
  const integrationBudget = physics ? times.reduce((n, t) => n + Math.ceil(t * args.fps), 0) * source.bones.length : 0;
  if (integrationBudget > 1000000) throw new Error('Constraint repair world verification exceeds one million independently-reset bone integration steps. Lower FPS or shorten the animation.');
  let maxUnselectedWorldError = 0, maxOutsideWorldError = 0, verifiedBonePoses = 0;
  const changed = new Set(scopes.flatMap(s => [...s.bones]));
  for (const t of times) {
    const a = physics ? sampleSkeleton(source, args.animation, t, args.skin, undefined, { physics: true, fps: args.fps }) : original.sample(t), b = after.sample(t), active = new Set(scopes.filter(s => t >= s.start && t <= s.end).flatMap(s => [...s.bones]));
    for (let index = 0; index < a.bones.length; index++) {
      const before = a.bones[index]!, next = b.bones[index]!; if (!before.active || active.has(before.data.name)) continue;
      if (!next.active) throw new Error('Constraint repair changed unselected bone activation.');
      const p = before.appliedPose, q = next.appliedPose, error = Math.max(...['worldX', 'worldY', 'a', 'b', 'c', 'd'].map(k => Math.abs((p as any)[k] - (q as any)[k]))); verifiedBonePoses++;
      if (changed.has(before.data.name)) maxOutsideWorldError = Math.max(maxOutsideWorldError, error); else maxUnselectedWorldError = Math.max(maxUnselectedWorldError, error);
    }
  }
  if (Math.max(maxUnselectedWorldError, maxOutsideWorldError) > args.bakeTolerance) throw new Error(`Constraint repair world-pose tolerance exceeded: unrelated ${maxUnselectedWorldError}, outside ${maxOutsideWorldError}, tolerance ${args.bakeTolerance}. Increase sampling density or revise the windows.`);
  return { maxUnselectedWorldError, maxOutsideWorldError, tolerance: args.bakeTolerance, verifiedBonePoses, checkedSamples: times.length, independentResetIntegrationSteps: integrationBudget, affectedBoneClosure: [...changed], constraintDefinitionsPreserved: JSON.stringify(source.constraints) === JSON.stringify(output.constraints), scope: 'Selected bones and descendants may change only in their explicit repair/contact windows. Other world matrices match the source within the finite-sample tolerance. Constraints are baked/disabled only in the new animation; no live constraint solving is claimed.' };
}
