import { randomUUID } from 'node:crypto';
import { parseDocument, object, safeName, type SpineDocument, type JsonObject } from './document.js';
import { at, tracks, type Track } from './advanced-animation.js';
import { pathFor, readPath, writePath, writable, effectiveTarget, copyTimelines, type DetailedTimelineTarget, type TimelineMapping } from './timeline-tools.js';
import { sampleSkeleton } from './runtime.js';
import { RotateTimeline } from '@esotericsoftware/spine-core';
class RuntimeCurve extends RotateTimeline { get breakpoints() { return Array.from(this.curves).slice(2, 20).filter((_value, index) => index % 2 === 0); } }

const timeOf = (key: JsonObject) => Number(key.time ?? 0);
const sameTime = (a: number, b: number) => Math.fround(a) === Math.fround(b);
export type Collision = 'error' | 'overwrite' | 'keep';
function animation(data: SpineDocument, name: string) { safeName(name); const value = data.animations?.[name]; if (!value) throw new Error(`Animation not found: ${name}`); return value; }
function cleanup(frames: JsonObject[]) { frames.sort((a, b) => timeOf(a) - timeOf(b)); if (frames.length) delete frames.at(-1)!.curve; return frames; }
function selected(data: SpineDocument, value: JsonObject, target: DetailedTimelineTarget) {
  writable(data, target); const path = pathFor(data, target), frames = readPath(value, path);
  return { path, frames: frames === undefined ? [] : structuredClone(frames as JsonObject[]) };
}
export function editKeyframes(source: SpineDocument, name: string, target: DetailedTimelineTarget, options: { action: 'upsert' | 'delete'; keyframes?: JsonObject[]; times?: number[]; indices?: number[]; start?: number; end?: number; collision?: Collision }) {
  const data = structuredClone(source), value = animation(data, name), { path, frames } = selected(data, value, target), collision = options.collision ?? 'error';
  let output = frames;
  if (options.action === 'delete') {
    if (!options.times?.length && !options.indices?.length && !options.keyframes?.length && options.start === undefined) throw new Error('Delete requires times, indices, keyframe identities or an inclusive start/end range.');
    if (options.indices?.some(index => !Number.isInteger(index) || index < 0 || index >= frames.length)) throw new Error('Delete index is outside timeline key count.');
    if (options.start !== undefined && (options.end === undefined || options.end < options.start)) throw new Error('Delete range requires start <= end.');
    output = frames.filter((key, index) => !(options.indices?.includes(index) || options.keyframes?.some(selected => sameTime(timeOf(selected), timeOf(key)) && (selected.name === undefined || selected.name === key.name)) || options.times?.some(time => sameTime(time, timeOf(key))) || options.start !== undefined && timeOf(key) >= options.start && timeOf(key) <= options.end!));
  } else {
    if (!options.keyframes?.length || options.keyframes.length > 10000) throw new Error('Upsert requires 1–10,000 keyframes.');
    for (const raw of options.keyframes) {
      const key = structuredClone(raw), time = timeOf(key); if (!Number.isFinite(time) || time < 0 || time > 300) throw new Error('Key time must be within 0–300.');
      const matches = output.filter(existing => sameTime(timeOf(existing), time) && (target.kind !== 'events' || existing.name === key.name));
      if (matches.length && collision === 'error') throw new Error(`Key collision at ${time}. Choose overwrite or keep.`);
      if (matches.length && collision === 'keep') continue;
      output = output.filter(existing => !matches.includes(existing)); output.push(key);
    }
  }
  writePath(value, path, cleanup(output)); return parseDocument(data);
}
export function editCurves(source: SpineDocument, name: string, target: DetailedTimelineTarget, times: number[], curve: 'linear' | 'stepped' | number[]) {
  const data = structuredClone(source), value = animation(data, name), { path, frames } = selected(data, value, target);
  if (target.kind === 'events' || target.kind === 'drawOrder' || target.kind === 'slot' && target.channel === 'attachment' || target.kind === 'attachment' && target.channel === 'sequence' || target.kind === 'bone' && target.channel === 'inherit' || target.kind === 'constraint' && target.channel === 'reset') throw new Error('Discrete channels do not have interpolation curves.');
  for (const time of times) { const index = frames.findIndex(key => sameTime(timeOf(key), time)); if (index < 0 || index === frames.length - 1) throw new Error(`No outgoing segment at ${time}.`); if (curve === 'linear') delete frames[index]!.curve; else frames[index]!.curve = structuredClone(curve); }
  writePath(value, path, frames); return parseDocument(data);
}
type Point = [number, number];
const mix = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export function splitCubic(p: [Point, Point, Point, Point], time: number) {
  if (p[1][0] < p[0][0] || p[2][0] < p[1][0] || p[2][0] > p[3][0]) throw new Error('Boundary synthesis requires monotone Bezier time controls inside the interval.');
  let lo = 0, hi = 1;
  for (let i = 0; i < 55; i++) { const t = (lo + hi) / 2, a = mix(p[0], p[1], t), b = mix(p[1], p[2], t), c = mix(p[2], p[3], t); if (mix(mix(a, b, t), mix(b, c, t), t)[0] < time) lo = t; else hi = t; }
  const t = (lo + hi) / 2, a = mix(p[0], p[1], t), b = mix(p[1], p[2], t), c = mix(p[2], p[3], t), d = mix(a, b, t), e = mix(b, c, t), f = mix(d, e, t);
  return { left: [a, d].flat(), right: [e, c].flat(), value: f[1] };
}
function values(key: JsonObject, track: Track): number[] {
  if (track.deform !== undefined) { const array = new Array<number>(track.deform).fill(0); (key.vertices as number[] ?? []).forEach((value, i) => { array[Number(key.offset ?? 0) + i] = value; }); return array; }
  if (track.colors) return track.colors.flatMap(field => { const hex = String(key[field] ?? (field === 'dark' ? '000000' : 'ffffffff')); const count = field !== 'dark' && ['rgba', 'rgba2'].includes(String(track.path.at(-1))) ? 4 : 3; return Array.from({ length: count }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2) || 'ff', 16) / 255); });
  return Object.entries(track.defaults ?? {}).filter(([, fallback]) => typeof fallback === 'number').map(([field, fallback]) => Number(key[field] ?? fallback));
}
function setValues(key: JsonObject, track: Track, components: number[]) {
  if (track.deform !== undefined) { delete key.offset; key.vertices = components; return; }
  let index = 0;
  if (track.colors) for (const field of track.colors) { const count = field !== 'dark' && ['rgba', 'rgba2'].includes(String(track.path.at(-1))) ? 4 : 3; key[field] = components.slice(index, index + count).map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join(''); index += count; }
  else for (const [field, fallback] of Object.entries(track.defaults ?? {})) if (typeof fallback === 'number') key[field] = components[index++];
}
export function insertBoundary(source: SpineDocument, name: string, target: DetailedTimelineTarget, time: number, mode: 'runtime' | 'curve' = 'runtime') {
  if (!Number.isFinite(time) || time < 0 || time > 300) throw new Error('Boundary time must be within 0–300.');
  const data = structuredClone(source), value = animation(data, name), { path, frames } = selected(data, value, target);
  if (frames.some(key => sameTime(timeOf(key), time))) return data;
  if (target.kind === 'events' || target.kind === 'constraint' && target.channel === 'reset') throw new Error('Events and physics resets cannot be synthesized.');
  const track = tracks(data, value).find(track => JSON.stringify(track.path) === JSON.stringify(path)); if (!track || !frames.length || time < timeOf(frames[0]!)) throw new Error('Boundary synthesis requires an existing active timeline at this time.');
  const leftIndex = frames.findLastIndex(key => timeOf(key) < time), left = frames[leftIndex]!, right = frames[leftIndex + 1];
  if (track.sequence !== undefined && right && String(left.mode ?? 'hold') !== 'hold') throw new Error('Boundary synthesis on playing sequences requires an explicit sequence key; automatic phase rounding is not lossless.');
  const key = at(track, time); delete key.curve;
  if (mode === 'runtime' && right && Array.isArray(left.curve)) {
    const t0 = timeOf(left), t1 = timeOf(right), breakpoints = new Set<number>([time]), a = track.deform !== undefined ? [0] : values(left, track), b = track.deform !== undefined ? [1] : values(right, track);
    for (let component = 0; component < a.length; component++) {
      const controls = left.curve.slice(component * 4, component * 4 + 4) as [number, number, number, number];
      splitCubic([[t0, a[component]!], [controls[0], controls[1]], [controls[2], controls[3]], [t1, b[component]!]], time);
      const curve = new RuntimeCurve(2, 1, 0); curve.setFrame(0, t0, a[component]!); curve.setFrame(1, t1, b[component]!); curve.setBezier(0, 0, 0, t0, a[component]!, ...controls, t1, b[component]!);
      for (const t of curve.breakpoints) if (t > t0 && t < t1) breakpoints.add(t);
    }
    const keys = [...breakpoints].sort((a, b) => a - b).map(t => { const sample = at(track, t); delete sample.curve; return sample; });
    delete left.curve; frames.splice(leftIndex + 1, 0, ...keys); writePath(value, path, cleanup(frames));
    // 4.3.23 snaps times very close to whole editor frames on JSON import.
    // A finer editor grid preserves generated fractional breakpoints in native
    // round-trips. Timeline values remain in seconds, so playback is unchanged.
    data.skeleton.fps = Math.max(Number(data.skeleton.fps ?? 30), 240);
    return parseDocument(data);
  }
  if (right && left.curve === 'stepped') { key.curve = 'stepped'; }
  else if (right && Array.isArray(left.curve)) {
    const t0 = timeOf(left), t1 = timeOf(right), a = track.deform !== undefined ? [0] : values(left, track), b = track.deform !== undefined ? [1] : values(right, track);
    const leftControls: number[] = [], rightControls: number[] = [], interpolated: number[] = [];
    for (let i = 0; i < a.length; i++) { const c = left.curve.slice(i * 4, i * 4 + 4) as [number, number, number, number], part = splitCubic([[t0, a[i]!], [c[0], c[1]], [c[2], c[3]], [t1, b[i]!]], time); leftControls.push(...part.left); rightControls.push(...part.right); interpolated.push(part.value); }
    if (track.deform !== undefined) {
      const f = interpolated[0]!, originalA = values(left, track), originalB = values(right, track); if (Math.abs(f) < 1e-12 || Math.abs(1 - f) < 1e-12) throw new Error('Deform split has a singular easing value; select another boundary.');
      setValues(key, track, originalA.map((n, i) => n + (originalB[i]! - n) * f));
      left.curve = leftControls.map((n, i) => i % 2 ? n / f : n); key.curve = rightControls.map((n, i) => i % 2 ? (n - f) / (1 - f) : n);
    } else { setValues(key, track, interpolated); left.curve = leftControls; key.curve = rightControls; }
  }
  frames.splice(leftIndex + 1, 0, key); writePath(value, path, cleanup(frames)); return parseDocument(data);
}
export function pasteKeyframes(source: SpineDocument, fromAnimation: string, toAnimation: string, mappings: TimelineMapping[], start: number, end: number, destination: number, collision: Collision = 'error', boundaries = false) {
  if (end < start || destination < 0 || end > 300) throw new Error('Paste requires a valid source range and nonnegative destination.');
  let prepared = source;
  if (boundaries) for (const mapping of mappings) for (const time of [start, end]) prepared = insertBoundary(prepared, fromAnimation, effectiveTarget(prepared, mapping.from), time);
  const temporary = `mcp-paste-${randomUUID()}`, copied = copyTimelines(prepared, fromAnimation, temporary, mappings), origin = copied.animations![temporary]!;
  let result = structuredClone(source); safeName(toAnimation); result.animations ??= {}; if (!Object.hasOwn(result.animations, toAnimation)) result.animations[toAnimation] = {};
  for (const mapping of mappings) {
    const path = pathFor(copied, mapping.to), frames = structuredClone(readPath(origin, path) as JsonObject[]).filter(key => timeOf(key) >= start && timeOf(key) <= end);
    for (const key of frames) { key.time = timeOf(key) + destination - start; if (Array.isArray(key.curve)) key.curve = key.curve.map((value: number, i: number) => i % 2 ? value : value + destination - start); }
    cleanup(frames); if (frames.length) result = editKeyframes(result, toAnimation, mapping.to, { action: 'upsert', keyframes: frames, collision });
  }
  return parseDocument(result);
}
export function keyPose(source: SpineDocument, name: string, sourceAnimation: string, time: number, destination: number, bones: string[], skin?: string, collision: Collision = 'error') {
  const skeleton = sampleSkeleton(source, sourceAnimation, time, skin); let data = structuredClone(source); safeName(name); data.animations ??= {}; if (!Object.hasOwn(data.animations, name)) data.animations[name] = {};
  for (const boneName of bones) {
    const bone = skeleton.bones.find(bone => bone.data.name === boneName); if (!bone?.active) throw new Error(`Pose bone missing or inactive: ${boneName}`);
    const pose = bone.pose, setup = bone.data.setupPose;
    if (!setup.scaleX || !setup.scaleY) throw new Error('Pose keys require nonzero setup scales.');
    const channels = { rotate: { value: pose.rotation - setup.rotation }, translate: { x: pose.x - setup.x, y: pose.y - setup.y }, scale: { x: pose.scaleX / setup.scaleX, y: pose.scaleY / setup.scaleY }, shear: { x: pose.shearX - setup.shearX, y: pose.shearY - setup.shearY } };
    for (const [channel, values] of Object.entries(channels)) data = editKeyframes(data, name, { kind: 'bone', bone: boneName, channel: channel as 'rotate' }, { action: 'upsert', keyframes: [{ time: destination, ...values }], collision });
  }
  return data;
}
