import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
import { RegionAttachment, Vector2 } from '@esotericsoftware/spine-core';
import type { Workspace } from './config.js';
import { type SpineDocument, type JsonObject } from './document.js';
import { attachmentEntries } from './attachment-data.js';
import { imagesRoot, readPngAsset } from './image-assets.js';
import { sampleSkeleton } from './runtime.js';
import { setAttachment } from './geometry-edits.js';

type Point = [number, number];
export interface AlphaOptions { alphaThreshold?: number; padding?: number; maxVertices?: number }
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function convexHull(points: Point[]) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (values: Point[]) => {
    const result: Point[] = [];
    for (const point of values) { while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop(); result.push(point); }
    return result.slice(0, -1);
  };
  return [...half(points), ...half(points.toReversed())];
}
function enclosingPolygon(hull: Point[], width: number, height: number, limit: number): Point[] {
  // Intersect supporting half-planes, starting from the image rectangle. This
  // gives a conservative approximation, unlike deleting boundary vertices.
  const sides = Math.max(4, limit - 4);
  let polygon: Point[] = [[0, 0], [width, 0], [width, height], [0, height]];
  for (let side = 0; side < sides; side++) {
    const angle = side * Math.PI * 2 / sides, nx = Math.cos(angle), ny = Math.sin(angle);
    const support = Math.max(...hull.map(([x, y]) => nx * x + ny * y));
    const next: Point[] = [];
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!, da = nx * a[0] + ny * a[1] - support, db = nx * b[0] + ny * b[1] - support;
      if (da <= 1e-9) next.push(a);
      if ((da <= 1e-9) !== (db <= 1e-9)) {
        const t = da / (da - db); next.push([Math.max(0, Math.min(width, a[0] + t * (b[0] - a[0]))), Math.max(0, Math.min(height, a[1] + t * (b[1] - a[1])))]);
      }
    }
    polygon = next;
  }
  // Remove numerically repeated points on supporting rectangle edges.
  const cleaned = polygon.filter((point, index) => Math.hypot(point[0] - polygon[(index + polygon.length - 1) % polygon.length]![0], point[1] - polygon[(index + polygon.length - 1) % polygon.length]![1]) > 1e-8);
  if (cleaned.length < 3 || cleaned.length > limit) throw new Error('Could not construct a bounded alpha hull. Increase maxVertices.');
  return cleaned;
}
export function alphaHull(width: number, height: number, rgba: Uint8Array, options: AlphaOptions = {}) {
  const alphaThreshold = options.alphaThreshold ?? 1, padding = options.padding ?? 1, maxVertices = options.maxVertices ?? 64;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216 || rgba.length !== width * height * 4) throw new Error('Alpha analysis requires a valid RGBA raster within the PNG size limits.');
  if (!Number.isInteger(alphaThreshold) || alphaThreshold < 1 || alphaThreshold > 255 || !Number.isFinite(padding) || padding < 0 || padding > 64 || !Number.isInteger(maxVertices) || maxVertices < 4 || maxVertices > 512) throw new Error('alphaThreshold must be 1–255, padding 0–64 pixels, maxVertices 4–512.');
  const points: Point[] = []; let alphaPixels = 0, minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    let left = width, right = -1;
    for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3]! >= alphaThreshold) { left = Math.min(left, x); right = x; alphaPixels++; }
    if (right < 0) continue;
    minX = Math.min(minX, left); minY = Math.min(minY, y); maxX = Math.max(maxX, right + 1); maxY = y + 1;
    const x0 = Math.max(0, left - padding), x1 = Math.min(width, right + 1 + padding), y0 = Math.max(0, y - padding), y1 = Math.min(height, y + 1 + padding);
    points.push([x0, y0], [x1, y0], [x1, y1], [x0, y1]);
  }
  if (!alphaPixels) throw new Error('No PNG pixels meet alphaThreshold; no geometry was generated.');
  const exact = convexHull(points), hull = exact.length > maxVertices ? enclosingPolygon(exact, width, height, maxVertices) : exact;
  return { width, height, alphaThreshold, padding, maxVertices, alphaPixels, alphaFraction: alphaPixels / (width * height), alphaBounds: { minX, minY, maxX, maxY }, exactHullVertices: exact.length, approximated: exact.length > maxVertices, hull: hull.flat(), uvs: hull.flatMap(([x, y]) => [x / width, y / height]) };
}

export async function traceRegion(workspace: Workspace, source: SpineDocument, jsonPath: string, skin: string, slotName: string, name: string, options: AlphaOptions = {}) {
  const entry = attachmentEntries(source).find(item => item.skin === skin && item.slot === slotName && item.name === name);
  if (!entry || (entry.value.type ?? 'region') !== 'region' || entry.value.sequence !== undefined) throw new Error('Alpha tracing requires an existing static region attachment.');
  const root = await imagesRoot(workspace, source, jsonPath), image = path.resolve(root, `${String(entry.value.path ?? entry.value.name ?? name)}.png`), relative = path.relative(root, image);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Alpha image must stay inside skeleton.images.');
  const canonicalRelative = path.relative(await realpath(root), await realpath(await workspace.resolve(image)));
  if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) throw new Error('Alpha image link points outside skeleton.images.');
  const asset = await readPngAsset(workspace, image);
  const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}"><image width="100%" height="100%" preserveAspectRatio="none" href="data:image/png;base64,${asset.bytes.toString('base64')}"/></svg>`).render();
  const outline = alphaHull(asset.width, asset.height, raster.pixels, options);
  const skeleton = sampleSkeleton(source, undefined, 0, skin), slot = skeleton.slots.find(item => item.data.name === slotName)!;
  const region = skeleton.data.findSkin(skin)?.getAttachment(slot.data.index, name);
  if (!(region instanceof RegionAttachment) || !slot.bone.active) throw new Error('Runtime could not load an active source region. Select the skin that activates its bone.');
  const corners = region.getOffsets(slot.appliedPose), vertices: number[] = [], worldVertices: number[] = [];
  if (Math.abs((corners[4]! - corners[2]!) * (corners[1]! - corners[3]!) - (corners[5]! - corners[3]!) * (corners[0]! - corners[2]!)) < 1e-12) throw new Error('Cannot trace a region with zero display area.');
  for (let index = 0; index < outline.uvs.length; index += 2) {
    const u = outline.uvs[index]!, v = outline.uvs[index + 1]!;
    const x = (1 - v) * (corners[2]! + u * (corners[4]! - corners[2]!)) + v * (corners[0]! + u * (corners[6]! - corners[0]!));
    const y = (1 - v) * (corners[3]! + u * (corners[5]! - corners[3]!)) + v * (corners[1]! + u * (corners[7]! - corners[1]!));
    vertices.push(x, y); const world = slot.bone.appliedPose.localToWorld(new Vector2(x, y)); worldVertices.push(world.x, world.y);
  }
  if (![...vertices, ...worldVertices].every(Number.isFinite)) throw new Error('Alpha hull has non-finite setup coordinates.');
  return { image: asset.path, skin, slot: slotName, name, ...outline, vertexCount: vertices.length / 2, localVertices: vertices, worldVertices, shape: 'convex' as const, note: 'Convex envelope includes concavities, holes and separated islands. PNG transparency remains unchanged. Thresholded-out pixels may be outside the generated geometry; padding is in source pixels and clipped to image bounds.' };
}

export async function meshFromAlpha(workspace: Workspace, source: SpineDocument, jsonPath: string, skin: string, slot: string, name: string, options: AlphaOptions = {}) {
  const trace = await traceRegion(workspace, source, jsonPath, skin, slot, name, options), entry = attachmentEntries(source).find(item => item.skin === skin && item.slot === slot && item.name === name)!;
  const vertices = [...trace.localVertices], uvs = [...trace.uvs], count = trace.vertexCount, triangles: number[] = [];
  for (let axis = 0; axis < 2; axis++) { vertices.push(trace.localVertices.filter((_value, index) => index % 2 === axis).reduce((sum, value) => sum + value, 0) / count); uvs.push(trace.uvs.filter((_value, index) => index % 2 === axis).reduce((sum, value) => sum + value, 0) / count); }
  for (let index = 0; index < count; index++) triangles.push(index, (index + 1) % count, count);
  const mesh: JsonObject = { ...entry.value, type: 'mesh', path: entry.value.path ?? entry.value.name ?? name, width: trace.width, height: trace.height, uvs, vertices, triangles, hull: count };
  for (const field of ['x', 'y', 'rotation', 'scaleX', 'scaleY']) delete mesh[field];
  return setAttachment(source, skin, slot, name, mesh, true);
}

export interface PolygonOptions extends AlphaOptions { targetSlot: string; targetName: string; kind: 'boundingbox' | 'clipping'; endSlot?: string; replace?: boolean; setAsSetup?: boolean }
export async function polygonFromRegion(workspace: Workspace, source: SpineDocument, jsonPath: string, skin: string, slot: string, name: string, options: PolygonOptions) {
  if (options.kind !== 'boundingbox' && options.kind !== 'clipping') throw new Error('Polygon kind must be boundingbox or clipping.');
  if (options.endSlot !== undefined && (options.kind !== 'clipping' || !source.slots?.some(item => item.name === options.endSlot))) throw new Error('endSlot is only valid for clipping and must reference an existing slot.');
  const setAsSetup = options.setAsSetup ?? true;
  if (options.targetSlot === slot && setAsSetup) throw new Error('Use a separate targetSlot or setAsSetup=false to keep the source image in its setup slot.');
  if (options.kind === 'clipping' && setAsSetup) {
    const order = (source.slots ?? []).map(item => item.name);
    if (order.indexOf(options.targetSlot) < 0 || order.indexOf(options.targetSlot) >= order.indexOf(slot) || (options.endSlot !== undefined && order.indexOf(options.endSlot) < order.indexOf(slot))) throw new Error('Active clipping must start before the source slot and end at or after it in setup draw order. Use set_slot_order first.');
  }
  const trace = await traceRegion(workspace, source, jsonPath, skin, slot, name, options), skeleton = sampleSkeleton(source, undefined, 0, skin), target = skeleton.slots.find(item => item.data.name === options.targetSlot);
  if (!target || !target.bone.active) throw new Error('Polygon target slot must exist and its bone must be active in the selected skin.');
  const pose = target.bone.appliedPose;
  if (Math.abs(pose.a * pose.d - pose.b * pose.c) < 1e-12) throw new Error('Polygon target bone has a singular setup transform.');
  const vertices: number[] = [];
  for (let index = 0; index < trace.worldVertices.length; index += 2) { const point = pose.worldToLocal(new Vector2(trace.worldVertices[index]!, trace.worldVertices[index + 1]!)); vertices.push(point.x, point.y); }
  const attachment: JsonObject = { type: options.kind, vertexCount: trace.vertexCount, vertices, ...(options.kind === 'clipping' ? { convex: true, ...(options.endSlot ? { end: options.endSlot } : {}) } : {}) };
  return setAttachment(source, skin, options.targetSlot, options.targetName, attachment, options.replace, setAsSetup);
}
