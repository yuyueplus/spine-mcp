import { object, parseDocument, safeName, type JsonObject, type SpineDocument } from './document.js';
import { attachmentEntries, attachmentTracks, sourceMesh, vertexLayout } from './attachment-data.js';
import { constraintKeyFields, constraintTracks, constraintTypes, resolveConstraint, type ConstraintType } from './constraint-data.js';
import type { TimelineTarget } from './animation-edits.js';
import { orientedTriangles } from './geometry-verification.js';

export const boneTimelineChannels = ['rotate', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary', 'inherit'] as const;
export const slotTimelineChannels = ['attachment', 'rgba', 'rgb', 'alpha', 'rgba2', 'rgb2'] as const;
export type DetailedTimelineTarget = TimelineTarget
  | { kind: 'constraint'; constraint: string; constraintType: ConstraintType; channel: string }
  | { kind: 'attachment'; skin: string; slot: string; name: string; channel: 'deform' | 'sequence' };
export interface TimelineMapping { from: DetailedTimelineTarget; to: DetailedTimelineTarget }
export interface TimelineCopyOptions { replace?: boolean; timeScale?: number; timeOffset?: number }
type Track = { target: DetailedTimelineTarget; frames: JsonObject[] };
const maxKeys = 100_000, maxDeformCoordinates = 5_000_000, maxCopyBytes = 16 * 1024 * 1024;

function animation(data: SpineDocument, name: string): JsonObject {
  safeName(name); if (!Object.hasOwn(data.animations ?? {}, name)) throw new Error(`Animation not found: ${name}`);
  return data.animations![name]!;
}
function attachment(data: SpineDocument, target: Extract<DetailedTimelineTarget, { kind: 'attachment' }>) {
  const found = attachmentEntries(data).find(item => item.skin === target.skin && item.slot === target.slot && item.name === target.name);
  if (!found) throw new Error(`Attachment not found: ${target.skin}/${target.slot}/${target.name}`); return found;
}
export function pathFor(data: SpineDocument, target: DetailedTimelineTarget): string[] {
  if (target.kind === 'bone') {
    safeName(target.bone); if (!data.bones.some(item => item.name === target.bone) || !(boneTimelineChannels as readonly string[]).includes(target.channel)) throw new Error('Missing bone or unsupported bone channel.');
    return ['bones', target.bone, target.channel];
  }
  if (target.kind === 'slot') {
    safeName(target.slot); if (!data.slots?.some(item => item.name === target.slot) || !(slotTimelineChannels as readonly string[]).includes(target.channel)) throw new Error('Missing slot or unsupported slot channel.');
    return ['slots', target.slot, target.channel];
  }
  if (target.kind === 'constraint') {
    if (!(target.constraintType === 'physics' && target.constraint === '')) { safeName(target.constraint); resolveConstraint(data, target.constraint, target.constraintType); }
    constraintKeyFields(target.constraintType, target.channel);
    return ['ik', 'transform'].includes(target.constraintType) ? [target.constraintType, target.constraint] : [target.constraintType, target.constraint, target.channel];
  }
  if (target.kind === 'attachment') {
    [target.skin, target.slot, target.name].forEach(safeName); const item = attachment(data, target);
    if (target.channel === 'deform') vertexLayout(data, sourceMesh(data, target.skin, target.slot, target.name));
    else if (target.channel !== 'sequence' || item.value.sequence === undefined) throw new Error('Sequence channel requires an attachment sequence.');
    return ['attachments', target.skin, target.slot, target.name, target.channel];
  }
  if (target.kind === 'events' || target.kind === 'drawOrder') return [target.kind];
  throw new Error('Unsupported timeline target. Flatten folder draw order before editing it with these tools.');
}
export function readPath(value: JsonObject, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) { const map = object(current ?? {}, 'timeline map'); if (!Object.hasOwn(map, key)) return undefined; current = map[key]; }
  return current;
}
export function writePath(value: JsonObject, path: string[], frames: JsonObject[]) {
  let map = value;
  for (const key of path.slice(0, -1)) { if (!Object.hasOwn(map, key)) map[key] = {}; map = object(map[key], 'timeline map'); }
  map[path.at(-1)!] = frames;
}
export function effectiveTarget(data: SpineDocument, target: DetailedTimelineTarget): DetailedTimelineTarget {
  if (target.kind !== 'attachment') return target;
  const item = attachment(data, target);
  return item.value.source !== undefined && item.value.timelines !== false ? { ...target, skin: String(item.value.skin ?? 'default'), slot: String(item.value.slot ?? target.slot), name: String(item.value.source) } : target;
}
export function writable(data: SpineDocument, target: DetailedTimelineTarget) {
  pathFor(data, target);
  if (target.kind === 'attachment' && attachment(data, target).value.source !== undefined && attachment(data, target).value.timelines !== false) throw new Error('This linked mesh inherits its timelines. Select the original source, disable inheritance, or unlink_mesh before writing this target.');
}
function framesFor(data: SpineDocument, value: JsonObject, target: DetailedTimelineTarget): JsonObject[] {
  const frames = readPath(value, pathFor(data, target));
  if (!Array.isArray(frames) || !frames.length) throw new Error(`Timeline has no keyframes: ${JSON.stringify(target)}`); return frames as JsonObject[];
}
export function inventory(data: SpineDocument, value: JsonObject) {
  const tracks: Track[] = [], unsupported: string[][] = [];
  for (const group of ['bones', 'slots'] as const) for (const [entity, raw] of Object.entries(object(value[group] ?? {}, group))) for (const [channel, frames] of Object.entries(object(raw, 'channels'))) {
    const allowed = group === 'bones' ? boneTimelineChannels : slotTimelineChannels;
    if (!(allowed as readonly string[]).includes(channel)) { unsupported.push([group, entity, channel]); continue; }
    if (Array.isArray(frames) && frames.length) tracks.push({ target: group === 'bones' ? { kind: 'bone', bone: entity, channel } : { kind: 'slot', slot: entity, channel }, frames: frames as JsonObject[] });
  }
  for (const target of [{ kind: 'events' }, { kind: 'drawOrder' }] as const) if (Array.isArray(value[target.kind]) && (value[target.kind] as unknown[]).length) tracks.push({ target, frames: value[target.kind] as JsonObject[] });
  for (const track of constraintTracks(data, value)) tracks.push({ target: { kind: 'constraint', constraint: track.name, constraintType: track.type as ConstraintType, channel: track.channel }, frames: track.frames });
  for (const track of attachmentTracks(data, value)) tracks.push({ target: { kind: 'attachment', skin: track.skin, slot: track.slot, name: track.name, channel: track.channel as 'deform' | 'sequence' }, frames: track.frames });
  const known = ['bones', 'slots', 'events', 'drawOrder', 'attachments', 'color', ...constraintTypes];
  for (const [field, raw] of Object.entries(value)) if (!known.includes(field) && raw != null && (typeof raw !== 'object' || Object.keys(raw).length)) unsupported.push([field]);
  return { tracks, unsupported };
}
export function inspectTimelines(data: SpineDocument, name: string, offset = 0, limit = 100) {
  const { tracks, unsupported } = inventory(data, animation(data, name));
  if (!Number.isInteger(offset) || offset < 0 || offset > tracks.length || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Timeline pages require offset within track count and limit from 1 to 500.');
  return { animation: name, total: tracks.length, keyframes: tracks.reduce((sum, track) => sum + track.frames.length, 0), offset, limit, nextOffset: offset + limit < tracks.length ? offset + limit : null,
    tracks: tracks.slice(offset, offset + limit).map(track => {
      const effective = effectiveTarget(data, track.target), inherited = JSON.stringify(pathFor(data, effective)) !== JSON.stringify(pathFor(data, track.target));
      return { target: track.target, keyframes: track.frames.length, firstTime: track.frames[0]!.time ?? 0, lastTime: track.frames.at(-1)!.time ?? 0,
        bezierSegments: track.frames.filter(key => Array.isArray(key.curve)).length, steppedSegments: track.frames.filter(key => key.curve === 'stepped').length,
        effectiveTarget: effective, editable: !inherited, storedKeysIgnoredByInheritance: inherited };
    }), unsupportedCount: unsupported.length, unsupported: unsupported.slice(0, 20),
    note: 'Lists stored populated channels, not synthetic inherited channels. Copy reads the effective source of inherited mesh timelines. Folder draw order must be flattened first. Other unknown data remains untouched.',
  };
}
function checkTiming(scale: number, offset: number) { if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(offset)) throw new Error('timeScale must be finite and positive; timeOffset must be finite.'); }
function movedFrames(frames: JsonObject[], times: number[], events: boolean) {
  const old = frames.map(key => Number(key.time ?? 0)), output = structuredClone(frames);
  for (let index = 0; index < times.length; index++) {
    const time = times[index]!;
    if (!Number.isFinite(time) || time < 0 || time > 300 || !Number.isFinite(Math.fround(time))) throw new Error('Keyframe time must remain within 0–300 seconds.');
    if (index && (old[index] === old[index - 1] ? time !== times[index - 1] : Math.fround(time) <= Math.fround(times[index - 1]!))) throw new Error('Time edit would cross or collapse keyframes at float32 precision.');
    if (index && !events && time <= times[index - 1]!) throw new Error('Stateful keyframe times must stay strictly increasing.');
    const key = output[index]!; if (time !== old[index]) key.time = time;
    if (key.curve === undefined || key.curve === 'stepped') continue;
    if (index === times.length - 1 || !Array.isArray(key.curve) || !key.curve.length || key.curve.length % 4 || key.curve.some(value => typeof value !== 'number' || !Number.isFinite(value)) || old[index + 1]! <= old[index]!) throw new Error('Time edits require valid outgoing Bezier controls.');
    if (times[index] !== old[index] || times[index + 1] !== old[index + 1]) {
      key.curve = key.curve.map((coordinate: number, axis: number) => {
        if (axis % 2) return coordinate;
        const value = time + (coordinate - old[index]!) * (times[index + 1]! - time) / (old[index + 1]! - old[index]!);
        if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error('Bezier time coordinate overflow.'); return value;
      });
    }
  }
  return output;
}
function sameChannel(from: DetailedTimelineTarget, to: DetailedTimelineTarget) {
  return from.kind === to.kind && (!('channel' in from) || ('channel' in to && from.channel === to.channel)) && (from.kind !== 'constraint' || to.kind === 'constraint' && from.constraintType === to.constraintType);
}
function avoidOverlap(value: JsonObject, target: DetailedTimelineTarget) {
  if (target.kind !== 'bone' && target.kind !== 'slot') return;
  const group = target.kind === 'bone' ? 'bones' : 'slots', entity = target.kind === 'bone' ? target.bone : target.slot;
  const channels = object(object(value[group] ?? {}, group)[entity] ?? {}, 'channels');
  const fields = (channel: string): string[] => {
    if (target.kind === 'slot') return ({ attachment: ['attachment'], rgba: ['rgb', 'alpha'], rgb: ['rgb'], alpha: ['alpha'], rgba2: ['rgb', 'alpha', 'dark'], rgb2: ['rgb', 'dark'] } as Record<string, string[]>)[channel] ?? [channel];
    return ({ translate: ['tx', 'ty'], translatex: ['tx'], translatey: ['ty'], scale: ['sx', 'sy'], scalex: ['sx'], scaley: ['sy'], shear: ['hx', 'hy'], shearx: ['hx'], sheary: ['hy'] } as Record<string, string[]>)[channel] ?? [channel];
  };
  for (const [channel, frames] of Object.entries(channels)) if (channel !== target.channel && Array.isArray(frames) && frames.length && fields(channel).some(field => fields(target.channel).includes(field))) throw new Error(`Target channel overlaps ${channel}. Remove the conflicting timeline explicitly first.`);
}
function deformMap(data: SpineDocument, from: Extract<DetailedTimelineTarget, { kind: 'attachment' }>, to: Extract<DetailedTimelineTarget, { kind: 'attachment' }>) {
  const a = sourceMesh(data, from.skin, from.slot, from.name), b = sourceMesh(data, to.skin, to.slot, to.name), left = vertexLayout(data, a), right = vertexLayout(data, b);
  if (left.count !== right.count || left.weighted !== right.weighted) throw new Error('Deform copy requires matching vertex counts and weighted layouts.');
  if ((a.type ?? 'region') !== (b.type ?? 'region')) throw new Error('Deform copy requires matching vertex attachment types.');
  if (a.type === 'mesh' && (!Array.isArray(a.uvs) || !Array.isArray(b.uvs) || a.uvs.length !== b.uvs.length || a.uvs.some((value, index) => Math.abs(Number(value) - Number((b.uvs as number[])[index])) > 1e-6) || JSON.stringify(orientedTriangles(a.triangles)) !== JSON.stringify(orientedTriangles(b.triangles)))) throw new Error('Deform copy requires matching mesh UV indices and oriented triangle topology; no automatic vertex matching is performed.');
  if (!left.weighted) return { length: left.deformLength, mapping: Array.from({ length: left.deformLength }, (_, index) => index) };
  const av = a.vertices as number[], bv = b.vertices as number[], mapping: number[] = []; let ac = 0, bc = 0, pair = 0;
  for (let vertex = 0; vertex < left.count; vertex++) {
    const count = av[ac++]!, otherCount = bv[bc++]!, indices = new Map<number, number>();
    for (let influence = 0; influence < count; influence++, ac += 4) indices.set(av[ac]!, pair++ * 2);
    if (count !== otherCount) throw new Error('Deform copy requires matching influence bones per vertex.');
    for (let influence = 0; influence < otherCount; influence++, bc += 4) {
      const index = indices.get(bv[bc]!); if (index === undefined) throw new Error('Deform copy requires matching influence bones per vertex.'); mapping.push(index, index + 1);
    }
  }
  return { length: left.deformLength, mapping };
}
export function copyTimelines(source: SpineDocument, fromAnimation: string, toAnimation: string, mappings: TimelineMapping[], options: TimelineCopyOptions = {}) {
  const origin = animation(source, fromAnimation); safeName(toAnimation);
  const scale = options.timeScale ?? 1, offset = options.timeOffset ?? 0; checkTiming(scale, offset);
  if (!mappings.length || mappings.length > 100) throw new Error('Provide 1–100 timeline mappings.');
  const data = structuredClone(source), animations = data.animations ??= {};
  if (!Object.hasOwn(animations, toAnimation)) animations[toAnimation] = {};
  const targetAnimation = animations[toAnimation]!, seen = new Set<string>(); let keys = 0, bytes = 0, work = 0;
  for (const { from, to } of mappings) {
    if (!sameChannel(from, to)) throw new Error('Copy targets must use the same timeline kind, channel and constraint type.');
    pathFor(source, from); writable(data, to); const path = pathFor(data, to), id = JSON.stringify(path);
    if (seen.has(id)) throw new Error('Each destination timeline may appear only once.'); seen.add(id);
    if (readPath(targetAnimation, path) !== undefined && !options.replace) throw new Error('Destination timeline exists. Use replace=true to replace only the selected channel in the new output.');
    avoidOverlap(targetAnimation, to);
    if (to.kind === 'drawOrder' && Array.isArray(targetAnimation.drawOrderFolder) && targetAnimation.drawOrderFolder.length) throw new Error('Flatten destination folder draw order before copying global drawOrder.');
    const actual = effectiveTarget(source, from), original = framesFor(source, origin, actual);
    keys += original.length; bytes += Buffer.byteLength(JSON.stringify(original));
    if (keys > maxKeys || bytes > maxCopyBytes) throw new Error('Copy exceeds 100,000 keys or 16 MiB of source timeline data.');
    let map: ReturnType<typeof deformMap> | undefined;
    if (actual.kind === 'attachment' && to.kind === 'attachment') {
      if (actual.channel === 'deform') { map = deformMap(source, actual, to); work += original.length * map.length; if (work > maxDeformCoordinates) throw new Error('Deform copy exceeds 5,000,000 coordinates.'); }
      else if (Number(object(attachment(source, actual).value.sequence, 'source sequence').count) !== Number(object(attachment(data, to).value.sequence, 'target sequence').count)) throw new Error('Sequence copy requires matching frame counts.');
    }
    const frames = movedFrames(original, original.map(key => Number(key.time ?? 0) * scale + offset), from.kind === 'events');
    if (map && map.mapping.some((value, index) => value !== index)) for (const key of frames) {
      const old = new Array<number>(map.length).fill(0), raw = (key.vertices ?? []) as number[], start = Number(key.offset ?? 0); raw.forEach((value, index) => { old[start + index] = value; });
      const next = map.mapping.map(index => old[index]!); let first = 0, last = next.length; while (first < last && next[first] === 0) first++; while (last > first && next[last - 1] === 0) last--;
      delete key.offset; delete key.vertices; if (first < last) { if (first) key.offset = first; key.vertices = next.slice(first, last); }
    }
    if (from.kind === 'attachment' && from.channel === 'sequence') for (const key of frames) if (typeof key.delay === 'number') {
      key.delay *= scale; if (!Number.isFinite(key.delay) || !Number.isFinite(Math.fround(key.delay)) || key.delay > 0 && Math.fround(key.delay) === 0) throw new Error('Sequence delay overflow or float32 underflow.');
    }
    writePath(targetAnimation, path, frames);
  }
  if (Buffer.byteLength(JSON.stringify(data)) > 32 * 1024 * 1024) throw new Error('Result exceeds the 32 MiB skeleton JSON limit.');
  return parseDocument(data);
}
export function retimeKeyframes(source: SpineDocument, name: string, targets: DetailedTimelineTarget[], start: number, end: number, timeScale = 1, timeOffset = 0) {
  animation(source, name); checkTiming(timeScale, timeOffset);
  if (!targets.length || targets.length > 100 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > 300) throw new Error('Choose 1–100 targets and an inclusive 0 <= start <= end <= 300 range.');
  const data = structuredClone(source), value = animation(data, name), seen = new Set<string>(); let selected = 0, keys = 0;
  for (const target of targets) {
    writable(data, target); const path = pathFor(data, target), id = JSON.stringify(path);
    if (seen.has(id)) throw new Error('Each selected timeline may appear only once.'); seen.add(id);
    const original = framesFor(data, value, target); keys += original.length; if (keys > maxKeys) throw new Error('Time edit exceeds 100,000 keys.');
    const times = original.map(key => { const time = Number(key.time ?? 0); if (time < start || time > end) return time; selected++; return start + (time - start) * timeScale + timeOffset; });
    writePath(value, path, movedFrames(original, times, target.kind === 'events'));
  }
  if (!selected) throw new Error('No keyframes lie in the selected range.');
  if (Buffer.byteLength(JSON.stringify(data)) > 32 * 1024 * 1024) throw new Error('Result exceeds the 32 MiB skeleton JSON limit.');
  return parseDocument(data);
}
