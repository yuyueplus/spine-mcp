import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { attachmentEntries, sourceMesh } from './attachment-data.js';
import { parseDocument, writeDocument, type SpineDocument } from './document.js';
import { collectAssets } from './production-assets.js';
import { readPngAsset } from './image-assets.js';
import { filename, label, request, sha, pin, verifyPins, verifySource, captureSource, immutableJson, jsonRead, operation, copyPinned, writeCandidate } from './character-candidates.js';
import { VERSION } from './version.js';

const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const planReplacementSchema = z.object({ input: filename, skin: label.default('default'), slot: label, attachment: label, image: filename, resizePolicy: z.enum(['reject', 'preserve-geometry']).default('reject'), allowAspectChange: z.boolean().default(false), anchors: z.object({ old: point, replacement: point }).strict().optional(), uvMapping: z.object({ oldAnchor: point, replacementAnchor: point, pixelScale: z.number().finite().positive().max(100).default(1) }).strict().optional(), propagateLinkedUVs: z.boolean().default(false) }).strict();
export const applyReplacementSchema = z.object({ ...request, plan: filename, expectedSha256: sha }).strict();
type Dimensions = { width: number; height: number };
export function replacementData(source: SpineDocument, args: z.output<typeof planReplacementSchema>, old: Dimensions, image: Dimensions) {
  const data = structuredClone(source), entry = attachmentEntries(data).find(a => a.skin === args.skin && a.slot === args.slot && a.name === args.attachment); if (!entry) throw new Error('Replacement attachment does not exist.');
  const v = entry.value, type = v.type ?? 'region', blockers: string[] = [], warnings: string[] = [], affectedUVs: string[] = [];
  if (!['region', 'mesh', 'linkedmesh'].includes(String(type))) blockers.push('Only region/mesh artwork can be replaced.');
  if (v.sequence) blockers.push('A static PNG cannot replace an image sequence; use the sequence tools.');
  const resized = old.width !== image.width || old.height !== image.height, aspectChanged = Math.abs(old.width / old.height - image.width / image.height) > 1e-8;
  if (resized && args.resizePolicy === 'reject') blockers.push('PNG canvas size differs. Explicit preserve-geometry policy is required.');
  if (aspectChanged && !args.allowAspectChange) blockers.push('Image aspect ratio changed; explicit allowAspectChange is required.');
  const inBounds = (p: { x: number; y: number }, d: Dimensions) => p.x >= 0 && p.y >= 0 && p.x <= d.width && p.y <= d.height;
  if (args.anchors && (!inBounds(args.anchors.old, old) || !inBounds(args.anchors.replacement, image))) blockers.push('Anchor lies outside its image canvas.');
  if (type === 'region') {
    if (args.uvMapping) blockers.push('UV remapping requires a mesh attachment.');
    const width = Number(v.width ?? old.width), height = Number(v.height ?? old.height), sx = Number(v.scaleX ?? 1), sy = Number(v.scaleY ?? 1);
    v.width = image.width; v.height = image.height; v.scaleX = sx * width / image.width; v.scaleY = sy * height / image.height;
    if (args.anchors) {
      const dx = (args.anchors.old.x / old.width - args.anchors.replacement.x / image.width) * width * sx, dy = (args.anchors.replacement.y / image.height - args.anchors.old.y / old.height) * height * sy, r = Number(v.rotation ?? 0) * Math.PI / 180;
      v.x = Number(v.x ?? 0) + dx * Math.cos(r) - dy * Math.sin(r); v.y = Number(v.y ?? 0) + dx * Math.sin(r) + dy * Math.cos(r);
    }
  } else if (type === 'mesh' || type === 'linkedmesh') {
    if (args.anchors) blockers.push('Mesh anchors require an explicit uvMapping; world vertices are preserved.');
    if (args.uvMapping) {
      const owner = sourceMesh(data, args.skin, args.slot, args.attachment), family = attachmentEntries(data).filter(a => ['mesh', 'linkedmesh'].includes(String(a.value.type)) && sourceMesh(data, a.skin, a.slot, a.name) === owner);
      if (family.length > 1 && !args.propagateLinkedUVs) blockers.push('Shared UVs affect linked meshes; inspect affectedUVs and explicitly allow propagation.');
      const m = args.uvMapping;
      if (!inBounds(m.oldAnchor, old) || !inBounds(m.replacementAnchor, image)) blockers.push('UV mapping anchor lies outside its canvas.');
      const uvs = (owner.uvs as number[]).map((u, i) => ((u * (i % 2 ? old.height : old.width) - (i % 2 ? m.oldAnchor.y : m.oldAnchor.x)) * m.pixelScale + (i % 2 ? m.replacementAnchor.y : m.replacementAnchor.x)) / (i % 2 ? image.height : image.width));
      if (uvs.some(n => n < -1e-9 || n > 1 + 1e-9 || !Number.isFinite(n))) blockers.push('Mapped UVs leave the replacement canvas. Pad/align the image instead of clipping the mesh.'); else owner.uvs = uvs.map(n => Math.max(0, Math.min(1, n)));
      affectedUVs.push(...family.map(a => `${a.skin}/${a.slot}/${a.name}`));
    }
    v.width = image.width; v.height = image.height;
  }
  if (aspectChanged) warnings.push('Preserved world geometry stretches the new image to its existing footprint. Review the artwork.');
  return { data: blockers.length ? data : parseDocument(data), blockers, warnings, affectedUVs, resized, aspectChanged, bonesPreserved: JSON.stringify(data.bones) === JSON.stringify(source.bones), timelinesPreserved: JSON.stringify(data.animations) === JSON.stringify(source.animations) };
}
export async function planImageReplacement(service: SpineService, raw: z.input<typeof planReplacementSchema>) {
  const args = planReplacementSchema.parse(raw), source = await captureSource(service, args.input), entry = attachmentEntries(source.data).find(a => a.skin === args.skin && a.slot === args.slot && a.name === args.attachment);
  if (!entry || !['region', 'mesh', 'linkedmesh'].includes(String(entry.value.type ?? 'region'))) throw new Error('Select one existing artwork attachment.');
  const sequence: any = entry.value.sequence, suffix = sequence ? String(sequence.start ?? 1).padStart(sequence.digits ?? 0, '0') : '', oldPath = path.resolve(source.resources.roots.images, String(entry.value.path ?? entry.value.name ?? entry.name) + suffix + '.png');
  const old = await readPngAsset(service.workspace, oldPath), replacement = await readPngAsset(service.workspace, args.image), imagePin = await pin(service, replacement.path), change = replacementData(source.data, args, old, replacement);
  if (imagePin.sha256 !== createHash('sha256').update(replacement.bytes).digest('hex')) throw new Error('Replacement PNG changed during planning.');
  await verifySource(service, source.source); await verifyPins(service, [imagePin]);
  const { data: _, ...report } = change, manifest = { schema: 'spine-image-replacement-plan/1', version: VERSION, args, source: source.source, replacement: imagePin, oldDimensions: { width: old.width, height: old.height }, newDimensions: { width: replacement.width, height: replacement.height }, checksPassed: !change.blockers.length, report };
  const plan = await immutableJson(service, 'image-replacement-plans', manifest); return { plan: plan.path, planSha256: plan.sha256, ...manifest, writesOriginalImages: false };
}
export async function applyImageReplacement(service: SpineService, raw: z.input<typeof applyReplacementSchema>) {
  const args = applyReplacementSchema.parse(raw);
  return operation(service, args.requestId, 'image_replacement', args, async () => {
    const p = await pin(service, args.plan); if (p.sha256 !== args.expectedSha256) throw new Error('Image replacement plan changed.');
    const plan = await jsonRead(service, p.path); if (plan.schema !== 'spine-image-replacement-plan/1' || plan.version !== VERSION || !plan.checksPassed) throw new Error('Replacement plan is invalid, belongs to another build, or has blockers.');
    const options = planReplacementSchema.parse(plan.args); await verifySource(service, plan.source); await verifyPins(service, [plan.replacement]);
    const loaded = await captureSource(service, options.input), changed = replacementData(loaded.data, options, plan.oldDimensions, plan.newDimensions); if (changed.blockers.length) throw new Error('Replacement no longer passes checks.');
    const bundle = await collectAssets(service.workspace, changed.data, loaded.jsonPath), data = await jsonRead(service, bundle.output), entry = attachmentEntries(data).find(a => a.skin === options.skin && a.slot === options.slot && a.name === options.attachment)!;
    const image = await copyPinned(service, plan.replacement.path, path.join(bundle.directory, 'images', `replacement-${plan.replacement.sha256}.png`)); entry.value.path = path.basename(image.path, '.png');
    const output = (await writeDocument(service.workspace, path.join(bundle.directory, 'replacement.json'), data, bundle.directory)).path;
    await verifySource(service, plan.source); await verifyPins(service, [plan.replacement]);
    return writeCandidate(service, 'image_replacement', output, plan.source, { plan: p.path, planSha256: p.sha256, replacement: image, report: plan.report, preserved: { bones: changed.bonesPreserved, allAnimationTimelines: changed.timelinesPreserved, meshVerticesWeightsDeform: true }, next: 'Review this isolated candidate, then explicitly promote it. A bound session promotion requests its native preview.' }, true, [p.path]);
  });
}
