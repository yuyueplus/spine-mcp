import { object, parseDocument, safeName, type JsonObject, type SpineDocument } from './document.js';
import { documentSkins, hasAttachment } from './slot-data.js';
import { decodeDrawOrder } from './animation-data.js';
import { sampleSkeleton } from './runtime.js';
import { resolveConstraint, type ConstraintType } from './constraint-data.js';

type SimpleKind = 'bone' | 'slot' | 'skin' | 'animation';
export type NamedTarget = { [Kind in SimpleKind]: { kind: Kind; name: string } }[SimpleKind] | { kind: 'constraint'; name: string; constraintType?: ConstraintType } | { kind: 'attachment'; skin: string; slot: string; name: string };
export function attachments(data: SpineDocument) {
  return documentSkins(data).flatMap(skin => Object.entries(object(skin.attachments ?? {}, 'attachments')).flatMap(([slot, raw]) => Object.entries(object(raw, 'slot attachments')).map(([name, value]) => ({ skin: String(skin.name), slot, name, value: object(value, 'attachment') }))));
}
const constraints = (data: SpineDocument) => (data.constraints ?? []) as JsonObject[];
function renameKey(map: JsonObject, oldName: string, newName: string) {
  if (!Object.hasOwn(map, oldName)) return;
  if (Object.hasOwn(map, newName)) throw new Error(`Reference target already exists: ${newName}`);
  map[newName] = map[oldName]; delete map[oldName];
}
function nestedAttachments(animation: JsonObject) {
  return ['attachments', 'deform'].flatMap(field => Object.values(object(animation[field] ?? {}, field)).map(raw => object(raw, field)));
}
function hasLegacyConstraints(data: SpineDocument) {
  if (['ik', 'transform', 'path', 'physics'].some(key => Array.isArray(data[key]) && (data[key] as unknown[]).length)) throw new Error('Structure edits require the ordered Spine 4.3 constraints layout, not legacy constraint arrays.');
}
function renameConstraintRefs(data: SpineDocument, type: string, oldName: string, newName: string) {
  for (const skin of documentSkins(data)) if (Array.isArray(skin[type])) skin[type] = (skin[type] as unknown[]).map(name => name === oldName ? newName : name);
  for (const animation of Object.values(data.animations ?? {})) for (const field of type === 'slider' ? ['slider', 'sliders'] : [type]) renameKey(object(animation[field] ?? {}, field), oldName, newName);
}
export function renameObject(source: SpineDocument, target: NamedTarget, newName: string) {
  safeName(newName); hasLegacyConstraints(source);
  const data = structuredClone(source), oldName = target.name;
  if (newName === oldName) throw new Error('Choose a different name.');
  if (target.kind === 'bone') {
    const bone = data.bones.find(item => item.name === oldName);
    if (!bone) throw new Error(`Bone not found: ${oldName}`);
    if (data.bones.some(item => item.name === newName)) throw new Error(`Bone already exists: ${newName}`);
    bone.name = newName;
    for (const item of data.bones) if (item.parent === oldName) item.parent = newName;
    for (const slot of data.slots ?? []) if (slot.bone === oldName) slot.bone = newName;
    for (const skin of documentSkins(data)) if (Array.isArray(skin.bones)) skin.bones = skin.bones.map(name => name === oldName ? newName : name);
    for (const constraint of constraints(data)) {
      if (Array.isArray(constraint.bones)) constraint.bones = constraint.bones.map(name => name === oldName ? newName : name);
      for (const field of ['bone', 'source', 'target']) if (constraint[field] === oldName) constraint[field] = newName;
    }
    for (const animation of Object.values(data.animations ?? {})) renameKey(object(animation.bones ?? {}, 'bone timelines'), oldName, newName);
  } else if (target.kind === 'slot') {
    const slot = data.slots?.find(item => item.name === oldName);
    if (!slot) throw new Error(`Slot not found: ${oldName}`);
    if (data.slots!.some(item => item.name === newName)) throw new Error(`Slot already exists: ${newName}`);
    slot.name = newName;
    for (const skin of documentSkins(data)) renameKey(object(skin.attachments ?? {}, 'attachments'), oldName, newName);
    for (const attachment of attachments(data)) for (const field of ['end', 'slot']) if (attachment.value[field] === oldName) attachment.value[field] = newName;
    for (const constraint of constraints(data)) if (constraint.type === 'path' && constraint.slot === oldName) constraint.slot = newName;
    for (const animation of Object.values(data.animations ?? {})) {
      renameKey(object(animation.slots ?? {}, 'slot timelines'), oldName, newName);
      for (const map of nestedAttachments(animation)) renameKey(map, oldName, newName);
      for (const key of (animation.drawOrder ?? []) as JsonObject[]) for (const offset of (key.offsets ?? []) as JsonObject[]) if (offset.slot === oldName) offset.slot = newName;
      for (const folder of (animation.drawOrderFolder ?? []) as JsonObject[]) {
        folder.slots = (folder.slots as string[]).map(name => name === oldName ? newName : name);
        for (const key of (folder.keys ?? []) as JsonObject[]) for (const offset of (key.offsets ?? []) as JsonObject[]) if (offset.slot === oldName) offset.slot = newName;
      }
    }
  } else if (target.kind === 'skin') {
    if (oldName === 'default' || newName === 'default') throw new Error('Use add_skin with baseSkin for default-skin conversion; default is reserved for fallback attachments.');
    const skins = documentSkins(data), skin = skins.find(item => item.name === oldName);
    if (!skin) throw new Error(`Skin not found: ${oldName}`);
    if (skins.some(item => item.name === newName)) throw new Error(`Skin already exists: ${newName}`);
    skin.name = newName;
    for (const attachment of attachments(data)) if (attachment.value.skin === oldName) attachment.value.skin = newName;
    for (const animation of Object.values(data.animations ?? {})) for (const field of ['attachments', 'deform']) renameKey(object(animation[field] ?? {}, field), oldName, newName);
  } else if (target.kind === 'animation') {
    const map = data.animations ?? {};
    if (!Object.hasOwn(map, oldName)) throw new Error(`Animation not found: ${oldName}`);
    renameKey(map, oldName, newName);
    for (const constraint of constraints(data)) if (constraint.type === 'slider' && constraint.animation === oldName) constraint.animation = newName;
  } else if (target.kind === 'constraint') {
    const found = resolveConstraint(data, oldName, target.constraintType);
    if (constraints(data).some(item => item.name === newName && item.type === found.type)) throw new Error(`Constraint already exists: ${String(found.type)}/${newName}`);
    found.name = newName; renameConstraintRefs(data, String(found.type), oldName, newName);
  } else {
    const found = attachments(data).find(item => item.skin === target.skin && item.slot === target.slot && item.name === oldName);
    if (!found) throw new Error('Attachment not found.');
    // A placeholder is shared across skins and animation keys. Rename it in all
    // skins for this slot; keep actual attachment names and image paths stable.
    for (const item of attachments(data).filter(item => item.slot === target.slot && item.name === oldName)) {
      item.value.name ??= oldName;
      if (['region', 'mesh', 'linkedmesh'].includes(String(item.value.type ?? 'region'))) item.value.path ??= item.value.name;
      if (item.skin === 'default') {
        if (attachments(data).some(other => other.value !== item.value && (other.value.name ?? other.name) === newName)) throw new Error('The renamed default attachment would conflict with an existing internal attachment name.');
        item.value.name = newName;
      }
      const skin = documentSkins(data).find(skin => skin.name === item.skin)!;
      renameKey(object(object(skin.attachments, 'attachments')[target.slot], 'slot attachments'), oldName, newName);
    }
    for (const item of attachments(data)) if (item.value.source === oldName && (item.value.slot ?? item.slot) === target.slot) item.value.source = newName;
    for (const slot of data.slots ?? []) if (slot.name === target.slot && slot.attachment === oldName) slot.attachment = newName;
    for (const animation of Object.values(data.animations ?? {})) {
      const slots = object(animation.slots ?? {}, 'slots'), channels = Object.hasOwn(slots, target.slot) ? object(slots[target.slot], 'slot channels') : {};
      for (const key of (channels.attachment ?? []) as JsonObject[]) if (key.name === oldName) key.name = newName;
      for (const map of nestedAttachments(animation)) if (Object.hasOwn(map, target.slot)) renameKey(object(map[target.slot], 'attachment timelines'), oldName, newName);
    }
  }
  return parseDocument(data);
}

function vertexCount(value: JsonObject): number | undefined {
  if (Array.isArray(value.uvs)) return value.uvs.length / 2;
  if (typeof value.vertexCount === 'number') return value.vertexCount;
  return undefined;
}
export function remapBoneIndices(data: SpineDocument, originalBones: SpineDocument['bones']) {
  const newIndices = new Map(data.bones.map((bone, index) => [bone.name, index]));
  for (const attachment of attachments(data)) {
    const vertices = attachment.value.vertices, count = vertexCount(attachment.value);
    if (!Array.isArray(vertices) || count === undefined || vertices.length === count * 2) continue;
    let offset = 0;
    for (let vertex = 0; vertex < count; vertex++) {
      const influences = vertices[offset++];
      if (!Number.isInteger(influences) || influences < 1 || offset + influences * 4 > vertices.length) throw new Error('Malformed weighted vertices.');
      for (let index = 0; index < influences; index++, offset += 4) {
        const bone = originalBones[vertices[offset]]?.name, newIndex = bone === undefined ? undefined : newIndices.get(bone);
        if (newIndex === undefined) throw new Error(`A weighted attachment still uses a removed bone (${attachment.skin}/${attachment.slot}/${attachment.name}). Delete that attachment first.`);
        vertices[offset] = newIndex;
      }
    }
    if (offset !== vertices.length) throw new Error('Unexpected weighted vertex data.');
  }
}
export function reparentBone(source: SpineDocument, name: string, parent: string, preserveWorld = true) {
  hasLegacyConstraints(source);
  const data = structuredClone(source), bone = data.bones.find(item => item.name === name);
  if (!bone || !data.bones.some(item => item.name === parent)) throw new Error('Bone or parent not found.');
  if (!bone.parent) throw new Error('The root bone cannot be reparented.');
  let ancestor: string | undefined = parent;
  while (ancestor) { if (ancestor === name) throw new Error('Reparenting would create a cycle.'); ancestor = data.bones.find(item => item.name === ancestor)?.parent; }
  if (preserveWorld && constraints(data).length) throw new Error('preserveWorld requires an unconstrained setup pose. Use preserveWorld=false to retain local values on a constrained rig.');
  const original = preserveWorld ? sampleSkeleton(source, undefined, 0).bones.find(item => item.data.name === name)!.appliedPose : undefined;
  bone.parent = parent;
  const ordered: SpineDocument['bones'] = [], visited = new Set<string>();
  const visit = (item: SpineDocument['bones'][number]) => { if (visited.has(item.name)) return; if (item.parent) visit(data.bones.find(bone => bone.name === item.parent)!); visited.add(item.name); ordered.push(item); };
  for (const item of data.bones) visit(item);
  data.bones = ordered; remapBoneIndices(data, source.bones);
  if (original) {
    const skeleton = sampleSkeleton(data, undefined, 0), pose = skeleton.bones.find(item => item.data.name === name)!.appliedPose;
    for (const field of ['a', 'b', 'c', 'd', 'worldX', 'worldY'] as const) pose[field] = original[field];
    pose.updateLocalTransform(skeleton);
    for (const field of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearX', 'shearY'] as const) bone[field] = pose[field];
    const actual = sampleSkeleton(data, undefined, 0).bones.find(item => item.data.name === name)!.appliedPose;
    if (['a', 'b', 'c', 'd', 'worldX', 'worldY'].some(field => Math.abs(Number(actual[field as keyof typeof actual]) - Number(original[field as keyof typeof original])) > 0.0001 * Math.max(1, Math.abs(Number(original[field as keyof typeof original]))))) throw new Error('World transform could not be preserved; check zero scales and inheritance mode.');
  }
  return parseDocument(data);
}

function encodeOrder(setup: string[], order: string[], time: unknown): JsonObject {
  const offsets = setup.map((slot, index) => ({ slot, offset: order.indexOf(slot) - index })).filter(item => item.offset !== 0);
  return offsets.length ? { time: time ?? 0, offsets } : { time: time ?? 0 };
}
export function setSlotOrder(source: SpineDocument, order: string[]) {
  const setup = (source.slots ?? []).map(slot => slot.name);
  if (order.length !== setup.length || new Set(order).size !== order.length || setup.some(name => !order.includes(name))) throw new Error('Setup order must list every slot exactly once.');
  const data = structuredClone(source);
  for (const animation of Object.values(data.animations ?? {})) if (Array.isArray(animation.drawOrder)) animation.drawOrder = animation.drawOrder.map(raw => { const key = object(raw, 'draw key'); return encodeOrder(order, decodeDrawOrder(source, key), key.time); });
  data.slots = order.map(name => data.slots!.find(slot => slot.name === name)!);
  return parseDocument(data);
}

function removeConstraint(data: SpineDocument, name: string, type: string) {
  data.constraints = constraints(data).filter(item => item.name !== name || item.type !== type);
  for (const skin of documentSkins(data)) if (Array.isArray(skin[type])) skin[type] = skin[type].filter(item => item !== name);
  for (const animation of Object.values(data.animations ?? {})) for (const field of type === 'slider' ? ['slider', 'sliders'] : [type]) delete object(animation[field] ?? {}, field)[name];
}
function cleanAttachmentRefs(data: SpineDocument) {
  for (const slot of data.slots ?? []) if (typeof slot.attachment === 'string' && !hasAttachment(data, slot.name, slot.attachment)) delete slot.attachment;
  for (const animation of Object.values(data.animations ?? {})) for (const [slot, raw] of Object.entries(object(animation.slots ?? {}, 'slots'))) for (const key of (object(raw, 'slot channels').attachment ?? []) as JsonObject[]) if (typeof key.name === 'string' && !hasAttachment(data, slot, key.name)) delete key.name;
}
export function deleteObject(source: SpineDocument, target: NamedTarget, cascade = false): SpineDocument {
  hasLegacyConstraints(source);
  let data = structuredClone(source);
  const dependencies: string[] = [];
  if (target.kind === 'bone') {
    const bone = data.bones.find(item => item.name === target.name);
    if (!bone) throw new Error('Bone not found.'); if (!bone.parent) throw new Error('The root bone cannot be deleted.');
    const names = new Set([target.name]);
    for (const item of data.bones) if (item.parent && names.has(item.parent)) names.add(item.name);
    const slots = (data.slots ?? []).filter(slot => names.has(slot.bone));
    const linked = constraints(data).filter(item => (item.bones as string[] | undefined)?.some(name => names.has(name)) || ['bone', 'source', 'target'].some(field => names.has(String(item[field]))));
    for (const name of names) if (name !== target.name) dependencies.push(`child bone:${name}`);
    dependencies.push(...slots.map(slot => `slot:${slot.name}`), ...linked.map(item => `constraint:${String(item.name)}`));
    for (const [name, animation] of Object.entries(data.animations ?? {})) if ([...names].some(bone => Object.hasOwn(object(animation.bones ?? {}, 'bones'), bone))) dependencies.push(`animation:${name}`);
    if (dependencies.length && !cascade) throw new Error(`Object has dependencies; set cascade=true in the NEW output: ${dependencies.slice(0, 12).join(', ')}`);
    for (const slot of slots) data = deleteObject(data, { kind: 'slot', name: slot.name }, true);
    for (const item of linked) removeConstraint(data, String(item.name), String(item.type));
    data.bones = data.bones.filter(item => !names.has(item.name));
    for (const skin of documentSkins(data)) if (Array.isArray(skin.bones)) skin.bones = skin.bones.filter(name => !names.has(String(name)));
    for (const animation of Object.values(data.animations ?? {})) for (const name of names) delete object(animation.bones ?? {}, 'bones')[name];
    remapBoneIndices(data, source.bones);
  } else if (target.kind === 'slot') {
    if (!data.slots?.some(item => item.name === target.name)) throw new Error('Slot not found.');
    const linked = constraints(data).filter(item => item.type === 'path' && item.slot === target.name);
    if (attachments(data).some(item => item.slot === target.name)) dependencies.push('slot attachments');
    if (linked.length) dependencies.push('path constraints');
    for (const animation of Object.values(data.animations ?? {})) if (Object.hasOwn(object(animation.slots ?? {}, 'slots'), target.name) || Array.isArray(animation.drawOrder) || Array.isArray(animation.drawOrderFolder)) dependencies.push('animation tracks');
    for (const item of attachments(data)) if (item.value.end === target.name || item.value.slot === target.name) dependencies.push('clipping or linked-mesh reference');
    if (dependencies.length && !cascade) throw new Error(`Object has dependencies; set cascade=true: ${dependencies.join(', ')}`);
    for (const item of linked) removeConstraint(data, String(item.name), String(item.type));
    const setup = data.slots.filter(slot => slot.name !== target.name).map(slot => slot.name);
    for (const animation of Object.values(data.animations ?? {})) {
      if (Array.isArray(animation.drawOrder)) animation.drawOrder = animation.drawOrder.map(raw => { const key = object(raw, 'draw key'); return encodeOrder(setup, decodeDrawOrder(data, key).filter(name => name !== target.name), key.time); });
      if (Array.isArray(animation.drawOrderFolder)) for (const folder of animation.drawOrderFolder as JsonObject[]) {
        const folderData = { ...data, slots: (folder.slots as string[]).map(name => data.slots!.find(slot => slot.name === name)!) };
        const remaining = (folder.slots as string[]).filter(name => name !== target.name);
        folder.keys = (folder.keys as JsonObject[]).map(key => encodeOrder(remaining, decodeDrawOrder(folderData, key).filter(name => name !== target.name), key.time)); folder.slots = remaining;
      }
      if (Array.isArray(animation.drawOrderFolder)) {
        const remaining = animation.drawOrderFolder.filter(raw => (object(raw, 'folder').slots as string[]).length);
        if (remaining.length) animation.drawOrderFolder = remaining; else delete animation.drawOrderFolder;
      }
      delete object(animation.slots ?? {}, 'slots')[target.name];
      for (const map of nestedAttachments(animation)) delete map[target.name];
    }
    for (const skin of documentSkins(data)) delete object(skin.attachments ?? {}, 'attachments')[target.name];
    for (const item of attachments(data)) {
      if (item.value.end === target.name) delete item.value.end;
      if (item.value.slot === target.name) throw new Error('A linked mesh uses this slot. Delete the linked attachment first.');
    }
    data.slots = data.slots.filter(slot => slot.name !== target.name);
  } else if (target.kind === 'constraint') {
    const type = String(resolveConstraint(data, target.name, target.constraintType).type);
    if (!cascade && Object.values(data.animations ?? {}).some(animation => (type === 'slider' ? ['slider', 'sliders'] : [type]).some(field => Object.hasOwn(object(animation[field] ?? {}, field), target.name)))) throw new Error('Constraint has animation tracks; set cascade=true.');
    if (!cascade && documentSkins(data).some(skin => Array.isArray(skin[type]) && skin[type].includes(target.name))) throw new Error('Constraint has skin membership references; set cascade=true.');
    removeConstraint(data, target.name, type);
  } else if (target.kind === 'animation') {
    if (!Object.hasOwn(data.animations ?? {}, target.name)) throw new Error('Animation not found.');
    const linked = constraints(data).filter(item => item.type === 'slider' && item.animation === target.name);
    if (linked.length && !cascade) throw new Error('Animation is referenced by slider constraints; set cascade=true.');
    linked.forEach(item => removeConstraint(data, String(item.name), String(item.type))); delete data.animations![target.name];
  } else if (target.kind === 'skin') {
    if (!documentSkins(data).some(skin => skin.name === target.name)) throw new Error('Skin not found.');
    if (!cascade && attachments(data).some(item => item.skin === target.name)) throw new Error('Skin has attachments; set cascade=true.');
    if (attachments(data).some(item => item.skin !== target.name && item.value.skin === target.name)) throw new Error('Other skins have linked meshes using this skin; delete those linked attachments first.');
    data.skins = documentSkins(data).filter(skin => skin.name !== target.name);
    for (const animation of Object.values(data.animations ?? {})) for (const field of ['attachments', 'deform']) delete object(animation[field] ?? {}, field)[target.name];
    cleanAttachmentRefs(data);
  } else {
    const found = attachments(data).find(item => item.skin === target.skin && item.slot === target.slot && item.name === target.name);
    if (!found) throw new Error('Attachment not found.');
    if (attachments(data).some(item => item.value.source === target.name && (item.value.slot ?? item.slot) === target.slot && (item.value.skin ?? 'default') === target.skin)) throw new Error('Linked meshes use this attachment. Delete linked attachments first.');
    if (!cascade && ((data.slots ?? []).some(slot => slot.name === target.slot && slot.attachment === target.name) || Object.values(data.animations ?? {}).some(animation => Object.hasOwn(object(animation.slots ?? {}, 'slots'), target.slot)))) throw new Error('Attachment has setup/animation references; set cascade=true.');
    if (!cascade && Object.values(data.animations ?? {}).some(animation => {
      const skins = object(animation.attachments ?? {}, 'attachment timelines'), slots = Object.hasOwn(skins, target.skin) ? object(skins[target.skin], 'attachment slots') : {}, items = Object.hasOwn(slots, target.slot) ? object(slots[target.slot], 'attachment tracks') : {};
      return Object.hasOwn(items, target.name);
    })) throw new Error('Attachment has deformation/sequence tracks; set cascade=true.');
    const skin = documentSkins(data).find(skin => skin.name === target.skin)!;
    delete object(object(skin.attachments, 'attachments')[target.slot], 'slot attachments')[target.name];
    for (const animation of Object.values(data.animations ?? {})) for (const field of ['attachments', 'deform']) {
      const skins = object(animation[field] ?? {}, field), slots = Object.hasOwn(skins, target.skin) ? object(skins[target.skin], field) : {};
      if (Object.hasOwn(slots, target.slot)) delete object(slots[target.slot], 'attachment timelines')[target.name];
    }
    cleanAttachmentRefs(data);
  }
  return parseDocument(data);
}
