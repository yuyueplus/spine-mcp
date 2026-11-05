import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

// Explicit local acceptance entrypoint. The ordinary automated suite never
// changes the user's open preview or assumes that its window is visible.
const config = await loadConfig(), pointerPath = path.join(config.workspaceRoot, 'current-native-preview.json'), pointer = JSON.parse(await readFile(pointerPath, 'utf8')), id = pointer.id;
const directory = path.join(config.workspaceRoot, `playback-current-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const connection = await connectSpine(), owned = new Set<string>(), sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const reportPath = path.join(config.workspaceRoot, `native-playback-current-report-${VERSION}.json`), markerPath = path.join(config.workspaceRoot, 'current-native-playback-trial.json');
const sourceRoot = 'C:/Users/Administrator/Spine/examples/4.3/spineboy';
async function hashes(root: string) { const all: Record<string, string> = {}; async function walk(folder: string) { for (const entry of await readdir(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isDirectory()) await walk(file); else all[path.relative(root, file)] = await fileSha256(file); } } await walk(root); return all; }
async function call(name: string, args: Record<string, unknown>) { const response = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), text = response.content.find(c => c.type === 'text'); if (response.isError || text?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`); return JSON.parse(text.text); }
async function until(predicate: (s: any) => boolean, ms = 90000) { let s; for (const deadline = Date.now() + ms; Date.now() < deadline;) { s = await call('spine_get_native_preview', { id }); if (predicate(s)) return s; if (s.lastError) throw new Error(s.lastError); await sleep(120); } throw new Error(`Current preview timeout: ${JSON.stringify(s)}`); }
const settled = (s: any) => s.generation === s.pendingGeneration && !s.lastError;
const control = (value: Record<string, unknown>) => call('spine_control_native_playback', { id, control: value });
let baseline: any, originalFiles: Record<string, string> | undefined, projectHash: string | undefined, inputHash: string | undefined, failure: unknown;
const report: Record<string, any> = { passed: false, version: VERSION, tools: TOOL_COUNT, id, directory, rates: [], nativeDisplayVerified: false, nativeDisplayReceiptAvailable: false, inputAutomationUsed: false };
try {
  baseline = await call('spine_get_native_preview', { id });
  assert.equal(baseline.requestedPlayback, null, 'Current-preview test requires a static baseline.'); owned.add(baseline.pendingInput);
  originalFiles = await hashes(sourceRoot); projectHash = await fileSha256(baseline.project); inputHash = await fileSha256(baseline.pendingInput);
  report.before = { input: baseline.pendingInput, options: baseline.options, png: baseline.textureSha256, project: baseline.project, projectSha256: projectHash };
  await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive);
  await call('spine_resume_native_preview', { id, options: { durationSeconds: 28800 } }); await until(settled);
  const clone = JSON.parse(await readFile(baseline.pendingInput, 'utf8'));
  for (const kind of ['images', 'audio']) if (clone.skeleton[kind]) clone.skeleton[kind] = path.resolve(path.dirname(baseline.pendingInput), clone.skeleton[kind]);
  const clonePath = path.join(directory, 'clone.json'); await writeFile(clonePath, JSON.stringify(clone), { flag: 'wx' });
  const collected = await call('spine_collect_assets', { input: clonePath }); owned.add(collected.output);
  await call('spine_update_native_preview', { id, input: collected.output, changes: { animation: 'run', time: 0.15, skin: null } }); await until(settled);
  for (const playbackFps of [8, 12, 24]) {
    await control({ action: 'play', start: 0, playbackFps, speed: 1, loop: true, time: 0 });
    const ready = await until(s => settled(s) && s.playback?.state === 'playing');
    console.log(JSON.stringify({ event: 'rate-start', playbackFps, cacheFrames: ready.playback.cacheFrames, cacheBuildMs: ready.playback.cacheBuildMs }));
    await sleep(5000); const after = await call('spine_get_native_preview', { id });
    const frames = after.playback.publishedFrames - ready.playback.publishedFrames, elapsedMs = Date.parse(after.publishedAt) - Date.parse(ready.publishedAt);
    assert.ok(frames >= playbackFps * 3, 'Cached PNG publication should keep up with the conservative minimum.');
    report.rates.push({ requestedPublicationFps: playbackFps, publishedFrames: frames, observedPublicationFps: Math.round(frames * 1000 / elapsedMs * 100) / 100, cacheBuildMs: ready.playback.cacheBuildMs, cacheFrames: ready.playback.cacheFrames, cacheBytes: ready.playback.cacheBytes });
  }
  await control({ action: 'pause' }); const paused = await until(s => settled(s) && s.playback?.state === 'paused'); await sleep(500); assert.equal(await fileSha256(paused.image), paused.textureSha256);
  const edit = await call('spine_set_bone', { input: collected.output, output: path.join(directory, 'edited.json'), bone: 'root', transform: { x: 18 } }); owned.add(edit.path);
  const edited = await until(s => settled(s) && s.input === edit.path && s.playback?.state === 'paused'); assert.notEqual(edited.playback.cacheKey, paused.playback.cacheKey);
  report.ordinaryEditRebuildVerified = true;
  await control({ action: 'seek', time: 0.5 }); await until(s => settled(s) && s.playback?.state === 'paused' && s.playback.currentTime === 0.5);
  await control({ action: 'play', start: 0.1, end: 0.5, playbackFps: 8, speed: 2, loop: false }); await until(s => settled(s) && s.playback?.state === 'completed');
  report.pauseSeekSpeedRangeAndCompletionVerified = true;
  await call('spine_update_native_preview', { id, input: collected.output }); await until(settled);
  await control({ action: 'stop' }); await until(s => settled(s) && !s.playback);
  // A bounded, clearly announced 120-second window for actual native visual
  // observation. This marker is data; it is not a fabricated editor receipt.
  await control({ action: 'play', start: 0, end: 0.6666667, playbackFps: 8, speed: 1, loop: true, time: 0 }); const visual = await until(s => settled(s) && s.playback?.state === 'playing');
  const restoreAt = new Date(Date.now() + 120000).toISOString();
  await writeFile(markerPath, JSON.stringify({ phase: 'playing-for-observation', id, project: visual.project, input: collected.output, playbackFps: 8, restoreAt, reportPath, nativeDisplayVerified: false }, null, 2));
  console.log(JSON.stringify({ event: 'visual-window-start', playbackFps: 8, restoreAt }));
  await sleep(120000); report.passed = true;
} catch (error) { failure = error; report.error = (error as Error).message; }
finally {
  try {
    if (baseline && owned.size) {
      const latest = await call('spine_get_native_preview', { id }); if (!owned.has(latest.pendingInput)) throw new Error('Preview changed outside this test. Restoration skipped.');
      if (latest.stopRequested || Date.parse(latest.expiresAt) <= Date.now()) await call('spine_resume_native_preview', { id, options: { durationSeconds: baseline.options.durationSeconds } });
      await control({ action: 'stop' });
      const o = baseline.options; await call('spine_update_native_preview', { id, input: baseline.pendingInput, changes: { animation: o.animation ?? null, skin: o.skin ?? null, time: o.time, physics: o.physics, fps: o.fps, ...(o.viewport ? { viewport: o.viewport } : { refit: true }), ...(o.skeletonName ? { skeletonName: o.skeletonName } : {}) } });
      const restored = await until(s => settled(s) && !s.playback && s.input === baseline.pendingInput);
      assert.equal(restored.textureSha256, baseline.textureSha256); assert.equal(await fileSha256(baseline.project), projectHash); assert.equal(await fileSha256(baseline.pendingInput), inputHash); assert.deepEqual(await hashes(sourceRoot), originalFiles);
      report.restored = { exactPng: true, sourceAndNativeProjectUnchanged: true, originalFilesUnchanged: Object.keys(originalFiles!).length, generation: restored.generation, sha256: restored.textureSha256 };
      pointer.expiresAt = restored.expiresAt; pointer.lastPlaybackVerification = { version: VERSION, reportPath, at: new Date().toISOString(), nativeDisplayVerified: false }; await writeFile(pointerPath, JSON.stringify(pointer, null, 2));
      await writeFile(markerPath, JSON.stringify({ phase: 'restored', id, reportPath, at: new Date().toISOString() }, null, 2));
    }
  } catch (error) { failure ??= error; report.passed = false; report.restoreError = (error as Error).message; }
  await writeFile(reportPath, JSON.stringify(report, null, 2)); await connection.client.close();
}
console.log(JSON.stringify({ passed: report.passed, reportPath, rates: report.rates, restored: report.restored }, null, 2)); if (failure) throw failure;
