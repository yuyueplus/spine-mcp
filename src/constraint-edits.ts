import { object, parseDocument, type JsonObject, type SpineDocument } from './document.js';
import { constraintList, constraintTypes, checkConstraintKeys, resolveConstraint, constraintIdentity, type ConstraintType, type ConstraintSelector } from './constraint-data.js';
import { documentSkins } from './slot-data.js';

export function setConstraint(source: SpineDocument, definition: JsonObject, index?: number) {
  const data = structuredClone(source), list = constraintList(data), found = list.findIndex(item => item.name === definition.name && item.type === definition.type);
  const merged = { ...(found >= 0 ? list[found] : {}), ...structuredClone(definition) };
  if (found >= 0) list.splice(found, 1);
  const position = index ?? (found >= 0 ? found : list.length);
  if (!Number.isInteger(position) || position < 0 || position > list.length) throw new Error('Constraint index is outside the ordered list.');
  list.splice(position, 0, merged); data.constraints = list;
  return parseDocument(data);
}
export function setConstraintTimeline(source: SpineDocument, animationName: string, constraintName: string, channel: string, keyframes: JsonObject[], constraintType?: ConstraintType) {
  const data = structuredClone(source);
  if (constraintName === '' && constraintType !== undefined && constraintType !== 'physics') throw new Error('Empty constraint name selects global physics only.');
  const type = constraintName === '' ? 'physics' : String(resolveConstraint(data, constraintName, constraintType).type);
  if (keyframes.length) checkConstraintKeys(type, channel, keyframes);
  const animations = data.animations ??= {};
  if (!Object.hasOwn(animations, animationName)) animations[animationName] = {};
  const map = object(animations[animationName]![type] ??= {}, 'constraint timelines');
  if (type === 'ik' || type === 'transform') {
    if (channel !== 'parameters') throw new Error('Use channel=parameters for IK/transform timelines.');
    if (keyframes.length) map[constraintName] = structuredClone(keyframes); else delete map[constraintName];
  } else {
    if (!Object.hasOwn(map, constraintName)) map[constraintName] = {};
    const channels = object(map[constraintName], 'constraint channels');
    if (keyframes.length) channels[channel] = structuredClone(keyframes); else delete channels[channel];
  }
  return parseDocument(data);
}
export function setSkinMembers(source: SpineDocument, name: string, bones: string[] | undefined, members: ConstraintSelector[] | undefined) {
  const data = structuredClone(source), skin = documentSkins(data).find(item => item.name === name);
  if (!skin) throw new Error('Skin not found.');
  if (bones !== undefined) { if (new Set(bones).size !== bones.length) throw new Error('Duplicate skin bone.'); skin.bones = [...bones]; }
  if (members !== undefined) {
    const selected = members.map(member => typeof member === 'string' ? resolveConstraint(data, member) : resolveConstraint(data, member.name, member.type));
    if (new Set(selected.map(constraintIdentity)).size !== selected.length) throw new Error('Duplicate skin constraint.');
    for (const type of constraintTypes) skin[type] = selected.filter(item => item.type === type).map(item => item.name);
  }
  return parseDocument(data);
}
