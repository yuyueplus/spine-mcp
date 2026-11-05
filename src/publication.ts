import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import type { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { publishSchema } from './stability-schema.js';
import { atomicJson } from './jobs.js';
import { syncLease } from './sync-lock.js';
import { fileSha256 } from './file-hash.js';
import { auditAssets, assertSnapshot, snapshotEditSources } from './production-assets.js';
import { verifyRoundTrip } from './project-workflow.js';
import { applyEdits } from './edits.js';
import { readDocument, writeDocument } from './document.js';
import { checkPublishQuality, assertPublishQuality } from './publish-quality.js';
import type { WorkControl } from './progress.js';
import { checkpoint } from './progress.js';

type Args = z.input<typeof publishSchema>;
interface Record { id: string; fingerprint: string; input: string; output: string; sourceSha256: string; files: { path: string; sha256: string }[]; phase: string; updatedAt: string; projectSha256?: string; result?: any; error?: string; failedStage?: string; quality?: Awaited<ReturnType<typeof checkPublishQuality>> }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function location(service: SpineService, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid publication ID.');
  const root = await service.workspace.resolve('.publications', false); await mkdir(root, { recursive: true });
  return { root, filename: await service.workspace.resolve(path.join(root, `${id}.json`), false) };
}
async function readRecord(service: SpineService, filename: string, id: string): Promise<Record> {
  if ((await stat(filename)).size > 8 * 1024 ** 2) throw new Error('Publication record exceeds 8 MiB.');
  const record = JSON.parse(await readFile(filename, 'utf8')) as Record, hash = /^[a-f0-9]{64}$/;
  if (record.id !== id || !hash.test(record.fingerprint) || !hash.test(record.sourceSha256) || (record.projectSha256 !== undefined && !hash.test(record.projectSha256)) || !Array.isArray(record.files) || record.files.length > 100000 || typeof record.phase !== 'string') throw new Error('Invalid publication record.');
  await service.workspace.resolve(record.input, false); await service.workspace.resolve(record.output, false);
  for (const file of record.files) { if (!file || !hash.test(file.sha256)) throw new Error('Invalid publication resource snapshot.'); await service.workspace.resolve(file.path, false); }
  return record;
}
export async function getPublication(service: SpineService, id: string) {
  const { filename } = await location(service, id), record = await readRecord(service, filename, id);
  const currentOutputHash = await fileSha256(record.output).catch(() => null);
  return { ...record, projectUnchanged: Boolean(record.projectSha256 && record.projectSha256 === currentOutputHash), visualAcceptance: 'pending', statusPath: filename,
    editor: record.result?.editorOpen?.id ? await service.editorProjects.get(record.result.editorOpen.id).catch(() => null) : null };
}
export async function publishAndOpen(service: SpineService, raw: Args, control?: WorkControl) {
  const parsed = publishSchema.parse(raw), args = { ...parsed, requestId: parsed.requestId ?? randomUUID() }, input = await service.workspace.resolve(args.input), output = await service.workspace.resolve(args.output, false);
  if (path.extname(output).toLowerCase() !== '.spine' || input === output) throw new Error('Publish requires a NEW .spine output distinct from the input.');
  const { root, filename } = await location(service, args.requestId), release = await syncLease(service.workspace, path.join(root, `${args.requestId}.lock`));
  if (!release) throw new Error('This publication is running. Query spine_get_publication with its requestId.');
  let record: Record | undefined;
  const save = async () => { record!.updatedAt = new Date().toISOString(); await atomicJson(filename, record); };
  try {
    const sourceSha256 = await fileSha256(input), fingerprint = digest({ input, output, sourceSha256, edits: args.edits, skeletonName: args.skeletonName, openInEditor: args.openInEditor, reuseInstance: args.reuseInstance, ...(args.quality === undefined ? {} : { quality: args.quality }) });
    try { record = await readRecord(service, filename, args.requestId); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (record && record.fingerprint !== fingerprint) { record = undefined; throw new Error('requestId belongs to another source revision, output, edits or open mode. Use a new requestId.'); }
    if (!record) {
      try { await stat(output); throw new Error('Output exists; select a NEW .spine filename.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const loaded = await service.load(input, args.skeletonName), assets = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false), dependencies = await snapshotEditSources(service.workspace, args.edits);
      if (!assets.valid) throw new Error(`Missing resources: ${assets.missing.map(x => x.relative).join(', ')}`);
      const prepared = args.edits.length ? await applyEdits(loaded.data, args.edits, { workspace: service.workspace, jsonPath: loaded.jsonPath }) : loaded.data, editedAssets = await auditAssets(service.workspace, prepared, loaded.jsonPath, false);
      if (!editedAssets.valid) throw new Error(`Edited project has missing resources: ${editedAssets.missing.map(x => x.relative).join(', ')}`);
      await assertSnapshot(assets); await assertSnapshot(dependencies);
      record = { id: args.requestId, fingerprint, input, output, sourceSha256, files: [...new Map([...assets.files, ...editedAssets.files, ...dependencies.files].map(file => [file.path, file])).values()], phase: 'preflight', updatedAt: new Date().toISOString() }; await save();
    }
    await assertSnapshot(record); delete record.error; delete record.failedStage;
    if (record.projectSha256 && await fileSha256(output) !== record.projectSha256) throw new Error('Published output changed. Refusing to reuse or open a different revision.');
    if (!record.projectSha256) {
      await checkpoint(control, { phase: 'publication-preflight', completed: 0, total: 3 });
      const qualitySource = await service.load(input, args.skeletonName), qualityData = args.edits.length ? await applyEdits(qualitySource.data, args.edits, { workspace: service.workspace, jsonPath: qualitySource.jsonPath }) : qualitySource.data;
      const qualityFolder = await service.workspace.resolve(path.join('.publications', `${args.requestId}-quality-${randomUUID()}`), false); await mkdir(qualityFolder, { recursive: true });
      const qualityInput = await writeDocument(service.workspace, path.join(qualityFolder, 'candidate.json'), qualityData, path.dirname(qualitySource.jsonPath));
      record.quality = await checkPublishQuality(service, qualityInput.path, args.quality, args.skeletonName, control); await save(); assertPublishQuality(record.quality);
      const probe = await service.cli.probe(); if (!probe.available) throw new Error(`Native CLI preflight failed: ${probe.reason ?? 'entrypoint unavailable'}`);
      record.phase = 'building'; await save();
      let build: unknown;
      const outputExists = await stat(output).then(() => true).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
      if (outputExists) {
        // Recover an uncertain post-build interruption by independently checking
        // the existing output against this exact request. Never blindly trust it.
        const before = await fileSha256(output), source = await service.load(input, args.skeletonName), expected = args.edits.length ? await applyEdits(source.data, args.edits, { workspace: service.workspace, jsonPath: source.jsonPath }) : source.data;
        const exported = await service.cli.exportData(output), files = exported.files.filter(f => f.endsWith('.json'));
        if (files.length !== 1) throw new Error('Interrupted publication has an unexpected skeleton inventory.');
        const verification = verifyRoundTrip(expected, await readDocument(files[0]!), source.jsonPath, files[0]!);
        if (await fileSha256(output) !== before) throw new Error('Output changed during recovery verification.');
        build = { recovered: true, output, verification };
      } else if (!args.edits.length) {
        const loaded = await service.load(input, args.skeletonName);
        build = await service.buildProject([{ input: loaded.jsonPath, name: args.skeletonName ?? path.basename(loaded.jsonPath, '.json') }], output, control);
      } else build = await service.editProject(input, output, args.edits, args.skeletonName, control);
      if (await fileSha256(input) !== sourceSha256) throw new Error('Input changed during publication.'); await assertSnapshot(record);
      record.projectSha256 = await fileSha256(output); record.result = { project: output, build, quality: record.quality, structuralAndNativeRoundTrip: 'passed', nativeVisualAcceptance: 'pending' }; record.phase = 'published'; await save();
    }
    await checkpoint(control, { phase: 'publication-open', completed: 2, total: 3 });
    if (args.openInEditor) {
      await assertSnapshot(record);
      if (await fileSha256(input) !== sourceSha256 || await fileSha256(output) !== record.projectSha256) throw new Error('Source or verified output changed before editor handoff.');
      record.phase = 'opening'; await save();
      try { record.result.editorOpen = await service.editorProjects.open(output, { requestId: args.requestId, reuseInstance: args.reuseInstance, waitMs: args.waitMs }); }
      catch (error) { record.result.editorOpen = { launchAccepted: false, error: (error as Error).message, projectLoadedVerified: false }; }
      record.phase = record.result.editorOpen.launchAccepted ? 'complete' : 'published_open_failed';
    } else { record.result.editorOpen = { requested: false }; record.phase = 'complete'; }
    await save(); await checkpoint(control, { phase: 'complete', completed: 3, total: 3 });
    return { requestId: args.requestId, ...record.result, phase: record.phase, statusPath: filename, originalUnchanged: true,
      handoff: { project: output, action: 'Open Project', animations: 'Select the animation and press Play in Spine. Native playback/selection is not controlled by this tool.', importDataNeeded: false } };
  } catch (error) { if (record) { record.failedStage = record.phase; record.error = (error as Error).message; record.phase = record.projectSha256 ? 'published_attention_required' : 'failed'; await save(); } throw error; }
  finally { await release(); }
}
