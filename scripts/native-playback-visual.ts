import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION } from '../src/version.js';

const config = await loadConfig(), pointer = JSON.parse(await readFile(path.join(config.workspaceRoot, 'current-native-preview.json'), 'utf8')), id = pointer.id;
const { client, timeoutMs } = await connectSpine(), sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const markerPath = path.join(config.workspaceRoot, 'current-native-playback-trial.json'), reportPath = path.join(config.workspaceRoot, `native-playback-visual-report-${VERSION}.json`);
const report: Record<string, any> = { version: VERSION, backendPassed: false, humanVerified: false, id, delivery: 'staging-outside-images-and-constant-size-png', note: 'Visual acknowledgement requires a separate human observation. PNG publication is not native display FPS.' };
async function call(name: string, args: Record<string, unknown>) { const r = await client.callTool({ name, arguments: args }, { timeout: timeoutMs }), b = r.content.find(c => c.type === 'text'); if (r.isError || b?.type !== 'text') throw new Error(JSON.stringify(r.content)); return JSON.parse(b.text); }
async function until(predicate: (s: any) => boolean) { for (const deadline = Date.now() + 60000; Date.now() < deadline;) { const s = await call('spine_get_native_preview', { id }); if (predicate(s)) return s; if (s.lastError) throw new Error(s.lastError); await sleep(100); } throw new Error('Visual trial preparation timed out.'); }
const settled = (s: any) => s.generation === s.pendingGeneration && !s.lastError;
let before: any, sourceHash: string | undefined, projectHash: string | undefined, failure: unknown;
try {
  before = await call('spine_get_native_preview', { id }); assert.equal(before.requestedPlayback, null); sourceHash = await fileSha256(before.pendingInput); projectHash = await fileSha256(before.project);
  await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive);
  await call('spine_resume_native_preview', { id }); await until(settled);
  await call('spine_control_native_playback', { id, control: { action: 'play', start: 0, playbackFps: 8, loop: true, time: 0 } });
  const ready = await until(s => settled(s) && s.playback?.state === 'playing');
  const cache = JSON.parse(await readFile(path.join(ready.directory, 'playback-cache.json'), 'utf8')), sizes = await Promise.all(cache.times.map((_: number, i: number) => readFile(path.join(cache.directory, `frame-${String(i).padStart(4, '0')}.png`)).then(b => b.length)));
  assert.equal(new Set(sizes).size, 1);
  report.startedAt = new Date().toISOString(); report.playbackFps = 8; report.frameBytes = sizes[0]; report.cacheFrames = sizes.length; report.before = { input: before.pendingInput, png: before.textureSha256, project: before.project };
  const restoreAt = new Date(Date.now() + 90000).toISOString(); await writeFile(markerPath, JSON.stringify({ phase: 'playing-for-observation', delivery: report.delivery, id, playbackFps: 8, restoreAt, reportPath }, null, 2));
  console.log(JSON.stringify({ event: 'corrected-visual-window-start', restoreAt, frameBytes: sizes[0] }));
  for (let i = 0; i < 180; i++) { await sleep(500); const marker = JSON.parse(await readFile(markerPath, 'utf8')); if (marker.stopRequested) break; }
  const after = await call('spine_get_native_preview', { id }); assert.ok(after.playback.publishedFrames > ready.playback.publishedFrames + 4); report.publishedFrames = after.playback.publishedFrames - ready.playback.publishedFrames; report.backendPassed = true;
} catch (error) { failure = error; report.error = (error as Error).message; }
finally {
  try {
    if (before) { const latest = await call('spine_get_native_preview', { id }); assert.equal(latest.pendingInput, before.pendingInput, 'External edit detected; leave that edit intact.'); await call('spine_control_native_playback', { id, control: { action: 'stop' } }); const restored = await until(s => settled(s) && !s.playback); assert.equal(restored.textureSha256, before.textureSha256); assert.equal(await fileSha256(before.pendingInput), sourceHash); assert.equal(await fileSha256(before.project), projectHash); report.restoredExactly = true; }
  } catch (error) { failure ??= error; report.backendPassed = false; report.restoreError = (error as Error).message; }
  await writeFile(reportPath, JSON.stringify(report, null, 2)); await writeFile(markerPath, JSON.stringify({ phase: 'restored', id, reportPath }, null, 2)); await client.close();
}
console.log(JSON.stringify({ backendPassed: report.backendPassed, reportPath, restoredExactly: report.restoredExactly })); if (failure) throw failure;
