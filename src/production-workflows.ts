import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod/v4';
import { Resvg } from '@resvg/resvg-js';
import type { SpineService } from './service.js';
import { applyEdits, type ProjectEdit } from './edits.js';
import { documentDiff, auditAssets, assertSnapshot, collectAssets, saveReport } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { readDocument, writeDocument, safeName, type JsonObject } from './document.js';
import { sampleState, stateError } from './production-quality.js';
import { sampleArtwork, renderArtwork } from './scene-preview.js';
import { deliveryOptionsSchema, packSettingsSchema } from './production-schema.js';
import { pipelineSchema } from './job-schema.js';
import { atomicJson } from './jobs.js';
import { checkPublishQuality, assertPublishQuality, qualityResourceSignature } from './publish-quality.js';
import { checkpoint, type WorkControl } from './progress.js';
import { TextureAtlas } from '@esotericsoftware/spine-core';
import { resourceRefs } from './production-assets.js';
import { nativeCompatibility } from './native-compatibility.js';

export async function preflight(service: SpineService, input: string, edits: ProjectEdit[], skeletonName?: string) {
  const filename = await service.workspace.resolve(input), sourceHash = await fileSha256(filename), { data, jsonPath } = await service.load(input, skeletonName), snapshot = await auditAssets(service.workspace, data, jsonPath, false);
  const edited = await applyEdits(data, edits, { workspace: service.workspace, jsonPath }), after = await auditAssets(service.workspace, edited, jsonPath, false);
  await assertSnapshot(snapshot); if (await fileSha256(filename) !== sourceHash) throw new Error('Source changed during preflight.');
  const compatibility = nativeCompatibility(edited), diff = documentDiff(data, edited), report = { source: filename, sourceHash, inputUnchanged: true, publishesProject: false, edits: edits.length, diff, nativeCompatibility: compatibility, resources: { before: snapshot, after }, newMissingResources: after.missing.filter(ref => !snapshot.missing.some(old => old.path === ref.path)) };
  const reportPath = await saveReport(service.workspace, 'preflight', report);
  return { source: filename, inputUnchanged: true, reportPath, changes: diff.total, diff: { ...diff, changes: diff.changes.slice(0, 100), truncated: diff.total > 100 }, nativeCompatibility: compatibility, missingBefore: snapshot.missing.length, missingAfter: after.missing.length, publishesProject: false };
}
async function treeFiles(service: SpineService, root: string) { const files: string[] = []; const walk = async (folder: string): Promise<void> => { for (const entry of await readdir(folder, { withFileTypes: true })) { if (entry.isSymbolicLink()) throw new Error('Packages and checkpoints reject symbolic links.'); const filename = await service.workspace.resolve(path.join(folder, entry.name)); if (entry.isDirectory()) await walk(filename); else files.push(filename); if (files.length > 20000) throw new Error('Output manifest exceeds 20,000 files.'); } }; await walk(root); return files; }
export async function deliver(service: SpineService, input: string, raw: z.input<typeof deliveryOptionsSchema>, skeletonName?: string, control?: WorkControl) {
  const options = deliveryOptionsSchema.parse(raw); await checkpoint(control, { phase: 'collect-assets', completed: 0, total: 5 });
  const quality = await checkPublishQuality(service, input, options.quality, skeletonName, control); assertPublishQuality(quality);
  const source = await service.workspace.resolve(input), hash = await fileSha256(source), { data, jsonPath } = await service.load(input, skeletonName), snapshot = await auditAssets(service.workspace, data, jsonPath, false);
  if (hash !== quality.sourceSha256 || await fileSha256(source) !== hash || qualityResourceSignature(snapshot.files) !== quality.resourceSignature) throw new Error('Delivery source/resources changed after publication quality validation. Run validation again on the new revision.');
  const collected = await collectAssets(service.workspace, data, jsonPath);
  const runtimeDirectory = path.join(collected.directory, 'runtime'); await mkdir(runtimeDirectory);
  const project = path.join(runtimeDirectory, 'project.spine');
  await checkpoint(control, { phase: 'verify-project', completed: 1, total: 5 });
  // Even runtime-only packages undergo a full native import/export comparison.
  await service.buildProject([{ input: collected.output, name: skeletonName ?? 'skeleton' }], project, control);
  await checkpoint(control, { phase: 'export-data', completed: 2, total: 5 });
  for (const format of new Set(options.formats)) { const exported = await service.cli.exportData(project, format); for (const file of exported.files) if (file.endsWith(format === 'json' ? '.json' : '.skel')) { const destination = path.join(runtimeDirectory, path.basename(file)); if (format === 'json') await writeDocument(service.workspace, destination, await readDocument(file), path.dirname(file)); else await copyFile(file, destination, constants.COPYFILE_EXCL); } }
  if (options.atlas && snapshot.files.some(file => file.path.toLowerCase().endsWith('.png'))) {
    await checkpoint(control, { phase: 'pack-atlas', completed: 3, total: 5 });
    const defaults = options.atlasPreset === 'pixel' ? { filterMin: 'Nearest', filterMag: 'Nearest' } : options.atlasPreset === 'compact' ? { rotation: true, stripWhitespaceX: true, stripWhitespaceY: true } : {};
    const settings = packSettingsSchema.parse({ ...defaults, ...options.packSettings }), packed = await service.cli.packAtlas(path.join(collected.directory, 'images'), 'skeleton', settings, project);
    const atlasFile = packed.files.find(file => file.endsWith('.atlas')); if (!atlasFile) throw new Error('Delivery atlas missing.');
    const atlas = new TextureAtlas(await readFile(atlasFile, 'utf8')), refs = await resourceRefs(service.workspace, await readDocument(collected.output), collected.output), missing = refs.refs.filter(ref => ref.kind === 'images' && !atlas.findRegion(ref.relative.replaceAll('\\', '/').replace(/\.png$/i, '')));
    if (missing.length) throw new Error(`Packed atlas lost image/sequence regions: ${missing.slice(0, 10).map(ref => ref.relative).join(', ')}`);
    for (const file of packed.files) await copyFile(file, path.join(runtimeDirectory, path.basename(file)), constants.COPYFILE_EXCL);
  }
  const collectedData = await readDocument(collected.output); const check = await auditAssets(service.workspace, collectedData, collected.output, false); if (!check.valid) throw new Error('Delivery lost referenced resources.');
  await assertSnapshot(snapshot); if (await fileSha256(source) !== hash) throw new Error('Delivery source changed during export.');
  if (!options.includeProject) await unlink(await service.workspace.resolve(project));
  await checkpoint(control, { phase: 'delivery-manifest', completed: 4, total: 5 });
  const files = []; for (const filename of await treeFiles(service, collected.directory)) { files.push({ path: path.relative(collected.directory, filename).replaceAll('\\', '/'), bytes: (await stat(filename)).size, sha256: await fileSha256(filename) }); }
  const manifest = { schemaVersion: 1, kind: 'delivery', targetVersion: '4.3.23', profile: 'spine-4.3.23', sourceHash: hash, options, files, verifiedNativeRoundTrip: true, publicationQuality: { checksPassed: quality.checksPassed, mode: quality.policy.mode, sampledPoses: quality.sampledPoses }, resourcesComplete: true, complete: true, note: options.includeProject ? 'Editable project included; original source retained.' : 'Native verification completed; runtime-only package excludes the staging project.' };
  const deliveryManifest = path.join(collected.directory, 'delivery.json'); await writeFile(deliveryManifest, JSON.stringify(manifest, null, 2), { flag: 'wx' }); await checkpoint(control, { phase: 'complete', completed: 5, total: 5 });
  return { ...collected, project: options.includeProject ? project : null, runtimeDirectory, deliveryManifest, files: files.length, quality, complete: true };
}
export async function verifyPackage(service: SpineService, input: string) {
  const filename = await service.workspace.resolve(input), manifest = JSON.parse(await readFile(filename, 'utf8')) as { targetVersion: string; complete: boolean; files: { path: string; sha256: string }[] };
  if (manifest.targetVersion !== '4.3.23' || !manifest.complete || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw new Error('Invalid or incomplete delivery manifest.');
  const issues: string[] = [], directory = path.dirname(filename);
  for (const file of manifest.files) { const absolute = path.resolve(directory, file.path), relative = path.relative(directory, absolute); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Manifest path escapes package.'); try { if (await fileSha256(await service.workspace.resolve(absolute)) !== file.sha256) issues.push(`Hash mismatch: ${file.path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; issues.push(`Missing: ${file.path}`); } }
  if (!manifest.files.some(file => file.path === 'skeleton.json')) issues.push('Manifest does not include skeleton.json.');
  if (!issues.length) for (const file of manifest.files.filter(file => file.path.toLowerCase().endsWith('.json') && file.path !== 'manifest.json')) { const dataPath = path.resolve(directory, file.path), resources = await auditAssets(service.workspace, await readDocument(dataPath), dataPath, false); issues.push(...resources.missing.map(ref => `Missing resource in ${file.path}: ${ref.relative}`)); }
  return { valid: !issues.length, checkedFiles: manifest.files.length, issues };
}
export async function compareProjects(service: SpineService, a: string, b: string, options: { animation: string; otherAnimation?: string; times: number[]; skin?: string; otherSkin?: string; physics?: boolean; fps?: number; render?: boolean; tolerance?: number; geometry?: boolean }) {
  const left = await service.load(a), right = await service.load(b), other = options.otherAnimation ?? options.animation;
  if (options.times.length * Math.max(left.data.bones.length, right.data.bones.length) > 200000) throw new Error('Comparison exceeds the sampling budget.');
  if (options.physics && options.times.reduce((sum, time) => sum + Math.ceil(time * (options.fps ?? 60)), 0) * Math.max(left.data.bones.length, right.data.bones.length) * 2 > 500000) throw new Error('Physics comparison exceeds the simulation budget.');
  let maxError = 0, compatible = true;
  const samples = options.geometry === false ? [] : options.times.map(time => { const result = stateError(sampleState(left.data, options.animation, time, options.skin, options.physics, options.fps), sampleState(right.data, other, time, options.otherSkin ?? options.skin, options.physics, options.fps)); compatible &&= result.compatible; maxError = Math.max(maxError, result.maxError ?? 0); return { time, ...result }; });
  const images: { before: string; after: string; changedPixels: number; maxChannelError: number; meanAbsoluteError: number }[] = [];
  if (options.render) for (let offset = 0; offset < options.times.length; offset += 8) {
    const times = options.times.slice(offset, offset + 8), viewport = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    let triangles = 0;
    for (const item of [{ ...left, name: options.animation, skin: options.skin }, { ...right, name: other, skin: options.otherSkin ?? options.skin }]) { const { frames } = await sampleArtwork(service.workspace, item.data, item.jsonPath, item.name, times, item.skin, options); for (const frame of frames) for (const slot of frame.slots) { triangles += slot.triangles ? slot.triangles.length / 3 : slot.image ? 2 : 0; if (slot.vertices) for (let i = 0; i < slot.vertices.length; i += 2) { viewport.minX = Math.min(viewport.minX, slot.vertices[i]!); viewport.maxX = Math.max(viewport.maxX, slot.vertices[i]!); viewport.minY = Math.min(viewport.minY, slot.vertices[i + 1]!); viewport.maxY = Math.max(viewport.maxY, slot.vertices[i + 1]!); } } }
    if (triangles > 5000) throw new Error('CPU pixel comparison exceeds 5000 drawn triangles per group. Use fewer sampled times or render=false for geometry-only comparison.');
    if (!Number.isFinite(viewport.minX)) Object.assign(viewport, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
    const clean = options.geometry === false;
    const before = await renderArtwork(service.workspace, left.data, left.jsonPath, options.animation, times, options.skin, { ...options, viewport, clean }), after = await renderArtwork(service.workspace, right.data, right.jsonPath, other, times, options.otherSkin ?? options.skin, { ...options, viewport, clean });
    const decode = async (file: string) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${times.length * 320}" height="300"><image width="100%" height="100%" href="data:image/png;base64,${(await readFile(file)).toString('base64')}"/></svg>`).render().pixels;
    const ap = await decode(before.path), bp = await decode(after.path); let changedPixels = 0, maxChannelError = 0, sum = 0, count = 0;
    for (let y = clean ? 0 : 45; y < (clean ? 300 : 265); y++) for (let x = 0; x < times.length * 320; x++) { let changed = false; for (let c = 0; c < 4; c++) { const i = (y * times.length * 320 + x) * 4 + c, error = Math.abs(ap[i]! - bp[i]!); sum += error; count++; maxChannelError = Math.max(maxChannelError, error); changed ||= error > 0; } if (changed) changedPixels++; }
    images.push({ before: before.path, after: after.path, changedPixels, maxChannelError, meanAbsoluteError: sum / count });
  }
  const pixelOnly = options.geometry === false, report = { comparisonMode: pixelOnly ? 'cpu-pixels-only' : 'geometry', compatible, maxSampledError: pixelOnly ? null : compatible ? maxError : null, withinTolerance: pixelOnly ? images.length > 0 && images.every(image => image.meanAbsoluteError <= (options.tolerance ?? 1)) : compatible && maxError <= (options.tolerance ?? 0.001), samples, images, diff: documentDiff(left.data, right.data), note: 'Listed-time comparison: CPU-pixel-only mode compares the entire clean artwork frame; optional geometry-mode imagery excludes preview title/footer. Mean errors use 0–255 channel units. This is not native GPU rendering.' };
  const reportPath = await saveReport(service.workspace, 'comparison', report); return { ...report, diff: { ...report.diff, changes: report.diff.changes.slice(0, 100) }, reportPath };
}
export async function runPipeline(service: SpineService, raw: z.input<typeof pipelineSchema>, control?: WorkControl) {
  const request = pipelineSchema.parse(raw), ids = request.steps.map(step => step.id); if (new Set(ids).size !== ids.length) throw new Error('Pipeline step ids must be unique.');
  ids.forEach(safeName);
  for (const step of request.steps) for (const dep of [...step.dependsOn, ...(step.inputFrom ? [step.inputFrom] : [])]) if (!ids.includes(dep) || dep === step.id) throw new Error('Pipeline references a missing step or itself.');
  const ordered: typeof request.steps = [], remaining = [...request.steps], done = new Set<string>();
  while (remaining.length) { const i = remaining.findIndex(step => [...step.dependsOn, ...(step.inputFrom ? [step.inputFrom] : [])].every(dep => done.has(dep))); if (i < 0) throw new Error('Pipeline contains a dependency cycle.'); const [step] = remaining.splice(i, 1); ordered.push(step!); done.add(step!.id); }
  const root = await service.workspace.resolve(path.join('.pipelines', request.id), false); await mkdir(root, { recursive: true });
  const releaseLock = await lockPipeline(root); try {
  const results: Record<string, { result: any; reused: boolean; signature: string }> = {};
  for (let index = 0; index < ordered.length; index++) {
    const step = ordered[index]!; await checkpoint(control, { phase: `pipeline:${step.id}`, completed: index, total: ordered.length });
    const previous = step.inputFrom ? results[step.inputFrom]?.result : undefined, input = previous ? previous.path ?? previous.output ?? previous.workingJson : step.input;
    if (typeof input !== 'string') throw new Error(`Step ${step.id} requires input or inputFrom with a file output.`);
    const source = await service.workspace.resolve(input), { data, jsonPath } = await service.load(source, step.skeletonName), assets = await auditAssets(service.workspace, data, jsonPath, false), dependencies: { path: string; sha256: string }[] = [{ path: source, sha256: await fileSha256(source) }, ...assets.files];
    for (const edit of step.edits ?? []) if ('source' in edit && typeof edit.source === 'string') { const filename = await service.workspace.resolve(edit.source); dependencies.push({ path: filename, sha256: await fileSha256(filename) }); }
    const signature = createHash('sha256').update(JSON.stringify({ step, dependencies, parents: step.dependsOn.map(dep => results[dep]!.signature) })).digest('hex'), checkpointPath = path.join(root, `${step.id}.json`);
    if (request.resume) { let saved: { signature: string; result: unknown; outputs: { path: string; sha256: string }[] } | undefined; try { saved = JSON.parse(await readFile(checkpointPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (saved && saved.signature === signature) { let valid = true; for (const output of saved.outputs) try { if (await fileSha256(await service.workspace.resolve(output.path)) !== output.sha256) valid = false; } catch { valid = false; } if (valid) { results[step.id] = { result: saved.result, reused: true, signature }; continue; } }
    }
    const execution = path.join(root, `${step.id}-${randomUUID()}`); await mkdir(execution); const output = step.output ?? path.join(execution, step.operation === 'edit_project' ? 'result.spine' : 'result.json'); let result: any;
    switch (step.operation) {
      case 'audit_assets': result = await auditAssets(service.workspace, data, jsonPath); result.reportPath = await saveReport(service.workspace, 'assets', result); break;
      case 'preflight': if (!step.edits) throw new Error('Preflight step requires edits.'); result = await preflight(service, source, step.edits, step.skeletonName); break;
      case 'edit_json': if (!step.edits) throw new Error('Edit step requires edits.'); result = await service.editFile(source, output, step.edits); break;
      case 'edit_project': if (!step.edits) throw new Error('Edit step requires edits.'); result = await service.editProject(source, output, step.edits, step.skeletonName, control); break;
      case 'collect_assets': { const collected = await collectAssets(service.workspace, data, jsonPath); result = await service.afterPublish(source, collected.output, collected); break; }
      case 'deliver': result = await deliver(service, source, step.options ?? {}, step.skeletonName, control); break;
      case 'export_frames': if (!step.frames) throw new Error('Frame step requires frames options.'); result = await service.exportFrames(source, step.frames, step.skeletonName, control); break;
      case 'export_media': if (!step.media) throw new Error('Media step requires media options.'); result = await service.exportMedia(source, step.media, step.skeletonName, control); break;
    }
    await assertSnapshot(assets); if (await fileSha256(source) !== dependencies[0]!.sha256) throw new Error('Pipeline source changed during a step.');
    const outputFiles = result.directory ? await treeFiles(service, result.directory) : [result.path, result.output, result.reportPath].filter((file): file is string => typeof file === 'string'); const outputs = []; for (const filename of new Set<string>(outputFiles)) outputs.push({ path: filename, sha256: await fileSha256(filename) });
    await atomicJson(checkpointPath, { schemaVersion: 1, signature, result, outputs }); results[step.id] = { result, reused: false, signature };
  }
  await checkpoint(control, { phase: 'complete', completed: ordered.length, total: ordered.length }); return { id: request.id, directory: root, complete: true, steps: results, reusedSteps: Object.values(results).filter(step => step.reused).length };
  } finally { await releaseLock(); }
}
async function lockPipeline(root: string): Promise<() => Promise<void>> {
  const lock = path.join(root, '.lock'), owner = path.join(lock, 'owner.json'), token = randomUUID();
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stale = false; try { const previous = JSON.parse(await readFile(owner, 'utf8')); if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid pipeline lock owner.'); try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') stale = true; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (Date.now() - (await stat(lock)).mtimeMs > 10000) stale = true; }
    if (!stale) throw new Error('This pipeline id is already running. Query its background job or wait for it to finish.');
    const retired = path.join(root, `.retired-lock-${randomUUID()}`); const { rename } = await import('node:fs/promises'); await rename(lock, retired); return lockPipeline(root);
  }
  await writeFile(owner, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
  return async () => { const current = JSON.parse(await readFile(owner, 'utf8')); if (current.token === token) { await unlink(owner); await rmdir(lock); } };
}
