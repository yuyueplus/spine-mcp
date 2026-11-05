import { DeformTimeline, VertexAttachment, RotateTimeline, TranslateTimeline, TranslateXTimeline, TranslateYTimeline, ScaleTimeline, ScaleXTimeline, ScaleYTimeline, ShearTimeline, ShearXTimeline, ShearYTimeline, type SkeletonData } from '@esotericsoftware/spine-core';
import { attachmentEntries, attachmentTracks, sourceMesh, vertexLayout, normalizedAttachmentKeys } from './attachment-data.js';
import { parseDocument, type SpineDocument, type JsonObject } from './document.js';

const coordinateQuantum = 0.00501;
const boneChannels = [
  { channel: 'rotate', kind: RotateTimeline, fields: ['value'], fallback: 0 },
  { channel: 'translate', kind: TranslateTimeline, fields: ['x', 'y'], fallback: 0 },
  { channel: 'translatex', kind: TranslateXTimeline, fields: ['value'], fallback: 0 },
  { channel: 'translatey', kind: TranslateYTimeline, fields: ['value'], fallback: 0 },
  { channel: 'scale', kind: ScaleTimeline, fields: ['x', 'y'], fallback: 1 },
  { channel: 'scalex', kind: ScaleXTimeline, fields: ['value'], fallback: 1 },
  { channel: 'scaley', kind: ScaleYTimeline, fields: ['value'], fallback: 1 },
  { channel: 'shear', kind: ShearTimeline, fields: ['x', 'y'], fallback: 0 },
  { channel: 'shearx', kind: ShearXTimeline, fields: ['value'], fallback: 0 },
  { channel: 'sheary', kind: ShearYTimeline, fields: ['value'], fallback: 0 },
];
function checkRounded(json: number, binary: number, label: string, tolerance = coordinateQuantum) {
  if (!Number.isFinite(binary) || Math.abs(json - binary) > tolerance) throw new Error(`JSON/binary geometry mismatch: ${label}.`);
}
// JSON exports round positions to hundredths. Read the authoritative binary
// data from the same export to retain float precision during repeated edits.
// Keep JSON influence order, since its deformation arrays use that order.
export function readbackGeometry(source: SpineDocument, binary: SkeletonData) {
  if (binary.version !== source.skeleton.spine) throw new Error('JSON/binary skeleton versions differ.');
  const data = structuredClone(source), boneIndices = new Map(data.bones.map((bone, index) => [bone.name, index]));
  const runtime = new Map<string, VertexAttachment>(), mappings = new Map<JsonObject, number[]>();
  const identity = (skin: string, slot: string, name: string) => JSON.stringify([skin, slot, name]);
  let attachments = 0, deformTracks = 0, boneTracks = 0;
  for (const item of attachmentEntries(data)) {
    const slotIndex = binary.slots.findIndex(slot => slot.name === item.slot), attachment = binary.findSkin(item.skin)?.getAttachment(slotIndex, item.name);
    if (!(attachment instanceof VertexAttachment)) { if (Array.isArray(item.value.vertices)) throw new Error(`Binary vertex attachment missing: ${item.skin}/${item.slot}/${item.name}`); continue; }
    runtime.set(identity(item.skin, item.slot, item.name), attachment);
    if (!Array.isArray(item.value.vertices) || item.value.source !== undefined) continue;
    const layout = vertexLayout(data, item.value), raw = item.value.vertices as number[], values = Array.from(attachment.vertices);
    if (attachment.worldVerticesLength !== layout.count * 2 || Boolean(attachment.bones) !== layout.weighted) throw new Error('JSON/binary vertex layout differs.');
    const precise: number[] = [], mapping: number[] = [];
    if (!layout.weighted) {
      if (values.length !== raw.length) throw new Error('JSON/binary vertex count differs.');
      raw.forEach((value, index) => { checkRounded(value, values[index]!, item.name); precise.push(values[index]!); mapping.push(index); });
    } else {
      let jsonCursor = 0, boneCursor = 0, valueCursor = 0, influenceIndex = 0;
      for (let vertex = 0; vertex < layout.count; vertex++) {
        const count = raw[jsonCursor++]!, binaryCount = attachment.bones![boneCursor++]!;
        if (count !== binaryCount) throw new Error('JSON/binary influence count differs.');
        const row = new Map<string, { values: number[]; deform: number }>();
        for (let index = 0; index < count; index++, valueCursor += 3, influenceIndex++) {
          const name = binary.bones[attachment.bones![boneCursor++]!]!.name;
          if (row.has(name)) throw new Error('Duplicate binary influence bone.');
          row.set(name, { values: values.slice(valueCursor, valueCursor + 3), deform: influenceIndex * 2 });
        }
        precise.push(count);
        for (let index = 0; index < count; index++, jsonCursor += 4) {
          const name = data.bones[raw[jsonCursor]!]!.name, found = row.get(name);
          if (!found) throw new Error('JSON/binary influence bone differs.');
          checkRounded(raw[jsonCursor + 1]!, found.values[0]!, item.name); checkRounded(raw[jsonCursor + 2]!, found.values[1]!, item.name);
          checkRounded(raw[jsonCursor + 3]!, found.values[2]!, item.name, 0.00001);
          precise.push(boneIndices.get(name)!, ...found.values); mapping.push(found.deform, found.deform + 1);
        }
      }
      if (boneCursor !== attachment.bones!.length || valueCursor !== values.length) throw new Error('Unexpected binary vertex payload.');
    }
    item.value.vertices = precise; mappings.set(item.value, mapping); attachments++;
  }
  for (const [name, animation] of Object.entries(data.animations ?? {})) for (const track of attachmentTracks(data, animation)) {
    if (track.channel !== 'deform') continue;
    const attachment = runtime.get(identity(track.skin, track.slot, track.name)), mesh = sourceMesh(data, track.skin, track.slot, track.name), mapping = mappings.get(mesh);
    const timelines = binary.findAnimation(name)?.timelines.filter(item => item instanceof DeformTimeline && item.attachment === attachment) as DeformTimeline[] | undefined;
    if (!attachment || !mapping || timelines?.length !== 1) throw new Error(`Binary deform timeline missing or ambiguous: ${name}/${track.skin}/${track.slot}/${track.name}`);
    const timeline = timelines[0]!, old = normalizedAttachmentKeys(track);
    if (timeline.frames.length !== track.frames.length) throw new Error('JSON/binary deform frame count differs.');
    track.frames.forEach((key, index) => {
      checkRounded(Number(key.time ?? 0), timeline.frames[index]!, `${name} deform time`, 0.0001);
      const binaryValues = Array.from(timeline.vertices[index]!), jsonValues = (old[index] as { vertices: number[] }).vertices;
      if (binaryValues.length !== mapping.length) throw new Error('JSON/binary deform layout differs.');
      const values = mapping.map((position, coordinate) => {
        const value = attachment.bones ? binaryValues[position]! : binaryValues[position]! - attachment.vertices[position]!;
        checkRounded(jsonValues[coordinate]!, value, `${name} deform coordinate`); return value;
      });
      let first = 0, last = values.length;
      while (first < last && values[first] === 0) first++;
      while (last > first && values[last - 1] === 0) last--;
      delete key.vertices; delete key.offset; key.time = timeline.frames[index]!;
      if (first < last) { if (first) key.offset = first; key.vertices = values.slice(first, last); }
    }); deformTracks++;
  }
  for (const [name, animation] of Object.entries(data.animations ?? {})) for (const [bone, rawChannels] of Object.entries((animation.bones ?? {}) as Record<string, JsonObject>)) for (const [channel, rawKeys] of Object.entries(rawChannels)) {
    const definition = boneChannels.find(item => item.channel === channel); if (!definition || !Array.isArray(rawKeys) || !rawKeys.length) continue;
    const matches = binary.findAnimation(name)?.timelines.filter(timeline => timeline instanceof definition.kind && binary.bones[timeline.boneIndex]?.name === bone);
    if (matches?.length !== 1) throw new Error(`JSON/binary bone timeline missing or ambiguous: ${name}/${bone}/${channel}`);
    const timeline = matches[0]! as RotateTimeline | TranslateTimeline, stride = definition.fields.length + 1;
    if (timeline.frames.length !== rawKeys.length * stride) throw new Error('JSON/binary bone frame count differs.');
    (rawKeys as JsonObject[]).forEach((key, index) => {
      const time = timeline.frames[index * stride]!; checkRounded(Number(key.time ?? 0), time, `${name}/${bone}/${channel} time`, 0.0001); key.time = time;
      definition.fields.forEach((field, component) => { const value = timeline.frames[index * stride + component + 1]!; checkRounded(Number(key[field] ?? definition.fallback), value, `${name}/${bone}/${channel}/${field}`); key[field] = value; });
    }); boneTracks++;
  }
  return { data: parseDocument(data), attachments, deformTracks, boneTracks };
}
