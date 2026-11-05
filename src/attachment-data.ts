import { object, safeName, type JsonObject } from './json.js';
import type { SpineDocument } from './document.js';
import { documentSkins, checkFrameTimes } from './slot-data.js';

export function attachmentEntries(data: SpineDocument) {
  return documentSkins(data).flatMap(skin => Object.entries(object(skin.attachments ?? {}, 'attachments')).flatMap(([slot, raw]) => Object.entries(object(raw, 'slot attachments')).map(([name, value]) => ({ skin: String(skin.name), slot, name, value: object(value, 'attachment') }))));
}
export function sourceMesh(data: SpineDocument, skin: string, slot: string, name: string): JsonObject {
  const item = attachmentEntries(data).find(item => item.skin === skin && item.slot === slot && item.name === name);
  if (!item) throw new Error(`Attachment not found: ${skin}/${slot}/${name}`);
  if (item.value.source !== undefined) {
    const parent = attachmentEntries(data).find(parent => parent.skin === (item.value.skin ?? 'default') && parent.slot === (item.value.slot ?? slot) && parent.name === item.value.source);
    if (!parent || parent.value.source !== undefined || (parent.value.type ?? 'region') !== 'mesh') throw new Error('Linked mesh source must be an existing nonlinked mesh.');
    return parent.value;
  }
  return item.value;
}
export function vertexLayout(data: SpineDocument, attachment: JsonObject) {
  const count = Array.isArray(attachment.uvs) ? attachment.uvs.length / 2 : Number(attachment.vertexCount ?? 0), raw = attachment.vertices;
  if (!Number.isInteger(count) || count < 1 || count > 10000 || !Array.isArray(raw) || raw.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Invalid attachment vertices or vertex count.');
  if (raw.length === count * 2) return { count, weighted: false, deformLength: raw.length };
  let offset = 0, influences = 0;
  for (let vertex = 0; vertex < count; vertex++) {
    const bones = raw[offset++];
    if (!Number.isInteger(bones) || bones < 1 || bones > 16 || offset + bones * 4 > raw.length) throw new Error('Invalid weighted vertex influences.');
    let weight = 0; const seen = new Set<number>();
    for (let index = 0; index < bones; index++, offset += 4) {
      if (!Number.isInteger(raw[offset]) || raw[offset] < 0 || raw[offset] >= data.bones.length || raw[offset + 3] < 0) throw new Error('Invalid weighted bone index or weight.');
      if (seen.has(raw[offset])) throw new Error('A weighted vertex cannot repeat the same bone.'); seen.add(raw[offset]);
      weight += raw[offset + 3];
    }
    if (Math.abs(weight - 1) > 0.001) throw new Error('Each vertex weight sum must be 1.');
    influences += bones;
  }
  if (offset !== raw.length) throw new Error('Unexpected weighted vertex payload.');
  return { count, weighted: true, deformLength: influences * 2 };
}
export function attachmentTracks(data: SpineDocument, animation: JsonObject) {
  const tracks: { skin: string; slot: string; name: string; channel: string; frames: JsonObject[]; length?: number }[] = [];
  for (const [skin, rawSlots] of Object.entries(object(animation.attachments ?? {}, 'attachment timelines'))) for (const [slot, rawAttachments] of Object.entries(object(rawSlots, 'attachment slots'))) for (const [name, rawChannels] of Object.entries(object(rawAttachments, 'attachment channels'))) {
    const record = attachmentEntries(data).find(item => item.skin === skin && item.slot === slot && item.name === name);
    if (!record) throw new Error('Attachment timeline references a missing attachment.');
    for (const [channel, rawFrames] of Object.entries(object(rawChannels, 'attachment channels'))) {
      if (Array.isArray(rawFrames) && !rawFrames.length) continue;
      const frames = checkFrameTimes(rawFrames, `${skin}/${slot}/${name}/${channel}`);
      let length: number | undefined;
      if (channel === 'deform') {
        const attachment = sourceMesh(data, skin, slot, name);
        if (!Array.isArray(attachment.vertices)) throw new Error('Deform requires a vertex attachment.');
        length = vertexLayout(data, attachment).deformLength;
        frames.forEach((key, index) => {
          const offset = key.offset ?? 0, vertices = key.vertices ?? [];
          if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || !Array.isArray(vertices) || offset + vertices.length > length! || vertices.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Deform offset/vertex data exceeds attachment layout.');
          if (key.curve !== undefined && (index === frames.length - 1 || (key.curve !== 'stepped' && (!Array.isArray(key.curve) || key.curve.length !== 4 || key.curve.some(n => typeof n !== 'number' || !Number.isFinite(n)))))) throw new Error('Deform curve requires four numeric controls or stepped, on a non-final key.');
        });
      } else if (channel === 'sequence') {
        const sequence = object(record.value.sequence, 'attachment sequence');
        let delay = 0;
        for (const key of frames) {
          const mode = key.mode ?? 'hold', index = key.index ?? 0;
          if (!['hold', 'once', 'loop', 'pingpong', 'onceReverse', 'loopReverse', 'pingpongReverse'].includes(String(mode)) || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= Number(sequence.count)) throw new Error('Invalid sequence mode/index.');
          delay = Number(key.delay ?? delay);
          if (!Number.isFinite(delay) || delay < 0 || (mode !== 'hold' && delay === 0)) throw new Error('Playing sequences requires positive frame delay.');
        }
      } else throw new Error(`Unsupported attachment timeline: ${channel}`);
      tracks.push({ skin, slot, name, channel, frames, length });
    }
  }
  return tracks;
}
export function normalizedAttachmentKeys(track: ReturnType<typeof attachmentTracks>[number]) {
  let delay = 0;
  return track.frames.map(key => {
    if (track.channel === 'deform') {
      const vertices = new Array<number>(track.length!).fill(0), raw = (key.vertices ?? []) as number[], offset = Number(key.offset ?? 0);
      raw.forEach((value, index) => { vertices[offset + index] = value; });
      return { time: key.time ?? 0, vertices, ...(key.curve === undefined ? {} : { curve: key.curve }) };
    }
    delay = Number(key.delay ?? delay);
    return { time: key.time ?? 0, mode: key.mode ?? 'hold', index: key.index ?? 0, delay };
  });
}
export function validateAttachments(data: SpineDocument) {
  for (const item of attachmentEntries(data)) {
    const value = item.value, type = value.type ?? 'region';
    if (!['region', 'mesh', 'linkedmesh', 'path', 'boundingbox', 'point', 'clipping'].includes(String(type))) throw new Error(`Unsupported 4.3 attachment type: ${String(type)}`);
    if (value.name !== undefined && typeof value.name !== 'string') throw new Error('Attachment internal name must be a string.');
    if (value.sequence !== undefined) {
      const seq = object(value.sequence, 'sequence'), count = seq.count, setup = seq.setup ?? 0;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 600 || typeof setup !== 'number' || !Number.isInteger(setup) || setup < 0 || setup >= count) throw new Error('Invalid sequence count/setup index.');
      for (const [field, fallback] of [['start', 1], ['digits', 0]] as const) { const n = seq[field] ?? fallback; if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || (field === 'digits' && n > 10)) throw new Error('Invalid sequence suffix.'); }
    }
    if (type === 'mesh' || type === 'linkedmesh') {
      if (value.source !== undefined) { sourceMesh(data, item.skin, item.slot, item.name); continue; }
      if (!Array.isArray(value.uvs) || value.uvs.length < 6 || value.uvs.length % 2 || value.uvs.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) throw new Error('Mesh UVs must be normalized pairs for at least three vertices.');
      const layout = vertexLayout(data, value);
      if (!Array.isArray(value.triangles) || !value.triangles.length || value.triangles.length % 3 || value.triangles.some(n => !Number.isInteger(n) || n < 0 || n >= layout.count)) throw new Error('Invalid mesh triangles.');
      if (value.hull !== undefined && (typeof value.hull !== 'number' || !Number.isInteger(value.hull) || value.hull < 0 || value.hull > layout.count)) throw new Error('Invalid mesh hull.');
    } else if (['path', 'boundingbox', 'clipping'].includes(String(type))) {
      const layout = vertexLayout(data, value);
      if (layout.count < (type === 'path' ? 6 : 3) || (type === 'path' && layout.count % 3)) throw new Error('Invalid path/polygon vertex count.');
      if (type === 'path' && (!Array.isArray(value.lengths) || value.lengths.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0))) throw new Error('Path needs finite nonnegative curve lengths.');
      if (type === 'path' && value.constantSpeed === false && (value.lengths as number[]).length < layout.count / 3 - (value.closed === true ? 0 : 1)) throw new Error('Non-constant-speed path needs a length for every curve.');
      if (type === 'clipping' && value.end !== undefined && !data.slots?.some(slot => slot.name === value.end)) throw new Error('Clipping end slot is missing.');
    }
  }
  for (const animation of Object.values(data.animations ?? {})) attachmentTracks(data, animation);
}
