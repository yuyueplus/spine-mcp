import { RegionAttachment, VertexAttachment, Vector2 } from '@esotericsoftware/spine-core';
import { object, parseDocument, type JsonObject, type SpineDocument } from './document.js';
import { attachmentEntries, normalizedAttachmentKeys, sourceMesh, vertexLayout } from './attachment-data.js';
import { setAttachment } from './geometry-edits.js';
import { documentSkins } from './slot-data.js';
import { sampleSkeleton } from './runtime.js';

export interface AttachmentRef { skin: string; slot: string; name: string }
interface Matrix { a: number; b: number; c: number; d: number; x: number; y: number }
interface Pose { a: number; b: number; c: number; d: number; worldX: number; worldY: number }
type Entry = ReturnType<typeof attachmentEntries>[number];
const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
const isIdentity = (matrix: Matrix) => Object.keys(identity).every(key => Math.abs(matrix[key as keyof Matrix] - identity[key as keyof Matrix]) < 1e-10);
function entry(data: SpineDocument, ref: AttachmentRef): Entry {
  const found = attachmentEntries(data).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name);
  if (!found) throw new Error(`Attachment not found: ${ref.skin}/${ref.slot}/${ref.name}`);
  return found;
}
function freshTarget(data: SpineDocument, from: AttachmentRef, to: AttachmentRef) {
  if (from.skin === to.skin && from.slot === to.slot && from.name === to.name) throw new Error('Copy/link target must differ from source.');
  if (!documentSkins(data).some(skin => skin.name === to.skin) || !data.slots?.some(slot => slot.name === to.slot)) throw new Error('Target skin and slot must already exist.');
  if (attachmentEntries(data).some(item => item.skin === to.skin && item.slot === to.slot && item.name === to.name)) throw new Error('Target attachment already exists. Choose a new name.');
}
function between(source: Pose, target: Pose): Matrix {
  const det = target.a * target.d - target.b * target.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('World preservation requires a nonsingular target bone transform.');
  const a = target.d / det, b = -target.b / det, c = -target.c / det, d = target.a / det;
  return { a: a * source.a + b * source.c, b: a * source.b + b * source.d, c: c * source.a + d * source.c, d: c * source.b + d * source.d, x: a * (source.worldX - target.worldX) + b * (source.worldY - target.worldY), y: c * (source.worldX - target.worldX) + d * (source.worldY - target.worldY) };
}
function transform(matrix: Matrix, x: number, y: number, vector = false): [number, number] {
  return [matrix.a * x + matrix.b * y + (vector ? 0 : matrix.x), matrix.c * x + matrix.d * y + (vector ? 0 : matrix.y)];
}
function independentValue(data: SpineDocument, item: Entry) {
  const value = structuredClone(item.value);
  if (item.value.source !== undefined) {
    const geometry = sourceMesh(data, item.skin, item.slot, item.name);
    for (const field of ['vertices', 'uvs', 'triangles', 'hull', 'edges', 'width', 'height']) if (geometry[field] !== undefined) value[field] = structuredClone(geometry[field]); else delete value[field];
    for (const field of ['source', 'skin', 'slot', 'timelines']) delete value[field];
    value.type = 'mesh';
  }
  if (value.type === 'linkedmesh') value.type = 'mesh';
  if (['region', 'mesh'].includes(String(value.type ?? 'region'))) value.path ??= item.value.name ?? item.name;
  return value;
}
function effectiveSource(data: SpineDocument, item: Entry) {
  return item.value.source !== undefined && item.value.timelines !== false
    ? entry(data, { skin: String(item.value.skin ?? 'default'), slot: String(item.value.slot ?? item.slot), name: String(item.value.source) }) : item;
}
function channels(animation: JsonObject, ref: AttachmentRef): JsonObject {
  const skins = object(animation.attachments ?? {}, 'attachments'), slots = object(skins[ref.skin] ?? {}, 'skin'), items = object(slots[ref.slot] ?? {}, 'slot');
  return object(items[ref.name] ?? {}, 'attachment channels');
}
function setChannels(animation: JsonObject, ref: AttachmentRef, value: JsonObject) {
  if (!Object.keys(value).length) {
    const skins = object(animation.attachments ?? {}, 'attachments'), slots = object(skins[ref.skin] ?? {}, 'skin'), items = object(slots[ref.slot] ?? {}, 'slot'); delete items[ref.name]; return;
  }
  let map = object(animation.attachments ??= {}, 'attachments');
  for (const key of [ref.skin, ref.slot]) { if (!Object.hasOwn(map, key)) map[key] = {}; map = object(map[key], 'attachment map'); }
  if (Object.keys(value).length) map[ref.name] = value; else delete map[ref.name];
}
function copyChannels(source: SpineDocument, output: SpineDocument, from: Entry, to: AttachmentRef, value: JsonObject, matrices?: Matrix[]) {
  const effective = effectiveSource(source, from), geometry = sourceMesh(source, from.skin, from.slot, from.name);
  for (const [name, animation] of Object.entries(source.animations ?? {})) {
    const original = channels(animation, effective), result: JsonObject = {};
    if (Array.isArray(original.deform) && original.deform.length) {
      const length = vertexLayout(source, geometry).deformLength;
      const normalized = normalizedAttachmentKeys({ ...effective, channel: 'deform', frames: original.deform as JsonObject[], length });
      result.deform = (original.deform as JsonObject[]).map((key, index) => {
        if (!matrices) return structuredClone(key);
        const values = (normalized[index] as { vertices: number[] }).vertices, transformed: number[] = [];
        for (let coordinate = 0; coordinate < values.length; coordinate += 2) transformed.push(...transform(matrices[coordinate / 2]!, values[coordinate]!, values[coordinate + 1]!, true));
        let first = 0, last = transformed.length;
        while (first < last && transformed[first] === 0) first++;
        while (last > first && transformed[last - 1] === 0) last--;
        const copy = structuredClone(key); delete copy.offset; delete copy.vertices;
        if (first < last) { if (first) copy.offset = first; copy.vertices = transformed.slice(first, last); }
        return copy;
      });
    }
    if (Array.isArray(original.sequence) && original.sequence.length && value.sequence !== undefined) {
      const sourceCount = Number(object(effective.value.sequence, 'source sequence').count), targetCount = Number(object(value.sequence, 'target sequence').count);
      if (sourceCount !== targetCount) throw new Error('Preserving inherited sequence keys requires matching source/target sequence counts. Use copyTimelines=false or preserveTimelines=false to omit those keys.');
      result.sequence = structuredClone(original.sequence);
    }
    setChannels(output.animations![name]!, to, result);
  }
}
function baseGeometry(data: SpineDocument, ref: AttachmentRef) {
  const skeleton = sampleSkeleton(data, undefined, 0, ref.skin), slot = skeleton.slots.find(slot => slot.data.name === ref.slot)!;
  const attachment = skeleton.data.findSkin(ref.skin)!.getAttachment(slot.data.index, ref.name);
  if (!slot.bone.active) throw new Error('Slot bone is inactive in its skin. Use set_skin_members first.');
  slot.appliedPose.deform.length = 0;
  if (attachment instanceof RegionAttachment) { const values = new Array<number>(8); attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), values, 0, 2); return values; }
  if (attachment instanceof VertexAttachment) { const values = new Array<number>(attachment.worldVerticesLength); attachment.computeWorldVertices(skeleton, slot, 0, values.length, values, 0, 2); return values; }
  const value = entry(data, ref).value, pose = slot.bone.appliedPose, point = pose.localToWorld(new Vector2(Number(value.x ?? 0), Number(value.y ?? 0))), angle = Number(value.rotation ?? 0) * Math.PI / 180;
  const x = pose.a * Math.cos(angle) + pose.b * Math.sin(angle), y = pose.c * Math.cos(angle) + pose.d * Math.sin(angle), length = Math.hypot(x, y);
  return [point.x, point.y, x / length, y / length];
}
function verifySetup(source: SpineDocument, output: SpineDocument, from: AttachmentRef, to: AttachmentRef) {
  const expected = baseGeometry(source, from), actual = baseGeometry(output, to);
  if (actual.length !== expected.length || expected.some((value, index) => !Number.isFinite(value) || !Number.isFinite(actual[index]!) || Math.abs(value - actual[index]!) > 0.0001 * Math.max(1, Math.abs(value)))) throw new Error('Setup world geometry could not be preserved. Check skin activation, constraints and slot setup dependencies; use preserveWorld=false to retain local data.');
}
function checkClipSetup(data: SpineDocument, to: AttachmentRef, value: JsonObject, enabled: boolean) {
  if (enabled && value.type === 'clipping' && typeof value.end === 'string') {
    const order = data.slots!.map(slot => slot.name);
    if (order.indexOf(value.end) <= order.indexOf(to.slot)) throw new Error('An active copied clipping attachment must end after its target slot. Change setup slot order first.');
  }
}

export function copyAttachment(source: SpineDocument, from: AttachmentRef, to: AttachmentRef, options: { preserveWorld?: boolean; copyTimelines?: boolean; setAsSetup?: boolean } = {}) {
  const item = entry(source, from); freshTarget(source, from, to);
  const value = independentValue(source, item), preserveWorld = options.preserveWorld ?? true;
  delete value.name;
  let matrices: Matrix[] | undefined;
  if (preserveWorld) {
    const a = sampleSkeleton(source, undefined, 0, from.skin), b = sampleSkeleton(source, undefined, 0, to.skin);
    const sourceSlot = a.slots.find(slot => slot.data.name === from.slot)!, targetSlot = b.slots.find(slot => slot.data.name === to.slot)!;
    if (!sourceSlot.bone.active || !targetSlot.bone.active) throw new Error('Source and target slot bones must be active in the selected skins. Use set_skin_members first.');
    const local = between(sourceSlot.bone.appliedPose, targetSlot.bone.appliedPose);
    if ((value.type ?? 'region') === 'region' && !isIdentity(local)) {
      const region = a.data.findSkin(from.skin)!.getAttachment(sourceSlot.data.index, from.name);
      if (!(region instanceof RegionAttachment)) throw new Error('Source region could not be loaded.');
      value.type = 'mesh'; value.vertices = [...region.getOffsets(sourceSlot.appliedPose)]; value.uvs = [0, 1, 0, 0, 1, 0, 1, 1]; value.triangles = [0, 1, 2, 0, 2, 3]; value.hull = 4;
      for (const field of ['x', 'y', 'rotation', 'scaleX', 'scaleY']) delete value[field];
    }
    if (Array.isArray(value.vertices)) {
      const layout = vertexLayout(source, value), raw = value.vertices as number[]; matrices = [];
      if (!layout.weighted) {
        for (let index = 0; index < raw.length; index += 2) { matrices.push(local); [raw[index], raw[index + 1]] = transform(local, raw[index]!, raw[index + 1]!); }
      } else {
        const boneMatrices = new Map<number, Matrix>(); let cursor = 0;
        while (cursor < raw.length) {
          const count = raw[cursor++]!;
          for (let index = 0; index < count; index++, cursor += 4) {
            const boneIndex = raw[cursor]!;
            if (!a.bones[boneIndex]!.active || !b.bones[boneIndex]!.active) throw new Error('Weighted influence bones must be active in both skins. Use set_skin_members first.');
            let matrix = boneMatrices.get(boneIndex); if (!matrix) { matrix = between(a.bones[boneIndex]!.appliedPose, b.bones[boneIndex]!.appliedPose); boneMatrices.set(boneIndex, matrix); }
            matrices.push(matrix); [raw[cursor + 1], raw[cursor + 2]] = transform(matrix, raw[cursor + 1]!, raw[cursor + 2]!);
          }
        }
      }
      if (value.type === 'path' && value.constantSpeed === false && matrices.some(matrix => !isIdentity(matrix))) throw new Error('Non-constant-speed paths require preserveWorld=false when changing coordinate systems.');
    } else if (value.type === 'point') {
      [value.x, value.y] = transform(local, Number(value.x ?? 0), Number(value.y ?? 0));
      const radians = Number(value.rotation ?? 0) * Math.PI / 180, direction = transform(local, Math.cos(radians), Math.sin(radians), true); value.rotation = Math.atan2(direction[1]!, direction[0]!) * 180 / Math.PI;
    }
  }
  checkClipSetup(source, to, value, options.setAsSetup ?? false);
  const output = setAttachment(source, to.skin, to.slot, to.name, value, false, options.setAsSetup);
  if (options.copyTimelines ?? true) copyChannels(source, output, item, to, value, matrices);
  const result = parseDocument(output); if (preserveWorld) verifySetup(source, result, from, to); return result;
}

export function linkMesh(source: SpineDocument, from: AttachmentRef, to: AttachmentRef, options: { inheritTimelines?: boolean; copyTimelines?: boolean; preserveWorld?: boolean; setAsSetup?: boolean } = {}) {
  const item = entry(source, from); freshTarget(source, from, to);
  if (item.value.type !== 'mesh' || item.value.source !== undefined) throw new Error('A new link requires a non-linked source mesh. Select the original mesh to avoid link chains.');
  const inheritTimelines = options.inheritTimelines ?? true;
  if (inheritTimelines && options.copyTimelines) throw new Error('copyTimelines applies only when inheritTimelines=false.');
  const value: JsonObject = { type: 'mesh', source: from.name, skin: from.skin, slot: from.slot, timelines: inheritTimelines, path: item.value.path ?? item.value.name ?? item.name };
  for (const field of ['color', 'sequence', 'width', 'height']) if (item.value[field] !== undefined) value[field] = structuredClone(item.value[field]);
  const output = setAttachment(source, to.skin, to.slot, to.name, value, false, options.setAsSetup);
  if (options.copyTimelines) copyChannels(source, output, item, to, value);
  const result = parseDocument(output);
  if (options.preserveWorld) {
    try { verifySetup(source, result, from, to); }
    catch { throw new Error('Shared geometry cannot preserve setup world positions on this target. Use copy_attachment with preserveWorld=true for an independent copy.'); }
  }
  return result;
}

export function unlinkMesh(source: SpineDocument, ref: AttachmentRef, preserveTimelines = true) {
  const item = entry(source, ref);
  if (item.value.source === undefined || !['mesh', 'linkedmesh'].includes(String(item.value.type))) throw new Error('Select an existing linked mesh to make independent.');
  const value = independentValue(source, item), output = setAttachment(source, ref.skin, ref.slot, ref.name, value, true);
  if (preserveTimelines && item.value.timelines !== false) copyChannels(source, output, item, ref, value);
  else if (!preserveTimelines) for (const animation of Object.values(output.animations ?? {})) setChannels(animation, ref, {});
  return parseDocument(output);
}
