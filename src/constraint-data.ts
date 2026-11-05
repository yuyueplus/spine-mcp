import { object, safeName, type JsonObject } from './json.js';
import type { SpineDocument } from './document.js';
import { checkFrameTimes, documentSkins } from './slot-data.js';

export const constraintTypes = ['ik', 'transform', 'path', 'physics', 'slider'] as const;
export type ConstraintType = typeof constraintTypes[number];
export type ConstraintSelector = string | { name: string; type: ConstraintType };
export const constraintIdentity = (constraint: JsonObject) => JSON.stringify([constraint.type, constraint.name]);
export function resolveConstraint(data: SpineDocument, name: string, type?: ConstraintType): JsonObject {
  const matches = constraintList(data).filter(item => item.name === name && (type === undefined || item.type === type));
  if (!matches.length) throw new Error(`Constraint not found: ${type ? `${type}/` : ''}${name}`);
  if (matches.length > 1) throw new Error(`Ambiguous constraint ${name}; provide constraintType (${matches.map(item => item.type).join(', ')}).`);
  return matches[0]!;
}
export const mixFields = ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'];
export function normalizedConstraint(definition: JsonObject): JsonObject {
  const type = String(definition.type);
  const defaults: JsonObject = type === 'ik' ? { skin: false, mix: 1, softness: 0, bendPositive: true, compress: false, stretch: false, scaleY: 'none' }
    : type === 'transform' ? { skin: false, localSource: false, localTarget: false, additive: false, clamp: false, rotation: 0, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0, ...Object.fromEntries(mixFields.map(field => [field, 1])) }
    : type === 'path' ? { skin: false, positionMode: 'percent', spacingMode: 'length', rotateMode: 'tangent', rotation: 0, position: 0, spacing: 0, mixRotate: 1, mixX: 1, mixY: 1 }
    : type === 'physics' ? { skin: false, x: 0, y: 0, rotate: 0, scaleX: 0, scaleY: 'none', shearX: 0, limit: 5000, fps: 60, inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1, ...Object.fromEntries(['inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'mix'].map(name => [`${name}Global`, false])) }
    : { skin: false, additive: false, loop: false, mix: 1, time: 0, from: 0, to: 0, scale: 1, max: 0, local: false };
  const result = { ...defaults };
  for (const field of [...Object.keys(defaults), 'bones', 'bone', 'target', 'source', 'slot', 'animation', 'property']) if (definition[field] !== undefined) result[field] = definition[field];
  for (const field of ['positionMode', 'spacingMode', 'rotateMode']) if (typeof result[field] === 'string') result[field] = result[field].toLowerCase();
  if (type === 'ik' || type === 'physics') result.scaleY = String(result.scaleY).toLowerCase();
  if (type === 'transform') result.properties = Object.fromEntries(Object.entries(object(definition.properties ?? {}, 'properties')).map(([name, raw]) => {
    const entry = object(raw, 'property');
    return [name, { offset: entry.offset ?? 0, to: Object.fromEntries(Object.entries(object(entry.to ?? {}, 'property mappings')).map(([target, rawMapping]) => [target, { offset: 0, scale: 1, max: 1, ...object(rawMapping, 'mapping') }])) }];
  }));
  if (type === 'transform' || type === 'path') result.mixY = definition.mixY ?? definition.mixX ?? 1;
  if (type === 'transform') result.mixScaleY = definition.mixScaleY ?? definition.mixScaleX ?? 1;
  return result;
}
const transformProperties = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];
export function constraintList(data: SpineDocument): JsonObject[] {
  if (data.constraints === undefined) return [];
  if (!Array.isArray(data.constraints)) throw new Error('constraints must be an ordered 4.3 array.');
  return data.constraints.map(raw => object(raw, 'constraint'));
}
export function constraintKeyFields(type: string, channel: string): Record<string, unknown> {
  if (type === 'ik' && channel === 'parameters') return { mix: 1, softness: 0, bendPositive: true, compress: false, stretch: false };
  if (type === 'transform' && channel === 'parameters') return Object.fromEntries(mixFields.map(field => [field, 1]));
  if (type === 'path' && channel === 'mix') return { mixRotate: 1, mixX: 1, mixY: 1 };
  if (type === 'path' && ['position', 'spacing'].includes(channel)) return { value: 0 };
  if (type === 'physics' && channel === 'reset') return {};
  if (type === 'physics' && ['inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'mix'].includes(channel)) return { value: channel === 'mix' ? 1 : 0 };
  if (type === 'slider' && ['time', 'mix'].includes(channel)) return { value: 1 };
  throw new Error(`Unsupported ${type} timeline channel: ${channel}`);
}
// 4.3 imports retain mix channels only for actual transform property outputs.
// Zeroing unused outputs is redundant and the editor removes those fields.
export function disabledParameterKey(definition: JsonObject): JsonObject | null {
  if (definition.type === 'ik') return { time: 0, ...constraintKeyFields('ik', 'parameters'), mix: 0 };
  if (definition.type !== 'transform') throw new Error('Disabled parameter keys require IK or transform constraints.');
  const targets = new Set(Object.values(object(definition.properties ?? {}, 'properties')).flatMap(raw => Object.keys(object(object(raw, 'property').to ?? {}, 'mapping'))));
  const fields: Record<string, string> = { rotate: 'mixRotate', x: 'mixX', y: 'mixY', scaleX: 'mixScaleX', scaleY: 'mixScaleY', shearY: 'mixShearY' }, key: JsonObject = { time: 0 };
  for (const target of targets) { const field = fields[target]; if (field) key[field] = 0; }
  return Object.keys(key).length > 1 ? key : null;
}
export function normalizedConstraintKey(type: string, channel: string, key: JsonObject): JsonObject {
  const result: JsonObject = { ...constraintKeyFields(type, channel), ...key, time: key.time ?? 0 };
  if ((type === 'transform' || type === 'path') && channel !== 'position' && channel !== 'spacing') {
    result.mixY = key.mixY ?? key.mixX ?? 1;
    if (type === 'transform') result.mixScaleY = key.mixScaleY ?? key.mixScaleX ?? 1;
  }
  return result;
}
export function checkConstraintKeys(type: string, channel: string, raw: unknown) {
  const frames = checkFrameTimes(raw, `${type}/${channel}`), defaults = constraintKeyFields(type, channel);
  const numericFields = Object.entries(defaults).filter(([_name, value]) => typeof value === 'number').map(([name]) => name);
  frames.forEach((key, index) => {
    for (const [field, value] of Object.entries(key)) {
      if (field === 'time' || field === 'curve') continue;
      if (!Object.hasOwn(defaults, field)) throw new Error(`Unknown ${type}/${channel} keyframe field: ${field}`);
      if (typeof defaults[field] === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid constraint keyframe ${field}.`);
      if (type !== 'transform' && typeof value === 'number' && (field.startsWith('mix') || (channel === 'mix' && field === 'value')) && (value < 0 || value > 1)) throw new Error('Constraint mix values must be between 0 and 1.');
    }
    if (type === 'physics' && channel === 'mass' && Number(key.value ?? 0) <= 0) throw new Error('Physics mass must be positive.');
    if (key.curve !== undefined) {
      if (index === frames.length - 1 || !numericFields.length) throw new Error('This keyframe cannot have an outgoing curve.');
      if (key.curve !== 'stepped' && (!Array.isArray(key.curve) || key.curve.length !== numericFields.length * 4 || key.curve.some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new Error(`Constraint curve needs ${numericFields.length * 4} finite controls or stepped.`);
    }
  });
  return frames;
}
export function constraintTracks(data: SpineDocument, animation: JsonObject) {
  const tracks: { type: string; name: string; channel: string; frames: JsonObject[] }[] = [];
  for (const type of constraintTypes) for (const [name, raw] of Object.entries(object(animation[type] ?? {}, `${type} timelines`))) {
    if (!(type === 'physics' && name === '') && !constraintList(data).some(item => item.name === name && item.type === type)) throw new Error(`Timeline references missing ${type} constraint: ${name}`);
    const channels = type === 'ik' || type === 'transform' ? { parameters: raw } : object(raw, `${type} channels`);
    for (const [channel, frames] of Object.entries(channels)) if (Array.isArray(frames) && !frames.length) continue; else tracks.push({ type, name, channel, frames: checkConstraintKeys(type, channel, frames) });
  }
  return tracks;
}
export function validateConstraints(data: SpineDocument) {
  const bones = new Map(data.bones.map(bone => [bone.name, bone])), slots = new Set((data.slots ?? []).map(slot => slot.name)), names = new Set<string>();
  for (const constraint of constraintList(data)) {
    if (typeof constraint.name !== 'string' || typeof constraint.type !== 'string' || !(constraintTypes as readonly string[]).includes(constraint.type)) throw new Error('A constraint needs a name and a supported 4.3 type.');
    safeName(constraint.name);
    const identity = constraintIdentity(constraint);
    if (names.has(identity)) throw new Error(`Duplicate ${constraint.type} constraint: ${constraint.name}`); names.add(identity);
    const type = constraint.type;
    if (['ik', 'transform', 'path'].includes(type)) {
      if (!Array.isArray(constraint.bones) || !constraint.bones.length || new Set(constraint.bones).size !== constraint.bones.length || constraint.bones.some(name => !bones.has(String(name)))) throw new Error(`Invalid constrained bones: ${constraint.name}`);
      if (type === 'ik' && (constraint.bones.length > 2 || (constraint.bones.length === 2 && bones.get(String(constraint.bones[1]))!.parent !== constraint.bones[0]))) throw new Error('IK requires one bone or a direct two-bone chain.');
    }
    for (const field of type === 'ik' ? ['target'] : type === 'transform' ? ['source'] : type === 'physics' ? ['bone'] : type === 'slider' && constraint.bone !== undefined ? ['bone'] : []) if (!bones.has(String(constraint[field]))) throw new Error(`Constraint ${constraint.name} references missing bone ${String(constraint[field])}.`);
    if (type === 'ik' && (constraint.bones as string[]).includes(String(constraint.target))) throw new Error('IK target cannot be a constrained bone.');
    if (type === 'transform' && (constraint.bones as string[]).includes(String(constraint.source))) throw new Error('Transform source cannot be a constrained bone.');
    if (type === 'path' && !slots.has(String(constraint.slot))) throw new Error('Path constraint references a missing slot.');
    if (type === 'slider' && !Object.hasOwn(data.animations ?? {}, String(constraint.animation))) throw new Error('Slider references a missing animation.');
    for (const field of ['skin', 'bendPositive', 'compress', 'stretch', 'localSource', 'localTarget', 'additive', 'clamp', 'local', 'loop', ...['inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'mix'].map(name => `${name}Global`)]) if (constraint[field] !== undefined && typeof constraint[field] !== 'boolean') throw new Error(`Constraint ${field} must be boolean.`);
    for (const [field, values] of Object.entries({ positionMode: ['fixed', 'percent'], spacingMode: ['length', 'fixed', 'percent', 'proportional'], rotateMode: ['tangent', 'chain', 'chainscale'], scaleY: ['none', 'uniform', 'volume'] })) if (typeof constraint[field] === 'string' && !values.includes(String(constraint[field]).toLowerCase())) throw new Error(`Unknown constraint ${field} mode.`);
    for (const field of ['mix', ...mixFields, 'softness', 'x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearY', 'shearX', 'rotate', 'position', 'spacing', 'limit', 'fps', 'inertia', 'strength', 'damping', 'mass', 'wind', 'gravity', 'time', 'from', 'to', 'scale', 'max']) {
      const value = constraint[field];
      if (value === undefined || (field === 'scaleY' && typeof value === 'string')) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid constraint numeric field: ${constraint.name}.${field}`);
      if ((type !== 'transform' && field.startsWith('mix') && (value < 0 || value > 1)) || (['fps', 'mass'].includes(field) && value <= 0)) throw new Error(`Constraint ${field} is outside the supported range.`);
    }
    if (type === 'transform') for (const [from, raw] of Object.entries(object(constraint.properties ?? {}, 'transform properties'))) {
      if (!transformProperties.includes(from)) throw new Error(`Unknown transform property: ${from}`);
      const property = object(raw, 'transform property');
      if (property.offset !== undefined && (typeof property.offset !== 'number' || !Number.isFinite(property.offset))) throw new Error('Transform property offset must be finite.');
      for (const [to, rawTarget] of Object.entries(object(property.to ?? {}, 'transform targets'))) {
        if (!transformProperties.includes(to)) throw new Error(`Unknown transform target: ${to}`);
        for (const value of Object.values(object(rawTarget, 'transform target'))) if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Transform mapping values must be finite.');
      }
    }
  }
  for (const skin of documentSkins(data)) {
    for (const name of (skin.bones ?? []) as string[]) if (!bones.has(name)) throw new Error('Skin references a missing bone.');
    for (const type of constraintTypes) for (const name of (skin[type] ?? []) as string[]) if (!constraintList(data).some(item => item.name === name && item.type === type)) throw new Error(`Skin references a missing ${type} constraint.`);
  }
  for (const animation of Object.values(data.animations ?? {})) constraintTracks(data, animation);
}
