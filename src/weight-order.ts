import { attachmentEntries, attachmentTracks, sourceMesh, vertexLayout } from './attachment-data.js';
import type { SpineDocument, JsonObject } from './document.js';

// The editor importer requires ascending bone indices. A deformation contains
// one XY pair per influence, so its coordinates must follow the same reorder.
// Verification uses bone names instead, to compare rigs with reordered bones.
export function canonicalizeWeights(source: SpineDocument, byName = false): SpineDocument {
  const data = structuredClone(source), mappings = new Map<JsonObject, { indices: number[]; oldLength: number }>();
  const tracks = Object.values(data.animations ?? {}).flatMap(animation => attachmentTracks(data, animation));
  for (const entry of attachmentEntries(data)) {
    const mesh = entry.value;
    if (mesh.source !== undefined || !Array.isArray(mesh.vertices) || !vertexLayout(data, mesh).weighted) continue;
    const raw = mesh.vertices as number[], packed: number[] = [], mapping: number[] = [];
    let cursor = 0, influence = 0, changed = false;
    while (cursor < raw.length) {
      const count = raw[cursor++]!, row: { bone: number; values: number[]; old: number }[] = [];
      for (let index = 0; index < count; index++, cursor += 4, influence++) { if (raw[cursor + 3] === 0) { changed = true; continue; } row.push({ bone: raw[cursor]!, values: raw.slice(cursor, cursor + 4), old: influence }); }
      row.sort((a, b) => byName ? (data.bones[a.bone]!.name < data.bones[b.bone]!.name ? -1 : 1) : a.bone - b.bone);
      packed.push(row.length);
      for (const item of row) { changed ||= item.old * 2 !== mapping.length; mapping.push(item.old * 2, item.old * 2 + 1); packed.push(...item.values); }
    }
    if (changed) { mesh.vertices = packed; mappings.set(mesh, { indices: mapping, oldLength: influence * 2 }); }
  }
  if (!mappings.size) return source;
  for (const track of tracks) {
    if (track.channel !== 'deform') continue;
    const entry = mappings.get(sourceMesh(data, track.skin, track.slot, track.name));
    if (!entry) continue; const mapping = entry.indices;
    for (const key of track.frames) {
      const old = new Array<number>(entry.oldLength).fill(0), values = (key.vertices ?? []) as number[], offset = Number(key.offset ?? 0);
      values.forEach((value, index) => { old[offset + index] = value; });
      const next = mapping.map(index => old[index]!);
      let first = 0, last = next.length;
      while (first < last && next[first] === 0) first++;
      while (last > first && next[last - 1] === 0) last--;
      delete key.offset; delete key.vertices;
      if (first < last) { if (first) key.offset = first; key.vertices = next.slice(first, last); }
    }
  }
  return data;
}
