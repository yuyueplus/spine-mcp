import { object, type JsonObject, type SpineDocument } from './document.js';
import { equivalentNativeCurve } from './curve-equivalence.js';

export function verifyExtraTracks(expected: SpineDocument, actual: SpineDocument, equal: (a: unknown, b: unknown) => boolean) {
  const issues: string[] = [];
  for (const [name, animation] of Object.entries(expected.animations ?? {})) for (const group of ['bones', 'slots']) for (const [entity, rawChannels] of Object.entries(object(animation[group] ?? {}, group))) {
    const received = object(object(actual.animations?.[name]?.[group] ?? {}, group)[entity] ?? {}, 'channels');
    for (const [channel, rawKeys] of Object.entries(object(rawChannels, 'channels'))) {
      if (group === 'bones' && !['translatex', 'translatey', 'scalex', 'scaley', 'shearx', 'sheary', 'inherit'].includes(channel)) continue;
      if (group === 'slots' && !['rgb', 'alpha', 'rgba2', 'rgb2'].includes(channel)) continue;
      const keys = rawKeys as JsonObject[], right = received[channel] as JsonObject[] | undefined;
      if (!right || right.length !== keys.length) { issues.push(`Key count differs: ${name}/${entity}/${channel}.`); continue; }
      const normalize = (key: JsonObject): unknown[] => {
        if (channel === 'inherit') return [String(key.inherit ?? 'normal').toLowerCase()];
        if (group === 'bones' || channel === 'alpha') return [key.value ?? (channel.startsWith('scale') || channel === 'alpha' ? 1 : 0)];
        const fields = channel.endsWith('2') ? ['light', 'dark'] : ['color'];
        return fields.map(field => {
          const color = String(key[field] ?? (field === 'dark' ? '000000' : 'ffffffff')).toLowerCase();
          return field !== 'dark' && channel === 'rgba2' ? color.padEnd(8, 'f') : color.slice(0, 6);
        });
      };
      keys.forEach((key, index) => {
        const other = right[index]!;
        if (!equal(key.time ?? 0, other.time ?? 0) || !equal(normalize(key), normalize(other))) issues.push(`Key differs: ${name}/${entity}/${channel}[${index}].`);
        const numericValues = (frame: JsonObject): number[] => normalize(frame).flatMap(value => typeof value === 'string' ? (channel === 'inherit' ? [NaN] : value.match(/../g)!.map(v => parseInt(v, 16) / 255)) : [Number(value)]);
        const constant = equivalentNativeCurve(key, keys[index + 1], other, right[index + 1], numericValues, equal).equivalent;
        if (!equal(key.curve, other.curve) && !constant) issues.push(`Curve differs: ${name}/${entity}/${channel}[${index}].`);
      });
    }
  }
  return issues;
}
