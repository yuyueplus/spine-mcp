import { ClippingAttachment, MeshAttachment, RegionAttachment, type Skeleton } from '@esotericsoftware/spine-core';
export interface AuditTexture { width: number; height: number; pixels: Uint8Array }
export interface VisibilityBudget { vertices: number; triangleTests: number; pixels?: number }
export interface PixelCoverage { coveredPixels: number; alphaPixels: number; visiblePixels: number; clippedPixels: number; occludedPixels: number; pixelSize: number; reason: 'clipped' | 'occluded' | 'transparent' | null; triangle: number[]; visiblePoints: Point[] }
type Point = [number, number];
interface Clip { polygon: number[]; inverse: boolean; end: number | null }
interface Layer { index: number; vertices: number[]; uvs: ArrayLike<number>; triangles: ArrayLike<number>; opacity: number; normal: boolean; image: string; clip: Clip | null; bounds: [number, number, number, number] }
function hull(vertices: number[]) {
  const points = Array.from({ length: vertices.length / 2 }, (_, i) => [vertices[i * 2]!, vertices[i * 2 + 1]!] as Point).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const lower: Point[] = [], upper: Point[] = [];
  for (const p of points) { while (lower.length > 1 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop(); lower.push(p); }
  for (const p of points.toReversed()) { while (upper.length > 1 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}
function inside([x, y]: Point, polygon: number[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 2; i < polygon.length; j = i, i += 2) {
    const ax = polygon[j]!, ay = polygon[j + 1]!, bx = polygon[i]!, by = polygon[i + 1]!;
    const area = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(area) <= 1e-9 && x >= Math.min(ax, bx) - 1e-9 && x <= Math.max(ax, bx) + 1e-9 && y >= Math.min(ay, by) - 1e-9 && y <= Math.max(ay, by) + 1e-9) return true;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) result = !result;
  }
  return result;
}
const visibleAt = (point: Point, clip: Clip | null) => !clip || inside(point, clip.polygon) !== clip.inverse;
function alpha(texture: AuditTexture, u: number, v: number) {
  const x = Math.max(0, Math.min(texture.width - 1, u * texture.width - 0.5)), y = Math.max(0, Math.min(texture.height - 1, v * texture.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(texture.width - 1, x0 + 1), y1 = Math.min(texture.height - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const a = (px: number, py: number) => texture.pixels[(py * texture.width + px) * 4 + 3]! / 255;
  return (a(x0, y0) * (1 - fx) + a(x1, y0) * fx) * (1 - fy) + (a(x0, y1) * (1 - fx) + a(x1, y1) * fx) * fy;
}
/** Visibility is sampled ONLY at the deformed triangle centroid. It is not a
 * footprint/GPU coverage test and cannot establish intentional deformation. */
export function visibilityFrame(skeleton: Skeleton, load: (image: string) => Promise<AuditTexture>, budget: VisibilityBudget) {
  const layers: Layer[] = []; let clip: Clip | null = null;
  for (const slot of skeleton.drawOrder.appliedPose) {
    const a = slot.appliedPose.attachment;
    if (slot.bone.active && slot.data.visible && a) {
      if (a instanceof ClippingAttachment && !clip) {
        let polygon = new Array<number>(a.worldVerticesLength); a.computeWorldVertices(skeleton, slot, 0, polygon.length, polygon, 0, 2);
        if (a.convex || a.inverse) polygon = hull(polygon);
        if (!polygon.every(Number.isFinite)) throw new Error('Nonfinite clipping geometry in visibility audit.');
        clip = { polygon, inverse: a.inverse, end: a.endSlot?.index ?? null }; budget.vertices += polygon.length / 2;
      } else if (a instanceof MeshAttachment || a instanceof RegionAttachment) {
        const vertices = new Array<number>(a instanceof MeshAttachment ? a.worldVerticesLength : 8), sequence = a.sequence.resolveIndex(slot.appliedPose);
        if (a instanceof MeshAttachment) a.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2); else a.computeWorldVertices(slot, a.getOffsets(slot.appliedPose), vertices, 0, 2);
        if (!vertices.every(Number.isFinite)) throw new Error('Nonfinite artwork geometry in visibility audit.');
        const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < vertices.length; i += 2) { bounds[0] = Math.min(bounds[0], vertices[i]!); bounds[1] = Math.min(bounds[1], vertices[i + 1]!); bounds[2] = Math.max(bounds[2], vertices[i]!); bounds[3] = Math.max(bounds[3], vertices[i + 1]!); }
        layers.push({ index: slot.data.index, vertices, uvs: a instanceof MeshAttachment ? a.sequence.getUVs(sequence) : [0, 1, 0, 0, 1, 0, 1, 1], triangles: a instanceof MeshAttachment ? a.triangles : [0, 1, 2, 0, 2, 3], opacity: slot.appliedPose.color.a * a.color.a * skeleton.color.a, normal: slot.data.blendMode === 0, image: a.sequence.getPath(a.path ?? a.name, sequence), clip, bounds });
        budget.vertices += vertices.length / 2;
      }
    }
    if (clip?.end === slot.data.index) clip = null;
    if (budget.vertices > 8_000_000) throw new Error('Visibility audit exceeds eight million vertex visits.');
  }
  const frame = { async hiddenReason(slotIndex: number, point: Point): Promise<'clipped' | 'occluded' | null> {
    const index = layers.findIndex(layer => layer.index === slotIndex); if (index < 0) return null;
    if (!visibleAt(point, layers[index]!.clip)) return 'clipped';
    for (const layer of layers.slice(index + 1)) {
      if (!layer.normal || layer.opacity < 1 - 1e-8 || point[0] < layer.bounds[0] || point[0] > layer.bounds[2] || point[1] < layer.bounds[1] || point[1] > layer.bounds[3] || !visibleAt(point, layer.clip)) continue;
      for (let i = 0; i < layer.triangles.length; i += 3) {
        if (++budget.triangleTests > 2_000_000) throw new Error('Visibility audit exceeds two million triangle point tests.');
        const a = layer.triangles[i]!, b = layer.triangles[i + 1]!, c = layer.triangles[i + 2]!, p = layer.vertices, uv = layer.uvs;
        const ax = p[a * 2]!, ay = p[a * 2 + 1]!, bx = p[b * 2]!, by = p[b * 2 + 1]!, cx = p[c * 2]!, cy = p[c * 2 + 1]!, denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(denominator) < 1e-12) continue;
        const l0 = ((by - cy) * (point[0] - cx) + (cx - bx) * (point[1] - cy)) / denominator, l1 = ((cy - ay) * (point[0] - cx) + (ax - cx) * (point[1] - cy)) / denominator, l2 = 1 - l0 - l1;
        if (Math.min(l0, l1, l2) < -1e-9) continue;
        const texture = await load(layer.image), opacity = alpha(texture, l0 * uv[a * 2]! + l1 * uv[b * 2]! + l2 * uv[c * 2]!, l0 * uv[a * 2 + 1]! + l1 * uv[b * 2 + 1]! + l2 * uv[c * 2 + 1]!);
        if (opacity * layer.opacity >= 1 - 1e-8) return 'occluded';
      }
    }
    return null;
  }, async coverage(slotIndex: number, triangleIndex: number, pixelSize: number, threshold: number, maxPixels: number): Promise<PixelCoverage> {
    const layer = layers.find(layer => layer.index === slotIndex); if (!layer) throw new Error('Missing artwork layer for pixel coverage.');
    const ids = [0, 1, 2].map(i => layer.triangles[triangleIndex * 3 + i]!); if (ids.some(i => i === undefined)) throw new Error('Missing coverage triangle.');
    const triangle = ids.flatMap(i => [layer.vertices[i * 2]!, layer.vertices[i * 2 + 1]!]), [ax, ay, bx, by, cx, cy] = triangle as [number, number, number, number, number, number], denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    const result: PixelCoverage = { coveredPixels: 0, alphaPixels: 0, visiblePixels: 0, clippedPixels: 0, occludedPixels: 0, pixelSize, reason: null, triangle, visiblePoints: [] };
    if (Math.abs(denominator) < 1e-12) return result;
    const x0 = Math.floor(Math.min(ax, bx, cx) / pixelSize), x1 = Math.ceil(Math.max(ax, bx, cx) / pixelSize), y0 = Math.floor(Math.min(ay, by, cy) / pixelSize), y1 = Math.ceil(Math.max(ay, by, cy) / pixelSize);
    if (![x0, x1, y0, y1].every(Number.isSafeInteger)) throw new Error('Visibility pixel grid exceeds safe integer precision; increase visibilityPixelSize or recenter the skeleton.');
    if ((x1 - x0) * (y1 - y0) + (budget.pixels ?? 0) > maxPixels) throw new Error('Visibility pixel budget exceeded; increase visibilityPixelSize, shorten the range or increase maxVisibilityPixels within the cap.');
    const texture = threshold ? await load(layer.image) : undefined;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      budget.pixels = (budget.pixels ?? 0) + 1;
      const point: Point = [(x + 0.5) * pixelSize, (y + 0.5) * pixelSize], l0 = ((by - cy) * (point[0] - cx) + (cx - bx) * (point[1] - cy)) / denominator, l1 = ((cy - ay) * (point[0] - cx) + (ax - cx) * (point[1] - cy)) / denominator, l2 = 1 - l0 - l1;
      if (Math.min(l0, l1, l2) < -1e-9) continue;
      result.coveredPixels++;
      if (texture) { const uv = layer.uvs, opacity = alpha(texture, l0 * uv[ids[0]! * 2]! + l1 * uv[ids[1]! * 2]! + l2 * uv[ids[2]! * 2]!, l0 * uv[ids[0]! * 2 + 1]! + l1 * uv[ids[1]! * 2 + 1]! + l2 * uv[ids[2]! * 2 + 1]!); if (opacity * layer.opacity * 255 < threshold) continue; }
      result.alphaPixels++;
      const reason = await frame.hiddenReason(slotIndex, point);
      if (reason === 'clipped') result.clippedPixels++; else if (reason === 'occluded') result.occludedPixels++; else { result.visiblePixels++; if (result.visiblePoints.length < 32) result.visiblePoints.push(point); }
    }
    if (result.coveredPixels && !result.alphaPixels) result.reason = 'transparent';
    else if (result.alphaPixels && !result.visiblePixels) result.reason = result.occludedPixels ? 'occluded' : 'clipped';
    // No covered pixel is unresolved subpixel geometry: keep the finding.
    return result;
  } };
  return frame;
}
