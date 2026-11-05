import { sampleTimes } from './advanced-animation.js';

/** CFR media uses the half-open requested interval by default. The exact endpoint
 * is useful for still-frame exports, but would add a hold at a loop boundary. */
export function mediaSampleTimes(start: number, end: number, fps: number, omitEndFrame = true): number[] {
  const times = sampleTimes(start, end, fps, 302);
  // Native JSON rounds key times, e.g. 20/30 becomes 0.6666667. Retain the
  // requested endpoint, removing a preceding grid sample only within 1e-5 frames.
  if (times.length > 2 && end - times.at(-2)! <= 1e-5 / fps) times.splice(-2, 1);
  if (omitEndFrame && times.length > 1) times.pop();
  if (times.length > 300) throw new Error('Media exceeds 300 encoded frames. Lower FPS or shorten the range.');
  return times;
}
