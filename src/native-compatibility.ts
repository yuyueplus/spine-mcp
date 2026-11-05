import { attachmentEntries, attachmentTracks, sourceMesh, vertexLayout } from './attachment-data.js';
import type { JsonObject, SpineDocument } from './document.js';

// Consistent signed turns and a winding of exactly one reject both concavity
// and star polygons. Backtracking/zero-length edges are conservatively unsafe.
export function isConvexPolygon(vertices: number[]): boolean {
  if (vertices.length < 6 || vertices.length % 2 || vertices.some(n => !Number.isFinite(n))) return false;
  const edges: [number, number][] = [];
  for (let i = 0; i < vertices.length; i += 2) {
    const next = (i + 2) % vertices.length, x = vertices[next]! - vertices[i]!, y = vertices[next + 1]! - vertices[i + 1]!;
    const length = Math.hypot(x, y); if (!Number.isFinite(length) || length === 0) return false; edges.push([x / length, y / length]);
  }
  let direction = 0, total = 0;
  for (let i = 0; i < edges.length; i++) {
    const [ax, ay] = edges[i]!, [bx, by] = edges[(i + 1) % edges.length]!, turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    if (Math.abs(Math.abs(turn) - Math.PI) < 1e-10) return false;
    if (turn !== 0) { const sign = Math.sign(turn); if (direction && direction !== sign) return false; direction = sign; }
    total += turn;
  }
  return Math.abs(Math.abs(total) - Math.PI * 2) < 1e-7;
}
export function deformedAttachments(data: SpineDocument) {
  const result = new Set<JsonObject>();
  for (const animation of Object.values(data.animations ?? {})) for (const track of attachmentTracks(data, animation)) if (track.channel === 'deform') result.add(sourceMesh(data, track.skin, track.slot, track.name));
  return result;
}
export function canNormalizeClippingConvexity(data: SpineDocument, attachment: JsonObject, deformed = deformedAttachments(data)) {
  return attachment.inverse === true || !vertexLayout(data, attachment).weighted && !deformed.has(attachment) && isConvexPolygon(attachment.vertices as number[]);
}
export function nativeCompatibility(data: SpineDocument) {
  const deformed = deformedAttachments(data), clipping = attachmentEntries(data).filter(item => item.value.type === 'clipping').map(item => {
    const weighted = vertexLayout(data, item.value).weighted, animatedDeformation = deformed.has(item.value), safe = canNormalizeClippingConvexity(data, item.value, deformed), risk = !item.value.convex && !safe;
    return { skin: item.skin, slot: item.slot, name: item.name, weighted, animatedDeformation, inverse: !!item.value.inverse, convex: !!item.value.convex, convexFlagNormalizationSafe: safe, nativeImportRisk: risk,
      ...(risk ? { reason: 'Installed 4.3.23 JSON importer may force convex=true. Concave or deforming clipping must retain its flag; native publication will fail if readback differs.', action: 'Keep the JSON workflow, or archive the original and explicitly choose spine_bake_clipping for a dedicated sampled visual output. This flat fallback drops rig, other skins/animations and editable clipping. Validate native readback and spine_compare_artwork; the original remains intact.' } : {}) };
  });
  return { profile: 'spine-4.3.23', savedFilesOnly: true, requiresNativeRoundTripVerification: true, clippingAttachments: clipping.length, clippingImportRisks: clipping.filter(item => item.nativeImportRisk).length, clipping, editorOnlyMetadataPreservationProven: false };
}
