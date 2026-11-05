import path from 'node:path';
import { z } from 'zod/v4';
import { Resvg } from '@resvg/resvg-js';
import { Vector2 } from '@esotericsoftware/spine-core';
import type { SpineService } from './service.js';
import { sampleArtwork, type RegionSample } from './scene-preview.js';
import { sampleSkeleton } from './runtime.js';
import { readPngAsset } from './image-assets.js';
import { addBone, type SpineDocument } from './document.js';
import { fileSha256 } from './file-hash.js';
import { auditAssets, assertSnapshot, saveReport } from './production-assets.js';
import { characterSchema } from './stability-schema.js';

const finite = z.number().finite(), name = z.string().min(1).max(256);
const pointSchema = z.object({ x: finite, y: finite }).strict();
const layerSchema = z.object({ slot: name, attachment: name.optional() }).strict();
const base = { input: z.string().min(1), skeletonName: name.optional(), skin: name.optional() };
export const layerAuditSchema = z.object({ ...base, layers: z.array(layerSchema).min(1).max(64).optional(), alphaThreshold: z.number().int().min(1).max(255).default(128), seams: z.array(z.object({ name, a: layerSchema, b: layerSchema, point: pointSchema.optional(), radius: finite.positive().max(10000), minOverlapFraction: finite.min(0).max(1).default(0.2), minUnionFraction: finite.min(0).max(1).default(0.85) }).strict()).max(100).default([]), samplesPerAxis: z.number().int().min(5).max(65).refine(n => n % 2 === 1, 'Use an odd sample count.').default(17) }).strict();
export const rigSuggestionSchema = z.object({ ...base, output: z.string().min(1), chains: z.array(z.object({ namePrefix: name, parent: name, layers: z.array(layerSchema).min(1).max(8), points: z.array(pointSchema).min(2).max(9).optional() }).strict()).min(1).max(20), alphaThreshold: z.number().int().min(1).max(255).default(128), columns: z.number().int().min(1).max(32).default(4), rows: z.number().int().min(1).max(64).default(12), minWeight: finite.min(0).max(1).default(0.00001) }).strict();
type Point = { x: number; y: number };
type LayerRef = z.infer<typeof layerSchema>;
interface Texture { width: number; height: number; pixels: Uint8Array }
interface Layer {
  sample: RegionSample; texture: Texture; image: string; alphaPixels: number; alphaFraction: number;
  pixelBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  worldBounds: { minX: number; minY: number; maxX: number; maxY: number };
  centroid: Point | null; principalAxis: [Point, Point] | null;
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const uvForRegion = [0, 1, 0, 0, 1, 0, 1, 1], regionTriangles = [0, 1, 2, 0, 2, 3];
function barycentric(x: number, y: number, p: ArrayLike<number>, a: number, b: number, c: number) {
  const ax = p[a * 2]!, ay = p[a * 2 + 1]!, bx = p[b * 2]!, by = p[b * 2 + 1]!, cx = p[c * 2]!, cy = p[c * 2 + 1]!;
  const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(det) < 1e-12) return null;
  const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det, v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det, w = 1 - u - v;
  return Math.min(u, v, w) >= -1e-9 ? [u, v, w] as const : null;
}
function worldFromUv(sample: RegionSample, u: number, v: number): Point | null {
  const uv = sample.uvs ?? uvForRegion, triangles = sample.triangles ?? regionTriangles, vertices = sample.vertices!;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i]!, b = triangles[i + 1]!, c = triangles[i + 2]!, weights = barycentric(u, v, uv, a, b, c);
    if (weights) return { x: weights[0] * vertices[a * 2]! + weights[1] * vertices[b * 2]! + weights[2] * vertices[c * 2]!, y: weights[0] * vertices[a * 2 + 1]! + weights[1] * vertices[b * 2 + 1]! + weights[2] * vertices[c * 2 + 1]! };
  }
  return null;
}
export function alphaAt(texture: Texture, u: number, v: number) {
  if (u < -1e-9 || u > 1 + 1e-9 || v < -1e-9 || v > 1 + 1e-9) return 0;
  const x = Math.max(0, Math.min(texture.width - 1, u * texture.width - 0.5)), y = Math.max(0, Math.min(texture.height - 1, v * texture.height - 0.5)), x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(texture.width - 1, x0 + 1), y1 = Math.min(texture.height - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const at = (x: number, y: number) => texture.pixels[(y * texture.width + x) * 4 + 3]!;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}
export function layerAlpha(layer: Pick<Layer, 'sample' | 'texture'>, point: Point, budget: { tests: number }) {
  const p = layer.sample.vertices!, uv = layer.sample.uvs ?? uvForRegion, t = layer.sample.triangles ?? regionTriangles; let result = 0;
  for (let i = 0; i < t.length; i += 3) {
    if (++budget.tests > 2_000_000) throw new Error('Layer analysis exceeds two million triangle tests. Use fewer joints/layers or lower sampling density.');
    const a = t[i]!, b = t[i + 1]!, c = t[i + 2]!, w = barycentric(point.x, point.y, p, a, b, c);
    if (w) result = Math.max(result, alphaAt(layer.texture, w[0] * uv[a * 2]! + w[1] * uv[b * 2]! + w[2] * uv[c * 2]!, w[0] * uv[a * 2 + 1]! + w[1] * uv[b * 2 + 1]! + w[2] * uv[c * 2 + 1]!) * (layer.sample.color?.a ?? 1));
  }
  return result;
}
function measure(sample: RegionSample, texture: Texture, threshold: number): Layer {
  let count = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, minX = texture.width, minY = texture.height, maxX = 0, maxY = 0;
  for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) if (texture.pixels[(y * texture.width + x) * 4 + 3]! >= threshold) {
    const px = x + 0.5, py = y + 0.5; count++; sx += px; sy += py; sxx += px * px; syy += py * py; sxy += px * py; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + 1); maxY = Math.max(maxY, y + 1);
  }
  const vertices = sample.vertices!, xs = vertices.filter((_, i) => i % 2 === 0), ys = vertices.filter((_, i) => i % 2 === 1), worldBounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  let centroid: Point | null = null, principalAxis: [Point, Point] | null = null;
  if (count) {
    const x = sx / count, y = sy / count, a = sxx / count - x * x, d = syy / count - y * y, b = sxy / count - x * y, angle = Math.atan2(2 * b, a - d) / 2, radius = Math.sqrt(Math.max(0, (a + d + Math.hypot(a - d, 2 * b)) / 2)) * Math.sqrt(3);
    centroid = worldFromUv(sample, x / texture.width, y / texture.height);
    const ends = [-1, 1].map(sign => worldFromUv(sample, Math.max(0, Math.min(1, (x + sign * radius * Math.cos(angle)) / texture.width)), Math.max(0, Math.min(1, (y + sign * radius * Math.sin(angle)) / texture.height))));
    if (ends[0] && ends[1]) principalAxis = [ends[0], ends[1]];
  }
  return { sample, texture, image: sample.image!, alphaPixels: count, alphaFraction: count / (texture.width * texture.height), pixelBounds: count ? { minX, minY, maxX, maxY } : null, worldBounds, centroid, principalAxis };
}
const find = (layers: Layer[], ref: LayerRef) => {
  const matches = layers.filter(l => l.sample.slot === ref.slot && (ref.attachment === undefined || l.sample.attachment === ref.attachment));
  if (matches.length !== 1) throw new Error(`Select an active setup-pose region/mesh: ${ref.slot}/${ref.attachment ?? '*'}`); return matches[0]!;
};
function suggestedJoint(a: Layer, b: Layer) {
  if (!a.centroid || !b.centroid) throw new Error('Empty or unmappable layer needs an explicit joint point.');
  const x0 = Math.max(a.worldBounds.minX, b.worldBounds.minX), x1 = Math.min(a.worldBounds.maxX, b.worldBounds.maxX), y0 = Math.max(a.worldBounds.minY, b.worldBounds.minY), y1 = Math.min(a.worldBounds.maxY, b.worldBounds.maxY);
  if (x0 <= x1 && y0 <= y1) return { point: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, basis: 'geometry_bounds_overlap' };
  const closest = (p: Point, l: Layer) => ({ x: Math.max(l.worldBounds.minX, Math.min(l.worldBounds.maxX, p.x)), y: Math.max(l.worldBounds.minY, Math.min(l.worldBounds.maxY, p.y)) });
  return { point: midpoint(closest(b.centroid, a), closest(a.centroid, b)), basis: 'geometry_bounds_gap' };
}
async function loadLayers(service: SpineService, args: { input: string; skeletonName?: string; skin?: string; alphaThreshold: number }, refs?: LayerRef[]) {
  const source = await service.workspace.resolve(args.input), sourceSha256 = await fileSha256(source), loaded = await service.load(source, args.skeletonName), snapshot = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  if (!snapshot.valid) throw new Error('Layer analysis requires all referenced resources.');
  const artwork = await sampleArtwork(service.workspace, loaded.data, loaded.jsonPath, undefined, [0], args.skin), textures = new Map<string, Texture>(), layers: Layer[] = [];
  const active = artwork.frames[0]!.slots.filter(s => s.image && s.vertices && (!refs || refs.some(r => r.slot === s.slot && (r.attachment === undefined || r.attachment === s.attachment))));
  if (active.length > 64) throw new Error('Layer assistance is limited to 64 selected active setup layers.');
  let pixelVisits = 0, triangleVisits = 0;
  for (const sample of active) {
    const asset = [...artwork.assets.values()].find(a => a.path === sample.image)!;
    pixelVisits += asset.width * asset.height; triangleVisits += (sample.triangles ?? regionTriangles).length / 3;
    if (pixelVisits > 64 * 1024 * 1024 || triangleVisits > 200000) throw new Error('Layer analysis exceeds 64 megapixel visits or 200,000 selected triangles; select fewer layers.');
    let texture = textures.get(sample.image!);
    if (!texture) { const asset = await readPngAsset(service.workspace, sample.image!), raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}"><image width="100%" height="100%" href="data:image/png;base64,${asset.bytes.toString('base64')}"/></svg>`).render(); texture = { width: asset.width, height: asset.height, pixels: raster.pixels }; textures.set(sample.image!, texture); }
    layers.push(measure(sample, texture, args.alphaThreshold));
  }
  const verify = async () => { await assertSnapshot(snapshot); if (await fileSha256(source) !== sourceSha256) throw new Error('Source changed during layer assistance.'); };
  return { ...loaded, source, sourceSha256, snapshot, layers, verify };
}
const describe = (l: Layer) => ({ slot: l.sample.slot, attachment: l.sample.attachment, image: l.image, dimensions: [l.texture.width, l.texture.height], alphaPixels: l.alphaPixels, alphaFraction: l.alphaFraction, pixelBounds: l.pixelBounds, worldBounds: l.worldBounds, centroid: l.centroid, principalAxis: l.principalAxis, geometry: l.sample.uvs ? 'mesh' : 'region' });
export async function auditCharacterLayers(service: SpineService, raw: z.input<typeof layerAuditSchema>) {
  const args = layerAuditSchema.parse(raw), refs = args.layers ? [...args.layers, ...args.seams.flatMap(s => [s.a, s.b])] : undefined, loaded = await loadLayers(service, args, refs), selected = args.layers ? args.layers.map(ref => find(loaded.layers, ref)) : loaded.layers, seams = [], findings: { kind: string; layer?: string; seam?: string }[] = [], budget = { tests: 0 }; let samples = 0;
  if (!selected.length) findings.push({ kind: 'no_active_artwork_layers' });
  for (const l of selected) { if (!l.alphaPixels) findings.push({ kind: 'empty_layer', layer: l.sample.slot }); else if (l.alphaFraction < 0.01) findings.push({ kind: 'mostly_transparent_layer', layer: l.sample.slot }); }
  for (const seam of args.seams) {
    const a = find(loaded.layers, seam.a), b = find(loaded.layers, seam.b); if (a === b) throw new Error('A seam requires two different layers.');
    const candidate = seam.point ? { point: seam.point, basis: 'explicit_world_point' } : suggestedJoint(a, b), center = candidate.point; let tested = 0, overlap = 0, union = 0;
    for (let y = 0; y < args.samplesPerAxis; y++) for (let x = 0; x < args.samplesPerAxis; x++) {
      const dx = 2 * x / (args.samplesPerAxis - 1) - 1, dy = 2 * y / (args.samplesPerAxis - 1) - 1; if (dx * dx + dy * dy > 1 + 1e-9) continue;
      if (++samples > 200000) throw new Error('Seam analysis exceeds 200,000 sample points.');
      const p = { x: center.x + dx * seam.radius, y: center.y + dy * seam.radius }, av = layerAlpha(a, p, budget) >= args.alphaThreshold, bv = layerAlpha(b, p, budget) >= args.alphaThreshold; tested++; if (av && bv) overlap++; if (av || bv) union++;
    }
    const overlapFraction = overlap / tested, unionFraction = union / tested, passed = overlapFraction >= seam.minOverlapFraction && unionFraction >= seam.minUnionFraction;
    if (overlapFraction < seam.minOverlapFraction) findings.push({ kind: 'insufficient_joint_overlap', seam: seam.name });
    if (unionFraction < seam.minUnionFraction) findings.push({ kind: 'uncovered_joint_area', seam: seam.name });
    seams.push({ name: seam.name, ...candidate, radius: seam.radius, samples: tested, overlapFraction, unionFraction, uncoveredFraction: 1 - unionFraction, passed, minOverlapFraction: seam.minOverlapFraction, minUnionFraction: seam.minUnionFraction });
  }
  await loaded.verify();
  const report = { source: loaded.source, sourceSha256: loaded.sourceSha256, resourceHashes: loaded.snapshot.files.map(f => ({ path: f.path, sha256: f.sha256 })), layers: selected.map(describe), seams, findings, checksPassed: !findings.length, samples, triangleTests: budget.tests, coverageScope: 'Setup-pose selected raw layer alpha and slot opacity before clipping/occlusion. Circular discrete samples in world units; no motion, anatomy or final visual acceptance inferred.', originalUnchanged: true, visualAcceptance: 'pending' };
  return { ...report, reportPath: await saveReport(service.workspace, 'character-layers', report) };
}
export async function suggestCharacterRig(service: SpineService, raw: z.input<typeof rigSuggestionSchema>) {
  const args = rigSuggestionSchema.parse(raw), loaded = await loadLayers(service, args, args.chains.flatMap(c => c.layers)), output = await service.workspace.resolve(args.output, false);
  if (path.extname(output).toLowerCase() !== '.json') throw new Error('Preparation recipe output must be a NEW JSON path.');
  let candidate: SpineDocument = loaded.data;
  const bones: z.input<typeof characterSchema>['bones'] = [], bindings: z.input<typeof characterSchema>['bindings'] = [], chains = [], used = new Set<string>(), names = new Set(candidate.bones.map(b => b.name));
  for (const chain of args.chains) {
    if (!names.has(chain.parent)) throw new Error(`Parent bone does not exist: ${chain.parent}`);
    const layers = chain.layers.map(ref => find(loaded.layers, ref));
    const keys = layers.map(l => `${l.sample.slot}/${l.sample.attachment}`); if (keys.some(k => used.has(k)) || new Set(keys).size !== keys.length) throw new Error('Each layer can be suggested for only one chain.'); keys.forEach(k => used.add(k));
    let points = chain.points; const basis = points ? 'explicit_world_landmarks' : 'alpha_principal_axes_and_geometry_bounds';
    if (points && points.length !== layers.length + 1) throw new Error('Provide exactly layers.length + 1 world landmark points.');
    if (!points) {
      const joints = layers.slice(1).map((l, i) => suggestedJoint(layers[i]!, l).point), first = layers[0]!.principalAxis, last = layers.at(-1)!.principalAxis;
      if (!first || !last) throw new Error('A layer has no stable alpha axis; provide explicit landmark points.');
      const far = (ends: [Point, Point], p: Point) => distance(ends[0], p) >= distance(ends[1], p) ? ends[0] : ends[1];
      points = layers.length === 1 ? [first[0], first[1]] : [far(first, joints[0]!), ...joints, far(last, joints.at(-1)!)];
    }
    const generated: string[] = [];
    for (let i = 0; i < layers.length; i++) {
      const name = `${chain.namePrefix}_${i + 1}`; if (names.has(name)) throw new Error(`Suggested bone name already exists: ${name}`);
      const parent = generated.at(-1) ?? chain.parent, skeleton = sampleSkeleton(candidate, undefined, 0, args.skin), runtimeParent = skeleton.bones.find(b => b.data.name === parent);
      if (!runtimeParent?.active) throw new Error('Selected parent must be active in the selected skin.');
      const start = runtimeParent.appliedPose.worldToLocal(new Vector2(points[i]!.x, points[i]!.y)), end = runtimeParent.appliedPose.worldToLocal(new Vector2(points[i + 1]!.x, points[i + 1]!.y)), dx = end.x - start.x, dy = end.y - start.y;
      if (![start.x, start.y, dx, dy].every(Number.isFinite) || Math.hypot(dx, dy) < 1e-5) throw new Error('Landmarks form a degenerate bone or singular parent transform.');
      const transform = { x: start.x, y: start.y, rotation: Math.atan2(dy, dx) * 180 / Math.PI, length: Math.hypot(dx, dy) };
      bones.push({ name, parent, transform }); candidate = addBone(candidate, name, parent, transform); generated.push(name); names.add(name);
    }
    for (let i = 0; i < layers.length; i++) bindings.push({ skin: args.skin ?? 'default', slot: layers[i]!.sample.slot, attachment: layers[i]!.sample.attachment!, bones: generated.slice(Math.max(0, i - 1), Math.min(generated.length, i + 2)), columns: args.columns, rows: args.rows, influences: Math.min(2, generated.length), power: 2, minWeight: args.minWeight });
    chains.push({ namePrefix: chain.namePrefix, basis, worldLandmarks: points, bones: generated });
  }
  const recipe = characterSchema.parse({ input: loaded.jsonPath, output, bones, bindings }); await loaded.verify();
  const report = { source: loaded.source, sourceSha256: loaded.sourceSha256, resourceHashes: loaded.snapshot.files.map(f => ({ path: f.path, sha256: f.sha256 })), chains, recipe, invokes: 'spine_prepare_character', projectWritten: false, requiresReview: true, anatomyInference: false, note: 'Geometry candidates are not anatomical joints. Review suggested world landmarks and seam coverage before applying the recipe. Distance weights/grid density are initial suggestions. minWeight explicitly drops tiny influences before native import (default 0.00001); set 0 to retain all positive weights. Preparation rejects incompatible deform/linked data and never modifies source images.' };
  return { ...report, reportPath: await saveReport(service.workspace, 'character-rig-suggestion', report) };
}
