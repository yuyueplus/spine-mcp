import { SkeletonJson, Skeleton, MixFrom, Physics } from '@esotericsoftware/spine-core';
import { boneDiagramLoader } from './runtime.js';
import type { SpineDocument } from './document.js';
export function animationSampler(data: SpineDocument, animation?: string, skin?: string, options: { physics?: boolean; fps?: number } = {}) {
  if (['ik', 'transform', 'path', 'physics'].some(key => Array.isArray(data[key]) && (data[key] as unknown[]).length)) throw new Error('Use modern Spine 4.3 constraint layout for this sampler.');
  const parsed = new SkeletonJson(boneDiagramLoader).readSkeletonData(data), skeleton = new Skeleton(parsed), selected = animation ? parsed.findAnimation(animation) : null;
  if (animation && !selected) throw new Error(`Animation not found: ${animation}`);
  if (skin) skeleton.setSkin(skin);
  const fps = options.fps ?? 60;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('Sampler FPS must be 1–120.');
  let previous = -1, steps = 0;
  const reset = () => { skeleton.time = 0; skeleton.setupPose(); selected?.apply(skeleton, -1, 0, false, null, 1, MixFrom.setup, false, false, false); skeleton.updateWorldTransform(Physics.reset); previous = 0; };
  return { skeleton, duration: selected?.duration ?? 0, get integrationSteps() { return steps; }, sample(time: number) {
    if (!Number.isFinite(time) || time < 0 || time > 300) throw new Error('Invalid sample time.');
    if (options.physics) {
      if (Math.ceil(time * fps) > 6000) throw new Error('Physics sampling exceeds 6000 steps from time zero.');
      if (previous < 0 || time < previous - 1e-12) reset();
      while (previous < time - 1e-12) {
        let next = Math.min(time, (Math.floor(previous * fps + 1e-8) + 1) / fps); if (next <= previous) next = Math.min(time, previous + 1 / fps);
        if (++steps * data.bones.length > 500000) throw new Error('Physics sampler exceeds 500,000 bone integration steps.');
        selected?.apply(skeleton, previous, next, false, null, 1, MixFrom.setup, false, false, false); skeleton.update(next - previous); skeleton.updateWorldTransform(Physics.update); previous = next;
      }
      return skeleton;
    }
    skeleton.setupPose(); selected?.apply(skeleton, -1, time, false, null, 1, MixFrom.setup, false, false, false); skeleton.updateWorldTransform(Physics.none); return skeleton;
  } };
}
