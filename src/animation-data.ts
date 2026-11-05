import { object, safeName, type JsonObject } from './json.js';
import type { SpineDocument } from './document.js';
import { checkFrameTimes } from './slot-data.js';

export function checkEventPayload(value: JsonObject) {
  if (value.int !== undefined && (typeof value.int !== 'number' || !Number.isInteger(value.int) || value.int < -2147483648 || value.int > 2147483647)) throw new Error('Event int must be a signed 32-bit integer.');
  if (value.float !== undefined && (typeof value.float !== 'number' || !Number.isFinite(value.float) || !Number.isFinite(Math.fround(value.float)))) throw new Error('Event float must fit a finite float32 value.');
  if (value.string !== undefined && typeof value.string !== 'string') throw new Error('Event string must be a string.');
}
export function eventFrames(value: unknown, label = 'event timeline'): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  let previous = -1;
  return value.map(raw => {
    const key = object(raw, label), time = key.time ?? 0;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time < previous) throw new Error(`Times in ${label} must be nonnegative and nondecreasing; simultaneous events are allowed.`);
    previous = time;
    if (typeof key.name !== 'string') throw new Error('Event keyframe needs a name.');
    safeName(key.name); checkEventPayload(key);
    return key;
  });
}

// Decode offsets by the same rules as the 4.3 runtime, checking bounds first.
// The editor may rewrite offsets while preserving the final slot permutation.
export function decodeDrawOrder(data: SpineDocument, key: JsonObject): string[] {
  const setup = (data.slots ?? []).map(slot => slot.name);
  if (key.offsets === undefined) return setup;
  if (!Array.isArray(key.offsets)) throw new Error('Draw-order offsets must be an array.');
  const indices = new Map(setup.map((name, index) => [name, index]));
  const result: (string | undefined)[] = new Array(setup.length), changed = new Set<number>();
  let previous = -1;
  for (const raw of key.offsets) {
    const entry = object(raw, 'draw-order offset'), index = indices.get(String(entry.slot));
    if (index === undefined || index <= previous) throw new Error('Draw-order offsets must reference existing slots once, in setup order.');
    const offset = entry.offset;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || index + offset < 0 || index + offset >= setup.length) throw new Error('Draw-order offset is outside the slot range.');
    const target = index + offset;
    if (result[target] !== undefined) throw new Error('Draw-order offsets place two slots at the same index.');
    result[target] = setup[index]!; changed.add(index); previous = index;
  }
  const unchanged = setup.filter((_name, index) => !changed.has(index));
  let next = 0;
  for (let index = 0; index < result.length; index++) if (result[index] === undefined) result[index] = unchanged[next++]!;
  return result as string[];
}

export function validateAnimationData(data: SpineDocument) {
  const definitions = object(data.events ?? {}, 'event definitions');
  for (const [name, raw] of Object.entries(definitions)) { safeName(name); checkEventPayload(object(raw, 'event definition')); }
  for (const [name, animation] of Object.entries(data.animations ?? {})) {
    if (animation.events !== undefined) for (const key of eventFrames(animation.events, `${name}/events`)) {
      if (!Object.hasOwn(definitions, String(key.name))) throw new Error(`Animation ${name} references missing event ${String(key.name)}.`);
    }
    if (animation.drawOrder !== undefined) {
      if (!Array.isArray(animation.drawOrder)) throw new Error('drawOrder must be an array.');
      if (animation.drawOrder.length) for (const key of checkFrameTimes(animation.drawOrder, `${name}/drawOrder`)) decodeDrawOrder(data, key);
    }
    for (const folder of folderTracks(data, animation)) for (const key of folder.frames) decodeDrawOrder(folder.data, key);
  }
}
export function folderTracks(data: SpineDocument, animation: JsonObject) {
  if (animation.drawOrderFolder === undefined) return [];
  if (!Array.isArray(animation.drawOrderFolder)) throw new Error('Invalid draw-order folder timelines.');
  return animation.drawOrderFolder.map(raw => {
    const folder = object(raw, 'draw-order folder');
    if (!Array.isArray(folder.slots) || !folder.slots.length || !Array.isArray(folder.keys) || !folder.keys.length || new Set(folder.slots).size !== folder.slots.length || folder.slots.some(name => !data.slots?.some(slot => slot.name === name))) throw new Error('Invalid draw-order folder slots/keys: both arrays must be nonempty.');
    const subset = { ...data, slots: folder.slots.map(name => data.slots!.find(slot => slot.name === name)!) };
    return { data: subset, slots: folder.slots as string[], frames: folder.keys.length ? checkFrameTimes(folder.keys, 'folder keys') : [] };
  });
}

export function effectiveEvent(data: SpineDocument, key: JsonObject) {
  const definitions = object(data.events ?? {}, 'event definitions');
  const defaults = object(Object.hasOwn(definitions, String(key.name)) ? definitions[String(key.name)] : {}, 'event definition');
  return { time: key.time ?? 0, name: key.name, int: key.int ?? defaults.int ?? 0, float: key.float ?? defaults.float ?? 0, string: key.string ?? defaults.string ?? '', ...(defaults.audio ? { volume: key.volume ?? defaults.volume ?? 1, balance: key.balance ?? defaults.balance ?? 0 } : {}) };
}
