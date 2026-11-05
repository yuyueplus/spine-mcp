import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { replaceFile } from '../src/file-replace.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { addSkin } from '../src/slot-edits.js';
import { parseDocument } from '../src/document.js';
import { documentSkins } from '../src/slot-data.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const config = await loadConfig(), pointerPath = path.join(config.workspaceRoot, 'current-native-preview.json');
const pointer = JSON.parse(await readFile(pointerPath, 'utf8')), id = pointer.id;
let connection = await connectSpine(), baseline: any, failure: unknown, currentRendererBaselineHash: string | undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const started = Date.now(), ownedInputs = new Set<string>(), latencies: number[] = [], imageHashes = new Set<string>();
const directory = path.join(config.workspaceRoot, `preview-stability-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const sourceRoot = 'C:/Users/Administrator/Spine/examples/4.3/spineboy';
async function hashes(root: string) {
  const result: Record<string, string> = {};
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file); else result[path.relative(root, file)] = await fileSha256(file);
    }
  }; await walk(root); return result;
}
async function call(name: string, args: Record<string, unknown>) {
  const response = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs });
  const block = response.content.find(item => item.type === 'text');
  if (response.isError || block?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`);
  return JSON.parse(block.text);
}
async function until(predicate: (status: any) => boolean, ms = 45000) {
  const deadline = Date.now() + ms; let s;
  do { s = await call('spine_get_native_preview', { id }); if (predicate(s)) return s; await sleep(180); } while (Date.now() < deadline);
  throw new Error(`Spineboy stability preview timed out: ${JSON.stringify(s)}`);
}
const published = (s: any) => s.state === 'watching' && s.workerAlive && s.supervisorAlive && s.generation === s.pendingGeneration && !s.lastError;
const report: Record<string, any> = { passed: false, version: VERSION, tools: TOOL_COUNT, id, directory, sourceRoot, iterations: 48, inputAutomationUsed: false, mode: 'sampled-static-artwork-in-dedicated-native-project', editorDisplayAcknowledged: false };
let originalFiles: Record<string, string> | undefined, projectHash: string | undefined, originalSourceHash: string | undefined;
let resourcePath: string | undefined, resourceBytes: Buffer | undefined;
try {
  assert.equal((await call('spine_status', { probeCli: false })).serverVersion, VERSION);
  const candidate = await call('spine_get_native_preview', { id });
  assert.equal(candidate.requestedPlayback ?? null, null, 'Static stability audit requires playback to be stopped first; the active playback is left unchanged.');
  baseline = candidate; ownedInputs.add(baseline.pendingInput);
  originalFiles = await hashes(sourceRoot); projectHash = await fileSha256(baseline.project); originalSourceHash = await fileSha256(baseline.pendingInput);
  report.before = { input: baseline.pendingInput, sourceSha256: originalSourceHash, options: baseline.options, textureSha256: baseline.textureSha256, project: baseline.project, projectSha256: projectHash };
  report.originalFilesBefore = originalFiles;

  // Cooperatively retire the previous renderer, including a still-running
  // v2.2 worker, while keeping its native project and PNG exactly in place.
  await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive);
  await call('spine_resume_native_preview', { id, options: { durationSeconds: 28800 } });
  const upgraded = await until(published);
  const { durationSeconds: _priorLifetime, ...priorPose } = baseline.options, { durationSeconds: _newLifetime, ...upgradedPose } = upgraded.options;
  assert.equal(upgraded.input, baseline.pendingInput); assert.equal(upgraded.project, baseline.project); assert.deepEqual(upgradedPose, priorPose);
  const upgradePublication = await call('spine_wait_native_preview', { id, options: { generation: upgraded.pendingGeneration, sourceSha256: originalSourceHash, waitMs: 0 } });
  assert.equal(upgradePublication.outcome, 'published'); assert.equal(await fileSha256(baseline.project), projectHash);
  // A previous process may run an older rasterizer. The upgrade can correct
  // its pixels; later restoration must match this version's verified baseline.
  currentRendererBaselineHash = upgraded.textureSha256;
  report.rendererUpgrade = { version: VERSION, previousTextureSha256: baseline.textureSha256, currentTextureSha256: currentRendererBaselineHash, inputAndPoseUnchanged: true, publication: upgradePublication };
  report.previousWorkerCooperativelyUpgraded = true;

  // Native regression for the skin-copy bug found by this real project. Use a
  // small deforming/link-mesh rig so Spineboy's known concave-importer issue
  // cannot obscure whether skin namespaces and links survive native readback.
  const skinDemo = await call('spine_create_demo', {});
  const skinRig = parseDocument({ skeleton: { spine: '4.3.23', images: skinDemo.images }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'mesh' }, { name: 'linked', bone: 'root', attachment: 'link' }], skins: [{ name: 'default', attachments: { art: { mesh: { type: 'mesh', path: 'arm', uvs: [0, 1, 0, 0, 1, 0], vertices: [0, 0, 0, 10, 10, 10], triangles: [0, 1, 2], hull: 3 } }, linked: { link: { type: 'linkedmesh', path: 'arm', source: 'mesh', slot: 'art' } } } }], animations: { motion: { attachments: { default: { art: { mesh: { deform: [{ time: 0 }, { time: 1, vertices: [3, 1] }] } } } } } } });
  const copiedSkinRig = addSkin(skinRig, 'copied', 'default', 'base'), skinRigJson = path.join(directory, 'skin-copy-regression.json');
  await writeFile(skinRigJson, JSON.stringify(copiedSkinRig), { flag: 'wx' });
  const nativeSkinRig = await call('spine_build_project', { entries: [{ input: skinRigJson, name: 'skin-copy-regression' }], output: path.join(directory, 'skin-copy-regression.spine') });
  const nativeSkinInspection = await call('spine_inspect', { input: nativeSkinRig.output }), nativeSkinData = JSON.parse(await readFile(nativeSkinInspection.workingJson, 'utf8'));
  assert.deepEqual(nativeSkinData.animations.motion.attachments.base, nativeSkinData.animations.motion.attachments.copied);
  assert.ok(attachmentEntries(nativeSkinData).some(entry => entry.skin === 'copied' && entry.value.source !== undefined && entry.value.skin === 'copied'));
  report.skinCopyDeformAndLinkNativeReadbackVerified = true;

  const clone = JSON.parse(await readFile(baseline.pendingInput, 'utf8'));
  for (const kind of ['images', 'audio']) if (typeof clone.skeleton[kind] === 'string' && clone.skeleton[kind]) clone.skeleton[kind] = path.resolve(path.dirname(baseline.pendingInput), clone.skeleton[kind]);
  const clonePath = path.join(directory, 'independent-source.json'); await writeFile(clonePath, JSON.stringify(clone), { flag: 'wx' });
  const collected = await call('spine_collect_assets', { input: clonePath });
  // The managed preview may already reference a named-skin result of a previous
  // run. Copy its effective skin into fresh per-run names; never assume default
  // still exists or remove a pre-existing skin to satisfy the test fixture.
  const available = documentSkins(parseDocument(clone)), requestedSkin = baseline.options.skin ?? 'default';
  const sourceSkin = available.find(s => s.name === requestedSkin && Object.keys(s.attachments ?? {}).length)?.name ?? available.find(s => Object.keys(s.attachments ?? {}).length)?.name;
  assert.ok(sourceSkin, 'Stability fixture needs a source skin with attachments.');
  const suffix = randomUUID().slice(0, 8), baseSkin = 'preview-base-' + suffix, alternateSkin = 'preview-alternate-' + suffix;
  let skinned;
  if (sourceSkin === 'default') skinned = await call('spine_add_skin', { input: collected.output, output: path.join(directory, 'prepared.json'), name: alternateSkin, copyFrom: sourceSkin, baseSkin });
  else {
    const base = await call('spine_add_skin', { input: collected.output, output: path.join(directory, 'prepared-base.json'), name: baseSkin, copyFrom: sourceSkin });
    skinned = await call('spine_add_skin', { input: base.path, output: path.join(directory, 'prepared.json'), name: alternateSkin, copyFrom: baseSkin });
  }
  report.fixtureSkins = { source: sourceSkin, base: baseSkin, alternate: alternateSkin, priorSkinNamesRetained: true };
  let current = skinned.path; ownedInputs.add(current);
  const data = JSON.parse(await readFile(current, 'utf8')), entries = attachmentEntries(data);
  const head = entries.find(entry => entry.name === 'head'), torso = entries.find(entry => entry.name === 'torso'); assert.ok(head && torso);
  resourcePath = path.resolve(path.dirname(current), data.skeleton.images, `${head.value.path ?? head.name}.png`);
  const donor = path.resolve(path.dirname(current), data.skeleton.images, `${torso.value.path ?? torso.name}.png`);
  resourceBytes = await readFile(resourcePath); const donorBytes = await readFile(donor);
  await call('spine_update_native_preview', { id, input: current, changes: { animation: 'run', skin: baseSkin, time: 0.15 } }); await until(published);
  let keyEdits = 0;
  for (let n = 0; n < report.iterations; n++) {
    const at = Date.now(), output = path.join(directory, `edit-${String(n).padStart(3, '0')}.json`);
    const edit = n % 4 === 0
      ? await call('spine_set_timeline', { input: current, output, animation: 'run', bone: 'root', channel: 'translate', keyframes: [{ time: 0, x: 0, y: 0 }, { time: 0.6666667, x: n % 9, y: n % 5 }] })
      : await call('spine_set_bone', { input: current, output, bone: 'root', transform: { x: n % 11 - 5, y: n % 3 } });
    if (n % 4 === 0) keyEdits++;
    current = edit.path; ownedInputs.add(current); assert.equal(edit.nativePreview.sessions[0].id, id);
    await call('spine_update_native_preview', { id, changes: { animation: ['run', 'walk', 'idle'][n % 3], time: 0.08 + (n % 6) * 0.09, skin: n % 2 ? alternateSkin : baseSkin } });
    const changed = await until(s => published(s) && s.input === current);
    imageHashes.add(changed.textureSha256); latencies.push(Date.now() - at);
    assert.equal(changed.project, baseline.project);
    if (n === 23) {
      const oldWorker = changed.workerPid;
      await connection.client.close(); await sleep(800); connection = await connectSpine();
      const reconnected = await until(published); assert.equal(reconnected.workerPid, oldWorker); report.clientReconnectPreservedRenderer = true;
      await call('spine_resume_native_preview', { id, options: { durationSeconds: 28800 } }); await until(published); report.activeRenewalVerified = true;
    }
    await sleep(1000);
  }
  assert.ok(imageHashes.size >= 12, 'Continuous edits should produce visibly different PNG frames.');
  const beforeResource = await until(published), resourceTemporary = path.join(path.dirname(resourcePath), `stability-${randomUUID()}.png`);
  await writeFile(resourceTemporary, donorBytes, { flag: 'wx' }); await replaceFile(resourceTemporary, resourcePath);
  const resourceChanged = await until(s => published(s) && s.textureRevision > beforeResource.textureRevision && s.textureSha256 !== beforeResource.textureSha256);
  const restoreTemporary = path.join(path.dirname(resourcePath), `stability-${randomUUID()}.png`);
  await writeFile(restoreTemporary, resourceBytes, { flag: 'wx' }); await replaceFile(restoreTemporary, resourcePath);
  await until(s => published(s) && s.textureRevision > resourceChanged.textureRevision && s.textureSha256 === beforeResource.textureSha256);
  report.imageOnlyChangeAndRestoreVerified = true;
  await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive);
  await call('spine_resume_native_preview', { id, options: { durationSeconds: 28800 } }); await until(published);
  report.stoppedSessionResumedInSameProject = true; report.boneEditCount = report.iterations - keyEdits; report.keyframeEditCount = keyEdits;
  report.skinSwitchCount = report.iterations; report.animations = ['run', 'walk', 'idle']; report.distinctImageHashes = imageHashes.size;
  report.mcpEditToPublishedPngMs = { samples: latencies.length, min: Math.min(...latencies), max: Math.max(...latencies), mean: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) };
  report.passed = true;
} catch (error) { failure = error; report.error = (error as Error).message; }
finally {
  try {
    if (resourcePath && resourceBytes) {
      const temporary = path.join(path.dirname(resourcePath), `restore-${randomUUID()}.png`);
      await writeFile(temporary, resourceBytes, { flag: 'wx' }); await replaceFile(temporary, resourcePath);
    }
    if (baseline) {
      const latest = await call('spine_get_native_preview', { id });
      if (!ownedInputs.has(latest.pendingInput)) throw new Error('Preview input was changed outside this test; automatic restoration skipped.');
      if (latest.stopRequested || Date.parse(latest.expiresAt) <= Date.now()) await call('spine_resume_native_preview', { id, options: { durationSeconds: 28800 } });
      const options = baseline.options;
      await call('spine_update_native_preview', { id, input: baseline.pendingInput, changes: { animation: options.animation ?? null, skin: options.skin ?? null, time: options.time, physics: options.physics, fps: options.fps, viewport: options.viewport, ...(options.skeletonName ? { skeletonName: options.skeletonName } : {}) } });
      const restored = await until(s => published(s) && s.input === baseline.pendingInput);
      assert.equal(restored.textureSha256, currentRendererBaselineHash ?? baseline.textureSha256); assert.equal(await fileSha256(baseline.project), projectHash);
      assert.equal(await fileSha256(baseline.pendingInput), originalSourceHash);
      assert.deepEqual(await hashes(sourceRoot), originalFiles);
      report.restored = { input: restored.input, project: restored.project, generation: restored.generation, textureSha256: restored.textureSha256, matchesCurrentRendererBaselineExactly: true, matchesOriginalLegacyPngExactly: restored.textureSha256 === baseline.textureSha256, expiresAt: restored.expiresAt };
      report.originalFilesUnchanged = true; report.originalFileCount = Object.keys(originalFiles!).length; report.previewProjectUnchanged = true;
      pointer.expiresAt = restored.expiresAt;
      pointer.lastStabilityVerification = { version: VERSION, passed: report.passed, at: new Date().toISOString(), reportPath: path.join(config.workspaceRoot, `native-preview-stability-report-${VERSION}.json`) };
      await writeFile(pointerPath, JSON.stringify(pointer, null, 2));
    }
  } catch (restoreError) { failure ??= restoreError; report.passed = false; report.restoreError = (restoreError as Error).message; }
  report.elapsedMs = Date.now() - started; report.finishedAt = new Date().toISOString();
  const reportPath = path.join(config.workspaceRoot, `native-preview-stability-report-${VERSION}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2)); await connection.client.close();
  console.log(JSON.stringify({ passed: report.passed, reportPath, iterations: report.iterations, elapsedMs: report.elapsedMs, latency: report.mcpEditToPublishedPngMs, originalFileCount: report.originalFileCount, restored: Boolean(report.restored) }, null, 2));
}
if (failure) throw failure;
