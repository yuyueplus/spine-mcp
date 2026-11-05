import { object, parseDocument, safeName, type JsonObject, type SpineDocument } from './document.js';
import { checkColorCurve, checkFrameTimes, colorRgba, documentSkins } from './slot-data.js';

export interface SlotSetup { bone?: string; attachment?: string | null; color?: string; dark?: string | null; blend?: 'normal' | 'additive' | 'multiply' | 'screen'; visible?: boolean }
export interface AttachmentKey { time: number; name: string | null }
export interface ColorKey { time: number; color: string; curve?: 'stepped' | number[] }
export interface RegionTransform { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number; width?: number; height?: number; color?: string }

function attachmentNames(data: SpineDocument) {
  const names = new Set<string>();
  for (const skin of documentSkins(data)) for (const items of Object.values(object(skin.attachments ?? {}, 'attachments'))) {
    for (const [placeholder, raw] of Object.entries(object(items, 'slot attachments'))) names.add(String(object(raw, 'attachment').name ?? placeholder));
  }
  return names;
}
function uniqueAttachmentName(used: Set<string>, preferred: string) {
  let result = preferred, suffix = 2;
  while (used.has(result)) result = `${preferred}-${suffix++}`;
  used.add(result);
  return result;
}

export function setSlot(source: SpineDocument, name: string, setup: SlotSetup) {
  if (!Object.keys(setup).length) throw new Error('Provide at least one slot setup field.');
  const data = structuredClone(source), slot = data.slots?.find(item => item.name === name);
  if (!slot) throw new Error(`Slot not found: ${name}`);
  for (const [field, value] of Object.entries(setup)) {
    if (value === null && ['attachment', 'dark'].includes(field)) delete slot[field];
    else slot[field] = field === 'color' ? colorRgba(value) : field === 'dark' && typeof value === 'string' ? value.toLowerCase() : value;
  }
  return parseDocument(data);
}
export function addSlot(source: SpineDocument, name: string, bone: string, setup: Omit<SlotSetup, 'bone'> = {}) {
  safeName(name);
  const data = structuredClone(source);
  const slots = data.slots ??= [];
  if (slots.some(slot => slot.name === name)) throw new Error(`Slot already exists: ${name}`);
  slots.push({ name, bone }); // Append to preserve existing draw-order timeline indices.
  return Object.keys(setup).length ? setSlot(data, name, setup) : parseDocument(data);
}
export function addSkin(source: SpineDocument, name: string, copyFrom?: string, baseSkin?: string): SpineDocument {
  safeName(name);
  const data = structuredClone(source), skins = documentSkins(data);
  if (skins.some(skin => skin.name === name)) throw new Error(`Skin already exists: ${name}`);
  const original = copyFrom === undefined ? undefined : skins.find(skin => skin.name === copyFrom);
  if (copyFrom !== undefined && !original) throw new Error(`Skin not found: ${copyFrom}`);
  if (name === 'default' && copyFrom !== undefined) throw new Error('default is the editor fallback attachment collection and cannot be a named-skin copy. Create a regular named skin instead.');
  if (copyFrom === 'default') {
    if (!baseSkin) throw new Error('default contains attachments outside editor skin placeholders. Copying it needs baseSkin: a NEW named skin to receive the existing default attachments. Select that base skin when previewing the NEW output.');
    safeName(baseSkin);
    if (baseSkin === 'default' || baseSkin === name || skins.some(skin => skin.name === baseSkin)) throw new Error('baseSkin must be a new name different from default and the copied skin.');
    data.skins = skins.map(skin => skin.name === 'default' ? { ...skin, name: baseSkin } : skin);
    // Moving fallback attachments changes the namespace used by deformation /
    // sequence tracks and by linked meshes (whose omitted skin means default).
    // Rebind every reference before validating or copying the promoted skin.
    for (const skin of documentSkins(data)) for (const items of Object.values(object(skin.attachments ?? {}, 'attachments'))) for (const raw of Object.values(object(items, 'slot attachments'))) {
      const attachment = object(raw, 'attachment');
      if (attachment.source !== undefined && (attachment.skin ?? 'default') === 'default') attachment.skin = baseSkin;
    }
    for (const animation of Object.values(data.animations ?? {})) for (const field of ['attachments', 'deform']) {
      const tracks = object(animation[field] ?? {}, 'attachment timelines');
      if (Object.hasOwn(tracks, 'default')) { tracks[baseSkin] = tracks.default; delete tracks.default; }
    }
    return addSkin(data, name, baseSkin);
  }
  if (baseSkin !== undefined) throw new Error('baseSkin applies only when copyFrom is default.');
  const copied: JsonObject = original ? { ...structuredClone(original), name } : { name, attachments: {} };
  if (original) {
    // Editor 4.3 requires unique attachment names across skins. Placeholder keys
    // stay unchanged; an explicit path retains the original image target.
    const used = attachmentNames(data);
    for (const items of Object.values(object(copied.attachments ?? {}, 'attachments'))) for (const [placeholder, raw] of Object.entries(object(items, 'slot attachments'))) {
      const attachment = object(raw, 'attachment');
      if (['region', 'mesh', 'linkedmesh'].includes(String(attachment.type ?? 'region'))) attachment.path ??= attachment.name ?? placeholder;
      attachment.name = uniqueAttachmentName(used, `${name}/${placeholder}`);
      if (attachment.source !== undefined && (attachment.skin ?? 'default') === copyFrom) attachment.skin = name;
    }
    for (const animation of Object.values(data.animations ?? {})) for (const field of ['attachments', 'deform']) {
      const tracks = object(animation[field] ?? {}, 'attachment timelines');
      if (Object.hasOwn(tracks, copyFrom!)) tracks[name] = structuredClone(tracks[copyFrom!]);
    }
  }
  data.skins = [...skins, copied];
  return parseDocument(data);
}
export function setRegion(source: SpineDocument, skinName: string, slotName: string, name: string, region: JsonObject, replace: boolean, setAsSetup: boolean) {
  safeName(name);
  const data = structuredClone(source), skin = documentSkins(data).find(item => item.name === skinName);
  if (!skin) throw new Error(`Skin not found: ${skinName}`);
  const slot = data.slots?.find(item => item.name === slotName);
  if (!slot) throw new Error(`Slot not found: ${slotName}`);
  const conflicting = documentSkins(data).some(other => {
    const otherSlots = object(other.attachments ?? {}, 'attachments');
    return other.name !== skinName && (skinName === 'default' || other.name === 'default') && Object.hasOwn(otherSlots, slotName) && Object.hasOwn(object(otherSlots[slotName], 'slot attachments'), name);
  });
  if (conflicting) throw new Error('This placeholder collides with a default attachment in the editor. Use add_skin with copyFrom=default and a new baseSkin before adding skin variants, or choose a distinct placeholder name.');
  const attachments = object(skin.attachments ??= {}, 'attachments');
  if (!Object.hasOwn(attachments, slotName)) attachments[slotName] = {};
  const items = object(attachments[slotName], 'slot attachments');
  const previous = Object.hasOwn(items, name) ? object(items[name], 'attachment') : undefined;
  if (previous && !replace) throw new Error(`Attachment already exists: ${skinName}/${slotName}/${name}. Set replace=true to update it in the NEW output.`);
  if (previous && ((previous.type ?? 'region') !== 'region' || previous.sequence !== undefined)) throw new Error('Only static region attachments can be replaced; meshes and image sequences require their own editor workflow.');
  const internalName = previous ? previous.name ?? name : uniqueAttachmentName(attachmentNames(data), skinName === 'default' ? name : `${skinName}/${name}`);
  items[name] = { ...previous, ...region, type: 'region', ...(internalName === name ? {} : { name: internalName }) };
  if (setAsSetup) slot.attachment = name;
  return parseDocument(data);
}
function animationSlot(data: SpineDocument, animationName: string, slot: string): JsonObject {
  safeName(animationName);
  if (!data.slots?.some(item => item.name === slot)) throw new Error(`Slot not found: ${slot}`);
  const animations = data.animations ??= {};
  if (!Object.hasOwn(animations, animationName)) animations[animationName] = {};
  const slots = object(animations[animationName]!.slots ??= {}, 'animation slots');
  if (!Object.hasOwn(slots, slot)) slots[slot] = {};
  return object(slots[slot], 'slot timelines');
}
export function setAttachmentTimeline(source: SpineDocument, animation: string, slot: string, keys: AttachmentKey[]) {
  checkFrameTimes(keys, 'attachment timeline');
  const data = structuredClone(source), timelines = animationSlot(data, animation, slot);
  timelines.attachment = keys.map(key => key.name === null ? { time: key.time } : { time: key.time, name: key.name });
  return parseDocument(data);
}
export function setColorTimeline(source: SpineDocument, animation: string, slot: string, keys: ColorKey[]) {
  checkFrameTimes(keys, 'RGBA timeline');
  const data = structuredClone(source), timelines = animationSlot(data, animation, slot);
  if (['rgb', 'alpha', 'rgb2', 'rgba2'].some(channel => Object.hasOwn(timelines, channel))) throw new Error('Existing RGB/alpha/two-color timelines overlap RGBA. Use a new animation to avoid conflicting channels.');
  timelines.rgba = keys.map((key, index) => {
    checkColorCurve(key as unknown as JsonObject, index === keys.length - 1);
    return { ...key, color: colorRgba(key.color) };
  });
  return parseDocument(data);
}
