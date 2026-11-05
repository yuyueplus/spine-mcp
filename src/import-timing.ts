import { object, type SpineDocument } from './document.js';
export function importTiming(source: SpineDocument) {
  const times: number[] = [];
  for (const animation of Object.values(source.animations ?? {})) for (const raw of Object.values(object(animation.bones ?? {}, 'bones'))) for (const frames of Object.values(object(raw, 'channels'))) if (Array.isArray(frames)) for (const frame of frames) times.push(Number(object(frame, 'keyframe').time ?? 0));
  const originalFps = Number(source.skeleton.fps ?? 30), base = Number.isInteger(originalFps) && originalFps >= 1 && originalFps <= 240 ? originalFps : 30;
  const compatible = (fps: number) => times.every(t => Math.abs(t * fps - Math.round(t * fps)) <= 0.00025);
  const matching = compatible(base) ? base : Array.from({ length: 241 - base }, (_, i) => base + i).find(compatible);
  const fps = matching ?? base, changed = fps !== originalFps;
  return { data: changed ? { ...source, skeleton: { ...source.skeleton, fps } } : source, report: { originalFps, importFps: fps, changed, boneKeyCount: times.length, boneKeysOnEditorGrid: compatible(fps), note: matching ? 'Only editor FPS metadata changes; key times and playback duration are preserved.' : 'No exact bone-key frame grid at or below 240 FPS was found. Key times are preserved; inspect native import timing.' } };
}
