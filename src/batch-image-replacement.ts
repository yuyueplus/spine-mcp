import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { attachmentEntries } from './attachment-data.js';
import { parseDocument, writeDocument, type SpineDocument } from './document.js';
import { readPngAsset } from './image-assets.js';
import { collectAssets } from './production-assets.js';
import { planReplacementSchema, replacementData } from './image-replacement.js';
import { filename, request, sha, captureSource, verifySource, pin, verifyPins, immutableJson, jsonRead, operation, copyPinned, writeCandidate, type Pin } from './character-candidates.js';
import { VERSION } from './version.js';

const replacement = planReplacementSchema.omit({ input: true });
export const planBatchReplacementSchema = z.object({ input: filename, replacements: z.array(replacement).min(1).max(64) }).strict();
export const applyBatchReplacementSchema = z.object({ ...request, plan: filename, expectedSha256: sha }).strict();
interface Row { index?: number; args: z.output<typeof planReplacementSchema>; oldDimensions: { width: number; height: number }; newDimensions: { width: number; height: number } }
const key = (v: { skin: string; slot: string; name: string }) => JSON.stringify([v.skin, v.slot, v.name]);
export function mergeReplacementRows(source: SpineDocument, rows: Row[]) {
  const data = structuredClone(source), original = new Map(attachmentEntries(source).map(e => [key(e), e.value])), destination = new Map(attachmentEntries(data).map(e => [key(e), e.value])), patches = new Map<string, unknown>(), selected = new Set<string>(), blockers: string[] = [], reports = [];
  for (const [position, row] of rows.entries()) {
    const index = row.index ?? position;
    const selector = key({ ...row.args, name: row.args.attachment }); if (selected.has(selector)) { blockers.push(`Repeated attachment selector at row ${index}.`); continue; } selected.add(selector);
    const result = replacementData(source, row.args, row.oldDimensions, row.newDimensions); reports.push({ index, skin: row.args.skin, slot: row.args.slot, attachment: row.args.attachment, blockers: result.blockers, warnings: result.warnings, affectedUVs: result.affectedUVs, resized: result.resized, aspectChanged: result.aspectChanged });
    blockers.push(...result.blockers.map(b => `Row ${index}: ${b}`)); if (result.blockers.length) continue;
    for (const entry of attachmentEntries(result.data)) for (const field of ['width', 'height', 'scaleX', 'scaleY', 'x', 'y', 'uvs']) {
      const before = original.get(key(entry))!, after = entry.value[field]; if (JSON.stringify(before[field]) === JSON.stringify(after)) continue;
      const fieldKey = JSON.stringify([entry.skin, entry.slot, entry.name, field]);
      if (patches.has(fieldKey) && JSON.stringify(patches.get(fieldKey)) !== JSON.stringify(after)) blockers.push(`Conflicting shared attachment/UV changes: ${fieldKey}`);
      else { patches.set(fieldKey, structuredClone(after)); destination.get(key(entry))![field] = structuredClone(after); }
    }
  }
  if (!blockers.length) parseDocument(data);
  return { data, checksPassed: !blockers.length, blockers, reports, changedFields: patches.size, bonesPreserved: JSON.stringify(data.bones) === JSON.stringify(source.bones), timelinesPreserved: JSON.stringify(data.animations) === JSON.stringify(source.animations) };
}
export async function planBatchImageReplacement(service: SpineService, raw: z.input<typeof planBatchReplacementSchema>) {
  const args = planBatchReplacementSchema.parse(raw), source = await captureSource(service, args.input), rows = [], images: Pin[] = [], inputErrors: { index: number; error: string }[] = []; let pixels = 0;
  for (const [index, replacement] of args.replacements.entries()) {
    try {
      const rowArgs = planReplacementSchema.parse({ ...replacement, input: args.input }), entry = attachmentEntries(source.data).find(a => a.skin === rowArgs.skin && a.slot === rowArgs.slot && a.name === rowArgs.attachment);
      if (!entry || !['region', 'mesh', 'linkedmesh'].includes(String(entry.value.type ?? 'region'))) throw new Error('Select an existing artwork attachment.');
      const sequence: any = entry.value.sequence, suffix = sequence ? String(sequence.start ?? 1).padStart(sequence.digits ?? 0, '0') : '', original = await readPngAsset(service.workspace, path.resolve(source.resources.roots.images, String(entry.value.path ?? entry.value.name ?? entry.name) + suffix + '.png')), image = await readPngAsset(service.workspace, rowArgs.image), imagePin = await pin(service, image.path);
      if (imagePin.sha256 !== createHash('sha256').update(image.bytes).digest('hex')) throw new Error('Replacement image changed during planning.');
      pixels += image.width * image.height + original.width * original.height; if (pixels > 64_000_000) throw new Error('Batch image inspection exceeds 64 million source/replacement pixels.');
      rows.push({ index, args: rowArgs, image: imagePin, oldDimensions: { width: original.width, height: original.height }, newDimensions: { width: image.width, height: image.height } }); images.push(imagePin);
    } catch (error) { inputErrors.push({ index, error: (error as Error).message }); }
  }
  const merged = mergeReplacementRows(source.data, rows); await verifySource(service, source.source); await verifyPins(service, images);
  const manifest = { schema: 'spine-batch-image-replacement-plan/1', version: VERSION, input: args.input, source: source.source, rows, images, inputErrors, checksPassed: merged.checksPassed && !inputErrors.length, blockers: merged.blockers, reports: merged.reports, changedFields: merged.changedFields, preserved: { bones: merged.bonesPreserved, allAnimationTimelines: merged.timelinesPreserved }, note: 'All rows are computed against the same original snapshot. Shared-field/UV conflicts reject; identical shared changes merge once. No formal version or original PNG is modified.' };
  const p = await immutableJson(service, 'batch-image-replacement-plans', manifest); return { plan: p.path, planSha256: p.sha256, ...manifest };
}
export async function applyBatchImageReplacement(service: SpineService, raw: z.input<typeof applyBatchReplacementSchema>) {
  const args = applyBatchReplacementSchema.parse(raw);
  return operation(service, args.requestId, 'batch_image_replacement', args, async () => {
    const p = await pin(service, args.plan); if (p.sha256 !== args.expectedSha256) throw new Error('Batch replacement plan changed.');
    const plan = await jsonRead(service, p.path); if (plan.schema !== 'spine-batch-image-replacement-plan/1' || plan.version !== VERSION || !plan.checksPassed || !Array.isArray(plan.rows) || plan.rows.length < 1 || plan.rows.length > 64) throw new Error('Batch plan is invalid, blocked, or belongs to another build.');
    await verifySource(service, plan.source); await verifyPins(service, plan.images);
    const loaded = await captureSource(service, plan.input), rows = plan.rows.map((r: any) => ({ ...r, args: planReplacementSchema.parse(r.args) })), merged = mergeReplacementRows(loaded.data, rows);
    if (!merged.checksPassed) throw new Error('Batch no longer passes shared-field and UV checks.');
    const bundle = await collectAssets(service.workspace, merged.data, loaded.jsonPath), data = parseDocument(await jsonRead(service, bundle.output)), destinations = new Map<string, Pin>(), applied = [];
    for (const row of rows) {
      let image = destinations.get(row.image.sha256);
      if (!image) { image = await copyPinned(service, row.image.path, path.join(bundle.directory, 'images', `batch-${row.image.sha256}.png`)); destinations.set(row.image.sha256, image); }
      const entry = attachmentEntries(data).find(a => a.skin === row.args.skin && a.slot === row.args.slot && a.name === row.args.attachment)!; entry.value.path = path.basename(image.path, '.png');
      applied.push({ skin: row.args.skin, slot: row.args.slot, attachment: row.args.attachment, image });
    }
    const output = (await writeDocument(service.workspace, path.join(bundle.directory, 'batch-replacement.json'), data, bundle.directory)).path; await verifySource(service, plan.source); await verifyPins(service, plan.images);
    return writeCandidate(service, 'batch_image_replacement', output, plan.source, { plan: p.path, planSha256: p.sha256, applied, reports: merged.reports, imageCopies: destinations.size, preserved: { bones: merged.bonesPreserved, allAnimationTimelines: merged.timelinesPreserved, meshVerticesWeightsDeform: true }, submission: 'Review then promote this single candidate. All replacements enter one session checkpoint; a failed plan/apply never changes the formal session.' }, true, [p.path]);
  });
}
