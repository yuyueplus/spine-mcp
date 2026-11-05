import { MeshAttachment, RegionAttachment, VertexAttachment } from '@esotericsoftware/spine-core';
import { sampleSkeleton } from './runtime.js';
import { animationDuration, sampleTimes, tracks, at } from './advanced-animation.js';
import { parseDocument, object, safeName, type SpineDocument, type JsonObject } from './document.js';
import { constraintList, disabledParameterKey } from './constraint-data.js';
import { setConstraintTimeline } from './constraint-edits.js';
import { writePath } from './timeline-tools.js';

export function sampleState(data: SpineDocument, animation: string, time: number, skin?: string, physics = false, fps = 60) {
  const skeleton = sampleSkeleton(data, animation, time, skin, undefined, { physics, fps }), values: number[] = [], signature: string[] = [];
  for (const bone of skeleton.bones) if (bone.active) { const p = bone.appliedPose; signature.push(`bone:${bone.data.name}`); values.push(p.worldX, p.worldY, p.a, p.b, p.c, p.d); }
  for (const slot of skeleton.drawOrder.appliedPose) {
    const pose = slot.appliedPose, attachment = pose.attachment; signature.push(`${slot.data.name}:${attachment?.name ?? ''}`); values.push(pose.color.r, pose.color.g, pose.color.b, pose.color.a); if (pose.darkColor) values.push(pose.darkColor.r, pose.darkColor.g, pose.darkColor.b);
    if (attachment instanceof RegionAttachment) { const vertices = new Array<number>(8); attachment.computeWorldVertices(slot, attachment.getOffsets(pose), vertices, 0, 2); values.push(...vertices); }
    else if (attachment instanceof VertexAttachment) { const vertices = new Array<number>(attachment.worldVerticesLength); attachment.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2); values.push(...vertices); if (attachment instanceof MeshAttachment) signature.push(JSON.stringify(attachment.triangles)); }
    if (values.length > 100000) throw new Error('State comparison exceeds 100,000 geometry/color coordinates per pose.');
  }
  if (values.some(value => !Number.isFinite(value))) throw new Error('Sampled state contains non-finite values.');
  return { values, signature };
}
export function stateError(left: ReturnType<typeof sampleState>, right: ReturnType<typeof sampleState>) {
  if (JSON.stringify(left.signature) !== JSON.stringify(right.signature) || left.values.length !== right.values.length) return { compatible: false, maxError: null as number | null };
  let error = 0; left.values.forEach((value, index) => { error = Math.max(error, Math.abs(value - right.values[index]!)); }); return { compatible: true, maxError: error };
}
export function checkVisualLoop(data: SpineDocument, name: string, options: { skin?: string; start?: number; end?: number; fps?: number; physics?: boolean; tolerance?: number }) {
  const animation = data.animations?.[name]; if (!animation) throw new Error('Animation missing.');
  const start = options.start ?? 0, end = options.end ?? animationDuration(animation), fps = options.fps ?? 60, h = Math.min(1 / fps, (end - start) / 4);
  if (end <= start || end > 300 || start < 0) throw new Error('Loop check requires 0 <= start < end <= 300.');
  if (options.physics && Math.ceil(end * fps) * data.bones.length * 4 > 500000) throw new Error('Loop physics check exceeds simulation budget.');
  const states = [start, start + h, end - h, end].map(time => sampleState(data, name, time, options.skin, options.physics, fps)), pose = stateError(states[0]!, states[3]!);
  let velocityError: number | null = null; if (pose.compatible && states.every(state => state.values.length === states[0]!.values.length && JSON.stringify(state.signature) === JSON.stringify(states[0]!.signature))) { velocityError = 0; states[0]!.values.forEach((value, index) => { velocityError = Math.max(velocityError!, Math.abs((states[1]!.values[index]! - value) / h - (states[3]!.values[index]! - states[2]!.values[index]!) / h)); }); }
  return { animation: name, start, end, samples: 4, ...pose, poseContinuous: pose.compatible && pose.maxError! <= (options.tolerance ?? 0.001), maxVelocityDifference: velocityError, physics: Boolean(options.physics), note: 'World bone matrices, attachment vertices, tint and draw order are sampled. Velocity is a one-sided finite difference; physics is simulated from reset at time zero, not a proof of steady-state repeated-loop dynamics.' };
}
function numericValues(key: JsonObject, defaults: JsonObject) { return Object.entries(defaults).map(([field, fallback]) => Number(key[field] ?? fallback)); }
export function simplifyAnimation(source: SpineDocument, name: string, newName: string, options: { fps?: number; tolerance?: number; skin?: string }) {
  safeName(newName); if (Object.hasOwn(source.animations ?? {}, newName)) throw new Error('Simplified animation destination exists.'); const original = source.animations?.[name]; if (!original) throw new Error('Animation missing.');
  const fps = options.fps ?? 60, tolerance = options.tolerance ?? 0.001, duration = animationDuration(original), grid = sampleTimes(0, duration, fps, 1000), data = structuredClone(source), output = structuredClone(original);
  let before = 0, after = 0;
  for (const track of tracks(source, original)) {
    before += track.frames.length;
    if (!track.frames.length || !track.defaults || Object.values(track.defaults).some(value => typeof value !== 'number') || track.discrete || track.event) { after += track.frames.length; continue; }
    const times = [...new Set([...grid.filter(time => time >= Number(track.frames[0]!.time ?? 0)), ...track.frames.map(key => Number(key.time ?? 0))])].sort((a, b) => a - b), sampled = times.map(time => at(track, time)), vectors = sampled.map(key => numericValues(key, track.defaults!)), keep = new Set([0, times.length - 1]);
    // Stepped transitions must retain their original keys and curve semantics.
    if (track.frames.some(key => key.curve === 'stepped')) { after += track.frames.length; continue; }
    const stack: [number, number][] = [[0, times.length - 1]];
    while (stack.length) { const [a, b] = stack.pop()!; let worst = -1, error = tolerance / 4; for (let i = a + 1; i < b; i++) { const f = (times[i]! - times[a]!) / (times[b]! - times[a]!), e = Math.max(...vectors[i]!.map((value, c) => Math.abs(value - vectors[a]![c]! - (vectors[b]![c]! - vectors[a]![c]!) * f))); if (e > error) { error = e; worst = i; } } if (worst >= 0) { keep.add(worst); stack.push([a, worst], [worst, b]); } }
    const reduced = [...keep].sort((a, b) => a - b).map(index => { const key = sampled[index]!; delete key.curve; return key; });
    // Never increase a channel's key count merely to linearize its curves.
    if (reduced.length < track.frames.length) { writePath(output, track.path as string[], reduced); after += reduced.length; } else after += track.frames.length;
  }
  (data.animations ??= {})[newName] = output; parseDocument(data);
  const times = [...new Set([...grid, ...grid.slice(1).map((time, index) => (time + grid[index]!) / 2), ...tracks(source, original).flatMap(track => track.frames.map(key => Number(key.time ?? 0)))])].sort((a, b) => a - b);
  if (times.length * source.bones.length > 200000) throw new Error('Simplification validation exceeds 200,000 bone samples.'); let maxError = 0;
  for (const time of times) { const comparison = stateError(sampleState(source, name, time, options.skin), sampleState(data, newName, time, options.skin)); if (!comparison.compatible || comparison.maxError! > tolerance) throw new Error(`Simplification exceeds world-space tolerance at ${time}s. Lower the reduction tolerance or increase FPS.`); maxError = Math.max(maxError, comparison.maxError!); }
  return { data, report: { originalKeys: before, resultingKeys: after, removedKeys: before - after, maxSampledError: maxError, validatedSamples: times.length, tolerance, fps, note: 'Error bound applies to the reported sampling grid, midpoints and original key times. It is not a mathematical bound between samples.' } };
}
export function selectiveBake(source: SpineDocument, name: string, newName: string, identities: string[], options: { fps?: number; skin?: string; physics?: boolean; tolerance?: number }) {
  safeName(newName); if (Object.hasOwn(source.animations ?? {}, newName)) throw new Error('Bake destination animation exists.'); const original = source.animations?.[name]; if (!original) throw new Error('Animation missing.');
  const constraints = constraintList(source).filter(c => identities.includes(`${c.type}/${c.name}`)); if (constraints.length !== identities.length) throw new Error('Constraint selection contains missing or duplicate identities.');
  const bones = new Set<string>(); for (const c of constraints) { for (const bone of Array.isArray(c.bones) ? c.bones : [c.bone]) if (typeof bone === 'string') bones.add(bone); if (c.type === 'slider') { const slider = object(source.animations?.[String(c.animation)] ?? {}, 'slider animation'); if (Object.keys(slider).some(field => !['bones', 'color'].includes(field))) throw new Error('Selective Slider bake supports bone-only source animations.'); for (const bone of Object.keys(object(slider.bones ?? {}, 'bones'))) bones.add(bone); } }
  const fps = options.fps ?? 60, times = sampleTimes(0, animationDuration(original), fps, 1000); if (times.length * source.bones.length * 3 > 200000) throw new Error('Selective bake exceeds the sampling budget.');
  if (options.physics && times.reduce((sum, time) => sum + Math.ceil(time * fps), 0) * source.bones.length * 3 > 500000) throw new Error('Selective physics bake exceeds the simulation budget.');
  let data = structuredClone(source); (data.animations ??= {})[newName] = structuredClone(original);
  for (const c of constraints) {
    const type = String(c.type);
    if (type === 'ik' || type === 'transform') { const key = disabledParameterKey(c); data = setConstraintTimeline(data, newName, String(c.name), 'parameters', key ? [key] : [], type); }
    else if (type === 'path') data = setConstraintTimeline(data, newName, String(c.name), 'mix', [{ time: 0, mixRotate: 0, mixX: 0, mixY: 0 }], 'path');
    else data = setConstraintTimeline(data, newName, String(c.name), 'mix', [{ time: 0, value: 0 }], type as 'physics' | 'slider');
  }
  const output = data.animations![newName]!, channels = object(output.bones ??= {}, 'bones');
  for (const bone of bones) { const inherit = (channels[bone] as JsonObject | undefined)?.inherit; channels[bone] = { rotate: [], translate: [], scale: [], shear: [], ...(inherit ? { inherit } : {}) }; }
  for (const time of times) {
    const skeleton = sampleSkeleton(source, name, time, options.skin, undefined, { physics: options.physics, fps });
    for (const bone of skeleton.bones.filter(bone => bones.has(bone.data.name))) { const pose = bone.appliedPose; pose.updateLocalTransform(skeleton); const setup = bone.data.setupPose, target = object(channels[bone.data.name], 'channels'); if (!setup.scaleX || !setup.scaleY) throw new Error('Bake requires nonzero setup scale.');
      const previous = Number((target.rotate as JsonObject[]).at(-1)?.value ?? pose.rotation - setup.rotation), rotation = pose.rotation - setup.rotation; (target.rotate as JsonObject[]).push({ time, value: rotation + 360 * Math.round((previous - rotation) / 360) });
      (target.translate as JsonObject[]).push({ time, x: pose.x - setup.x, y: pose.y - setup.y }); (target.scale as JsonObject[]).push({ time, x: pose.scaleX / setup.scaleX, y: pose.scaleY / setup.scaleY }); (target.shear as JsonObject[]).push({ time, x: pose.shearX - setup.shearX, y: pose.shearY - setup.shearY });
    }
  }
  parseDocument(data); let maxError = 0;
  for (const time of times) { const result = stateError(sampleState(source, name, time, options.skin, options.physics, fps), sampleState(data, newName, time, options.skin, options.physics, fps)); if (!result.compatible || result.maxError! > (options.tolerance ?? 0.01)) throw new Error(`Remaining constraints interact with baked bones at ${time}s; select the complete interacting constraint group.`); maxError = Math.max(maxError, result.maxError!); }
  return { data, report: { constraints: identities, bones: [...bones], frames: times.length, maxSampledError: maxError, otherAnimationsPreserved: true } };
}
