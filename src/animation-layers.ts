import { MixFrom, Physics, type Skeleton } from '@esotericsoftware/spine-core';
import { animationDuration, sampleTimes, tracks } from './advanced-animation.js';
import { createSkeleton, isolatedAnimation, prepareBoneChannels, prepareSlotChannels, solveWorldKeys, matrix, appendSlotKeys, finishSlotKeys, skeletonState, validateBaked } from './animation-baking.js';
import { parseDocument, object, type SpineDocument, type JsonObject } from './document.js';
import { sampleSkeleton } from './runtime.js';
import { coalesceBakingTimes } from './world-animation.js';

export interface AnimationLayer { animation: string; start?: number; end?: number; sourceStart?: number; timeScale?: number; weight?: number; fadeIn?: number; fadeOut?: number; mode?: 'override' | 'additive'; loop?: boolean; bones?: string[]; slots?: string[]; includeDrawOrder?: boolean; includeEvents?: boolean; discreteThreshold?: number }
type ResolvedLayer = AnimationLayer & { start: number; end: number; sourceStart: number; timeScale: number; weight: number; fadeIn: number; fadeOut: number; discreteThreshold: number; sourceDuration: number; full: string; continuous: string };
function maskedAnimation(original: JsonObject, layer: AnimationLayer, continuous: boolean) {
  const value = structuredClone(original), masked = layer.bones !== undefined || layer.slots !== undefined;
  if (masked) {
    if (layer.bones) value.bones = Object.fromEntries(Object.entries(object(value.bones ?? {}, 'bones')).filter(([name]) => layer.bones!.includes(name))); else delete value.bones;
    if (layer.slots) { value.slots = Object.fromEntries(Object.entries(object(value.slots ?? {}, 'slots')).filter(([name]) => layer.slots!.includes(name))); value.attachments = Object.fromEntries(Object.entries(object(value.attachments ?? {}, 'attachments')).map(([skin, slots]) => [skin, Object.fromEntries(Object.entries(object(slots, 'attachment slots')).filter(([name]) => layer.slots!.includes(name)))])); } else { delete value.slots; delete value.attachments; }
    for (const group of ['ik', 'transform', 'path', 'physics', 'slider']) delete value[group];
  }
  if (layer.includeDrawOrder === false || masked && layer.includeDrawOrder !== true) { delete value.drawOrder; delete value.drawOrderFolder; }
  delete value.events;
  if (continuous) {
    for (const channels of Object.values(object(value.bones ?? {}, 'bones'))) delete object(channels, 'bone').inherit;
    for (const channels of Object.values(object(value.slots ?? {}, 'slots'))) delete object(channels, 'slot').attachment;
    for (const slots of Object.values(object(value.attachments ?? {}, 'attachments'))) for (const attachments of Object.values(object(slots, 'slots'))) for (const channels of Object.values(object(attachments, 'attachments'))) delete object(channels, 'channels').sequence;
    for (const channels of Object.values(object(value.physics ?? {}, 'physics'))) delete object(channels, 'physics channels').reset;
    delete value.drawOrder; delete value.drawOrderFolder;
  }
  return value;
}
function resolveLayers(data: SpineDocument, layers: AnimationLayer[]) {
  if (!layers.length || layers.length > 20) throw new Error('Compose 1–20 layers.'); const runtimeData = structuredClone(data); runtimeData.animations ??= {};
  const resolved: ResolvedLayer[] = layers.map((layer, index) => {
    const original = data.animations?.[layer.animation]; if (!original) throw new Error(`Layer animation missing: ${layer.animation}`);
    const duration = animationDuration(original), start = layer.start ?? 0, sourceStart = layer.sourceStart ?? 0, timeScale = layer.timeScale ?? 1, end = layer.end ?? start + (duration - sourceStart) / timeScale, weight = layer.weight ?? 1, fadeIn = layer.fadeIn ?? 0, fadeOut = layer.fadeOut ?? 0, discreteThreshold = layer.discreteThreshold ?? 0.5;
    if (![start, end, sourceStart, timeScale, weight, fadeIn, fadeOut, discreteThreshold].every(Number.isFinite) || start < 0 || end <= start || end > 300 || sourceStart < 0 || sourceStart > duration || timeScale <= 0 || timeScale > 100 || weight < 0 || weight > 1 || fadeIn < 0 || fadeOut < 0 || fadeIn + fadeOut > end - start || discreteThreshold < 0 || discreteThreshold > 1) throw new Error('Invalid layer range, speed, weight, fade or discrete threshold.');
    if (layer.loop && duration <= 0) throw new Error('Looping layers need positive source duration.');
    for (const [selected, names] of [[layer.bones, data.bones.map(b => b.name)], [layer.slots, data.slots?.map(s => s.name) ?? []]] as const) if (selected && (new Set(selected).size !== selected.length || selected.some(name => !names.includes(name)))) throw new Error('Layer masks require distinct existing object names.');
    const full = `mcp-layer-${index}-full`, continuous = `mcp-layer-${index}-continuous`; if (runtimeData.animations![full] || runtimeData.animations![continuous]) throw new Error('Reserved layer animation name already exists.');
    runtimeData.animations![full] = maskedAnimation(original, layer, false); runtimeData.animations![continuous] = maskedAnimation(original, layer, true);
    return { ...layer, start, end, sourceStart, timeScale, weight, fadeIn, fadeOut, discreteThreshold, sourceDuration: duration, full, continuous };
  });
  return { runtimeData: parseDocument(runtimeData), layers: resolved };
}
function alpha(layer: ResolvedLayer, time: number) { if (time < layer.start - 1e-6 || time > layer.end + 1e-6) return 0; const t = Math.max(layer.start, Math.min(layer.end, time)); return layer.weight * Math.min(1, layer.fadeIn ? (t - layer.start) / layer.fadeIn : 1, layer.fadeOut ? (layer.end - t) / layer.fadeOut : 1); }
function applyLayers(skeleton: Skeleton, layers: ResolvedLayer[], time: number, previous: number) {
  skeleton.setupPose();
  for (const layer of layers) { const weight = alpha(layer, time); if (weight <= 0) continue; const animation = skeleton.data.findAnimation(weight >= layer.discreteThreshold ? layer.full : layer.continuous)!; animation.apply(skeleton, previous < layer.start ? -1 : layer.sourceStart + (previous - layer.start) * layer.timeScale, layer.sourceStart + (time - layer.start) * layer.timeScale, !!layer.loop, null, weight, MixFrom.current, layer.mode === 'additive', false, false); }
}
function sampleLayers(runtimeData: SpineDocument, layers: ResolvedLayer[], time: number, skin: string | undefined, physics: boolean, fps: number) {
  const skeleton = createSkeleton(runtimeData, skin); applyLayers(skeleton, layers, 0, -1); skeleton.updateWorldTransform(physics ? Physics.reset : Physics.none);
  if (!physics) { applyLayers(skeleton, layers, time, -1); skeleton.updateWorldTransform(Physics.none); return skeleton; }
  for (let step = 1; step <= Math.ceil(time * fps); step++) { const previous = (step - 1) / fps, current = Math.min(time, step / fps); applyLayers(skeleton, layers, current, previous); skeleton.update(current - previous); skeleton.updateWorldTransform(Physics.update); }
  return skeleton;
}
export function composeAnimation(source: SpineDocument, newName: string, raw: AnimationLayer[], options: { fps?: number; skin?: string; physics?: boolean; tolerance?: number }) {
  const resolved = resolveLayers(source, raw), layers = resolved.layers, duration = Math.max(...layers.map(layer => layer.end)), fps = options.fps ?? 60, keyTimes = [...sampleTimes(0, duration, fps, 1000)];
  for (const layer of layers) {
    keyTimes.push(layer.start, layer.end, layer.start + layer.fadeIn, layer.end - layer.fadeOut);
    const keys = tracks(source, source.animations![layer.animation]!).flatMap(track => track.frames.map(key => Number(key.time ?? 0))), loops = layer.loop ? Math.ceil(((layer.end - layer.start) * layer.timeScale + layer.sourceStart) / layer.sourceDuration) : 1;
    if (loops * keys.length > 10000) throw new Error('Layer expansion exceeds 10,000 key boundaries.');
    for (let loop = 0; loop < loops; loop++) for (const time of keys) { const t = layer.start + (time + loop * layer.sourceDuration - layer.sourceStart) / layer.timeScale; if (t >= layer.start && t <= layer.end) keyTimes.push(t); }
  }
  const times = coalesceBakingTimes(keyTimes);
  if (times.length > 1500 || times.length * source.bones.length > 200000 || options.physics && times.reduce((sum, time) => sum + Math.ceil(time * fps), 0) * source.bones.length > 500000) throw new Error('Layer sampling exceeds the animation or physics budget.');
  let data = isolatedAnimation(source, newName); const driver = structuredClone(data), output = data.animations![newName]!; prepareBoneChannels(output, source.bones.map(b => b.name)); prepareSlotChannels(output);
  const orders: { time: number; order: string[] }[] = [], samples: { time: number; state: ReturnType<typeof skeletonState> }[] = []; let coordinates = 0;
  for (const time of times) { const posed = sampleLayers(resolved.runtimeData, layers, time, options.skin, !!options.physics, fps), desired = new Map(posed.bones.filter(b => b.active).map(b => [b.data.name, matrix(b.appliedPose)])); solveWorldKeys(output, sampleSkeleton(driver, newName, time, options.skin), desired, time); appendSlotKeys(data, output, posed, time, orders); const state = skeletonState(posed); coordinates += state.values.length; if (coordinates > 5_000_000) throw new Error('Layer validation exceeds five million coordinates.'); samples.push({ time, state }); }
  const events: JsonObject[] = [];
  for (const layer of layers) if (layer.includeEvents !== false) {
    const raw = source.animations![layer.animation]!.events as JsonObject[] | undefined ?? [], loops = layer.loop ? Math.ceil(((layer.end - layer.start) * layer.timeScale + layer.sourceStart) / layer.sourceDuration) + 1 : 1;
    for (let loop = 0; loop < loops; loop++) for (const key of raw) { const time = layer.start + (Number(key.time ?? 0) + loop * layer.sourceDuration - layer.sourceStart) / layer.timeScale; if (time >= layer.start && time <= layer.end && alpha(layer, time) >= layer.discreteThreshold) events.push({ ...structuredClone(key), time: Math.fround(time) }); if (events.length > 10000) throw new Error('Layer event expansion exceeds 10,000 events.'); }
  }
  if (events.length) output.events = events.sort((a, b) => Number(a.time) - Number(b.time));
  data = finishSlotKeys(parseDocument(data), newName, orders); const error = validateBaked(data, newName, samples, options.skin, options.tolerance ?? 0.01);
  return { data, report: { layers: raw, frames: times.length, fps, duration, maxSampledError: error, events: events.length, constraintsDisabledOnlyInNewAnimation: true, note: 'Runtime override/additive mixing baked at listed frame and key times. Discrete tracks apply at their layer alpha threshold. No continuous-time error proof.' } };
}
