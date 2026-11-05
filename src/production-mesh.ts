import path from 'node:path';
import earcut, { deviation } from 'earcut';
import { Resvg } from '@resvg/resvg-js';
import { MeshAttachment, RegionAttachment, Vector2 } from '@esotericsoftware/spine-core';
import type { Workspace } from './config.js';
import { parseDocument, type SpineDocument, type JsonObject } from './document.js';
import { attachmentEntries, attachmentTracks, sourceMesh, vertexLayout } from './attachment-data.js';
import { setAttachment, setWeights, type Influence } from './geometry-edits.js';
import { inspectMesh, transformMesh } from './mesh-edits.js';
import { imagesRoot, readPngAsset } from './image-assets.js';
import { sampleSkeleton } from './runtime.js';
import type { AttachmentRef } from './attachment-reuse.js';
import { compileFolderDrawOrder } from './draw-order-compilation.js';
import { decodeDrawOrder } from './animation-data.js';
import { setDrawOrder } from './animation-edits.js';
import { surfaceSampler } from './surface-sampling.js';
import { retopologizeSurface } from './surface-retopology.js';

type Point = [number, number];
const area = (ring: Point[]) => ring.reduce((sum, a, index) => { const b = ring[(index + 1) % ring.length]!; return sum + a[0] * b[1] - a[1] * b[0]; }, 0) / 2;
function inside(point: Point, ring: Point[]) { let result = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i]!, b = ring[j]!; if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result; } return result; }
export function alphaContours(width: number, height: number, rgba: Uint8Array, threshold = 1) {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255 || width * height > 16777216 || rgba.length !== width * height * 4) throw new Error('Invalid alpha raster or threshold.');
  type Edge = { a: Point; b: Point; direction: number; used?: boolean };
  const edges: Edge[] = [], from = new Map<string, Edge[]>(), solid = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && rgba[(y * width + x) * 4 + 3]! >= threshold;
  const add = (a: Point, b: Point, direction: number) => { const edge = { a, b, direction }; edges.push(edge); const key = a.join(','), list = from.get(key) ?? []; list.push(edge); from.set(key, list); if (edges.length > 1000000) throw new Error('Alpha boundary exceeds one million pixel edges.'); };
  let pixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (solid(x, y)) { pixels++; if (!solid(x, y - 1)) add([x, y], [x + 1, y], 0); if (!solid(x + 1, y)) add([x + 1, y], [x + 1, y + 1], 1); if (!solid(x, y + 1)) add([x + 1, y + 1], [x, y + 1], 2); if (!solid(x - 1, y)) add([x, y + 1], [x, y], 3); }
  if (!pixels) throw new Error('No opaque pixels meet the threshold.');
  const rings: Point[][] = [];
  for (const first of edges) if (!first.used) {
    const ring: Point[] = []; let edge = first;
    for (;;) {
      edge.used = true; ring.push(edge.a); if (edge.b[0] === first.a[0] && edge.b[1] === first.a[1]) break;
      const candidates = (from.get(edge.b.join(',')) ?? []).filter(next => !next.used), priority = [1, 0, 3, 2]; candidates.sort((a, b) => priority.indexOf((a.direction - edge.direction + 4) % 4) - priority.indexOf((b.direction - edge.direction + 4) % 4));
      if (!candidates.length) throw new Error('Could not close alpha boundary.'); edge = candidates[0]!;
    }
    const simple = ring.filter((b, i) => { const a = ring[(i + ring.length - 1) % ring.length]!, c = ring[(i + 1) % ring.length]!; return (b[0] - a[0]) * (c[1] - b[1]) !== (b[1] - a[1]) * (c[0] - b[0]); });
    if (simple.length >= 3) rings.push(simple);
  }
  if (rings.reduce((n, ring) => n + ring.length, 0) > 10000) throw new Error('Exact contours exceed 10,000 vertices. Reduce the source image resolution or simplify its alpha.');
  const components = rings.filter(ring => area(ring) > 0).map(outer => ({ outer, holes: [] as Point[][] }));
  for (const hole of rings.filter(ring => area(ring) < 0)) { const parent = components.filter(component => inside(hole[0]!, component.outer)).sort((a, b) => area(a.outer) - area(b.outer))[0]; if (!parent) throw new Error('Alpha hole has no containing contour.'); parent.holes.push(hole); }
  const vertices: number[] = [], triangles: number[] = [];
  for (const component of components) { const flat = [component.outer, ...component.holes].flat().flat(), holes: number[] = []; let count = component.outer.length; for (const ring of component.holes) { holes.push(count); count += ring.length; } const indices = earcut(flat, holes); if (deviation(flat, holes, 2, indices) > 1e-8) throw new Error('Contour triangulation failed the area check.'); const offset = vertices.length / 2; vertices.push(...flat); triangles.push(...indices.map(index => index + offset)); }
  return { pixels, components, vertices, triangles, holes: components.reduce((n, component) => n + component.holes.length, 0), area: triangles.reduce((sum, _value, i) => { if (i % 3) return sum; const [a, b, c] = triangles.slice(i, i + 3) as [number, number, number]; return sum + Math.abs((vertices[b * 2]! - vertices[a * 2]!) * (vertices[c * 2 + 1]! - vertices[a * 2 + 1]!) - (vertices[b * 2 + 1]! - vertices[a * 2 + 1]!) * (vertices[c * 2]! - vertices[a * 2]!)) / 2; }, 0) };
}
export async function traceContours(workspace: Workspace, data: SpineDocument, jsonPath: string, ref: AttachmentRef, threshold = 1) {
  const item = attachmentEntries(data).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name);
  if (!item || (item.value.type ?? 'region') !== 'region' || item.value.sequence) throw new Error('Exact alpha contours require a static region attachment.');
  const image = await readPngAsset(workspace, path.resolve(await imagesRoot(workspace, data, jsonPath), `${String(item.value.path ?? item.value.name ?? item.name)}.png`));
  const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><image width="100%" height="100%" href="data:image/png;base64,${image.bytes.toString('base64')}"/></svg>`).render(), outline = alphaContours(image.width, image.height, raster.pixels, threshold);
  const skeleton = sampleSkeleton(data, undefined, 0, ref.skin), slot = skeleton.slots.find(slot => slot.data.name === ref.slot)!, region = skeleton.data.findSkin(ref.skin)?.getAttachment(slot.data.index, ref.name);
  if (!(region instanceof RegionAttachment) || !slot.bone.active) throw new Error('Source region is not active.'); const corners = region.getOffsets(slot.appliedPose), uvs = outline.vertices.map((value, i) => value / (i % 2 ? image.height : image.width)), vertices: number[] = [];
  for (let i = 0; i < uvs.length; i += 2) { const u = uvs[i]!, v = uvs[i + 1]!; vertices.push((1 - v) * (corners[2]! + u * (corners[4]! - corners[2]!)) + v * (corners[0]! + u * (corners[6]! - corners[0]!)), (1 - v) * (corners[3]! + u * (corners[5]! - corners[3]!)) + v * (corners[1]! + u * (corners[7]! - corners[1]!))); }
  return { ...outline, width: image.width, height: image.height, uvs, localVertices: vertices, image: image.path, threshold };
}
export async function meshFromContours(workspace: Workspace, data: SpineDocument, jsonPath: string, ref: AttachmentRef, threshold = 1, representation: 'compound' | 'single-mesh' = 'compound') {
  const outline = await traceContours(workspace, data, jsonPath, ref, threshold), original = attachmentEntries(data).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name)!.value;
  const mesh: JsonObject = { ...original, type: 'mesh', path: original.path ?? original.name ?? ref.name, width: outline.width, height: outline.height, uvs: outline.uvs, vertices: outline.localVertices, triangles: outline.triangles, hull: outline.components[0]!.outer.length };
  for (const field of ['x', 'y', 'rotation', 'scaleX', 'scaleY']) delete mesh[field];
  const edges = new Set<string>(); for (let i = 0; i < outline.triangles.length; i += 3) { const t = outline.triangles.slice(i, i + 3); for (let j = 0; j < 3; j++) edges.add([t[j]!, t[(j + 1) % 3]!].sort((a, b) => a - b).join(',')); } mesh.edges = [...edges].flatMap(edge => edge.split(',').map(index => Number(index) * 2));
  if (representation === 'single-mesh' || outline.components.length === 1 && !outline.holes) return setAttachment(data, ref.skin, ref.slot, ref.name, mesh, true);
  // The editor reconstructs a single outer mesh hull on import. Represent
  // holes/islands as a compound of ordinary hull meshes for native round-trips.
  const source = compileFolderDrawOrder(data), output = structuredClone(source), sourceSlot = output.slots!.find(slot => slot.name === ref.slot)!, added: string[] = [], pieces: number[][] = [], pieceNames: string[] = [ref.name];
  for (let i = 0; i < outline.triangles.length; i += 3) pieces.push(outline.triangles.slice(i, i + 3));
  if (pieces.length > 500) throw new Error('Native compound contour exceeds 500 pieces. Reduce source alpha complexity, or use representation=single-mesh for runtime-only JSON.');
  for (let i = 1; i < pieces.length; i++) { const slotName = `${ref.slot.slice(0, 150)}~${ref.name.slice(0, 70)}~${i}`; if (output.slots!.some(slot => slot.name === slotName)) throw new Error('Compound mesh slot name collision.'); added.push(slotName); pieceNames.push(`${ref.name.slice(0, 220)}~piece-${i}`); }
  const sourceIndex = output.slots!.findIndex(slot => slot.name === ref.slot); output.slots!.splice(sourceIndex + 1, 0, ...added.map((name, index) => ({ ...sourceSlot, name, ...(sourceSlot.attachment === ref.name ? { attachment: pieceNames[index + 1]! } : { attachment: undefined }) })));
  const skin = (output.skins as JsonObject[]).find(skin => skin.name === ref.skin)!, slots = skin.attachments as Record<string, Record<string, JsonObject>>;
  for (let i = 0; i < pieces.length; i++) { const indices = pieces[i]!, slot = i ? added[i - 1]! : ref.slot, placeholder = pieceNames[i]!; slots[slot] ??= {}; slots[slot]![placeholder] = { ...mesh, name: i ? ref.skin === 'default' ? placeholder : `${String(original.name ?? ref.name)}~piece-${i}` : original.name ?? ref.name, vertices: indices.flatMap(index => outline.localVertices.slice(index * 2, index * 2 + 2)), uvs: indices.flatMap(index => outline.uvs.slice(index * 2, index * 2 + 2)), triangles: [0, 1, 2], hull: 3, edges: [0, 2, 2, 4, 4, 0] }; }
  for (const item of attachmentEntries(output)) if (item.value.type === 'clipping' && item.value.end === ref.slot) item.value.end = added.at(-1) ?? ref.slot;
  for (const [name, animation] of Object.entries(output.animations ?? {})) {
    const channels = animation.slots as Record<string, Record<string, unknown>> | undefined, originalChannels = channels?.[ref.slot];
    if (originalChannels) for (const [index, slot] of added.entries()) { const copy = structuredClone(originalChannels); if (Array.isArray(copy.attachment)) copy.attachment = (copy.attachment as JsonObject[]).map(key => ({ time: key.time ?? 0, ...(key.name === ref.name ? { name: pieceNames[index + 1] } : {}) })); channels![slot] = copy; }
    if (Array.isArray(animation.drawOrder)) {
      const keys = (animation.drawOrder as JsonObject[]).map(key => ({ time: Number(key.time ?? 0), order: decodeDrawOrder(source, key).flatMap(slot => slot === ref.slot ? [slot, ...added] : [slot]) }));
      delete animation.drawOrder; const revised = setDrawOrder(output, name, keys); output.animations![name] = revised.animations![name]!;
    }
  }
  return parseDocument(output);
}
export function editMeshVertices(source: SpineDocument, ref: AttachmentRef, changes: { index: number; x?: number; y?: number; u?: number; v?: number }[]) {
  const selected = attachmentEntries(source).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name); if (!selected || selected.value.source !== undefined) throw new Error('Vertex editing requires a source mesh; unlink first.');
  if (new Set(changes.map(change => change.index)).size !== changes.length) throw new Error('Vertex indices must be distinct.');
  const data = structuredClone(source), mesh = sourceMesh(data, ref.skin, ref.slot, ref.name), layout = vertexLayout(data, mesh), raw = mesh.vertices as number[], uvs = mesh.uvs as number[], offsets: number[] = []; let cursor = 0;
  for (let i = 0; i < layout.count; i++) { offsets.push(cursor); cursor += layout.weighted ? 1 + raw[cursor]! * 4 : 2; }
  const positions = changes.some(change => change.x !== undefined || change.y !== undefined), skeleton = layout.weighted && positions ? sampleSkeleton(source, undefined, 0, ref.skin) : undefined, slot = skeleton?.slots.find(slot => slot.data.name === ref.slot), runtime = slot ? skeleton!.data.findSkin(ref.skin)?.getAttachment(slot.data.index, ref.name) : undefined, world = new Array<number>(layout.count * 2);
  if (skeleton) { if (!slot?.bone.active || !(runtime instanceof MeshAttachment)) throw new Error('Weighted vertex editing requires an active source mesh.'); runtime.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2); }
  for (const change of changes) {
    if (!Number.isInteger(change.index) || change.index < 0 || change.index >= layout.count || [change.x, change.y, change.u, change.v].some(n => n !== undefined && !Number.isFinite(n))) throw new Error('Vertex edit requires valid indices and finite values.');
    if ([change.u, change.v].some(n => n !== undefined && (n < 0 || n > 1))) throw new Error('UV values must be within 0–1.');
    const offset = offsets[change.index]!;
    if (change.x !== undefined || change.y !== undefined) {
      if (!layout.weighted) { raw[offset] = change.x ?? raw[offset]!; raw[offset + 1] = change.y ?? raw[offset + 1]!; }
      else { const pose = slot!.bone.appliedPose; if (Math.abs(pose.a * pose.d - pose.b * pose.c) < 1e-12) throw new Error('Slot transform is singular.'); const local = pose.worldToLocal(new Vector2(world[change.index * 2]!, world[change.index * 2 + 1]!)), dx = (change.x ?? local.x) - local.x, dy = (change.y ?? local.y) - local.y, wx = pose.a * dx + pose.b * dy, wy = pose.c * dx + pose.d * dy;
        for (let i = 0; i < raw[offset]!; i++) { const index = offset + 1 + i * 4, bone = skeleton!.bones[raw[index]!]!, p = bone.appliedPose, det = p.a * p.d - p.b * p.c; if (!bone.active || Math.abs(det) < 1e-12) throw new Error('Weighted influence bone is inactive or singular.'); raw[index + 1] = raw[index + 1]! + (p.d * wx - p.b * wy) / det; raw[index + 2] = raw[index + 2]! + (-p.c * wx + p.a * wy) / det; }
      }
    }
    uvs[change.index * 2] = change.u ?? uvs[change.index * 2]!; uvs[change.index * 2 + 1] = change.v ?? uvs[change.index * 2 + 1]!;
  }
  return parseDocument(data);
}
export function replaceMeshTopology(source: SpineDocument, ref: AttachmentRef, mesh: { vertices: number[]; uvs: number[]; triangles: number[]; hull: number }, deformPolicy: 'reject' | 'clear' | 'interpolate') {
  if (deformPolicy === 'interpolate') return retopologizeSurface(source, ref, mesh);
  const data = structuredClone(source), item = attachmentEntries(data).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name); if (!item || item.value.source !== undefined) throw new Error('Retopology requires a source mesh.');
  for (const animation of Object.values(data.animations ?? {})) for (const track of attachmentTracks(data, animation)) if (track.channel === 'deform' && sourceMesh(data, track.skin, track.slot, track.name) === item.value) { if (deformPolicy !== 'clear') throw new Error('Retopology requires explicit deformPolicy=clear when deform tracks exist.'); track.frames.length = 0; }
  Object.assign(item.value, mesh); delete item.value.edges; return parseDocument(data);
}
function meshSamples(data: SpineDocument, ref: AttachmentRef) {
  const skeleton = sampleSkeleton(data, undefined, 0, ref.skin), slot = skeleton.slots.find(slot => slot.data.name === ref.slot)!, attachment = skeleton.data.findSkin(ref.skin)?.getAttachment(slot.data.index, ref.name);
  if (!(attachment instanceof MeshAttachment) || !slot.bone.active) throw new Error('Weight transfer requires an active mesh.'); const mesh = sourceMesh(data, ref.skin, ref.slot, ref.name), layout = vertexLayout(data, mesh), positions = new Array<number>(layout.count * 2); attachment.computeWorldVertices(skeleton, slot, 0, positions.length, positions, 0, 2);
  const weights: Influence[][] = []; let cursor = 0; const raw = mesh.vertices as number[];
  for (let i = 0; i < layout.count; i++) { const n = layout.weighted ? raw[cursor++]! : 1, list: Influence[] = []; for (let j = 0; j < n; j++) { if (layout.weighted) { list.push({ bone: data.bones[raw[cursor]!]!.name, weight: raw[cursor + 3]! }); cursor += 4; } else { list.push({ bone: slot.bone.data.name, weight: 1 }); cursor += 2; } } weights.push(list); }
  const activeBones = new Set(skeleton.bones.filter(bone => bone.active).map(bone => bone.data.name));
  if (positions.some(n => !Number.isFinite(n)) || weights.some(row => row.some(item => !activeBones.has(item.bone)))) throw new Error('Weight transfer requires finite setup positions and active influence bones.');
  return { positions, weights, skeleton, slot, mesh };
}
export function transferWeights(source: SpineDocument, from: AttachmentRef, to: AttachmentRef, options: { method?: 'nearest-vertex' | 'surface'; maxDistance?: number; minWeight?: number; boneMap?: Record<string, string>; mirror?: 'x' | 'y'; lockedBones?: string[]; clearDeform?: boolean }) {
  const origin = meshSamples(source, from), target = meshSamples(source, to), count = target.positions.length / 2, method = options.method ?? 'nearest-vertex';
  if (!['nearest-vertex', 'surface'].includes(method) || options.maxDistance !== undefined && (!Number.isFinite(options.maxDistance) || options.maxDistance < 0)) throw new Error('Weight transfer requires a valid method and nonnegative maxDistance.');
  const minWeight = options.minWeight ?? 0; if (!Number.isFinite(minWeight) || minWeight < 0 || minWeight > 1) throw new Error('minWeight must be between zero and one; zero preserves every positive weight.');
  if (new Set(options.lockedBones).size !== (options.lockedBones?.length ?? 0) || options.lockedBones?.some(name => !source.bones.some(bone => bone.name === name))) throw new Error('Locked bones must be distinct existing bone names.');
  if (options.boneMap && Object.entries(options.boneMap).some(([from, to]) => !source.bones.some(bone => bone.name === from) || !source.bones.some(bone => bone.name === to))) throw new Error('Bone map must reference existing bones.');
  const surface = method === 'surface' ? surfaceSampler(origin.positions, origin.mesh.triangles as number[], count) : undefined;
  if (!surface && count * origin.weights.length > 5000000) throw new Error('Weight transfer exceeds five million vertex comparisons.');
  const pose = target.slot.bone.appliedPose; if (options.mirror && Math.abs(pose.a * pose.d - pose.b * pose.c) < 1e-12) throw new Error('Weight mirroring requires a nonsingular slot transform.');
  const weights: Influence[][] = [];
  for (let i = 0; i < count; i++) {
    const point = new Vector2(target.positions[i * 2]!, target.positions[i * 2 + 1]!);
    if (options.mirror) { pose.worldToLocal(point); if (options.mirror === 'x') point.x *= -1; else point.y *= -1; pose.localToWorld(point); }
    let samples: Influence[], distance: number;
    if (surface) { const sample = surface.locate(point.x, point.y); distance = sample.distance; samples = sample.vertices.flatMap((index, corner) => origin.weights[index]!.map(item => ({ bone: item.bone, weight: item.weight * sample.factors[corner]! }))); }
    else { let nearest = 0; distance = Infinity; for (let j = 0; j < origin.weights.length; j++) { const d = Math.hypot(origin.positions[j * 2]! - point.x, origin.positions[j * 2 + 1]! - point.y); if (d < distance) { distance = d; nearest = j; } } samples = origin.weights[nearest]!; }
    if (options.maxDistance !== undefined && distance > options.maxDistance) throw new Error(`Weight transfer vertex ${i} is ${distance} world units from the source; exceeds maxDistance=${options.maxDistance}.`);
    const locked = target.weights[i]!.filter(item => options.lockedBones?.includes(item.bone)), available = Math.max(0, 1 - locked.reduce((sum, item) => sum + item.weight, 0)), map = new Map<string, number>();
    for (const item of samples) { const bone = options.boneMap?.[item.bone] ?? item.bone; if (!options.lockedBones?.includes(bone)) map.set(bone, (map.get(bone) ?? 0) + item.weight); }
    const total = [...map.values()].reduce((a, b) => a + b, 0); if (available > 0 && !total) throw new Error('Locked influences leave no transferable weight.');
    const transferable = [...map].filter(([, weight]) => weight > 0 && available > 0 && weight / total * available >= minWeight), retained = transferable.reduce((sum, [, weight]) => sum + weight, 0);
    if (available > 0 && !retained) throw new Error('minWeight removes every transferable influence; lower the explicit threshold.');
    weights.push([...locked, ...transferable.map(([bone, weight]) => ({ bone, weight: weight / retained * available }))]);
    if (weights[i]!.length > 16) throw new Error(`Weight transfer vertex ${i} needs more than 16 influences; simplify source weights or change boneMap. No weights were discarded.`);
  }
  return setWeights(source, to.skin, to.slot, to.name, weights, options.clearDeform);
}
export function checkMeshIntersections(data: SpineDocument, ref: AttachmentRef) {
  const mesh = sourceMesh(data, ref.skin, ref.slot, ref.name), uv = mesh.uvs as number[], indices = mesh.triangles as number[], count = indices.length / 3;
  if (count > 3000) throw new Error('Intersection inspection is limited to 3000 triangles.'); const intersections: [number, number][] = [];
  const point = (index: number): Point => [uv[index * 2]!, uv[index * 2 + 1]!], cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const strictInside = (p: Point, tri: Point[]) => { const signs = tri.map((a, i) => cross(a, tri[(i + 1) % 3]!, p)); return signs.every(n => n > 1e-10) || signs.every(n => n < -1e-10); };
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) { const ia = indices.slice(a * 3, a * 3 + 3), ib = indices.slice(b * 3, b * 3 + 3), ta = ia.map(point), tb = ib.map(point); let overlap = ta.some(p => strictInside(p, tb)) || tb.some(p => strictInside(p, ta));
    for (let i = 0; i < 3 && !overlap; i++) for (let j = 0; j < 3 && !overlap; j++) { const p = ta[i]!, q = ta[(i + 1) % 3]!, r = tb[j]!, s = tb[(j + 1) % 3]!; overlap = cross(p, q, r) * cross(p, q, s) < -1e-12 && cross(r, s, p) * cross(r, s, q) < -1e-12; }
    if (overlap || new Set([...ia, ...ib]).size === 3) { intersections.push([a, b]); if (intersections.length >= 5000) return { intersections, truncated: true, space: 'UV' }; }
  }
  return { intersections, truncated: false, space: 'UV' };
}
