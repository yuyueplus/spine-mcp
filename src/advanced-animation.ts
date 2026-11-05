import { object, parseDocument, safeName, type JsonObject, type SpineDocument } from './document.js';
import { retimeAnimation } from './animation-edits.js';
import { constraintKeyFields, constraintTracks, constraintTypes } from './constraint-data.js';
import { attachmentEntries, attachmentTracks, normalizedAttachmentKeys } from './attachment-data.js';
import { sampleSkeleton } from './runtime.js';
import { RotateTimeline } from '@esotericsoftware/spine-core';

export function animationDuration(animation: JsonObject): number {
  const visit = (value: unknown): number => {
    let duration = 0;
    if (value && typeof value === 'object') for (const [field, child] of Object.entries(value)) duration = Math.max(duration, field === 'time' && typeof child === 'number' ? child : visit(child));
    return duration;
  };
  return visit(animation);
}
function animation(data: SpineDocument, name: string) {
  if (!data.animations || !Object.hasOwn(data.animations, name)) throw new Error(`Animation not found: ${name}`);
  return data.animations[name]!;
}
function destination(data: SpineDocument, name: string) { safeName(name); if (Object.hasOwn(data.animations ?? {}, name)) throw new Error(`Animation already exists: ${name}`); }
function rate(fps: number) { if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('FPS must be an integer from 1 to 120.'); }
export function sampleTimes(start: number, end: number, fps: number, max = 6000) {
  rate(fps);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > 300) throw new Error('Time range must satisfy 0 <= start <= end <= 300 seconds.');
  const count = Math.floor((end - start) * fps + 1e-8);
  if (count + 2 > max + 1) throw new Error(`Time range exceeds ${max} frames. Lower FPS or shorten it.`);
  const times = Array.from({ length: count + 1 }, (_, index) => Math.min(start + index / fps, end));
  if (end - times.at(-1)! > 1e-8) times.push(end); else times[times.length - 1] = end;
  if (times.length > max) throw new Error(`Time range exceeds ${max} frames. Lower FPS or shorten it.`);
  return times;
}
function bezier(time: number, t0: number, v0: number, t1: number, v1: number, controls: number[]) {
  const [x1, y1, x2, y2] = controls as [number, number, number, number];
  if (x1 < t0 || x2 < x1 || x2 > t1) throw new Error('Resampling requires monotone Bezier time controls inside their key interval.');
  const timeline = new RotateTimeline(2, 1, 0);
  timeline.setFrame(0, t0, v0); timeline.setFrame(1, t1, v1);
  timeline.setBezier(0, 0, 0, t0, v0, x1, y1, x2, y2, t1, v1);
  return timeline.getCurveValue(time);
}
export type Track = { path: (string | number)[]; frames: JsonObject[]; defaults?: JsonObject; colors?: string[]; deform?: number; sequence?: number; event?: boolean; discrete?: boolean };
export function tracks(data: SpineDocument, value: JsonObject): Track[] {
  const result: Track[] = [];
  for (const group of ['bones', 'slots']) for (const [entity, channels] of Object.entries(object(value[group] ?? {}, group))) for (const [channel, raw] of Object.entries(object(channels, 'channels'))) {
    const track: Track = { path: [group, entity, channel], frames: raw as JsonObject[] };
    if (group === 'bones') {
      if (['translate', 'scale', 'shear'].includes(channel)) track.defaults = { x: channel === 'scale' ? 1 : 0, y: channel === 'scale' ? 1 : 0 };
      else if (channel !== 'inherit') track.defaults = { value: channel.startsWith('scale') ? 1 : 0 };
      else track.discrete = true;
    } else {
      if (channel === 'attachment') track.discrete = true;
      else if (channel === 'alpha') track.defaults = { value: 1 };
      else { track.colors = channel.endsWith('2') ? ['light', 'dark'] : ['color']; }
    }
    result.push(track);
  }
  for (const track of constraintTracks(data, value)) result.push({ path: ['ik', 'transform'].includes(track.type) ? [track.type, track.name] : [track.type, track.name, track.channel], frames: track.frames, defaults: constraintKeyFields(track.type, track.channel), discrete: track.channel === 'reset' });
  for (const track of attachmentTracks(data, value)) result.push({ path: ['attachments', track.skin, track.slot, track.name, track.channel], frames: normalizedAttachmentKeys(track), ...(track.channel === 'deform' ? { deform: track.length } : { sequence: Number(object(attachmentEntries(data).find(item => item.skin === track.skin && item.slot === track.slot && item.name === track.name)!.value.sequence, 'sequence').count) }) });
  if (Array.isArray(value.events)) result.push({ path: ['events'], frames: value.events as JsonObject[], event: true });
  if (Array.isArray(value.drawOrder)) result.push({ path: ['drawOrder'], frames: value.drawOrder as JsonObject[], discrete: true });
  if (Array.isArray(value.drawOrderFolder)) value.drawOrderFolder.forEach((raw, index) => result.push({ path: ['drawOrderFolder', index, 'keys'], frames: object(raw, 'folder').keys as JsonObject[], discrete: true }));
  return result;
}
function put(root: JsonObject, path: (string | number)[], value: unknown) {
  let current: any = root;
  path.forEach((part, index) => { if (index === path.length - 1) current[part] = value; else current = current[part] ??= typeof path[index + 1] === 'number' ? [] : {}; });
}
function components(key: JsonObject, track: Track): number[] {
  if (track.deform !== undefined) return key.vertices as number[];
  if (track.colors) return track.colors.flatMap(field => {
    const color = String(key[field] ?? (field === 'dark' ? '000000' : 'ffffffff')).padEnd(8, 'f'), channel = String(track.path.at(-1)), length = field !== 'dark' && ['rgba', 'rgba2'].includes(channel) ? 4 : 3;
    return Array.from({ length }, (_, index) => Number.parseInt(color.slice(index * 2, index * 2 + 2), 16) / 255);
  });
  return Object.entries(track.defaults ?? {}).filter(([_field, fallback]) => typeof fallback === 'number').map(([field, fallback]) => Number(key[field] ?? (field === 'mixY' ? key.mixX : field === 'mixScaleY' ? key.mixScaleX : undefined) ?? fallback));
}
function sequenceIndex(key: JsonObject, time: number, count: number) {
  const mode = String(key.mode ?? 'hold'); let index = Number(key.index ?? 0);
  if (mode === 'hold') return index;
  index += Math.floor((time - Number(key.time ?? 0)) / Number(key.delay) + 0.00001);
  if (mode === 'once') return Math.min(count - 1, index);
  if (mode === 'loop') return index % count;
  if (mode === 'onceReverse') return Math.max(count - 1 - index, 0);
  if (mode === 'loopReverse') return count - 1 - index % count;
  const n = 2 * count - 2;
  index = n === 0 ? 0 : (index + (mode === 'pingpongReverse' ? count - 1 : 0)) % n;
  return index >= count ? n - index : index;
}
export function at(track: Track, time: number): JsonObject {
  let index = 0;
  while (index < track.frames.length - 1 && Number(track.frames[index + 1]!.time ?? 0) <= time) index++;
  const left = track.frames[index]!, right = track.frames[index + 1], t0 = Number(left.time ?? 0), t1 = Number(right?.time ?? t0);
  if (track.sequence !== undefined) return { time, mode: 'hold', index: sequenceIndex(left, time, track.sequence) };
  if (track.discrete) { const key = structuredClone(left); delete key.curve; return { ...key, time }; }
  const a = components(left, track), b = right ? components(right, track) : a;
  const values = a.map((value, i) => {
    if (!right || left.curve === 'stepped' || t1 <= t0) return value;
    if (Array.isArray(left.curve)) {
      if (track.deform !== undefined) return value + (b[i]! - value) * bezier(time, t0, 0, t1, 1, left.curve.map(Number));
      return bezier(time, t0, value, t1, b[i]!, left.curve.slice(i * 4, i * 4 + 4).map(Number));
    }
    return value + (b[i]! - value) * (time - t0) / (t1 - t0);
  });
  if (track.deform !== undefined) return { time, vertices: values };
  const key: JsonObject = { time };
  if (track.colors) {
    let offset = 0;
    for (const field of track.colors) { const length = field !== 'dark' && ['rgba', 'rgba2'].includes(String(track.path.at(-1))) ? 4 : 3; key[field] = values.slice(offset, offset + length).map(n => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0')).join(''); offset += length; }
  } else {
    let offset = 0;
    for (const [field, fallback] of Object.entries(track.defaults ?? {})) key[field] = typeof fallback === 'number' ? values[offset++]! : left[field] ?? fallback;
  }
  if (left.curve === 'stepped' && right && time < t1) key.curve = 'stepped';
  return key;
}
export function cropAnimation(source: SpineDocument, name: string, newName: string, start: number, end: number, fps = 60) {
  destination(source, newName); const original = animation(source, name);
  if (end <= start || end > animationDuration(original)) throw new Error('Crop requires start < end <= animation duration.');
  const grid = sampleTimes(start, end, fps), data = structuredClone(source);
  retimeAnimation(source, name, 1, 0); // Reject unknown populated timeline formats before touching anything.
  const output: JsonObject = {};
  if (original.color !== undefined) output.color = original.color;
  if (Array.isArray(original.drawOrderFolder)) output.drawOrderFolder = original.drawOrderFolder.map(raw => ({ ...object(raw, 'folder'), keys: [] }));
  for (const track of tracks(source, original)) {
    if (!track.frames.length) continue;
    let keys: JsonObject[];
    if (track.event || (track.discrete && track.path[0] === 'physics')) keys = track.frames.filter(key => Number(key.time ?? 0) >= start && Number(key.time ?? 0) <= end).map(key => ({ ...structuredClone(key), time: Number(key.time ?? 0) - start }));
    else {
      const times = [...new Set([...grid, ...track.frames.map(key => Number(key.time ?? 0)).filter(time => time >= start && time <= end)])].filter(time => time >= Number(track.frames[0]!.time ?? 0)).sort((a, b) => a - b);
      keys = [...new Map(times.map(time => [Math.fround(time - start), { ...at(track, time), time: Math.fround(time - start) }])).values()];
      if (keys.length) delete keys.at(-1)!.curve;
    }
    if (keys.length) put(output, track.path, keys);
  }
  (data.animations ??= {})[newName] = output;
  return parseDocument(data);
}
export function mergeAnimations(source: SpineDocument, names: string[], newName: string, gap = 0, fps = 60) {
  destination(source, newName); rate(fps);
  if (names.length < 2 || names.length > 20 || !Number.isFinite(gap) || gap < 0) throw new Error('Merge requires 2–20 animations and a nonnegative gap.');
  const data = structuredClone(source), output: JsonObject = {}; let offset = 0;
  const heldPaths = new Set<string>();
  for (const name of names) {
    const duration = animationDuration(animation(source, name));
    if (duration <= 0) throw new Error(`Cannot concatenate a zero-duration animation: ${name}`);
    const temporary = `mcp-merge-${Math.random().toString(36).slice(2)}`;
    const segment = cropAnimation(source, name, temporary, 0, duration, fps).animations![temporary]!;
    if (segment.drawOrderFolder !== undefined) throw new Error('Merge folder draw-order tracks separately before concatenating.');
    const current = tracks(source, segment).filter(track => track.frames.length), paths = new Set(current.filter(track => !track.event && !(track.discrete && track.path[0] === 'physics')).map(track => JSON.stringify(track.path)));
    if (current.some(track => !track.event && !(track.discrete && track.path[0] === 'physics') && Number(track.frames[0]!.time ?? 0) !== 0)) throw new Error('Each merged stateful track needs an explicit key at time zero.');
    if (heldPaths.size && (heldPaths.size !== paths.size || [...heldPaths].some(path => !paths.has(path)))) throw new Error('Merged clips must animate the same stateful track set. Add explicit setup keys for missing tracks first, preventing stale poses between clips.');
    paths.forEach(path => heldPaths.add(path));
    for (const track of current) {
      let existing: any = output;
      for (const part of track.path) existing = existing?.[part];
      const keys = (existing ?? []) as JsonObject[];
      if (offset && !track.event && !(track.discrete && track.path[0] === 'physics') && keys.length) {
        if (gap === 0 && Math.fround(Number(keys.at(-1)!.time)) === Math.fround(offset)) {
          if (track.discrete || track.sequence !== undefined) keys.pop();
          else {
            // The installed editor snaps very close times onto the same key.
            // Reserve a tenth of a sampled frame for the endpoint hold/cut.
            const before = Math.fround(offset - 1 / (fps * 10));
            if (before < 0 || (keys.length > 1 && before <= Number(keys.at(-2)!.time))) throw new Error('Merge boundary is too close to an existing key; lower FPS or remove the nearby key.');
            keys.at(-1)!.time = before; keys.at(-1)!.curve = 'stepped';
          }
        }
        else if (!track.discrete && track.sequence === undefined) keys.at(-1)!.curve = 'stepped';
      }
      const shifted = track.frames.map(key => ({ ...key, time: Math.fround(Number(key.time ?? 0) + offset) }));
      put(output, track.path, [...keys, ...shifted]);
    }
    offset = Math.fround(offset + duration + gap);
    if (offset - gap > 300) throw new Error('Merged duration exceeds 300 seconds.');
  }
  (data.animations ??= {})[newName] = output; return parseDocument(data);
}
export function mirrorAnimation(source: SpineDocument, name: string, newName: string, axis: 'x' | 'y', bones?: string[]) {
  destination(source, newName); const data = structuredClone(source), value = structuredClone(animation(data, name));
  const selected = new Set(bones ?? data.bones.map(bone => bone.name));
  for (const bone of selected) if (!data.bones.some(item => item.name === bone)) throw new Error(`Missing mirror bone: ${bone}`);
  for (const [bone, channels] of Object.entries(object(value.bones ?? {}, 'bones'))) {
    if (!selected.has(bone)) continue;
    for (const [channel, raw] of Object.entries(object(channels, 'channels'))) {
      const fields = channel === 'rotate' ? ['value'] : channel === 'shear' ? ['x', 'y'] : channel === 'translate' ? [axis] : channel === `translate${axis}` || channel.startsWith('shear') ? ['value'] : [];
      if (!fields.length) continue;
      const numericOrder = ['translate', 'shear'].includes(channel) ? ['x', 'y'] : ['value'];
      for (const key of raw as JsonObject[]) {
        fields.forEach(field => { if (typeof key[field] === 'number') key[field] = -key[field]; });
        if (Array.isArray(key.curve)) key.curve = key.curve.map((n: number, index: number) => index % 2 === 1 && fields.includes(numericOrder[Math.floor(index / 4)]!) ? -n : n);
      }
    }
  }
  (data.animations ??= {})[newName] = value; return parseDocument(data);
}

// Bake an isolated rig variant: keeping constraints or other unbaked animations
// would apply their effects a second time or alter their behavior silently.
export function bakeAnimation(source: SpineDocument, name: string, newName: string, fps = 60, skin?: string, physics = false) {
  safeName(newName); const original = animation(source, name), duration = animationDuration(original), times = sampleTimes(0, duration, fps);
  if (source.bones.length * times.length > 200000) throw new Error('Bake exceeds 200000 bone samples. Lower FPS or shorten the animation.');
  if (physics && times.reduce((sum, time) => sum + Math.ceil(time * fps), 0) * source.bones.length > 500000) throw new Error('Physics bake exceeds the simulation budget. Lower FPS or shorten the animation.');
  for (const raw of Array.isArray(source.constraints) ? source.constraints : []) {
    const constraint = object(raw, 'constraint');
    if (constraint.type === 'slider' && Object.entries(animation(source, String(constraint.animation))).some(([field, value]) => !['bones', 'color'].includes(field) && value && typeof value === 'object' && Object.keys(value).length)) throw new Error('Bone baking requires bone-only slider source animations; bake their non-bone effects separately.');
  }
  if (source.bones.some(bone => Number(bone.scaleX ?? 1) === 0 || Number(bone.scaleY ?? 1) === 0)) throw new Error('Cannot bake against zero setup scale.');
  const data = structuredClone(source), output = structuredClone(original); delete output.bones;
  for (const type of constraintTypes) delete output[type];
  const channels = Object.fromEntries(data.bones.map(bone => [bone.name, { rotate: [] as JsonObject[], translate: [] as JsonObject[], scale: [] as JsonObject[], shear: [] as JsonObject[], ...((object(original.bones ?? {}, 'bone channels')[bone.name] as JsonObject | undefined)?.inherit === undefined ? {} : { inherit: object(object(original.bones, 'bones')[bone.name], 'channels').inherit }) }]));
  for (const time of times) {
    const skeleton = sampleSkeleton(source, name, time, skin, undefined, { physics, fps });
    for (const bone of skeleton.bones) {
      const pose = bone.appliedPose; pose.updateLocalTransform(skeleton);
      const setup = bone.data.setupPose, target = channels[bone.data.name]!;
      const rotation = pose.rotation - setup.rotation, previous = Number(target.rotate.at(-1)?.value ?? rotation);
      const unwrapped = rotation + 360 * Math.round((previous - rotation) / 360);
      const values = [pose.x, pose.y, pose.scaleX, pose.scaleY, pose.shearX, pose.shearY, unwrapped];
      if (!values.every(Number.isFinite)) throw new Error(`Cannot bake singular world transform: ${bone.data.name}`);
      target.rotate.push({ time, value: unwrapped }); target.translate.push({ time, x: pose.x - setup.x, y: pose.y - setup.y });
      target.scale.push({ time, x: pose.scaleX / setup.scaleX, y: pose.scaleY / setup.scaleY }); target.shear.push({ time, x: pose.shearX - setup.shearX, y: pose.shearY - setup.shearY });
    }
  }
  output.bones = channels; data.animations = { [newName]: output }; delete data.constraints;
  if (Array.isArray(data.skins)) for (const raw of data.skins) for (const type of constraintTypes) delete object(raw, 'skin')[type];
  return parseDocument(data);
}
