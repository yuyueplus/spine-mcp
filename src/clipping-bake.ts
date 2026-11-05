import path from 'node:path';
import { ClippingAttachment, MeshAttachment, RegionAttachment, SkeletonClipping } from '@esotericsoftware/spine-core';
import type { Workspace } from './config.js';
import { attachmentEntries } from './attachment-data.js';
import { parseDocument, safeName, type SpineDocument, type JsonObject } from './document.js';
import { sampleSkeleton } from './runtime.js';
import { bakingTimes } from './world-animation.js';
import { imagesRoot, readPngAsset } from './image-assets.js';
import { finishSlotKeys } from './animation-baking.js';

type Piece = { slot: string; name: string; attachment: JsonObject; color: string; dark?: string; blend: string };
const rgba = (values: number[]) => values.map(n => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0')).join('');

// An explicit visual-bake fallback: the ORIGINAL project is never patched.
// Convex triangle pieces avoid importing a native concave clip or mesh hole.
export async function bakeClipping(workspace: Workspace, source: SpineDocument, jsonPath: string, animation: string, newName: string, options: { skin?: string; fps?: number; physics?: boolean }) {
  safeName(newName);
  const fps = options.fps ?? 30, times = bakingTimes(source, animation, fps); if (times.length > 300) throw new Error('Clipping bake is limited to 300 sampled frames.');
  if (options.physics && times.reduce((sum, time) => sum + Math.ceil(time * fps), 0) * source.bones.length > 500000) throw new Error('Clipping physics bake exceeds the sampling budget.');
  const entries = attachmentEntries(source), root = await imagesRoot(workspace, source, jsonPath), assets = new Map<string, Awaited<ReturnType<typeof readPngAsset>>>(), frames: { time: number; pieces: Piece[] }[] = [], slotDefinitions = new Map<string, { name: string; bone: string; blend: string; dark?: string }>(); let trianglesGenerated = 0, clippingSamples = 0;
  for (const [frameIndex, time] of times.entries()) {
    const skeleton = sampleSkeleton(source, animation, time, options.skin, undefined, { physics: options.physics, fps }), clipper = new SkeletonClipping(), pieces: Piece[] = [];
    for (const slot of skeleton.drawOrder.appliedPose) {
      const pose = slot.appliedPose, attachment = pose.attachment;
      if (!slot.bone.active || !slot.data.visible || !attachment) { clipper.clipEnd(slot); continue; }
      if (attachment instanceof ClippingAttachment) { clipper.clipStart(skeleton, slot, attachment); clippingSamples++; continue; }
      if (!(attachment instanceof RegionAttachment) && !(attachment instanceof MeshAttachment)) { clipper.clipEnd(slot); continue; }
      const item = entries.find(item => item.slot === slot.data.name && skeleton.data.findSkin(item.skin)?.getAttachment(slot.data.index, item.name) === attachment); if (!item) throw new Error('Could not identify clipped source attachment.');
      const sequenceIndex = attachment.sequence.resolveIndex(pose), base = String(item.value.path ?? item.value.name ?? item.name), imagePath = item.value.sequence ? attachment.sequence.getPath(base, sequenceIndex) : base;
      if (!assets.has(imagePath)) { if (assets.size >= 128) throw new Error('Clipping bake accepts at most 128 active PNG images.'); assets.set(imagePath, await readPngAsset(workspace, path.resolve(root, `${imagePath}.png`))); }
      const asset = assets.get(imagePath)!;
      let vertices = new Array<number>(attachment instanceof RegionAttachment ? 8 : attachment.worldVerticesLength), triangles = attachment instanceof RegionAttachment ? [0, 1, 2, 0, 2, 3] : Array.from(attachment.triangles), uvs = Array.from(attachment.sequence.getUVs(sequenceIndex));
      if (attachment instanceof RegionAttachment) attachment.computeWorldVertices(slot, attachment.getOffsets(pose), vertices, 0, 2); else attachment.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2);
      if (clipper.isClipping()) { clipper.clipTrianglesUnpacked(vertices, 0, triangles, triangles.length, uvs); vertices = Array.from(clipper.clippedVerticesTyped); uvs = Array.from(clipper.clippedUVsTyped); triangles = Array.from(clipper.clippedTrianglesTyped); }
      const color = rgba([pose.color.r * attachment.color.r * skeleton.color.r, pose.color.g * attachment.color.g * skeleton.color.g, pose.color.b * attachment.color.b * skeleton.color.b, pose.color.a * attachment.color.a * skeleton.color.a]), dark = pose.darkColor ? rgba([pose.darkColor.r, pose.darkColor.g, pose.darkColor.b]) : undefined, blend = ['normal', 'additive', 'multiply', 'screen'][slot.data.blendMode]!;
      for (let i = 0, pieceIndex = 0; i < triangles.length; i += 3) {
        const face = triangles.slice(i, i + 3), points = face.flatMap(index => vertices.slice(index * 2, index * 2 + 2)), texture = face.flatMap(index => uvs.slice(index * 2, index * 2 + 2));
        if (points.length !== 6 || texture.length !== 6 || [...points, ...texture].some(n => !Number.isFinite(n))) throw new Error('Clipping produced invalid triangle data.');
        if (Math.abs((points[2]! - points[0]!) * (points[5]! - points[1]!) - (points[3]! - points[1]!) * (points[4]! - points[0]!)) < 1e-10) continue;
        if (texture.some(n => n < -1e-5 || n > 1 + 1e-5)) throw new Error('Clipping UV interpolation exceeds the original texture.');
        const slotName = `baked-${slot.data.index}-${pieceIndex++}`, name = `${slotName}-frame-${frameIndex}`;
        slotDefinitions.set(slotName, { name: slotName, bone: 'baked-root', blend, ...(dark ? { dark } : {}) });
        pieces.push({ slot: slotName, name, color, ...(dark ? { dark } : {}), blend, attachment: { type: 'mesh', path: imagePath, width: asset.width, height: asset.height, vertices: points, uvs: texture.map(n => Math.max(0, Math.min(1, n))), triangles: [0, 1, 2], hull: 3, edges: [0, 2, 2, 4, 4, 0] } });
        if (++trianglesGenerated > 20000 || slotDefinitions.size > 500) throw new Error('Visual clipping bake exceeds 20,000 triangle samples or 500 compound slots. Reduce range/FPS or mesh complexity.');
      }
      clipper.clipEnd(slot);
    }
    clipper.clipEnd(); frames.push({ time, pieces });
  }
  if (!clippingSamples) throw new Error('The selected animation/skin has no active clipping to bake.');
  const attachments: Record<string, Record<string, JsonObject>> = {}, slots = [...slotDefinitions.values()], channels: Record<string, JsonObject> = {}, orders: { time: number; order: string[] }[] = [];
  for (const slot of slots) { attachments[slot.name] = {}; channels[slot.name] = { attachment: [], ...(slot.dark ? { rgba2: [] } : { rgba: [] }) }; }
  for (const frame of frames) {
    const active = new Map(frame.pieces.map(piece => [piece.slot, piece]));
    for (const slot of slots) {
      const piece = active.get(slot.name), timeline = channels[slot.name]!; (timeline.attachment as JsonObject[]).push({ time: frame.time, ...(piece ? { name: piece.name } : {}) });
      if (piece) { attachments[slot.name]![piece.name] = piece.attachment; if (slot.dark) (timeline.rgba2 as JsonObject[]).push({ time: frame.time, light: piece.color, dark: piece.dark ?? '000000', curve: 'stepped' }); else (timeline.rgba as JsonObject[]).push({ time: frame.time, color: piece.color, curve: 'stepped' }); }
    }
    orders.push({ time: frame.time, order: [...slots.filter(slot => !active.has(slot.name)).map(slot => slot.name), ...frame.pieces.map(piece => piece.slot)] });
  }
  for (const value of Object.values(channels)) for (const channel of ['rgba', 'rgba2']) if (Array.isArray(value[channel]) && value[channel].length) delete value[channel].at(-1)!.curve;
  for (const slot of slots) { const first = frames[0]?.pieces.find(piece => piece.slot === slot.name); if (first) Object.assign(slot, { attachment: first.name, color: first.color }); }
  let data = parseDocument({ skeleton: { ...source.skeleton, images: root, fps: Math.max(240, fps) }, bones: [{ name: 'baked-root' }], slots, skins: [{ name: 'default', attachments }], ...(source.events ? { events: structuredClone(source.events) } : {}), animations: { [newName]: { slots: channels, ...(source.animations![animation]!.events ? { events: structuredClone(source.animations![animation]!.events) } : {}) } } });
  data = finishSlotKeys(data, newName, orders);
  if (Buffer.byteLength(JSON.stringify(data)) > 32 * 1024 * 1024) throw new Error('Visual clipping bake exceeds the 32 MiB document limit.');
  return { data, report: { visualBakeOnly: true, selectedSkin: options.skin ?? 'default', sourceAnimation: animation, newName, frames: times.length, fps, clippingSamples, triangleSamples: trianglesGenerated, slots: slots.length, sourceProjectUnchanged: true, preservesEditableClipping: false, preservesOriginalRigAndOtherAnimations: false, note: 'Dedicated sampled visual output: ordinary convex triangle meshes with discrete attachment swaps. Original rig, other skins and animations are retained only in the original source/archive. Pose equivalence is asserted only at sampled times, not continuously between frames.' } };
}
