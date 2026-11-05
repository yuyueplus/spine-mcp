import { object, safeName, type JsonObject } from './json.js';
import type { SpineDocument } from './document.js';

export const blendModes = ['normal', 'additive', 'multiply', 'screen'] as const;
export function colorRgba(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) throw new Error('Color must be a 6- or 8-digit RGB/RGBA hex string without #.');
  return (value.length === 6 ? `${value}ff` : value).toLowerCase();
}
export function documentSkins(data: SpineDocument): JsonObject[] {
  if (data.skins === undefined) return [];
  if (!Array.isArray(data.skins)) throw new Error('Spine 4.3 skins must be an array.');
  return data.skins.map(item => object(item, 'skin'));
}
export function hasAttachment(data: SpineDocument, slot: string, name: string): boolean {
  return documentSkins(data).some(skin => {
    const attachments = object(skin.attachments ?? {}, 'attachments');
    return Object.hasOwn(attachments, slot) && Object.hasOwn(object(attachments[slot], 'slot attachments'), name);
  });
}
export function checkFrameTimes(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a nonempty keyframe array.`);
  let previous = -1;
  return value.map(raw => {
    const key = object(raw, label), time = key.time ?? 0;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time <= previous) throw new Error(`Keyframe times in ${label} must be nonnegative and strictly increasing.`);
    previous = time;
    return key;
  });
}
export function checkColorCurve(key: JsonObject, last: boolean) {
  if (key.curve === undefined) return;
  if (last) throw new Error('The last keyframe cannot have an outgoing curve.');
  if (key.curve !== 'stepped' && (!Array.isArray(key.curve) || key.curve.length !== 16 || key.curve.some(n => typeof n !== 'number' || !Number.isFinite(n)))) {
    throw new Error('An RGBA Bezier curve requires 16 finite values (four control values per color component).');
  }
}

export function validateSlotData(data: SpineDocument) {
  const slots = new Set((data.slots ?? []).map(slot => slot.name));
  for (const slot of data.slots ?? []) {
    safeName(slot.name);
    if (slot.color !== undefined) colorRgba(slot.color);
    if (slot.dark !== undefined && (typeof slot.dark !== 'string' || !/^[0-9a-f]{6}$/i.test(slot.dark))) throw new Error('Slot dark color must be 6 RGB hex digits.');
    if (slot.blend !== undefined && !(blendModes as readonly unknown[]).includes(slot.blend)) throw new Error(`Invalid slot blend: ${String(slot.blend)}`);
    if (slot.visible !== undefined && typeof slot.visible !== 'boolean') throw new Error('Slot visible must be boolean.');
  }
  const skinNames = new Set<string>();
  for (const skin of documentSkins(data)) {
    if (typeof skin.name !== 'string') throw new Error('Skin name must be a string.');
    safeName(skin.name);
    if (skinNames.has(skin.name)) throw new Error(`Duplicate skin: ${skin.name}`);
    skinNames.add(skin.name);
    for (const [slot, attachments] of Object.entries(object(skin.attachments ?? {}, 'attachments'))) {
      if (!slots.has(slot)) throw new Error(`Skin ${skin.name} references missing slot ${slot}.`);
      for (const [name, raw] of Object.entries(object(attachments, 'slot attachments'))) {
        safeName(name);
        const attachment = object(raw, 'attachment');
        if (attachment.color !== undefined) colorRgba(attachment.color);
        if (attachment.path !== undefined && (typeof attachment.path !== 'string' || !attachment.path)) throw new Error('Attachment path must be a nonempty string.');
        if ((attachment.type ?? 'region') === 'region') for (const field of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'width', 'height']) {
          const number = attachment[field];
          if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || (['width', 'height'].includes(field) && number <= 0))) throw new Error(`Invalid region ${name}.${field}.`);
        }
      }
    }
  }
  for (const slot of data.slots ?? []) {
    if (slot.attachment !== undefined && slot.attachment !== null && (typeof slot.attachment !== 'string' || !hasAttachment(data, slot.name, slot.attachment))) throw new Error(`Missing setup attachment for slot ${slot.name}: ${String(slot.attachment)}`);
  }
  for (const [animationName, animation] of Object.entries(data.animations ?? {})) {
    for (const [slot, timelines] of Object.entries(object(animation.slots ?? {}, 'slot timelines'))) {
      if (!slots.has(slot)) throw new Error(`Animation ${animationName} references missing slot ${slot}.`);
      for (const [channel, rawFrames] of Object.entries(object(timelines, 'slot channels'))) {
        const frames = checkFrameTimes(rawFrames, `${animationName}/${slot}/${channel}`);
        frames.forEach((key, index) => {
          if (channel === 'attachment' && key.name !== undefined && key.name !== null && (typeof key.name !== 'string' || !hasAttachment(data, slot, key.name))) throw new Error(`Missing timeline attachment for slot ${slot}: ${String(key.name)}`);
          if (channel === 'rgba') { colorRgba(key.color); checkColorCurve(key, index === frames.length - 1); }
          if (['rgb', 'rgba2', 'rgb2'].includes(channel)) {
            const fields = channel === 'rgb' ? ['color'] : ['light', 'dark'];
            for (const field of fields) colorRgba(key[field]);
          }
          if (channel === 'alpha' && (key.value !== undefined && (typeof key.value !== 'number' || !Number.isFinite(key.value) || key.value < 0 || key.value > 1))) throw new Error('Slot alpha must be between zero and one.');
          const controls = ({ rgb: 12, rgba2: 28, rgb2: 24, alpha: 4 } as Record<string, number>)[channel];
          if (controls && key.curve !== undefined && (index === frames.length - 1 || (key.curve !== 'stepped' && (!Array.isArray(key.curve) || key.curve.length !== controls || key.curve.some(n => typeof n !== 'number' || !Number.isFinite(n)))))) throw new Error(`Slot ${channel} requires ${controls} Bezier controls or stepped on a non-final key.`);
        });
      }
    }
  }
}
