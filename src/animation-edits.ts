import { object, parseDocument, safeName, type JsonObject, type SpineDocument } from './document.js';
import { checkEventPayload, eventFrames, folderTracks } from './animation-data.js';
import { attachmentTracks } from './attachment-data.js';
import { checkFrameTimes } from './slot-data.js';
import { constraintTracks, constraintTypes } from './constraint-data.js';

export interface EventPayload { int?: number; float?: number; string?: string }
export interface EventKey extends EventPayload { time: number; name: string }
export interface DrawOrderKey { time: number; order: string[] | null }
export interface FolderDrawOrder { slots: string[]; keyframes: DrawOrderKey[] }
export type TimelineTarget = { kind: 'bone'; bone: string; channel: string } | { kind: 'slot'; slot: string; channel: string } | { kind: 'events' } | { kind: 'drawOrder' };

function getAnimation(data: SpineDocument, name: string, create = false): JsonObject {
  safeName(name);
  const animations = data.animations ??= {};
  if (!Object.hasOwn(animations, name)) {
    if (!create) throw new Error(`Animation not found: ${name}`);
    animations[name] = {};
  }
  return animations[name]!;
}
export function setEvent(source: SpineDocument, name: string, defaults: EventPayload) {
  safeName(name); checkEventPayload(defaults as JsonObject);
  const data = structuredClone(source), events = object(data.events ??= {}, 'event definitions');
  events[name] = { ...(Object.hasOwn(events, name) ? object(events[name], 'event definition') : {}), ...defaults };
  return parseDocument(data);
}
export function setEventTimeline(source: SpineDocument, name: string, keys: EventKey[]) {
  eventFrames(keys);
  const data = structuredClone(source), animation = getAnimation(data, name, true);
  if (keys.length) animation.events = structuredClone(keys); else delete animation.events;
  return parseDocument(data);
}
export function encodeDrawOrderFrames(setup: string[], keys: DrawOrderKey[]) {
  if (keys.length) checkFrameTimes(keys, 'draw-order timeline');
  return keys.map(key => {
    if (key.order === null) return { time: key.time };
    const desired = new Map(key.order.map((slot, index) => [slot, index]));
    if (desired.size !== setup.length || key.order.length !== setup.length || setup.some(slot => !desired.has(slot))) throw new Error('Each draw order must contain every slot exactly once, from back to front; use null for setup order.');
    const offsets = setup.map((slot, index) => ({ slot, offset: desired.get(slot)! - index })).filter(entry => entry.offset !== 0);
    return offsets.length ? { time: key.time, offsets } : { time: key.time };
  });
}
export function setDrawOrder(source: SpineDocument, name: string, keys: DrawOrderKey[]) {
  const data = structuredClone(source), animation = getAnimation(data, name, true);
  if (Array.isArray(animation.drawOrderFolder) && animation.drawOrderFolder.length) throw new Error('This animation has draw-order folder timelines. Edit those in the matching editor before replacing the global draw-order timeline.');
  const frames = encodeDrawOrderFrames((data.slots ?? []).map(slot => slot.name), keys);
  if (frames.length) animation.drawOrder = frames; else delete animation.drawOrder;
  return parseDocument(data);
}
export function setFolderDrawOrder(source: SpineDocument, name: string, folders: FolderDrawOrder[]) {
  if (folders.length > 100) throw new Error('Folder draw order supports at most 100 groups.');
  const data = structuredClone(source), animation = getAnimation(data, name, true), used = new Set<string>();
  const values = folders.map(folder => {
    if (!folder.slots.length || new Set(folder.slots).size !== folder.slots.length || folder.slots.some(slot => !data.slots?.some(item => item.name === slot))) throw new Error('Folder slots must list distinct existing slots.');
    if (folder.slots.some(slot => used.has(slot))) throw new Error('Overlapping draw-order folder groups are ambiguous. Use disjoint groups.');
    folder.slots.forEach(slot => used.add(slot));
    const members = data.slots!.filter(slot => folder.slots.includes(slot.name));
    const encoded = encodeDrawOrderFrames(members.map(slot => slot.name), folder.keyframes);
    return { slots: members.map(slot => slot.name), keys: encoded };
  }).filter(folder => (folder.keys as unknown[]).length);
  if (values.length) animation.drawOrderFolder = values; else delete animation.drawOrderFolder;
  return parseDocument(data);
}
export function renameAnimation(source: SpineDocument, name: string, newName: string) {
  safeName(newName);
  const data = structuredClone(source), animation = getAnimation(data, name), animations = data.animations!;
  if (Object.hasOwn(animations, newName)) throw new Error(`Animation already exists: ${newName}`);
  animations[newName] = animation; delete animations[name];
  if (Array.isArray(data.constraints)) for (const raw of data.constraints) {
    const constraint = object(raw, 'constraint');
    if (constraint.type === 'slider' && constraint.animation === name) constraint.animation = newName;
  }
  return parseDocument(data);
}
export function removeTimeline(source: SpineDocument, name: string, target: TimelineTarget) {
  const data = structuredClone(source), animation = getAnimation(data, name);
  if (target.kind === 'events' || target.kind === 'drawOrder') {
    if (!Object.hasOwn(animation, target.kind)) throw new Error(`Timeline not found: ${name}/${target.kind}`);
    delete animation[target.kind];
  } else {
    const group = target.kind === 'bone' ? 'bones' : 'slots', entity = target.kind === 'bone' ? target.bone : target.slot;
    const items = object(animation[group] ?? {}, group);
    if (!Object.hasOwn(items, entity)) throw new Error(`Timeline not found: ${name}/${group}/${entity}`);
    const channels = object(items[entity], 'timeline channels');
    if (!Object.hasOwn(channels, target.channel)) throw new Error(`Timeline not found: ${name}/${entity}/${target.channel}`);
    delete channels[target.channel];
    if (!Object.keys(channels).length) delete items[entity];
    if (!Object.keys(items).length) delete animation[group];
  }
  return parseDocument(data);
}
export function retimeAnimation(source: SpineDocument, name: string, timeScale: number, timeOffset: number) {
  if (!Number.isFinite(timeScale) || timeScale <= 0 || !Number.isFinite(timeOffset)) throw new Error('timeScale must be finite and positive; timeOffset must be finite.');
  const data = structuredClone(source), animation = getAnimation(data, name), tracks: { frames: JsonObject[]; events: boolean; label: string }[] = [];
  const allowed = new Set(['bones', 'slots', 'events', 'drawOrder', 'drawOrderFolder', 'attachments', 'color', ...constraintTypes]);
  const nonempty = (value: unknown) => value !== undefined && value !== null && (typeof value !== 'object' || Object.keys(value).length > 0);
  for (const [field, value] of Object.entries(animation)) if (!allowed.has(field) && nonempty(value)) throw new Error(`Cannot safely retime ${field}; supported tracks are rotate/translate/scale/shear bones, attachment/RGBA slots, events and global drawOrder. No output was written.`);
  for (const group of ['bones', 'slots']) {
    const channelsAllowed = group === 'bones' ? ['rotate', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary', 'inherit'] : ['attachment', 'rgba', 'rgb', 'alpha', 'rgba2', 'rgb2'];
    for (const [entity, rawChannels] of Object.entries(object(animation[group] ?? {}, group))) for (const [channel, rawFrames] of Object.entries(object(rawChannels, 'channels'))) {
      if (!channelsAllowed.includes(channel)) throw new Error(`Cannot safely retime ${group}/${entity}/${channel}; this channel is not supported.`);
      tracks.push({ frames: checkFrameTimes(rawFrames, `${name}/${entity}/${channel}`), events: false, label: `${entity}/${channel}` });
    }
  }
  if (animation.events !== undefined) tracks.push({ frames: eventFrames(animation.events), events: true, label: 'events' });
  if (Array.isArray(animation.drawOrder) && animation.drawOrder.length) tracks.push({ frames: checkFrameTimes(animation.drawOrder, 'drawOrder'), events: false, label: 'drawOrder' });
  for (const track of constraintTracks(data, animation)) tracks.push({ frames: track.frames, events: false, label: `${track.type}/${track.name}/${track.channel}` });
  for (const folder of folderTracks(data, animation)) tracks.push({ frames: folder.frames, events: false, label: 'drawOrderFolder' });
  for (const track of attachmentTracks(data, animation)) {
    if (track.channel === 'sequence') for (const key of track.frames) if (typeof key.delay === 'number') key.delay *= timeScale;
    tracks.push({ frames: track.frames, events: false, label: `${track.skin}/${track.slot}/${track.name}/${track.channel}` });
  }
  if (!tracks.some(track => track.frames.length)) throw new Error('Animation has no supported keyframes to retime.');
  const transform = (time: number) => {
    const result = time * timeScale + timeOffset;
    if (!Number.isFinite(result) || !Number.isFinite(Math.fround(result))) throw new Error('Retime produced a non-finite float32 time coordinate.');
    return result;
  };
  for (const track of tracks) {
    const originalTimes = track.frames.map(key => Number(key.time ?? 0));
    for (const key of track.frames) {
      key.time = transform(Number(key.time ?? 0));
      if (Number(key.time) < 0) throw new Error('Retime would move a keyframe before zero. No output was written.');
      if (key.curve !== undefined && key.curve !== 'stepped') {
        if (!Array.isArray(key.curve) || !key.curve.length || key.curve.length % 4 !== 0 || key.curve.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Retime requires Spine 4.3 numeric Bezier arrays in groups of four.');
        key.curve = key.curve.map((coordinate: number, index: number) => index % 2 === 0 ? transform(coordinate) : coordinate);
      }
    }
    for (let index = 1; index < track.frames.length; index++) {
      const previous = Number(track.frames[index - 1]!.time), current = Number(track.frames[index]!.time);
      if (originalTimes[index] !== originalTimes[index - 1] && Math.fround(current) <= Math.fround(previous)) throw new Error('Retime would collapse distinct keyframe times at Spine float32 precision.');
    }
    if (track.events) eventFrames(track.frames); else checkFrameTimes(track.frames, track.label);
  }
  return parseDocument(data);
}
