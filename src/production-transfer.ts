import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument, object, safeName, type SpineDocument, type JsonObject } from './document.js';
import { renameObject, type NamedTarget } from './structure.js';
import { attachmentEntries, attachmentTracks, sourceMesh, vertexLayout } from './attachment-data.js';
import { documentSkins } from './slot-data.js';
import { orientedTriangles } from './geometry-verification.js';
import { constraintList, constraintTypes } from './constraint-data.js';
import { compileFolderDrawOrder } from './draw-order-compilation.js';
import { decodeDrawOrder } from './animation-data.js';
import { encodeDrawOrderFrames } from './animation-edits.js';

export interface NameMaps { bones?: Record<string, string>; slots?: Record<string, string>; skins?: Record<string, string>; events?: Record<string, string>; constraints?: Record<string, string> }
export function remapDocument(source: SpineDocument, maps: NameMaps) {
  let data = structuredClone(source);
  if (maps.skins?.default && maps.skins.default !== 'default') {
    const name = maps.skins.default, skins = documentSkins(data), fallback = skins.find(skin => skin.name === 'default'); safeName(name);
    if (!fallback || skins.some(skin => skin.name === name)) throw new Error('Default skin conversion mapping has a missing source or occupied target.');
    for (const item of attachmentEntries(data)) if (item.value.source !== undefined && (item.value.skin ?? 'default') === 'default') item.value.skin = name;
    fallback.name = name; data.skins = skins;
    for (const value of Object.values(data.animations ?? {})) if (value.attachments && Object.hasOwn(object(value.attachments, 'attachments'), 'default')) { const map = object(value.attachments, 'attachments'); map[name] = map.default; delete map.default; }
    data = parseDocument(data);
  }
  const changes: { target: NamedTarget; name: string; temporary: string }[] = [];
  for (const [group, kind] of [['bones', 'bone'], ['slots', 'slot'], ['skins', 'skin']] as const) for (const [from, to] of Object.entries(maps[group] ?? {})) { safeName(to); if (from !== to && !(group === 'skins' && from === 'default')) changes.push({ target: { kind, name: from }, name: to, temporary: `mcp-map-${randomUUID()}` }); }
  for (const [identity, to] of Object.entries(maps.constraints ?? {})) {
    const slash = identity.indexOf('/'), type = identity.slice(0, slash), name = identity.slice(slash + 1); safeName(to);
    if (slash < 0 || !constraintTypes.includes(type as typeof constraintTypes[number])) throw new Error('Constraint mappings use type/name identities.');
    if (name !== to) changes.push({ target: { kind: 'constraint', name, constraintType: type as typeof constraintTypes[number] }, name: to, temporary: `mcp-map-${randomUUID()}` });
  }
  for (const item of changes) data = renameObject(data, item.target, item.temporary);
  for (const item of changes) data = renameObject(data, { ...item.target, name: item.temporary }, item.name);
  if (maps.events) {
    const events = object(data.events ?? {}, 'events'), next: JsonObject = {};
    for (const [name, event] of Object.entries(events)) { const destination = maps.events[name] ?? name; safeName(destination); if (Object.hasOwn(next, destination)) throw new Error('Event mapping collision.'); next[destination] = event; }
    data.events = next;
    for (const animation of Object.values(data.animations ?? {})) if (Array.isArray(animation.events)) for (const key of animation.events as JsonObject[]) key.name = maps.events[String(key.name)] ?? key.name;
  }
  return parseDocument(data);
}
function rewriteDeforms(origin: SpineDocument, destination: SpineDocument, value: JsonObject) {
  for (const track of attachmentTracks(origin, value)) {
    if (track.channel !== 'deform') continue;
    const a = sourceMesh(origin, track.skin, track.slot, track.name), b = sourceMesh(destination, track.skin, track.slot, track.name), left = vertexLayout(origin, a), right = vertexLayout(destination, b);
    if (left.count !== right.count || left.weighted !== right.weighted || a.type !== b.type || a.type === 'mesh' && (JSON.stringify(a.uvs) !== JSON.stringify(b.uvs) || JSON.stringify(orientedTriangles(a.triangles)) !== JSON.stringify(orientedTriangles(b.triangles)))) throw new Error(`Incompatible deform topology: ${track.skin}/${track.slot}/${track.name}`);
    if (!left.weighted) continue;
    const av = a.vertices as number[], bv = b.vertices as number[], map: number[] = []; let ac = 0, bc = 0, pair = 0;
    for (let vertex = 0; vertex < left.count; vertex++) {
      const n = av[ac++]!, m = bv[bc++]!, byName = new Map<string, number>();
      for (let i = 0; i < n; i++, ac += 4) byName.set(origin.bones[av[ac]!]!.name, pair++ * 2);
      if (m !== n) throw new Error('Incompatible influence counts for deform transfer.');
      for (let i = 0; i < m; i++, bc += 4) { const index = byName.get(destination.bones[bv[bc]!]!.name); if (index === undefined) throw new Error('Deform influence bones must match after mapping.'); map.push(index, index + 1); }
    }
    for (const key of track.frames) { const dense = new Array<number>(left.deformLength).fill(0); (key.vertices as number[] ?? []).forEach((n, i) => { dense[Number(key.offset ?? 0) + i] = n; }); delete key.offset; key.vertices = map.map(index => dense[index]!); }
  }
}
export function transferAnimation(source: SpineDocument, target: SpineDocument, options: { animation: string; newName: string; maps?: NameMaps; replace?: boolean; includeEvents?: boolean }) {
  const origin = remapDocument(source, options.maps ?? {}), original = origin.animations?.[options.animation]; safeName(options.newName);
  if (!original) throw new Error(`Source animation missing: ${options.animation}`);
  const output = structuredClone(target); if (Object.hasOwn(output.animations ?? {}, options.newName) && !options.replace) throw new Error('Target animation exists; replace must be explicit.');
  const value = structuredClone(original); rewriteDeforms(origin, output, value);
  if (options.includeEvents) for (const key of Array.isArray(value.events) ? value.events as JsonObject[] : []) {
    const name = String(key.name), definition = object(origin.events ?? {}, 'events')[name], events = object(output.events ??= {}, 'events');
    if (Object.hasOwn(events, name) && JSON.stringify(events[name]) !== JSON.stringify(definition)) throw new Error(`Event definition conflict: ${name}`); events[name] = structuredClone(definition);
  }
  (output.animations ??= {})[options.newName] = value; return parseDocument(output);
}
export function mergeSkins(source: SpineDocument, skinNames: string[], newName: string, collision: 'error' | 'first' | 'last' = 'error') {
  safeName(newName); const data = structuredClone(source), skins = documentSkins(data); if (skins.some(skin => skin.name === newName)) throw new Error('Merged skin destination already exists.');
  const result: JsonObject = { name: newName, attachments: {} };
  for (const name of skinNames) {
    const skin = skins.find(skin => skin.name === name); if (!skin) throw new Error(`Skin missing: ${name}`);
    for (const field of ['bones', ...constraintTypes]) if (Array.isArray(skin[field])) result[field] = [...new Set([...(result[field] as string[] ?? []), ...skin[field] as string[]])];
    for (const [slot, raw] of Object.entries(object(skin.attachments ?? {}, 'attachments'))) {
      const slots = object(result.attachments, 'attachments'), items = object(slots[slot] ??= {}, 'slot');
      for (const [name, attachment] of Object.entries(object(raw, 'attachment map'))) {
        if (Object.hasOwn(items, name)) { if (collision === 'error') throw new Error(`Skin attachment collision: ${slot}/${name}`); if (collision === 'first') continue; }
        const copy = structuredClone(object(attachment, 'attachment')); copy.name = `${newName}/${slot}/${name}`; if (copy.path === undefined && ['region', 'mesh', 'linkedmesh'].includes(String(copy.type ?? 'region'))) copy.path = object(attachment, 'attachment').name ?? name;
        items[name] = copy;
      }
    }
  }
  if (!Array.isArray(data.skins)) throw new Error('Skin composition requires the 4.3 skin array representation.'); data.skins.push(result); return parseDocument(data);
}
export function transferRig(source: SpineDocument, target: SpineDocument, options: { root: string; parent: string; prefix: string; sourceJson: string; targetJson: string; includeAnimations?: boolean }) {
  if (!source.bones.some(bone => bone.name === options.root) || !target.bones.some(bone => bone.name === options.parent)) throw new Error('Source root or target parent missing.');
  const selected = new Set([options.root]); for (const bone of source.bones) if (selected.has(bone.parent ?? '')) selected.add(bone.name);
  const maps: NameMaps = { bones: Object.fromEntries(source.bones.map(bone => [bone.name, `${options.prefix}${bone.name}`])), slots: Object.fromEntries((source.slots ?? []).map(slot => [slot.name, `${options.prefix}${slot.name}`])), skins: Object.fromEntries(documentSkins(source).map(skin => [String(skin.name), `${options.prefix}${String(skin.name)}`])), constraints: Object.fromEntries(constraintList(source).map(c => [`${c.type}/${c.name}`, `${options.prefix}${String(c.name)}`])), events: Object.fromEntries(Object.keys(object(source.events ?? {}, 'events')).map(name => [name, `${options.prefix}${name}`])) };
  const origin = compileFolderDrawOrder(remapDocument(source, maps)), output = structuredClone(target), mapped = new Set([...selected].map(name => maps.bones![name]!));
  const bones = origin.bones.filter(bone => mapped.has(bone.name)); bones.find(bone => bone.name === maps.bones![options.root])!.parent = options.parent;
  if (bones.some(bone => output.bones.some(existing => existing.name === bone.name))) throw new Error('Transferred bone names collide. Choose a different prefix.');
  const oldIndices = new Map(origin.bones.map((bone, index) => [index, bone.name])), newIndices = new Map([...output.bones, ...bones].map((bone, index) => [bone.name, index])); output.bones.push(...bones);
  const slots = (origin.slots ?? []).filter(slot => mapped.has(slot.bone)), slotNames = new Set(slots.map(slot => slot.name));
  if (slots.some(slot => output.slots?.some(existing => existing.name === slot.name))) throw new Error('Transferred slot names collide.'); (output.slots ??= []).push(...slots);
  const sourceImages = path.resolve(path.dirname(options.sourceJson), String(source.skeleton.images ?? '.')), targetImages = path.resolve(path.dirname(options.targetJson), String(target.skeleton.images ?? '.'));
  const skins: JsonObject[] = [];
  for (const skin of documentSkins(origin)) {
    const copy = structuredClone(skin), attachments = object(copy.attachments ?? {}, 'attachments'); for (const slot of Object.keys(attachments)) if (!slotNames.has(slot)) delete attachments[slot]; copy.attachments = attachments;
    if (Array.isArray(copy.bones)) copy.bones = copy.bones.filter(name => mapped.has(String(name)));
    for (const type of constraintTypes) delete copy[type]; skins.push(copy);
  }
  if (!Array.isArray(output.skins)) output.skins = documentSkins(output);
  for (const skin of skins) { if (documentSkins(output).some(existing => existing.name === skin.name)) throw new Error('Transferred skin name collision.'); (output.skins as JsonObject[]).push(skin); }
  const originalEntries = attachmentEntries(origin);
  for (const item of attachmentEntries(output).filter(item => slots.some(slot => slot.name === item.slot))) {
    if (item.value.source === undefined && Array.isArray(item.value.vertices)) {
      const layout = vertexLayout(origin, item.value), raw = item.value.vertices as number[];
      if (layout.weighted) { let cursor = 0; for (let vertex = 0; vertex < layout.count; vertex++) { const n = raw[cursor++]!; for (let i = 0; i < n; i++, cursor += 4) { const name = oldIndices.get(raw[cursor]!); if (!name || !mapped.has(name)) throw new Error('Weighted mesh depends on a bone outside the selected branch. Transfer a common ancestor.'); raw[cursor] = newIndices.get(name)!; } } }
    }
    if (['region', 'mesh', 'linkedmesh'].includes(String(item.value.type ?? 'region'))) { const original = originalEntries.find(entry => entry.skin === item.skin && entry.slot === item.slot && entry.name === item.name)!; item.value.path = path.relative(targetImages, path.resolve(sourceImages, String(original.value.path ?? original.value.name ?? item.name))).replaceAll('\\', '/'); }
    item.value.name = `${item.skin}/${item.slot}/${item.name}`;
  }
  for (const c of constraintList(origin)) {
    const refs = [...(Array.isArray(c.bones) ? c.bones.map(String) : []), ...(typeof c.bone === 'string' ? [c.bone] : [])]; if (!refs.some(name => mapped.has(name))) continue;
    if (refs.some(name => !mapped.has(name)) || typeof c.target === 'string' && !mapped.has(c.target) || typeof c.source === 'string' && !mapped.has(c.source) || typeof c.slot === 'string' && !slotNames.has(c.slot)) throw new Error(`Constraint ${String(c.name)} has dependencies outside the selected branch.`);
    if (c.type === 'slider' && !options.includeAnimations) throw new Error('Slider transfer requires includeAnimations=true.');
    (output.constraints ??= [] as JsonObject[]); (output.constraints as JsonObject[]).push(structuredClone(c));
    for (const skin of skins) for (const type of constraintTypes) if ((documentSkins(origin).find(original => original.name === skin.name)?.[type] as string[] | undefined)?.includes(String(c.name))) { skin[type] ??= []; (skin[type] as string[]).push(String(c.name)); }
  }
  if (options.includeAnimations) {
    // Filter all keyed objects to the transferred dependency set. Validation
    // rejects draw-order and event references that cannot be represented safely.
    for (const [name, animation] of Object.entries(origin.animations ?? {})) {
      const value = structuredClone(animation); delete value.drawOrderFolder;
      if (Array.isArray(value.drawOrder)) value.drawOrder = encodeDrawOrderFrames((output.slots ?? []).map(slot => slot.name), (value.drawOrder as JsonObject[]).map(key => ({ time: Number(key.time ?? 0), order: [...(target.slots ?? []).map(slot => slot.name), ...decodeDrawOrder(origin, key).filter(slot => slotNames.has(slot))] })));
      for (const [group, allowed] of [['bones', mapped], ['slots', slotNames]] as const) if (value[group]) for (const key of Object.keys(object(value[group], group))) if (!allowed.has(key)) delete object(value[group], group)[key];
      if (value.attachments) for (const raw of Object.values(object(value.attachments, 'attachments'))) for (const key of Object.keys(object(raw, 'attachment slots'))) if (!slotNames.has(key)) delete object(raw, 'attachment slots')[key];
      for (const type of constraintTypes) if (value[type]) for (const key of Object.keys(object(value[type], type))) if (!(output.constraints as JsonObject[] ?? []).some(c => c.type === type && c.name === key)) delete object(value[type], type)[key];
      const newName = `${options.prefix}${name}`; if (Object.hasOwn(output.animations ?? {}, newName)) throw new Error('Transferred animation name collision.'); (output.animations ??= {})[newName] = value;
    }
    const events = object(output.events ??= {}, 'events'), sourceAudio = path.resolve(path.dirname(options.sourceJson), String(source.skeleton.audio ?? '.')), targetAudio = path.resolve(path.dirname(options.targetJson), String(target.skeleton.audio ?? '.'));
    for (const [name, raw] of Object.entries(object(origin.events ?? {}, 'events'))) { const event = structuredClone(object(raw, 'event')); if (typeof event.audio === 'string') event.audio = path.relative(targetAudio, path.resolve(sourceAudio, event.audio)).replaceAll('\\', '/'); if (Object.hasOwn(events, name)) throw new Error('Transferred event name collision.'); events[name] = event; }
    for (const c of constraintList(output)) if (c.type === 'slider' && typeof c.animation === 'string' && constraintList(origin).some(original => original.name === c.name)) c.animation = `${options.prefix}${c.animation}`;
  }
  return parseDocument(output);
}
