import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './config.js';
import { object, safeName, type JsonObject } from './json.js';
import { validateSlotData, documentSkins } from './slot-data.js';
import { decodeDrawOrder, validateAnimationData } from './animation-data.js';
import { colorRgba } from './slot-data.js';
import { validateConstraints } from './constraint-data.js';
import { validateAttachments } from './attachment-data.js';
export { object, safeName, type JsonObject } from './json.js';

export interface Bone extends JsonObject { name: string; parent?: string }
export interface SpineDocument extends JsonObject {
  skeleton: JsonObject & { spine: string };
  bones: Bone[];
  slots?: (JsonObject & { name: string; bone: string })[];
  animations?: Record<string, JsonObject>;
}

export function parseDocument(value: unknown, target = '4.3.23'): SpineDocument {
  const data = object(value, 'Spine JSON');
  const skeleton = object(data.skeleton, 'skeleton');
  if (skeleton.spine !== target) throw new Error(`Expected Spine ${target}; this JSON declares ${String(skeleton.spine)}. Export using the matching editor.`);
  if (!Array.isArray(data.bones) || data.bones.length === 0) throw new Error('A skeleton needs at least one bone.');
  const seen = new Set<string>();
  for (const item of data.bones) {
    const bone = object(item, 'bone');
    if (typeof bone.name !== 'string') throw new Error('Bone name must be a string.');
    safeName(bone.name);
    if (seen.has(bone.name)) throw new Error(`Duplicate bone: ${bone.name}`);
    if (bone.parent !== undefined && (typeof bone.parent !== 'string' || !seen.has(bone.parent))) {
      throw new Error(`Bone ${bone.name} has a missing parent or appears before its parent.`);
    }
    for (const key of ['x', 'y', 'rotation', 'length', 'scaleX', 'scaleY', 'shearX', 'shearY']) {
      if (bone[key] !== undefined && (typeof bone[key] !== 'number' || !Number.isFinite(bone[key]))) throw new Error(`Invalid bone field: ${bone.name}.${key}`);
    }
    seen.add(bone.name);
  }
  if (data.slots !== undefined && !Array.isArray(data.slots)) throw new Error('slots must be an array.');
  const slots = new Set<string>();
  for (const item of (data.slots ?? []) as unknown[]) {
    const slot = object(item, 'slot');
    if (typeof slot.name !== 'string' || typeof slot.bone !== 'string' || !seen.has(slot.bone)) throw new Error('Slot has an invalid name or bone reference.');
    if (slots.has(slot.name)) throw new Error(`Duplicate slot: ${slot.name}`);
    slots.add(slot.name);
  }
  if (data.animations !== undefined) {
    for (const [name, animation] of Object.entries(object(data.animations, 'animations'))) {
      safeName(name);
      const timelines = object(animation, `animation ${name}`);
      if (timelines.bones !== undefined) {
        for (const [boneName, timelinesForBone] of Object.entries(object(timelines.bones, 'animation bones'))) {
          if (!seen.has(boneName)) throw new Error(`Animation ${name} references missing bone ${boneName}.`);
          for (const [channel, frames] of Object.entries(object(timelinesForBone, 'bone timelines'))) {
            if (!Array.isArray(frames)) throw new Error(`Timeline ${channel} must be an array.`);
            let previous = -1;
            for (const [index, frame] of frames.entries()) {
              const key = object(frame, 'keyframe');
              const time = key.time ?? 0;
              if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time <= previous) throw new Error(`Keyframe times in ${name}/${boneName}/${channel} must be nonnegative and strictly increasing (received ${String(time)} after ${previous}).`);
              previous = time;
              const fields = ['rotate', 'translatex', 'translatey', 'scalex', 'scaley', 'shearx', 'sheary'].includes(channel) ? ['value'] : ['translate', 'scale', 'shear'].includes(channel) ? ['x', 'y'] : [];
              for (const field of fields) if (key[field] !== undefined && (typeof key[field] !== 'number' || !Number.isFinite(key[field]))) throw new Error(`Invalid numeric keyframe: ${name}/${boneName}/${channel}.${field}`);
              if (fields.length && key.curve !== undefined && (index === frames.length - 1 || (key.curve !== 'stepped' && (!Array.isArray(key.curve) || key.curve.length !== fields.length * 4 || key.curve.some(n => typeof n !== 'number' || !Number.isFinite(n)))))) throw new Error(`Bone ${channel} requires ${fields.length * 4} Bezier controls or stepped on a non-final key.`);
            }
          }
        }
      }
    }
  }
  validateSlotData(data as unknown as SpineDocument);
  validateAnimationData(data as unknown as SpineDocument);
  validateConstraints(data as unknown as SpineDocument);
  validateAttachments(data as unknown as SpineDocument);
  return data as unknown as SpineDocument;
}

export async function readDocument(filename: string): Promise<SpineDocument> {
  const info = await stat(filename);
  if (info.size > 32 * 1024 * 1024) throw new Error('JSON exceeds the 32 MiB limit.');
  const text = (await readFile(filename, 'utf8')).replace(/^\uFEFF/, '');
  return parseDocument(JSON.parse(text));
}

export function rebaseResources(data: SpineDocument, sourceDirectory: string, destinationDirectory?: string): SpineDocument {
  const result = structuredClone(data);
  for (const field of ['images', 'audio']) {
    const resource = result.skeleton[field];
    if (typeof resource !== 'string' || !resource) continue;
    const absolute = path.resolve(sourceDirectory, resource);
    result.skeleton[field] = destinationDirectory ? (path.relative(destinationDirectory, absolute) || '.').replaceAll('\\', '/') : absolute.replaceAll('\\', '/');
  }
  return result;
}
export async function writeDocument(workspace: Workspace, output: string, data: SpineDocument, sourceDirectory?: string) {
  parseDocument(data);
  const filename = await workspace.resolve(output, false);
  if (path.extname(filename).toLowerCase() !== '.json') throw new Error('JSON output must use the .json extension.');
  await mkdir(path.dirname(filename), { recursive: true });
  const normalized = sourceDirectory ? rebaseResources(data, sourceDirectory, path.dirname(filename)) : data;
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Generated JSON exceeds the 32 MiB limit. Split or shorten the edit.');
  await writeFile(filename, text, { encoding: 'utf8', flag: 'wx' });
  return { path: filename, sha256: createHash('sha256').update(text).digest('hex') };
}

function duration(value: unknown): number {
  if (value && typeof value === 'object') {
    let max = typeof (value as JsonObject).time === 'number' ? (value as JsonObject).time as number : 0;
    for (const child of Object.values(value)) max = Math.max(max, duration(child));
    return max;
  }
  return 0;
}
export function summarize(data: SpineDocument) {
  return {
    version: data.skeleton.spine,
    bones: data.bones,
    slots: data.slots ?? [],
    skins: Array.isArray(data.skins) ? data.skins.map(s => object(s, 'skin').name) : Object.keys((data.skins ?? {}) as JsonObject),
    attachments: documentSkins(data).flatMap(skin => Object.entries(object(skin.attachments ?? {}, 'attachments')).flatMap(([slot, items]) => Object.entries(object(items, 'slot attachments')).map(([name, raw]) => ({ ...object(raw, 'attachment'), skin: skin.name, slot, name, attachmentName: object(raw, 'attachment').name ?? name })))),
    constraints: { ordered: data.constraints ?? [], ik: data.ik ?? [], transform: data.transform ?? [], path: data.path ?? [], physics: data.physics ?? [] },
    events: data.events ?? {},
    animations: Object.entries(data.animations ?? {}).map(([name, animation]) => ({ name, duration: duration(animation), boneTimelines: Object.keys((animation.bones ?? {}) as JsonObject), slotTimelines: Object.keys((animation.slots ?? {}) as JsonObject), eventCount: Array.isArray(animation.events) ? animation.events.length : 0, drawOrderKeyCount: Array.isArray(animation.drawOrder) ? animation.drawOrder.length : 0 })),
    images: data.skeleton.images ?? null,
    note: 'File state only. Unsaved changes in the open editor are not included.',
  };
}

export interface Transform { x?: number; y?: number; rotation?: number; length?: number; scaleX?: number; scaleY?: number; shearX?: number; shearY?: number }
export function setBone(data: SpineDocument, name: string, values: Transform) {
  const result = structuredClone(data);
  const bone = result.bones.find(b => b.name === name);
  if (!bone) throw new Error(`Bone not found: ${name}`);
  if (!Object.keys(values).length) throw new Error('Provide at least one transform field.');
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${key}`);
    bone[key] = value;
  }
  return parseDocument(result);
}
export function addBone(data: SpineDocument, name: string, parent: string, values: Transform) {
  safeName(name);
  const result = structuredClone(data);
  if (result.bones.some(b => b.name === name)) throw new Error(`Bone already exists: ${name}`);
  if (!result.bones.some(b => b.name === parent)) throw new Error(`Parent bone not found: ${parent}`);
  result.bones.push({ name, parent, ...values });
  return parseDocument(result);
}

export type Channel = 'rotate' | 'translate' | 'scale' | 'shear';
export interface Keyframe { time: number; value?: number; x?: number; y?: number; curve?: 'stepped' | number[] }
export function setTimeline(data: SpineDocument, animationName: string, boneName: string, channel: Channel, keys: Keyframe[]) {
  safeName(animationName);
  if (!data.bones.some(b => b.name === boneName)) throw new Error(`Bone not found: ${boneName}`);
  if (!keys.length) throw new Error('Provide at least one keyframe.');
  const result = structuredClone(data);
  const animations = result.animations ??= {};
  if (!Object.hasOwn(animations, animationName)) animations[animationName] = {};
  const animation = animations[animationName]!;
  const bones = object(animation.bones ??= {}, 'animation bones');
  if (!Object.hasOwn(bones, boneName)) bones[boneName] = {};
  const timelines = object(bones[boneName], 'bone timelines');
  const frames = keys.map((key, index) => {
    if (!Number.isFinite(key.time) || key.time < 0 || (index > 0 && key.time <= keys[index - 1]!.time)) throw new Error('Keyframes must have nonnegative, strictly increasing times.');
    if (channel === 'rotate') {
      if (key.value === undefined || key.x !== undefined || key.y !== undefined) throw new Error('rotate needs value (degrees), without x/y.');
    } else if (key.value !== undefined || key.x === undefined || key.y === undefined) throw new Error(`${channel} needs x and y, without value.`);
    for (const number of [key.value, key.x, key.y]) if (number !== undefined && !Number.isFinite(number)) throw new Error('Keyframe values must be finite.');
    if (Array.isArray(key.curve)) {
      const expected = channel === 'rotate' ? 4 : 8;
      if (key.curve.length !== expected || key.curve.some(n => !Number.isFinite(n))) throw new Error(`A ${channel} Bezier curve requires ${expected} finite values in the Spine 4.3 JSON format.`);
    }
    if (index === keys.length - 1 && key.curve !== undefined) throw new Error('The last keyframe cannot have an outgoing curve.');
    return { ...key };
  });
  timelines[channel] = frames;
  return parseDocument(result);
}

export function addAnimation(data: SpineDocument, name: string, source?: string) {
  safeName(name);
  const result = structuredClone(data);
  const animations = result.animations ??= {};
  if (Object.hasOwn(animations, name)) throw new Error(`Animation already exists: ${name}`);
  if (source && !Object.hasOwn(animations, source)) throw new Error(`Animation not found: ${source}`);
  animations[name] = source ? structuredClone(animations[source]!) : {};
  return result;
}

export function loopCheck(data: SpineDocument, animationName: string) {
  const animation = Object.hasOwn(data.animations ?? {}, animationName) ? data.animations![animationName] : undefined;
  if (!animation) throw new Error(`Animation not found: ${animationName}`);
  const issues: { bone: string; channel: string; first: unknown; last: unknown }[] = [];
  for (const [bone, timelines] of Object.entries((animation.bones ?? {}) as JsonObject)) {
    for (const [channel, frames] of Object.entries(object(timelines, 'bone timelines'))) {
      if (!['rotate', 'translate', 'scale', 'shear'].includes(channel) || !Array.isArray(frames) || frames.length < 2) continue;
      const first = object(frames[0], 'keyframe');
      const last = object(frames.at(-1), 'keyframe');
      const fields = channel === 'rotate' ? ['value'] : ['x', 'y'];
      const fallback = channel === 'scale' ? 1 : 0;
      if (fields.some(field => Math.abs(Number(first[field] ?? fallback) - Number(last[field] ?? fallback)) > 1e-5)) issues.push({ bone, channel, first, last });
    }
  }
  const slotMismatches: { slot: string; channel: string; first: unknown; last: unknown }[] = [];
  for (const [slot, rawChannels] of Object.entries(object(animation.slots ?? {}, 'slot timelines'))) for (const [channel, raw] of Object.entries(object(rawChannels, 'slot channels'))) {
    if (!['attachment', 'rgba'].includes(channel) || !Array.isArray(raw) || raw.length < 2) continue;
    const first = object(raw[0], 'keyframe'), last = object(raw.at(-1), 'keyframe');
    const a = channel === 'attachment' ? first.name ?? null : colorRgba(first.color), b = channel === 'attachment' ? last.name ?? null : colorRgba(last.color);
    if (a !== b) slotMismatches.push({ slot, channel, first, last });
  }
  const drawKeys = (animation.drawOrder ?? []) as JsonObject[];
  const drawOrderMismatch = drawKeys.length > 1 && JSON.stringify(decodeDrawOrder(data, drawKeys[0]!)) !== JSON.stringify(decodeDrawOrder(data, drawKeys.at(-1)!));
  return { animation: animationName, endpointMismatches: issues, slotMismatches, drawOrderMismatch, note: 'First/last keyed values only. Events are discrete and not compared; this does not prove visual loop continuity, timing alignment or constraint/physics continuity.' };
}
