import { MeshAttachment, Physics, RegionAttachment, Skeleton, SkeletonJson, VertexAttachment, type Bone, type BonePose } from '@esotericsoftware/spine-core';
import { attachmentEntries, sourceMesh, vertexLayout } from './attachment-data.js';
import { parseDocument, object, safeName, type SpineDocument, type JsonObject } from './document.js';
import { constraintList, disabledParameterKey } from './constraint-data.js';
import { setConstraintTimeline } from './constraint-edits.js';
import { setDrawOrder } from './animation-edits.js';
import { boneDiagramLoader, sampleSkeleton } from './runtime.js';

export interface Matrix { a: number; b: number; c: number; d: number; x: number; y: number }
export const matrix = (p: BonePose): Matrix => ({ a: p.a, b: p.b, c: p.c, d: p.d, x: p.worldX, y: p.worldY });
export const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
export const mul = (a: Matrix, b: Matrix): Matrix => ({ a: a.a * b.a + a.b * b.c, b: a.a * b.b + a.b * b.d, c: a.c * b.a + a.d * b.c, d: a.c * b.b + a.d * b.d, x: a.a * b.x + a.b * b.y + a.x, y: a.c * b.x + a.d * b.y + a.y });
export function inverse(m: Matrix): Matrix { const det = m.a * m.d - m.b * m.c; if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('World conversion requires nonsingular transforms.'); return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, x: (m.b * m.y - m.d * m.x) / det, y: (m.c * m.x - m.a * m.y) / det }; }
export function createSkeleton(data: SpineDocument, skin?: string) { if (data.bones.length > 2000) throw new Error('Animation baking accepts at most 2000 bones.'); const skeleton = new Skeleton(new SkeletonJson(boneDiagramLoader).readSkeletonData(data)); if (skin) skeleton.setSkin(skin); skeleton.setupPose(); skeleton.updateWorldTransform(Physics.none); return skeleton; }

export function isolatedAnimation(source: SpineDocument, newName: string, base?: JsonObject) {
  safeName(newName); if (Object.hasOwn(source.animations ?? {}, newName)) throw new Error('Destination animation already exists.');
  let data = structuredClone(source); (data.animations ??= {})[newName] = structuredClone(base ?? {});
  for (const c of constraintList(data)) {
    const type = String(c.type), name = String(c.name);
    if (type === 'ik' || type === 'transform') { const key = disabledParameterKey(c); data = setConstraintTimeline(data, newName, name, 'parameters', key ? [key] : [], type); }
    else if (type === 'path') data = setConstraintTimeline(data, newName, name, 'mix', [{ time: 0, mixRotate: 0, mixX: 0, mixY: 0 }], 'path');
    else data = setConstraintTimeline(data, newName, name, 'mix', [{ time: 0, value: 0 }], type as 'slider' | 'physics');
  }
  return data;
}
export function appendBoneKey(output: JsonObject, bone: Bone, time: number, local: BonePose = bone.appliedPose) {
  const all = object(output.bones ??= {}, 'bones'), keys = object(all[bone.data.name] ??= { rotate: [], translate: [], scale: [], shear: [] }, 'bone channels'), setup = bone.data.setupPose;
  if (!setup.scaleX || !setup.scaleY) throw new Error(`Baking needs nonzero setup scale: ${bone.data.name}`);
  const rotations = keys.rotate as JsonObject[], raw = local.rotation - setup.rotation, previous = Number(rotations.at(-1)?.value ?? raw), rotation = raw + 360 * Math.round((previous - raw) / 360);
  rotations.push({ time, value: rotation }); (keys.translate as JsonObject[]).push({ time, x: local.x - setup.x, y: local.y - setup.y }); (keys.scale as JsonObject[]).push({ time, x: local.scaleX / setup.scaleX, y: local.scaleY / setup.scaleY }); (keys.shear as JsonObject[]).push({ time, x: local.shearX - setup.shearX, y: local.shearY - setup.shearY });
}
export function prepareBoneChannels(output: JsonObject, names: string[]) { const all = object(output.bones ??= {}, 'bones'); for (const name of names) { const previous = object(all[name] ?? {}, 'bone'); all[name] = { rotate: [], translate: [], scale: [], shear: [], ...(previous.inherit ? { inherit: previous.inherit } : {}) }; } }

// Resolve parent bones before children using the runtime's inheritance-aware
// world/local conversion. Invalidate descendants before changing a matrix.
export function solveWorldKeys(output: JsonObject, skeleton: Skeleton, desired: Map<string, Matrix>, time: number) {
  for (const bone of skeleton.bones) if (bone.active) bone.appliedPose.updateLocalTransform(skeleton);
  for (const bone of skeleton.bones) {
    if (!bone.active) { if (desired.has(bone.data.name)) throw new Error(`Mapped bone is inactive: ${bone.data.name}`); continue; }
    const m = desired.get(bone.data.name), p = bone.appliedPose;
    if (!m) { p.updateWorldTransform(skeleton); continue; }
    if (Object.values(m).some(n => !Number.isFinite(n))) throw new Error('World baking produced non-finite matrices.');
    p.modifyWorld(skeleton); p.a = m.a; p.b = m.b; p.c = m.c; p.d = m.d; p.worldX = m.x; p.worldY = m.y; p.updateLocalTransform(skeleton);
    appendBoneKey(output, bone, time);
  }
}
export function matrixError(skeleton: Skeleton, desired: Map<string, Matrix>) { let error = 0; for (const [name, m] of desired) { const bone = skeleton.bones.find(bone => bone.data.name === name); if (!bone?.active) throw new Error(`Mapped bone missing/inactive: ${name}`); const actual = matrix(bone.appliedPose); for (const field of Object.keys(m) as (keyof Matrix)[]) error = Math.max(error, Math.abs(m[field] - actual[field])); } return error; }

const color = (values: number[]) => values.map(n => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0')).join('');
export function prepareSlotChannels(output: JsonObject) { output.slots = {}; output.attachments = {}; delete output.drawOrder; delete output.drawOrderFolder; }
export function appendSlotKeys(data: SpineDocument, output: JsonObject, skeleton: Skeleton, time: number, drawOrders: { time: number; order: string[] }[]) {
  const entries = attachmentEntries(data), targets = new Map<JsonObject, number[]>();
  for (const slot of skeleton.slots) {
    const pose = slot.appliedPose, attachment = pose.attachment, channels = object(object(output.slots ??= {}, 'slots')[slot.data.name] ??= { attachment: [], ...(pose.darkColor ? { rgba2: [] } : { rgba: [] }) }, 'slot');
    const item = attachment ? entries.find(item => item.slot === slot.data.name && skeleton.data.findSkin(item.skin)?.getAttachment(slot.data.index, item.name) === attachment) : undefined;
    if (attachment && !item) throw new Error(`Cannot identify runtime attachment: ${slot.data.name}/${attachment.name}`);
    const swaps = channels.attachment as JsonObject[], placeholder = item?.name;
    if (!swaps.length || swaps.at(-1)!.name !== placeholder) swaps.push({ time, ...(placeholder ? { name: placeholder } : {}) });
    const light = color([pose.color.r, pose.color.g, pose.color.b, pose.color.a]);
    if (pose.darkColor) (channels.rgba2 as JsonObject[]).push({ time, light, dark: color([pose.darkColor.r, pose.darkColor.g, pose.darkColor.b]) }); else (channels.rgba as JsonObject[]).push({ time, color: light });
    if (item?.value.sequence) { let nested = object(output.attachments ??= {}, 'attachments'); for (const name of [item.skin, item.slot, item.name]) nested = object(nested[name] ??= {}, 'sequence target'); const keys = nested.sequence as JsonObject[] | undefined ?? []; nested.sequence = keys; const sequence = object(item.value.sequence, 'sequence'); keys.push({ time, mode: 'hold', index: pose.sequenceIndex < 0 ? Number(sequence.setup ?? 0) : pose.sequenceIndex }); }
    if (!(attachment instanceof VertexAttachment) || !item) continue;
    const definition = sourceMesh(data, item.skin, item.slot, item.name), layout = vertexLayout(data, definition), raw = (pose.deform.length ? Array.from(pose.deform) : new Array<number>(layout.deformLength).fill(0));
    if (pose.deform.length && !layout.weighted) for (let i = 0; i < raw.length; i++) raw[i] = raw[i]! - (definition.vertices as number[])[i]!;
    if (raw.length !== layout.deformLength) throw new Error('Runtime deformation does not match the saved mesh layout.');
    let target = item;
    if (item.value.source !== undefined && item.value.timelines !== false) target = entries.find(entry => entry.value === definition)!;
    const previous = targets.get(target.value); if (previous && previous.some((value, index) => Math.abs(value - raw[index]!) > 1e-7)) throw new Error('Inherited linked meshes need different deformation on the same frame. Unlink them explicitly before baking.'); if (previous) continue; targets.set(target.value, raw);
    let nested = object(output.attachments ??= {}, 'attachments'); for (const name of [target.skin, target.slot, target.name]) nested = object(nested[name] ??= {}, 'deform target');
    const keys = nested.deform as JsonObject[] | undefined ?? []; nested.deform = keys;
    let first = 0, last = raw.length; while (first < last && raw[first] === 0) first++; while (last > first && raw[last - 1] === 0) last--;
    keys.push({ time, ...(first < last ? { ...(first ? { offset: first } : {}), vertices: raw.slice(first, last) } : {}) });
  }
  const order = skeleton.drawOrder.appliedPose.map(slot => slot.data.name);
  if (!drawOrders.length || JSON.stringify(order) !== JSON.stringify(drawOrders.at(-1)!.order)) drawOrders.push({ time, order });
}
export function finishSlotKeys(data: SpineDocument, name: string, orders: { time: number; order: string[] }[]) {
  const bones = data.animations![name]!.bones as Record<string, JsonObject> | undefined;
  if (bones) for (const [bone, channels] of Object.entries(bones)) { for (const [channel, keys] of Object.entries(channels)) if (Array.isArray(keys) && !keys.length) delete channels[channel]; if (!Object.keys(channels).length) delete bones[bone]; }
  for (const channels of Object.values(data.animations![name]!.slots ?? {}) as Record<string, JsonObject[]>[]) for (const channel of ['rgba', 'rgba2']) {
    const keys = channels[channel]; if (!keys) continue;
    const value = (key: JsonObject) => JSON.stringify(Object.entries(key).filter(([field]) => field !== 'time' && field !== 'curve').sort(([a], [b]) => a.localeCompare(b)));
    keys.forEach((key, index) => { if (index === keys.length - 1 || key.curve === 'stepped' && value(key) === value(keys[index + 1]!)) delete key.curve; });
  }
  return setDrawOrder(data, name, orders);
}

export function skeletonState(skeleton: Skeleton) {
  const values: number[] = [], signature: string[] = [];
  for (const bone of skeleton.bones) if (bone.active) { const p = bone.appliedPose; signature.push(`bone:${bone.data.name}`); values.push(p.worldX, p.worldY, p.a, p.b, p.c, p.d); }
  for (const slot of skeleton.drawOrder.appliedPose) {
    const p = slot.appliedPose, a = p.attachment; signature.push(`${slot.data.name}:${a?.name ?? ''}`); if ((a instanceof RegionAttachment || a instanceof MeshAttachment) && a.sequence.regions.length > 1) signature.push(`sequence:${p.sequenceIndex < 0 ? a.sequence.setupIndex : p.sequenceIndex}`); values.push(p.color.r, p.color.g, p.color.b, p.color.a); if (p.darkColor) values.push(p.darkColor.r, p.darkColor.g, p.darkColor.b);
    if (a instanceof RegionAttachment) { const vertices = new Array<number>(8); a.computeWorldVertices(slot, a.getOffsets(p), vertices, 0, 2); values.push(...vertices); }
    else if (a instanceof VertexAttachment) { const vertices = new Array<number>(a.worldVerticesLength); a.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2); values.push(...vertices); if (a instanceof MeshAttachment) signature.push(JSON.stringify(a.triangles)); }
  }
  if (values.length > 100000 || values.some(n => !Number.isFinite(n))) throw new Error('Baked state exceeds 100,000 coordinates or contains non-finite values.');
  return { values, signature };
}
export function stateDifference(a: ReturnType<typeof skeletonState>, b: ReturnType<typeof skeletonState>) { if (JSON.stringify(a.signature) !== JSON.stringify(b.signature) || a.values.length !== b.values.length) return Infinity; let error = 0; for (let i = 0; i < a.values.length; i++) error = Math.max(error, Math.abs(a.values[i]! - b.values[i]!)); return error; }
export function validateBaked(data: SpineDocument, name: string, samples: { time: number; state: ReturnType<typeof skeletonState> }[], skin: string | undefined, tolerance: number) { let error = 0; for (const sample of samples) { const next = stateDifference(sample.state, skeletonState(sampleSkeleton(data, name, sample.time, skin))); if (next > tolerance) throw new Error(`Baked state differs at ${sample.time}s (${next}); output rejected.`); error = Math.max(error, next); } return error; }
