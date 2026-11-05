import { attachmentEntries, attachmentTracks, normalizedAttachmentKeys, vertexLayout } from './attachment-data.js';
import { folderTracks, decodeDrawOrder } from './animation-data.js';
import type { SpineDocument, JsonObject } from './document.js';
import { canNormalizeClippingConvexity, deformedAttachments } from './native-compatibility.js';

export function orientedTriangles(raw: unknown) {
  if (!Array.isArray(raw)) return raw;
  const faces: number[][] = [];
  for (let index = 0; index < raw.length; index += 3) {
    const face = raw.slice(index, index + 3) as number[], first = face.indexOf(Math.min(...face));
    faces.push([...face.slice(first), ...face.slice(0, first)]);
  }
  return faces.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
}
export function reorderedTriangleAttachments(expected: SpineDocument, actual: SpineDocument) {
  const actualEntries = attachmentEntries(actual);
  return attachmentEntries(expected).filter(item => {
    const other = actualEntries.find(entry => entry.skin === item.skin && entry.slot === item.slot && entry.name === item.name);
    return Array.isArray(item.value.triangles) && other && JSON.stringify(item.value.triangles) !== JSON.stringify(other.value.triangles) && JSON.stringify(orientedTriangles(item.value.triangles)) === JSON.stringify(orientedTriangles(other.value.triangles));
  }).map(({ skin, slot, name }) => ({ skin, slot, name }));
}

export function verifyGeometry(expected: SpineDocument, actual: SpineDocument, equal: (a: unknown, b: unknown) => boolean): string[] {
  const issues: string[] = [], deformed = deformedAttachments(expected);
  const vertices = (data: SpineDocument, item: JsonObject) => {
    if (!Array.isArray(item.vertices)) return undefined;
    const raw = item.vertices as number[];
    if (!vertexLayout(data, item).weighted) return raw;
    const result: unknown[] = []; let offset = 0;
    while (offset < raw.length) {
      const count = raw[offset++]!; result.push(count);
      for (let index = 0; index < count; index++) { result.push(data.bones[raw[offset]!]!.name, ...raw.slice(offset + 1, offset + 4)); offset += 4; }
    }
    return result;
  };
  for (const item of attachmentEntries(expected)) {
    const other = attachmentEntries(actual).find(entry => entry.skin === item.skin && entry.slot === item.slot && entry.name === item.name);
    if (!other) continue;
    const left = item.value, right = other.value, type = String(left.type ?? 'region'), label = `${item.skin}/${item.slot}/${item.name}`;
    const actualType = String(right.type ?? 'region');
    if (left.source === undefined ? type !== actualType : !['mesh', 'linkedmesh'].includes(actualType)) issues.push(`Attachment type differs: ${label}.`);
    const defaults: JsonObject = { name: item.name, path: left.name ?? item.name, color: 'ffffffff' };
    if (['mesh', 'linkedmesh', 'region'].includes(type)) {
      for (const field of ['name', 'path', 'color']) {
        const fallback = (value: JsonObject) => field === 'path' ? value.name ?? item.name : defaults[field];
        const a = left[field] ?? fallback(left), b = right[field] ?? fallback(right);
        if (!equal(field === 'color' ? String(a).toLowerCase() : a, field === 'color' ? String(b).toLowerCase() : b)) issues.push(`Attachment ${label}.${field} differs.`);
      }
      const sequence = (value: unknown) => value === undefined ? null : { count: 1, start: 1, digits: 0, setup: 0, ...(value as JsonObject) };
      if (!equal(sequence(left.sequence), sequence(right.sequence))) issues.push(`Sequence differs: ${label}.`);
    }
    if (type === 'region') for (const [field, fallback] of Object.entries({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 0, height: 0 })) {
      if (!equal(left[field] ?? fallback, right[field] ?? fallback)) issues.push(`Region ${label}.${field} differs.`);
    }
    if (type === 'point') for (const field of ['x', 'y', 'rotation']) if (!equal(left[field] ?? 0, right[field] ?? 0)) issues.push(`Point ${label}.${field} differs.`);
    if (left.source !== undefined) for (const [field, fallback] of Object.entries({ source: '', skin: 'default', slot: item.slot, timelines: true })) {
      if (!equal(left[field] ?? fallback, right[field] ?? fallback)) issues.push(`Linked mesh ${label}.${field} differs.`);
    }
    if (Array.isArray(left.vertices)) {
      if (!equal(vertices(expected, left), vertices(actual, right))) issues.push(`Vertices or weights differ: ${label}.`);
      if (left.uvs !== undefined && !equal(left.uvs, right.uvs)) issues.push(`Geometry ${label}.uvs differs.`);
      if (left.triangles !== undefined && !equal(orientedTriangles(left.triangles), orientedTriangles(right.triangles))) issues.push(`Geometry ${label}.triangles differs.`);
      // Constant-speed paths derive their own lengths from the cubic geometry.
      // The editor may append unused cached curve lengths to the exported list.
      if (type === 'path' && left.constantSpeed === false) {
        const length = (left.lengths as number[]).length;
        if (!equal(left.lengths, (right.lengths as number[] | undefined)?.slice(0, length))) issues.push(`Path lengths differ: ${label}.`);
      }
      const flags: JsonObject = type === 'path' ? { closed: false, constantSpeed: true } : type === 'clipping' ? { end: null, inverse: false } : { hull: 0 };
      for (const [field, fallback] of Object.entries(flags)) if (!equal(left[field] ?? fallback, right[field] ?? fallback)) issues.push(`Geometry ${label}.${field} differs.`);
      if (type === 'clipping' && Boolean(left.convex) !== Boolean(right.convex)) {
        if (!canNormalizeClippingConvexity(expected, left, deformed)) issues.push(`Clipping convexity differs: ${label}.`);
      }
    }
  }
  for (const [name, animation] of Object.entries(expected.animations ?? {})) {
    const received = actual.animations?.[name]; if (!received) continue;
    const left = attachmentTracks(expected, animation), right = attachmentTracks(actual, received);
    if (left.length !== right.length) issues.push(`Attachment timeline inventory differs: ${name}.`);
    for (const track of left) {
      const found = right.find(other => other.skin === track.skin && other.slot === track.slot && other.name === track.name && other.channel === track.channel);
      const equivalent = (() => {
        if (!found) return false;
        const a = normalizedAttachmentKeys(track) as JsonObject[], b = normalizedAttachmentKeys(found) as JsonObject[];
        if (track.channel !== 'deform') return equal(a, b);
        if (a.length !== b.length) return false;
        return a.every((key, index) => {
          const other = b[index]!, leftValue = { ...key }, rightValue = { ...other }; delete leftValue.curve; delete rightValue.curve;
          const constant = a[index + 1] && b[index + 1] && (key.curve === undefined || key.curve === 'stepped') && (other.curve === undefined || other.curve === 'stepped') && JSON.stringify(key.vertices) === JSON.stringify(a[index + 1]!.vertices) && JSON.stringify(other.vertices) === JSON.stringify(b[index + 1]!.vertices);
          return equal(leftValue, rightValue) && (equal(key.curve, other.curve) || !!constant);
        });
      })();
      if (!equivalent) issues.push(`Attachment keys differ: ${name}/${track.skin}/${track.slot}/${track.name}/${track.channel}.`);
    }
    const folders = (data: SpineDocument, value: JsonObject) => folderTracks(data, value).map(folder => ({ slots: folder.slots, keys: folder.frames.map(key => ({ time: key.time ?? 0, order: decodeDrawOrder(folder.data, key) })) }));
    if (!equal(folders(expected, animation), folders(actual, received))) issues.push(`Folder draw order differs: ${name}.`);
  }
  return issues;
}
