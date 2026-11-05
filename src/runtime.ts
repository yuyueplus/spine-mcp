import { SkeletonJson, Skeleton, MixFrom, Physics, BoundingBoxAttachment, PathAttachment, PointAttachment, ClippingAttachment, RegionAttachment, MeshAttachment, TextureRegion, type AttachmentLoader, type Sequence } from '@esotericsoftware/spine-core';
import type { SpineDocument } from './document.js';

export const boneDiagramLoader: AttachmentLoader = {
  newRegionAttachment: (_skin, _placeholder, name, _path, sequence) => { fillDummyRegions(sequence); return new RegionAttachment(name, sequence); },
  newMeshAttachment: (_skin, _placeholder, name, _path, sequence) => { fillDummyRegions(sequence); return new MeshAttachment(name, sequence); },
  newBoundingBoxAttachment: (_skin, _placeholder, name) => new BoundingBoxAttachment(name),
  newPathAttachment: (_skin, _placeholder, name) => new PathAttachment(name),
  newPointAttachment: (_skin, _placeholder, name) => new PointAttachment(name),
  newClippingAttachment: (_skin, _placeholder, name) => new ClippingAttachment(name),
};
function fillDummyRegions(sequence: Sequence) {
  for (let index = 0; index < sequence.regions.length; index++) {
    const region = new TextureRegion(); region.width = region.height = region.originalWidth = region.originalHeight = 1; region.u2 = region.v2 = 1; sequence.regions[index] = region;
  }
}
export interface PreviewOptions { physics?: boolean; fps?: number; viewport?: { minX: number; maxX: number; minY: number; maxY: number } }
export function sampleSkeleton(data: SpineDocument, animation: string | undefined, time: number, skin?: string, loader = boneDiagramLoader, options: PreviewOptions = {}) {
  if (!Number.isFinite(time) || time < 0 || time > 300) throw new Error('Preview time must be between 0 and 300 seconds.');
  if (data.bones.length > 2000) throw new Error('Preview is limited to 2000 bones.');
  if (['ik', 'transform', 'path', 'physics'].some(key => Array.isArray(data[key]) && (data[key] as unknown[]).length)) throw new Error('This preview runtime does not support the legacy constraint layout in this file. Use the matching editor to validate constraints.');
  const skeletonData = new SkeletonJson(loader).readSkeletonData(data), skeleton = new Skeleton(skeletonData);
  if (skin) skeleton.setSkin(skin);
  skeleton.setupPose();
  const selected = animation ? skeletonData.findAnimation(animation) : undefined;
  if (animation && !selected) throw new Error(`Animation not found: ${animation}`);
  if (options.physics) {
    const fps = options.fps ?? 60;
    if (!Number.isInteger(fps) || fps < 1 || fps > 120 || Math.ceil(time * fps) > 6000) throw new Error('Physics preview allows 1–120 FPS and at most 6000 simulation steps.');
    selected?.apply(skeleton, -1, 0, false, null, 1, MixFrom.setup, false, false, false);
    skeleton.updateWorldTransform(Physics.reset);
    const steps = Math.ceil(time * fps);
    for (let step = 1; step <= steps; step++) {
      const previous = (step - 1) / fps, current = Math.min(step / fps, time);
      selected?.apply(skeleton, previous, current, false, null, 1, MixFrom.setup, false, false, false);
      skeleton.update(current - previous); skeleton.updateWorldTransform(Physics.update);
    }
  } else {
    selected?.apply(skeleton, -1, time, false, null, 1, MixFrom.setup, false, false, false);
    skeleton.updateWorldTransform(Physics.none);
  }
  return skeleton;
}
export const escapeXml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
