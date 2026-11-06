import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, copyFile, constants } from 'node:fs/promises';
import { z } from 'zod/v4';
import { Resvg } from '@resvg/resvg-js';
import type { SpineService } from './service.js';
import { parseDocument, readDocument, type SpineDocument } from './document.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { syncLease } from './sync-lock.js';
import { atomicJson } from './jobs.js';
import { readPngAsset } from './image-assets.js';
import { unpremultiplyRgba } from './raster.js';
import { VERSION } from './version.js';
import { publishQualityPolicySchema } from './publish-quality-schema.js';
import { publishAndOpen } from './publication.js';
import { checkPublishQuality, assertPublishQuality } from './publish-quality.js';

export const sha = z.string().regex(/^[a-f0-9]{64}$/), filename = z.string().min(1), label = z.string().min(1).max(200).refine(s => !['__proto__', 'constructor', 'prototype'].includes(s));
export const request = { requestId: z.string().uuid() };
export interface Pin { path: string; sha256: string }
export interface SourcePin { input: string; sha256: string; files: Pin[]; skeletonName?: string }
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function jsonRead(service: SpineService, file: string, max = 16 * 1024 ** 2): Promise<any> {
  file = await service.workspace.resolve(file); if ((await stat(file)).size > max) throw new Error('Workflow JSON exceeds its size limit.'); return JSON.parse(await readFile(file, 'utf8'));
}
export async function pin(service: SpineService, file: string): Promise<Pin> { const p = await service.workspace.resolve(file); return { path: p, sha256: await fileSha256(p) }; }
export async function verifyPins(service: SpineService, pins: Pin[]) {
  if (!Array.isArray(pins) || pins.length > 10000) throw new Error('Invalid workflow file inventory.');
  for (const f of pins) if (!f || !sha.safeParse(f.sha256).success || await fileSha256(await service.workspace.resolve(f.path)) !== f.sha256) throw new Error('Workflow source/resource/artifact changed: ' + f?.path);
}
export async function verifySource(service: SpineService, source?: SourcePin) { if (source) await verifyPins(service, [{ path: source.input, sha256: source.sha256 }, ...source.files]); }
export async function captureSource(service: SpineService, input: string, skeletonName?: string) {
  const source = await service.workspace.resolve(input), sourceHash = await fileSha256(source);
  let loaded;
  if (path.extname(source).toLowerCase() === '.spine') {
    const exported = await service.cli.exportData(source), files = exported.files.filter(f => f.endsWith('.json'));
    if (files.length !== 1) throw new Error('Character candidates require a single-skeleton native project; use the multi-project tools for other projects.');
    if (skeletonName && path.basename(files[0]!, '.json') !== skeletonName) throw new Error('Selected skeleton does not match the native project.');
    loaded = { data: await readDocument(files[0]!), jsonPath: files[0]! };
  } else loaded = await service.load(source, skeletonName);
  const resources = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  if (!resources.valid || resources.files.length > 2000) throw new Error('Character workflow needs complete resources and at most 2000 files.');
  const sourcePin: SourcePin = { input: source, sha256: sourceHash, files: resources.files.map(f => ({ path: f.path, sha256: f.sha256 })), ...(skeletonName ? { skeletonName } : {}) };
  await verifySource(service, sourcePin); return { ...loaded, source: sourcePin, resources };
}
export async function newFolder(service: SpineService, kind: string) { const p = await service.workspace.resolve(path.join(kind, randomUUID()), false); await mkdir(p, { recursive: true }); return p; }
export async function immutableJson(service: SpineService, kind: string, data: unknown) { const folder = await newFolder(service, kind), file = path.join(folder, 'manifest.json'); await writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); return { path: file, sha256: await fileSha256(file) }; }
export async function decodePng(service: SpineService, image: string) {
  const asset = await readPngAsset(service.workspace, image), raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}"><image width="100%" height="100%" href="data:image/png;base64,${asset.bytes.toString('base64')}"/></svg>`).render();
  const sha256 = createHash('sha256').update(asset.bytes).digest('hex');
  await verifyPins(service, [{ path: asset.path, sha256 }]);
  return { ...asset, sha256, pixels: unpremultiplyRgba(new Uint8Array(raster.pixels)) };
}
export async function copyPinned(service: SpineService, input: string, output: string) {
  const before = await pin(service, input); output = await service.workspace.resolve(output, false); await mkdir(path.dirname(output), { recursive: true }); await copyFile(before.path, output, constants.COPYFILE_EXCL); await verifyPins(service, [before]); const after = await pin(service, output); if (after.sha256 !== before.sha256) throw new Error('Copied image hash mismatch.'); return after;
}
export async function operation<T extends object>(service: SpineService, requestId: string, kind: string, args: unknown, action: () => Promise<T>): Promise<T & { requestId: string; reused: boolean }> {
  const root = await service.workspace.resolve('.character-operations', false); await mkdir(root, { recursive: true });
  const file = await service.workspace.resolve(path.join(root, requestId + '.json'), false), release = await syncLease(service.workspace, path.join(root, requestId + '.lock'));
  if (!release) throw new Error('Character request is already running; retry the same requestId.');
  try {
    const signature = digest({ version: VERSION, kind, args }); let record: any;
    try { record = await jsonRead(service, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (record && record.signature !== signature) throw new Error('requestId belongs to different character workflow arguments.');
    if (record?.result) { if (record.resultSha256 !== digest(record.result)) throw new Error('Character request receipt is damaged.'); await verifyPins(service, record.result.pinnedFiles ?? []); return { ...record.result, requestId, reused: true }; }
    await atomicJson(file, { schema: 'spine-character-operation/1', signature, kind, args, startedAt: record?.startedAt ?? new Date().toISOString() });
    const result = await action(); await atomicJson(file, { schema: 'spine-character-operation/1', signature, kind, result, resultSha256: digest(result) }); return { ...result, requestId, reused: false };
  } finally { await release(); }
}
export async function writeCandidate<D extends object>(service: SpineService, kind: string, json: string, source: SourcePin | undefined, details: D, checksPassed: boolean, extraFiles: string[] = []) {
  const data = await readDocument(json), assets = await auditAssets(service.workspace, data, json, false); if (!assets.valid) throw new Error('Candidate has incomplete resources.');
  const folder = await newFolder(service, 'character-candidates'), files = [await pin(service, json), ...assets.files.map(f => ({ path: f.path, sha256: f.sha256 })), ...await Promise.all(extraFiles.map(f => pin(service, f)))];
  const candidate = { schema: 'spine-character-candidate/1', version: VERSION, kind, json, source, checksPassed, details, files, visualAcceptance: 'pending', createdAt: new Date().toISOString() };
  await verifySource(service, source); await assertSnapshot(assets);
  const candidatePath = path.join(folder, 'candidate.json'); await writeFile(candidatePath, JSON.stringify(candidate, null, 2), { flag: 'wx' }); const p = await pin(service, candidatePath);
  return { candidate: p.path, candidateSha256: p.sha256, kind, json, checksPassed, details, visualAcceptance: 'pending', originalUnchanged: true, pinnedFiles: [p, ...files] };
}
export const getCandidateSchema = z.object({ candidate: filename, expectedSha256: sha.optional() }).strict();
export async function readCandidate(service: SpineService, raw: z.input<typeof getCandidateSchema>) {
  const args = getCandidateSchema.parse(raw), p = await pin(service, args.candidate); if (args.expectedSha256 && p.sha256 !== args.expectedSha256) throw new Error('Candidate manifest changed.');
  const c = await jsonRead(service, p.path); if (c.schema !== 'spine-character-candidate/1' || !['layer_import', 'image_replacement', 'batch_image_replacement', 'animation_repair', 'ik_target_repair', 'ik_contact_repair', 'psd_import', 'psd_raster_import', 'psd_sections_import', 'mesh_deform_repair', 'joint_mesh_repair', 'facial_animation', 'physics_bake', 'motion_sequence', 'chain_contact', 'character_task'].includes(c.kind) || typeof c.checksPassed !== 'boolean') throw new Error('Invalid character candidate.');
  await verifyPins(service, c.files); await service.workspace.resolve(c.json); if (!c.files.some((f: Pin) => f.path === c.json)) throw new Error('Candidate JSON is missing from its pinned inventory.');
  const data = parseDocument(await jsonRead(service, c.json)), resources = await auditAssets(service.workspace, data, c.json, false);
  if (!resources.valid || resources.files.some(f => !c.files.some((p: Pin) => p.path === f.path && p.sha256 === f.sha256))) throw new Error('Candidate resource inventory is incomplete.');
  let sourceChanged = false; try { await verifySource(service, c.source); } catch { sourceChanged = true; }
  return { ...c, candidate: p.path, candidateSha256: p.sha256, sourceChanged };
}
export const promoteCandidateSchema = z.object({ ...request, candidate: filename, expectedSha256: sha, confirmation: z.literal('use_reviewed_candidate'), note: z.string().min(5).max(4000), native: z.boolean().default(true), openInEditor: z.boolean().default(false), quality: publishQualityPolicySchema.optional(), session: z.object({ id: z.string().uuid(), expectedRevision: z.number().int().nonnegative() }).strict().optional() }).strict();
export async function promoteCandidate(service: SpineService, raw: z.input<typeof promoteCandidateSchema>) {
  const args = promoteCandidateSchema.parse(raw);
  return operation(service, args.requestId, 'promote', args, async () => {
    const c = await readCandidate(service, { candidate: args.candidate, expectedSha256: args.expectedSha256 });
    if (!c.checksPassed || c.sourceChanged) throw new Error('Candidate failed checks or its original source/resources changed. Regenerate and review.');
    let session;
    if (args.session) {
      session = await service.projectSessions.get(args.session.id);
      const saved = await service.projectSessions.read(args.session.id), retry = Boolean(saved.receipts[args.requestId] || saved.receiptIndex[args.requestId]);
      if (!retry && (session.revision !== args.session.expectedRevision || !c.source || path.resolve(session.currentInput).toLowerCase() !== path.resolve(c.source.input).toLowerCase())) throw new Error('Candidate source/revision does not match the selected session branch.');
    }
    const qualityPolicy = args.quality ?? session?.quality, quality = await checkPublishQuality(service, c.json, qualityPolicy); assertPublishQuality(quality);
    let output: string = c.json, publication: unknown;
    if (args.native) {
      const folder = await service.workspace.resolve(path.join('character-promotions', args.requestId), false); await mkdir(folder, { recursive: true }); output = path.join(folder, 'project.spine');
      publication = await publishAndOpen(service, { requestId: args.requestId, input: c.json, output, quality: qualityPolicy, openInEditor: args.openInEditor });
    } else if (args.openInEditor) throw new Error('Opening a candidate requires native=true.');
    await verifyPins(service, c.files); await verifySource(service, c.source);
    const checkpoint = args.session ? await service.projectSessions.checkpoint({ ...args.session, requestId: args.requestId, input: output, note: args.note }) : undefined;
    return { candidate: c.candidate, output, publication, quality, session: checkpoint, selection: 'explicit_caller_reported', visualAcceptance: 'pending', editorDisplayAcknowledged: false, originalUnchanged: true, pinnedFiles: [...c.files, await pin(service, c.candidate), await pin(service, output)] };
  });
}
