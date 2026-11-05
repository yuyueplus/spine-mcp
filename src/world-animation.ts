import { animationDuration, sampleTimes, tracks } from './advanced-animation.js';
import { parseDocument, type JsonObject, type SpineDocument } from './document.js';
import { sampleSkeleton } from './runtime.js';
import { appendSlotKeys, createSkeleton, finishSlotKeys, identity, inverse, isolatedAnimation, matrix, matrixError, mul, prepareBoneChannels, prepareSlotChannels, skeletonState, solveWorldKeys, validateBaked, type Matrix } from './animation-baking.js';

export interface BakeOptions { fps?: number; skin?: string; physics?: boolean; tolerance?: number }
export function coalesceBakingTimes(values: number[]) {
  const result: number[] = []; let anchor = 0;
  for (const time of [...new Set(values.map(Math.fround))].sort((a, b) => a - b)) {
    const previous = result.at(-1);
    if (previous !== undefined && time - previous <= 0.000001) {
      if (time - anchor > 0.000001) throw new Error('A dense sub-microsecond key cluster cannot be baked safely.');
      if (previous !== 0) result[result.length - 1] = time;
    } else { result.push(time); anchor = time; }
  }
  return result;
}
export function bakingTimes(data: SpineDocument, animation: string, fps = 60) {
  const original = data.animations?.[animation]; if (!original) throw new Error('Source animation missing.');
  const times = coalesceBakingTimes([...sampleTimes(0, animationDuration(original), fps, 1000), ...tracks(data, original).flatMap(track => track.frames.map(key => Number(key.time ?? 0)))]);
  if (times.length > 1500 || times.length * data.bones.length > 200000) throw new Error('Animation baking exceeds 1500 frames or 200,000 bone samples.');
  return times;
}
export function normalizedBoneName(name: string) { return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/mixamorig|bip\d*/g, '').split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean).map(word => word === 'left' ? 'l' : word === 'right' ? 'r' : word).sort().join('_'); }
export function planRetarget(source: SpineDocument, target: SpineDocument, explicit: Record<string, string> = {}, autoMap = true) {
  const mapping = { ...explicit }, used = new Set<string>(), ambiguous: { source: string; candidates: string[] }[] = [];
  for (const [from, to] of Object.entries(mapping)) { if (!source.bones.some(b => b.name === from) || !target.bones.some(b => b.name === to) || used.has(to)) throw new Error('Retarget map must name existing bones and distinct targets.'); used.add(to); }
  if (autoMap) for (const bone of source.bones) {
    if (Object.hasOwn(mapping, bone.name)) continue;
    const candidates = target.bones.filter(b => !used.has(b.name) && b.name === bone.name), fallback = candidates.length ? candidates : target.bones.filter(b => !used.has(b.name) && normalizedBoneName(b.name) === normalizedBoneName(bone.name));
    if (fallback.length === 1) { mapping[bone.name] = fallback[0]!.name; used.add(fallback[0]!.name); } else if (fallback.length > 1) ambiguous.push({ source: bone.name, candidates: fallback.map(b => b.name) });
  }
  const reverse = new Map(Object.entries(mapping).map(([a, b]) => [b, a])), sourceParents = new Map(source.bones.map(b => [b.name, b.parent])), targetParents = new Map(target.bones.map(b => [b.name, b.parent])), hierarchyConflicts: { source: string; target: string; mappedAncestor: string }[] = [];
  for (const [from, to] of Object.entries(mapping)) {
    let ancestor = targetParents.get(to); while (ancestor && !reverse.has(ancestor)) ancestor = targetParents.get(ancestor);
    if (!ancestor) continue; let parent = sourceParents.get(from); while (parent && parent !== reverse.get(ancestor)) parent = sourceParents.get(parent);
    if (!parent) hierarchyConflicts.push({ source: from, target: to, mappedAncestor: ancestor });
  }
  const ratios = Object.entries(mapping).flatMap(([from, to]) => { const a = Number(source.bones.find(b => b.name === from)!.length ?? 0), b = Number(target.bones.find(b => b.name === to)!.length ?? 0); return a > 1e-7 && b > 1e-7 ? [b / a] : []; }).sort((a, b) => a - b);
  return { mapping, mappedBones: Object.keys(mapping).length, ambiguous, hierarchyConflicts, unmappedSource: source.bones.filter(b => !mapping[b.name]).map(b => b.name), unmappedTarget: target.bones.filter(b => !used.has(b.name)).map(b => b.name), suggestedRootTranslationScale: ratios.length ? ratios[Math.floor(ratios.length / 2)]! : 1, automaticMappingsAreSuggestions: true };
}
export function retargetAnimation(source: SpineDocument, target: SpineDocument, animation: string, newName: string, options: BakeOptions & { sourceSkin?: string; boneMap?: Record<string, string>; autoMap?: boolean; translationScale?: number }) {
  const plan = planRetarget(source, target, options.boneMap, options.autoMap ?? true);
  if (!plan.mappedBones || plan.ambiguous.length || plan.hierarchyConflicts.length) throw new Error('Retarget mapping is empty, ambiguous or violates ancestor correspondence. Inspect spine_plan_retarget and provide an explicit map.');
  const fps = options.fps ?? 60, times = bakingTimes(source, animation, fps), data = isolatedAnimation(target, newName), driver = structuredClone(data), output = data.animations![newName]!, sourceSetup = sampleSkeleton(source, undefined, 0, options.sourceSkin), targetSetup = sampleSkeleton(target, undefined, 0, options.skin), sourceRest = new Map(sourceSetup.bones.map(b => [b.data.name, matrix(b.appliedPose)])), targetRest = new Map(targetSetup.bones.map(b => [b.data.name, matrix(b.appliedPose)])), reverse = new Map(Object.entries(plan.mapping).map(([a, b]) => [b, a]));
  const rootScale = options.translationScale ?? plan.suggestedRootTranslationScale; if (!Number.isFinite(rootScale) || rootScale <= 0 || rootScale > 1000) throw new Error('translationScale must be positive and at most 1000.');
  const selected = target.bones.filter(b => reverse.has(b.name)); prepareBoneChannels(output, selected.map(b => b.name));
  if (options.physics && times.reduce((sum, time) => sum + Math.ceil(time * fps), 0) * source.bones.length > 500000) throw new Error('Physics retarget exceeds the simulation budget.');
  const samples: { time: number; desired: Map<string, Matrix> }[] = [];
  for (const time of times) {
    const sourcePose = sampleSkeleton(source, animation, time, options.sourceSkin, undefined, { physics: options.physics, fps }), sourceCurrent = new Map(sourcePose.bones.map(b => [b.data.name, matrix(b.appliedPose)])), desired = new Map<string, Matrix>(), targetPose = sampleSkeleton(driver, newName, time, options.skin);
    for (const bone of selected) {
      const from = reverse.get(bone.name)!; if (!sourcePose.bones.find(b => b.data.name === from)?.active) throw new Error(`Source retarget bone is inactive: ${from}`);
      let parent = bone.parent; while (parent && !reverse.has(parent)) parent = target.bones.find(b => b.name === parent)?.parent;
      const sourceParent = parent ? reverse.get(parent)! : undefined, sourceBase = sourceParent ? sourceRest.get(sourceParent)! : identity, targetBase = parent ? targetRest.get(parent)! : identity;
      const sr = mul(inverse(sourceBase), sourceRest.get(from)!), sp = mul(inverse(sourceParent ? sourceCurrent.get(sourceParent)! : identity), sourceCurrent.get(from)!), tr = mul(inverse(targetBase), targetRest.get(bone.name)!);
      const delta = mul({ ...sp, x: 0, y: 0 }, inverse({ ...sr, x: 0, y: 0 })), local = mul(delta, { ...tr, x: 0, y: 0 }), sourceLength = Math.hypot(sr.x, sr.y), targetLength = Math.hypot(tr.x, tr.y), scale = parent && sourceLength > 1e-7 && targetLength > 1e-7 ? targetLength / sourceLength : rootScale;
      local.x = tr.x + (sp.x - sr.x) * scale; local.y = tr.y + (sp.y - sr.y) * scale;
      desired.set(bone.name, mul(parent ? desired.get(parent)! : identity, local));
    }
    solveWorldKeys(output, targetPose, desired, time); samples.push({ time, desired });
  }
  parseDocument(data); let maxError = 0; for (const sample of samples) { const error = matrixError(sampleSkeleton(data, newName, sample.time, options.skin), sample.desired); if (error > (options.tolerance ?? 0.01)) throw new Error(`Retarget world/local reconstruction exceeds tolerance at ${sample.time}s (${error}).`); maxError = Math.max(maxError, error); }
  return { data, report: { ...plan, fps, frames: times.length, rootTranslationScale: rootScale, maxWorldReconstructionError: maxError, constraintsDisabledOnlyInNewAnimation: true, note: 'Rest-relative transforms through matched ancestors; not IK foot-contact solving. Source attachments/events are not transferred by this motion tool.' } };
}

function sidePartner(name: string) { const replacements: [RegExp, string][] = [[/left/i, 'right'], [/right/i, 'left'], [/(^|[_ .-])l(?=$|[_ .-])/i, '$1r'], [/(^|[_ .-])r(?=$|[_ .-])/i, '$1l']]; for (const [pattern, replacement] of replacements) if (pattern.test(name)) return name.replace(pattern, replacement); return name; }
export function worldMirror(source: SpineDocument, animation: string, newName: string, options: BakeOptions & { axis: 'x' | 'y'; pivotX?: number; pivotY?: number; swapSides?: boolean; boneMap?: Record<string, string>; bones?: string[] }) {
  const times = bakingTimes(source, animation, options.fps), sourceNames = options.bones ?? source.bones.map(b => b.name), names = new Set(source.bones.map(b => b.name)), mapping: Record<string, string> = {};
  if (options.physics && times.reduce((sum, time) => sum + Math.ceil(time * (options.fps ?? 60)), 0) * source.bones.length > 500000) throw new Error('Physics mirror exceeds the simulation budget.');
  if (!sourceNames.length || new Set(sourceNames).size !== sourceNames.length || sourceNames.some(name => !names.has(name))) throw new Error('Mirror bones must be distinct existing names.');
  for (const name of sourceNames) { const counterpart = sidePartner(name), match = source.bones.find(b => b.name.toLowerCase() === counterpart.toLowerCase())?.name; mapping[name] = options.boneMap?.[name] ?? (options.swapSides && match ? match : name); }
  if (new Set(Object.values(mapping)).size !== sourceNames.length || Object.values(mapping).some(name => !names.has(name))) throw new Error('Mirror map needs distinct existing target bones. Supply both directions for swaps.');
  const reflection: Matrix = options.axis === 'x' ? { a: -1, b: 0, c: 0, d: 1, x: 2 * (options.pivotX ?? 0), y: 0 } : { a: 1, b: 0, c: 0, d: -1, x: 0, y: 2 * (options.pivotY ?? 0) };
  let data = isolatedAnimation(source, newName, source.animations![animation]); const driver = structuredClone(data), output = data.animations![newName]!; prepareBoneChannels(output, source.bones.map(b => b.name)); prepareSlotChannels(output);
  const orders: { time: number; order: string[] }[] = [], samples: { time: number; state: ReturnType<typeof skeletonState> }[] = []; let coordinates = 0;
  for (const time of times) {
    const posed = sampleSkeleton(source, animation, time, options.skin, undefined, { physics: options.physics, fps: options.fps }), original = new Map(posed.bones.filter(b => b.active).map(b => [b.data.name, matrix(b.appliedPose)])), desired = new Map(original);
    for (const [from, to] of Object.entries(mapping)) { if (!original.has(from) || !original.has(to)) throw new Error('Mirror requires active mapped bones.'); desired.set(to, mul(reflection, original.get(from)!)); }
    appendSlotKeys(data, output, posed, time, orders); solveWorldKeys(output, sampleSkeleton(driver, newName, time, options.skin), desired, time);
    for (const bone of posed.bones) { const m = desired.get(bone.data.name); if (m) Object.assign(bone.appliedPose, { a: m.a, b: m.b, c: m.c, d: m.d, worldX: m.x, worldY: m.y }); }
    const state = skeletonState(posed); coordinates += state.values.length; if (coordinates > 5_000_000) throw new Error('Mirror validation exceeds five million coordinates.'); samples.push({ time, state });
  }
  data = finishSlotKeys(parseDocument(data), newName, orders); const error = validateBaked(data, newName, samples, options.skin, options.tolerance ?? 0.01);
  return { data, report: { mapping, frames: times.length, maxSampledError: error, space: 'world', constraintsDisabledOnlyInNewAnimation: true, otherAnimationsPreserved: true } };
}

export function bakeAllConstraints(source: SpineDocument, animation: string, newName: string, options: BakeOptions) {
  const times = bakingTimes(source, animation, options.fps); let data = isolatedAnimation(source, newName, source.animations![animation]); const driver = structuredClone(data), output = data.animations![newName]!; prepareBoneChannels(output, source.bones.map(b => b.name)); prepareSlotChannels(output);
  const orders: { time: number; order: string[] }[] = [], samples: { time: number; state: ReturnType<typeof skeletonState> }[] = []; let coordinates = 0;
  if (options.physics && times.reduce((sum, time) => sum + Math.ceil(time * (options.fps ?? 60)), 0) * source.bones.length > 500000) throw new Error('Constraint physics bake exceeds the simulation budget.');
  for (const time of times) { const posed = sampleSkeleton(source, animation, time, options.skin, undefined, { physics: options.physics, fps: options.fps }), desired = new Map(posed.bones.filter(b => b.active).map(b => [b.data.name, matrix(b.appliedPose)])); solveWorldKeys(output, sampleSkeleton(driver, newName, time, options.skin), desired, time); appendSlotKeys(data, output, posed, time, orders); const state = skeletonState(posed); coordinates += state.values.length; if (coordinates > 5_000_000) throw new Error('Constraint bake exceeds five million validation coordinates.'); samples.push({ time, state }); }
  data = finishSlotKeys(parseDocument(data), newName, orders); const error = validateBaked(data, newName, samples, options.skin, options.tolerance ?? 0.01);
  return { data, report: { frames: times.length, maxSampledError: error, fullRigCapture: true, includesSlotColorAttachmentsAndDeform: true, constraintsDisabledOnlyInNewAnimation: true } };
}
