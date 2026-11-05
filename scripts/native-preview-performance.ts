import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { watch } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig, Workspace } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { renderArtwork } from '../src/scene-preview.js';
import { readDocument } from '../src/document.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

// Local acceptance against the user's existing official Spineboy preview.
// A known previous release supplies real old-code pixels, not a second copy of
// the new implementation. No GUI input, project replacement or source writes.
const config = await loadConfig(), work = config.workspaceRoot;
const json = async (name: string) => JSON.parse(await readFile(path.join(work, name), 'utf8'));
const pointer = await json('current-native-sequence-preview.json');
const prior = await json('native-sequence-halfsize-window-test-2.4.0.json');
const priorReady = await json('native-preview-ready-2.4.0.json');
const historicalOriginals = (await json('native-preview-stability-report-2.4.0.json')).originalFilesBefore;
assert.equal(prior.passed, true); assert.equal(prior.id, pointer.id);
const oldRelease = priorReady.installation.directory;
assert.equal(JSON.parse(await readFile(path.join(oldRelease, 'package.json'), 'utf8')).version, '2.4.0');
const oldRenderer = await import(pathToFileURL(path.join(oldRelease, 'dist/src/scene-preview.js')).href);
const directory = path.join(work, `preview-performance-${VERSION}-${randomUUID().slice(0, 8)}`);
await mkdir(directory);
const reportPath = path.join(work, `native-preview-performance-report-${VERSION}.json`);
let connection = await connectSpine();
const id = pointer.id, staticId = (await json('current-native-preview.json')).id;
const ownedInputs = new Set<string>();
let baseline: any, staticBefore: any, originals: Record<string, string> | undefined, failure: unknown;
let inputMayHaveChanged = false;
let restoreStatic = process.argv.includes('--resume-static');
const report: Record<string, any> = { passed: false, version: VERSION, tools: TOOL_COUNT, id, directory,
  oldRelease, inputAutomationUsed: false, nativeDisplayAcknowledgedByApi: false,
  priorHumanAcceptance: { version: '2.4.0', report: path.join(work, 'native-sequence-window-acceptance-2.4.0.json') },
  currentVersionNativeWindowReobserved: false };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function call(name: string, args: Record<string, unknown>) {
  const r = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs });
  const b = r.content.find(c => c.type === 'text');
  if (r.isError || b?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(r.content)}`);
  return JSON.parse(b.text);
}
const ready = (s: any) => s.state === 'watching' && s.workerAlive && s.supervisorAlive
  && s.generation === s.pendingGeneration && s.sequence?.state === 'ready' && !s.lastError;
const brief = (s: any) => ({ id: s.id, state: s.state, input: s.input, pendingInput: s.pendingInput,
  generation: s.generation, pendingGeneration: s.pendingGeneration,
  sequence: s.sequence && { state: s.sequence.state, preparedFrames: s.sequence.preparedFrames, publishedFrames: s.sequence.publishedFrames } });
async function until(targetId: string, predicate: (s: any) => boolean, label: string) {
  let s: any, lastLog = Date.now();
  for (const deadline = Date.now() + 180000; Date.now() < deadline;) {
    s = await call('spine_get_native_preview', { id: targetId });
    if (predicate(s)) return s;
    if (s.lastError) throw new Error(`${label}: ${s.lastError}`);
    if (Date.now() - lastLog >= 10000) { console.log(JSON.stringify({ phase: label, ...brief(s) })); lastLog = Date.now(); }
    await sleep(150);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(brief(s))}`);
}
async function frames(s: any) {
  const hashes: Record<string, string> = {};
  for (let n = 0; n < s.sequence.layout.frameCount; n++) {
    const name = `frame-${String(n).padStart(4, '0')}.png`;
    hashes[name] = await fileSha256(path.join(s.directory, 'images', name));
  }
  hashes['preview.png'] = await fileSha256(s.image); return hashes;
}
async function treeHashes(root: string) {
  const hashes: Record<string, string> = {};
  async function walk(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(name); else hashes[path.relative(root, name)] = await fileSha256(name);
    }
  }
  await walk(root); return hashes;
}
const started = Date.now();
try {
  assert.equal(connection.client.getServerVersion()!.version, VERSION);
  assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT);
  baseline = await call('spine_get_native_preview', { id });
  assert.equal(baseline.pendingInput, prior.before.input);
  assert.deepEqual(baseline.options, prior.before.options);
  assert.equal(baseline.requestedPlayback ?? null, null);
  assert.equal(baseline.sequence.layout.frameCount, 20);
  assert.equal(await fileSha256(baseline.project), prior.before.projectSha256);
  assert.equal(await fileSha256(baseline.pendingInput), prior.before.sourceSha256);
  assert.deepEqual(await frames(baseline), prior.before.frameHashes);
  originals = await treeHashes(prior.sourceRoot); assert.deepEqual(originals, historicalOriginals);
  ownedInputs.add(baseline.pendingInput);
  staticBefore = await call('spine_get_native_preview', { id: staticId });
  assert.equal(staticBefore.pendingInput, baseline.pendingInput);
  assert.equal(staticBefore.requestedPlayback ?? null, null);
  // Avoid redundant work and updates to a different open preview window.
  if (!staticBefore.stopRequested && Date.parse(staticBefore.expiresAt) > Date.now()) {
    await call('spine_stop_native_preview', { id: staticId }); restoreStatic = true;
    await until(staticId, s => s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive, 'static-cooperative-stop');
  }
  report.before = { input: baseline.pendingInput, project: baseline.project, projectSha256: prior.before.projectSha256,
    sourceSha256: prior.before.sourceSha256, frameHashes: prior.before.frameHashes, options: baseline.options,
    state: baseline.state, oldEditToPublishedSequenceMs: prior.edit.mcpEditToPublishedSequenceMs };

  await call('spine_resume_native_preview', { id, options: { durationSeconds: 28800 } });
  const renewed = await until(id, ready, 'current-version-sequence-cache');
  assert.deepEqual(await frames(renewed), prior.before.frameHashes);
  report.original20FramesMatchPreviousReleaseExactly = true;
  const workspace = new Workspace(work), data = await readDocument(baseline.pendingInput);
  const samples: any[] = [];
  for (const item of [{ time: 0, clean: true, transparent: true }, { time: 0.3, clean: true, transparent: true },
    { time: 0.15, clean: true, transparent: false }, { time: 0.15, clean: false, transparent: false }]) {
    const options = { ...baseline.options, clean: item.clean, transparent: item.transparent };
    const a = performance.now(), old = await oldRenderer.renderArtwork(workspace, data, baseline.pendingInput, 'run', [item.time], undefined, options);
    const oldMs = Math.round(performance.now() - a), b = performance.now();
    const current = await renderArtwork(workspace, data, baseline.pendingInput, 'run', [item.time], undefined, options);
    const currentMs = Math.round(performance.now() - b), sha256 = await fileSha256(current.path);
    assert.equal(sha256, await fileSha256(old.path), 'Transparent, opaque and labeled PNGs must preserve every byte.');
    samples.push({ ...item, oldMs, currentMs, speedup: Math.round(oldMs / currentMs * 10) / 10, pngBytesIdentical: true, sha256 });
  }
  report.realRendererSamples = samples;
  const root = data.bones.find(b => b.name === 'root'); assert.ok(root);
  const output = path.join(directory, 'half-size.json'); ownedInputs.add(output);
  const began = Date.now(); inputMayHaveChanged = true;
  const edit = await call('spine_set_bone', { input: baseline.pendingInput, output, bone: 'root',
    transform: { x: root.x ?? 0, scaleX: Number(root.scaleX ?? 1) * 0.5, scaleY: Number(root.scaleY ?? 1) * 0.5 } });
  assert.ok(edit.nativePreview.sessions.some((s: any) => s.id === id));
  assert.deepEqual(edit.nativePreview.errors, []);
  const changed = await until(id, s => ready(s) && s.input === output, 'ordinary-mcp-half-size-edit');
  const editMs = Date.now() - began;
  assert.deepEqual(await frames(changed), prior.edit.frameHashes, 'All 20 edited frames must match the old accepted half-size trial.');
  assert.equal(await fileSha256(changed.project), prior.before.projectSha256);
  report.edit = { output, changedFrameCount: 20, all20EditedFramesMatchPreviousReleaseExactly: true,
    automaticFollowing: true, oldMs: prior.edit.mcpEditToPublishedSequenceMs, currentMs: editMs,
    speedup: Math.round(prior.edit.mcpEditToPublishedSequenceMs / editMs * 10) / 10,
    nativeProjectUnchanged: true, generation: changed.generation };
  assert.ok(editMs < prior.edit.mcpEditToPublishedSequenceMs, 'The same 20-frame edit should rebuild faster than its recorded previous-release baseline.');
  const events: string[] = [], watcher = watch(path.join(changed.directory, 'images'), (_e, name) => events.push(String(name)));
  try { await sleep(3500); } finally { watcher.close(); }
  assert.deepEqual(events, []); report.steadyImageEvents = events;
  await connection.client.close(); connection = await connectSpine();
  const reconnected = await until(id, ready, 'client-reconnection');
  assert.equal(reconnected.workerPid, changed.workerPid); report.reconnectPreservedRenderer = true;
  report.backendPerformancePassed = true;
} catch (error) { failure = error; report.error = (error as Error).stack; }
finally {
  try {
    if (baseline && inputMayHaveChanged) {
      const latest = await call('spine_get_native_preview', { id });
      if (!ownedInputs.has(latest.pendingInput) || latest.stopRequested) throw new Error('External preview input/stop changed; automatic restoration skipped.');
      assert.deepEqual(latest.options, baseline.options, 'External preview options changed; automatic restoration skipped.');
      const began = Date.now();
      await call('spine_update_native_preview', { id, input: baseline.pendingInput });
      const restored = await until(id, s => ready(s) && s.input === baseline.pendingInput, 'exact-baseline-restoration');
      assert.deepEqual(await frames(restored), prior.before.frameHashes);
      assert.equal(await fileSha256(restored.project), prior.before.projectSha256);
      assert.equal(await fileSha256(baseline.pendingInput), prior.before.sourceSha256);
      assert.deepEqual(await treeHashes(prior.sourceRoot), originals);
      report.restored = { all20FramesMatchOriginalExactly: true, helperPngUnchanged: true, sameProject: true,
        sourceAndNativeProjectUnchanged: true, originalFilesUnchanged: Object.keys(originals!).length,
        restoreMs: Date.now() - began, generation: restored.generation, expiresAt: restored.expiresAt };
    }
    if (staticBefore && restoreStatic) {
      const latest = await call('spine_get_native_preview', { id: staticId });
      assert.equal(latest.pendingInput, staticBefore.pendingInput);
      assert.equal(latest.pendingGeneration, staticBefore.pendingGeneration, 'External static preview request changed.');
      await call('spine_resume_native_preview', { id: staticId, options: { durationSeconds: staticBefore.options.durationSeconds } });
      const restored = await until(staticId, s => s.state === 'watching' && s.workerAlive && s.supervisorAlive
        && s.generation === s.pendingGeneration && !s.lastError, 'static-preview-restoration');
      assert.equal(restored.textureSha256, staticBefore.textureSha256);
      assert.equal(await fileSha256(restored.project), staticBefore.projectSha256);
      report.staticPreviewUpgradedAndPreserved = { id: staticId, exactPngPreserved: true, sameNativeProject: true, expiresAt: restored.expiresAt };
    }
  } catch (error) { failure ??= error; report.restoreError = (error as Error).stack; }
  report.passed = !failure && Boolean(report.backendPerformancePassed && report.restored);
  report.elapsedMs = Date.now() - started; report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2)); await connection.client.close();
  console.log(JSON.stringify({ passed: report.passed, version: VERSION, reportPath, edit: report.edit,
    restored: report.restored, samples: report.realRendererSamples, error: report.error, restoreError: report.restoreError }, null, 2));
}
if (failure) throw failure;
