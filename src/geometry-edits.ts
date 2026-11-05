import { object, parseDocument, safeName, type JsonObject, type SpineDocument } from './document.js';
import { attachmentEntries, sourceMesh, attachmentTracks, vertexLayout } from './attachment-data.js';
import { documentSkins } from './slot-data.js';
import { sampleSkeleton } from './runtime.js';
import { VertexAttachment, Vector2 } from '@esotericsoftware/spine-core';

export function setAttachment(source: SpineDocument, skinName: string, slotName: string, name: string, value: JsonObject, replace = false, setAsSetup = false) {
  safeName(name);
  const data = structuredClone(source), skin = documentSkins(data).find(skin => skin.name === skinName), slot = data.slots?.find(slot => slot.name === slotName);
  if (!skin || !slot) throw new Error('Skin or slot not found.');
  const map = object(skin.attachments ??= {}, 'attachments');
  if (!Object.hasOwn(map, slotName)) map[slotName] = {};
  const items = object(map[slotName], 'slot attachments');
  if (Object.hasOwn(items, name) && !replace) throw new Error('Attachment exists; set replace=true for the NEW output.');
  if (attachmentEntries(data).some(item => item.slot === slotName && item.name === name && item.skin !== skinName && (skinName === 'default' || item.skin === 'default'))) throw new Error('Default attachment and named-skin placeholder collide. Convert default to a named base skin first.');
  const previous = Object.hasOwn(items, name) ? object(items[name], 'attachment') : undefined;
  const record = structuredClone(value), used = new Set(attachmentEntries(data).filter(item => item.value !== previous).map(item => String(item.value.name ?? item.name)));
  let internal = String(record.name ?? previous?.name ?? (skinName === 'default' ? name : `${skinName}/${name}`)), suffix = 2;
  const base = internal; while (used.has(internal)) internal = `${base}-${suffix++}`;
  if (skinName === 'default' && internal !== name) throw new Error('A default attachment must have a unique internal name equal to its placeholder.');
  if (internal !== name || record.name !== undefined) record.name = internal;
  items[name] = record;
  if (setAsSetup) slot.attachment = name;
  return parseDocument(data);
}
export function setAttachmentTimeline(source: SpineDocument, animationName: string, skin: string, slot: string, name: string, channel: string, keys: JsonObject[]) {
  safeName(animationName);
  const data = structuredClone(source), animations = data.animations ??= {};
  if (!Object.hasOwn(animations, animationName)) animations[animationName] = {};
  let map = object(animations[animationName]!.attachments ??= {}, 'attachment timelines');
  for (const key of [skin, slot, name]) { safeName(key); if (!Object.hasOwn(map, key)) map[key] = {}; map = object(map[key], 'attachment timelines'); }
  if (keys.length) map[channel] = structuredClone(keys); else delete map[channel];
  return parseDocument(data);
}
export interface Influence { bone: string; weight: number; x?: number; y?: number }
export function setWeights(source: SpineDocument, skin: string, slotName: string, name: string, weights: Influence[][], clearDeform = false) {
  const data = structuredClone(source), record = attachmentEntries(data).find(item => item.skin === skin && item.slot === slotName && item.name === name);
  if (!record || record.value.type !== 'mesh' || record.value.source !== undefined) throw new Error('Weights require a nonlinked mesh.');
  const layout = vertexLayout(data, record.value);
  if (weights.length !== layout.count) throw new Error('Weights must list influences for every vertex.');
  for (const animation of Object.values(data.animations ?? {})) for (const track of attachmentTracks(data, animation)) if (track.channel === 'deform' && sourceMesh(data, track.skin, track.slot, track.name) === record.value) {
    if (!clearDeform) throw new Error('Changing weights affects source/linked-mesh deformation; use clearDeform=true to remove those deform keys in the NEW output.');
    const channels = object(object(object(object(animation.attachments, 'attachments')[track.skin], 'skin')[track.slot], 'slot')[track.name], 'attachment'); delete channels.deform;
  }
  const skeleton = sampleSkeleton(data, undefined, 0, skin), slot = skeleton.slots.find(slot => slot.data.name === slotName)!;
  const runtimeAttachment = skeleton.data.findSkin(skin)?.getAttachment(slot.data.index, name);
  if (!(runtimeAttachment instanceof VertexAttachment)) throw new Error('Runtime could not load the mesh.');
  const vertices = new Array<number>(layout.count * 2); runtimeAttachment.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2);
  const packed: number[] = [];
  const boneIndices = new Map(data.bones.map((bone, index) => [bone.name, index]));
  for (let vertex = 0; vertex < weights.length; vertex++) {
    const influences = weights[vertex]!;
    if (!influences.length || influences.length > 16 || new Set(influences.map(item => item.bone)).size !== influences.length) throw new Error('Each vertex needs 1–16 distinct influence bones.');
    const total = influences.reduce((sum, item) => sum + item.weight, 0);
    if (!Number.isFinite(total) || total <= 0 || influences.some(item => !Number.isFinite(item.weight) || item.weight < 0)) throw new Error('Weights must be nonnegative with a positive sum.');
    packed.push(influences.length);
    // The installed editor expects ascending bone indices in each vertex.
    for (const item of [...influences].sort((a, b) => (boneIndices.get(a.bone) ?? -1) - (boneIndices.get(b.bone) ?? -1))) {
      const index = boneIndices.get(item.bone);
      if (index === undefined) throw new Error('Influence bone is missing.');
      if (!skeleton.bones[index]!.active) throw new Error(`Influence bone is inactive in skin ${skin}: ${item.bone}`);
      if ((item.x === undefined) !== (item.y === undefined)) throw new Error('Supply both bind coordinates or omit both for automatic binding.');
      const point = new Vector2(vertices[vertex * 2]!, vertices[vertex * 2 + 1]!);
      const pose = skeleton.bones[index]!.appliedPose;
      if (item.x === undefined && Math.abs(pose.a * pose.d - pose.b * pose.c) < 1e-12) throw new Error('Automatic binding requires nonsingular bone transforms.');
      skeleton.bones[index]!.appliedPose.worldToLocal(point);
      const x = item.x ?? point.x, y = item.y ?? point.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid bind coordinates; check zero bone scales.');
      packed.push(index, x, y, item.weight / total);
    }
  }
  record.value.vertices = packed;
  return parseDocument(data);
}
