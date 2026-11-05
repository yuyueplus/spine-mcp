import { RegionAttachment, VertexAttachment } from '@esotericsoftware/spine-core';
import { attachmentEntries, vertexLayout } from './attachment-data.js';
import { type SpineDocument, type JsonObject } from './document.js';
import { setAttachment, setWeights } from './geometry-edits.js';
import { sampleSkeleton } from './runtime.js';

export function meshFromRegion(source: SpineDocument, skin: string, slotName: string, name: string, columns = 2, rows = 2) {
  if (![columns, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 64)) throw new Error('Mesh grid columns/rows must be integers from 1 to 64.');
  const record = attachmentEntries(source).find(item => item.skin === skin && item.slot === slotName && item.name === name);
  if (!record || (record.value.type ?? 'region') !== 'region') throw new Error('Grid conversion requires an existing region attachment.');
  if (record.value.sequence !== undefined) throw new Error('Convert a static region first; animated image sequences are not supported by grid conversion.');
  const skeleton = sampleSkeleton(source, undefined, 0, skin), slot = skeleton.slots.find(slot => slot.data.name === slotName)!;
  const region = skeleton.data.findSkin(skin)?.getAttachment(slot.data.index, name);
  if (!(region instanceof RegionAttachment)) throw new Error('Runtime could not load the region.');
  const corners = region.getOffsets(slot.appliedPose), originalIndex = (row: number, column: number) => row * (columns + 1) + column;
  const order: number[] = [];
  // The editor expects all hull vertices first, in boundary order.
  for (let row = rows; row >= 0; row--) order.push(originalIndex(row, 0));
  for (let column = 1; column <= columns; column++) order.push(originalIndex(0, column));
  for (let row = 1; row <= rows; row++) order.push(originalIndex(row, columns));
  for (let column = columns - 1; column >= 1; column--) order.push(originalIndex(rows, column));
  const hull = order.length;
  for (let row = 1; row < rows; row++) for (let column = 1; column < columns; column++) order.push(originalIndex(row, column));
  const remap = new Map(order.map((index, position) => [index, position])), vertices: number[] = [], uvs: number[] = [], triangles: number[] = [];
  for (const index of order) {
    const row = Math.floor(index / (columns + 1)), column = index % (columns + 1), u = column / columns, v = row / rows;
    for (let axis = 0; axis < 2; axis++) vertices.push((1 - v) * (corners[2 + axis]! + u * (corners[4 + axis]! - corners[2 + axis]!)) + v * (corners[axis]! + u * (corners[6 + axis]! - corners[axis]!)));
    uvs.push(u, v);
  }
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const tl = remap.get(originalIndex(row, column))!, tr = remap.get(originalIndex(row, column + 1))!, bl = remap.get(originalIndex(row + 1, column))!, br = remap.get(originalIndex(row + 1, column + 1))!;
    triangles.push(tl, tr, bl, tr, br, bl);
  }
  const attachment: JsonObject = { ...record.value, type: 'mesh', vertices, uvs, triangles, hull };
  for (const field of ['x', 'y', 'rotation', 'scaleX', 'scaleY']) delete attachment[field];
  return setAttachment(source, skin, slotName, name, attachment, true);
}

export function autoWeights(source: SpineDocument, skin: string, slotName: string, name: string, bones: string[], influences = 4, power = 2, clearDeform = false) {
  if (!bones.length || bones.length > 256 || new Set(bones).size !== bones.length) throw new Error('Choose 1–256 distinct influence bones.');
  if (!Number.isInteger(influences) || influences < 1 || influences > 8 || !Number.isFinite(power) || power < 1 || power > 8) throw new Error('Automatic binding supports 1–8 influences and distance power 1–8.');
  const record = attachmentEntries(source).find(item => item.skin === skin && item.slot === slotName && item.name === name);
  if (!record || record.value.type !== 'mesh' || record.value.source !== undefined) throw new Error('Automatic binding requires a non-linked mesh.');
  const layout = vertexLayout(source, record.value), skeleton = sampleSkeleton(source, undefined, 0, skin), slot = skeleton.slots.find(item => item.data.name === slotName)!;
  const mesh = skeleton.data.findSkin(skin)?.getAttachment(slot.data.index, name);
  if (!(mesh instanceof VertexAttachment)) throw new Error('Runtime could not load mesh geometry.');
  const vertices = new Array<number>(layout.count * 2); mesh.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2);
  const segments = bones.map(name => {
    const bone = skeleton.bones.find(item => item.data.name === name);
    if (!bone || !bone.active) throw new Error(`Influence bone is missing or inactive in skin ${skin}: ${name}`);
    const pose = bone.appliedPose, x = pose.worldX, y = pose.worldY, dx = bone.data.length * pose.a, dy = bone.data.length * pose.c;
    if (![x, y, dx, dy].every(Number.isFinite) || Math.abs(pose.a * pose.d - pose.b * pose.c) < 1e-12) throw new Error(`Influence bone has a singular transform: ${name}`);
    return { bone: name, x, y, dx, dy };
  });
  const boneIndices = new Map(source.bones.map((bone, index) => [bone.name, index]));
  const weights = Array.from({ length: layout.count }, (_, index) => {
    const x = vertices[index * 2]!, y = vertices[index * 2 + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Mesh has non-finite setup world vertices.');
    const nearest = segments.map(segment => {
      const denominator = segment.dx ** 2 + segment.dy ** 2, t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((x - segment.x) * segment.dx + (y - segment.y) * segment.dy) / denominator));
      return { bone: segment.bone, distance: Math.hypot(x - segment.x - segment.dx * t, y - segment.y - segment.dy * t) };
    }).sort((a, b) => a.distance - b.distance || a.bone.localeCompare(b.bone)).slice(0, influences);
    const zero = nearest.filter(item => item.distance < 1e-7), selected = zero.length ? zero : nearest;
    const minimum = selected[0]!.distance;
    // A distance ratio keeps the weight calculation finite at all rig scales.
    // The installed editor importer requires ascending bone indices per
    // vertex. Sorting here keeps its parsing consistent with runtime data.
    return selected.map(item => ({ bone: item.bone, weight: zero.length ? 1 : (minimum / item.distance) ** power })).sort((a, b) => boneIndices.get(a.bone)! - boneIndices.get(b.bone)!);
  });
  return setWeights(source, skin, slotName, name, weights, clearDeform);
}
