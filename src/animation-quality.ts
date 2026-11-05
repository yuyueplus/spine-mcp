import { MixFrom, Physics } from '@esotericsoftware/spine-core';
import { animationDuration, tracks } from './advanced-animation.js';
import { createSkeleton, skeletonState, stateDifference } from './animation-baking.js';
import { sampleSkeleton } from './runtime.js';
import { simplifyAnimation } from './production-quality.js';
import { safeName, parseDocument, type SpineDocument } from './document.js';

export interface AdaptiveOptions { start?: number; end?: number; tolerance?: number; maxDepth?: number; minDepth?: number; maxSamples?: number; skin?: string; otherSkin?: string }
export function compareAdaptive(a: SpineDocument, aName: string, b: SpineDocument, bName: string, options: AdaptiveOptions = {}) {
  const left = a.animations?.[aName], right = b.animations?.[bName]; if (!left || !right) throw new Error('Both comparison animations must exist.');
  const start = options.start ?? 0, end = options.end ?? Math.max(animationDuration(left), animationDuration(right)), tolerance = options.tolerance ?? 0.01, maxDepth = options.maxDepth ?? 10, minDepth = options.minDepth ?? 2, maxSamples = options.maxSamples ?? 2000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 300 || !Number.isFinite(tolerance) || tolerance <= 0 || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 16 || !Number.isInteger(minDepth) || minDepth < 0 || minDepth > maxDepth || !Number.isInteger(maxSamples) || maxSamples < 5 || maxSamples > 10000) throw new Error('Invalid adaptive comparison range, depth, tolerance or sample budget.');
  const boundaries = [...new Set([start, end, ...tracks(a, left).flatMap(t => t.frames.map(k => Number(k.time ?? 0))), ...tracks(b, right).flatMap(t => t.frames.map(k => Number(k.time ?? 0)))].filter(t => t >= start && t <= end))].sort((a, b) => a - b);
  type Point = { time: number; delta: number[] | null; error: number; signature: string };
  const cache = new Map<number, Point>(); let compatible = true, maxError = 0, peakTime = start, coordinates = 0, budgetExhausted = false;
  const sample = (time: number): Point | undefined => {
    const known = cache.get(time); if (known) return known;
    if (cache.size >= maxSamples || (cache.size + 1) * (a.bones.length + b.bones.length) > 500000) { budgetExhausted = true; return undefined; }
    const sa = skeletonState(sampleSkeleton(a, aName, time, options.skin)), sb = skeletonState(sampleSkeleton(b, bName, time, options.otherSkin ?? options.skin)), error = stateDifference(sa, sb);
    coordinates += sa.values.length; if (coordinates > 5_000_000) { budgetExhausted = true; return undefined; }
    const delta = Number.isFinite(error) ? sa.values.map((n, i) => n - sb.values[i]!) : null; compatible &&= delta !== null;
    if (Number.isFinite(error) && error > maxError) { maxError = error; peakTime = time; }
    const point = { time, delta, error, signature: JSON.stringify(sa.signature) }; cache.set(time, point); return point;
  };
  const unresolved: { start: number; end: number; reason: string }[] = [];
  const visit = (start: number, end: number, depth: number): void => {
    const left = sample(start), right = sample(end), middle = sample((start + end) / 2);
    if (!left || !right || !middle) { unresolved.push({ start, end, reason: 'sample-budget' }); return; }
    let curvature = 0;
    if (left.delta && middle.delta && right.delta && left.delta.length === middle.delta.length && left.delta.length === right.delta.length && left.signature === middle.signature && left.signature === right.signature) for (let i = 0; i < left.delta.length; i++) curvature = Math.max(curvature, Math.abs(middle.delta[i]! - (left.delta[i]! + right.delta[i]!) / 2));
    else if (middle.error !== 0 || left.error !== 0 || right.error !== 0) curvature = Infinity;
    if (depth < minDepth || curvature > tolerance / 4) { if (depth >= maxDepth) { unresolved.push({ start, end, reason: 'depth-limit' }); return; } visit(start, middle.time, depth + 1); visit(middle.time, end, depth + 1); }
  };
  for (let i = 1; i < boundaries.length; i++) { if (budgetExhausted) { unresolved.push({ start: boundaries[i - 1]!, end: boundaries[i]!, reason: 'sample-budget' }); continue; } visit(boundaries[i - 1]!, boundaries[i]!, 0); }
  const complete = !unresolved.length && !budgetExhausted;
  return { compatible, withinTolerance: complete && compatible && maxError <= tolerance, complete, maxSampledError: compatible ? maxError : null, peakTime, tolerance, samples: cache.size, evaluatedTimes: [...cache.keys()].sort((a, b) => a - b), unresolvedIntervals: unresolved.slice(0, 100), unresolvedCount: unresolved.length, maxDepth, minDepth, budgetExhausted, continuousTimeProof: false, note: 'Adaptive subdivision of the measured difference, seeded by both animations key times. This is empirical sampling; an unresolved interval never counts as passed.' };
}
export function simplifyAdaptive(source: SpineDocument, animation: string, newName: string, options: AdaptiveOptions & { fps?: number }) {
  safeName(newName); if (source.animations?.[newName]) throw new Error('Simplification destination exists.'); const original = source.animations?.[animation]; if (!original) throw new Error('Source animation missing.');
  const duration = animationDuration(original); if (duration <= 0) throw new Error('Adaptive simplification needs a positive duration.'); const tolerance = options.tolerance ?? 0.01; let lastReport: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { const candidate = simplifyAnimation(source, animation, newName, { fps: options.fps ?? 60, skin: options.skin, tolerance: tolerance / 2 ** attempt }), comparison = compareAdaptive(source, animation, candidate.data, newName, { ...options, start: 0, end: duration, tolerance }); lastReport = comparison;
      if (comparison.withinTolerance) return { data: candidate.data, report: { ...candidate.report, tolerance, adaptiveValidation: comparison, fallbackToOriginal: false, attempts: attempt + 1 } };
    } catch (error) { if (!/Simplification exceeds world-space tolerance/.test((error as Error).message)) throw error; lastReport = { error: (error as Error).message }; }
  }
  const data = structuredClone(source); (data.animations ??= {})[newName] = structuredClone(original); parseDocument(data);
  const validation = compareAdaptive(source, animation, data, newName, { ...options, start: 0, end: duration, tolerance }); if (!validation.withinTolerance) throw new Error('Adaptive validation budget is insufficient even for the unchanged animation. Increase maxSamples or reduce the range.');
  return { data, report: { removedKeys: 0, fallbackToOriginal: true, adaptiveValidation: validation, reductionAttempt: lastReport, note: 'No safe reduction found; all original keys retained in the new animation.' } };
}

export function checkPhysicsCycles(data: SpineDocument, name: string, options: { skin?: string; fps?: number; warmupCycles?: number; checkedCycles?: number; tolerance?: number } = {}) {
  const original = data.animations?.[name]; if (!original) throw new Error('Animation missing.'); const duration = animationDuration(original), fps = options.fps ?? 60, warmup = options.warmupCycles ?? 2, checked = options.checkedCycles ?? 3, tolerance = options.tolerance ?? 0.01;
  if (duration <= 0 || duration > 300 || !Number.isInteger(fps) || fps < 1 || fps > 120 || !Number.isInteger(warmup) || warmup < 0 || warmup > 50 || !Number.isInteger(checked) || checked < 2 || checked > 20 || !Number.isFinite(tolerance) || tolerance <= 0) throw new Error('Invalid repeated-physics duration, FPS, cycles or tolerance.');
  const steps = Math.ceil(duration * fps), cycles = warmup + checked, dt = duration / steps;
  if (steps > 1500 || cycles * steps * data.bones.length > 500000) throw new Error('Repeated physics exceeds 1500 steps per cycle or 500,000 bone steps.');
  const skeleton = createSkeleton(data, options.skin), animation = skeleton.data.findAnimation(name)!; animation.apply(skeleton, -1, 0, true, null, 1, MixFrom.setup, false, false, false); skeleton.updateWorldTransform(Physics.reset);
  let previous: ReturnType<typeof skeletonState>[] | undefined, maxDifference = 0, compatible = true; const comparisons: { cycle: number; maxDifference: number | null }[] = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    const states: ReturnType<typeof skeletonState>[] = []; let coordinates = 0;
    for (let step = 1; step <= steps; step++) { const before = (cycle * steps + step - 1) * dt, time = (cycle * steps + step) * dt; skeleton.setupPose(); animation.apply(skeleton, before, time, true, null, 1, MixFrom.setup, false, false, false); skeleton.update(dt); skeleton.updateWorldTransform(Physics.update); if (cycle >= warmup) { const state = skeletonState(skeleton); coordinates += state.values.length; if (coordinates > 5_000_000) throw new Error('Physics cycle exceeds five million stored coordinates.'); states.push(state); } }
    if (cycle < warmup) continue;
    if (previous) { let error = 0; for (let i = 0; i < steps; i++) error = Math.max(error, stateDifference(previous[i]!, states[i]!)); compatible &&= Number.isFinite(error); if (Number.isFinite(error)) maxDifference = Math.max(maxDifference, error); comparisons.push({ cycle: cycle + 1, maxDifference: Number.isFinite(error) ? error : null }); }
    previous = states;
  }
  return { animation: name, duration, fps, actualStep: dt, warmupCycles: warmup, checkedCycles: checked, simulatedCycles: cycles, sampledPhases: steps, compatible, maxCycleDifference: compatible ? maxDifference : null, converged: compatible && maxDifference <= tolerance, tolerance, comparisons, continuousOrFutureStabilityProof: false, note: 'One physics reset at the beginning; later cycles retain solver state and use normal looping timelines. Convergence applies only to the sampled phases and checked cycles.' };
}
