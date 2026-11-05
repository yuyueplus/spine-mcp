import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

let connection = await connectSpine(), id: string | undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function call(name: string, args: Record<string, unknown>) {
  const result = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), text = result.content.find(item => item.type === 'text');
  if (result.isError || text?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse(text.text);
}
async function until(predicate: (s: any) => boolean, ms = 45000) {
  let s; for (const deadline = Date.now() + ms; Date.now() < deadline;) { s = await call('spine_get_native_preview', { id }); if (predicate(s)) return s; if (s.state === 'failed') throw new Error(JSON.stringify(s)); await sleep(80); } throw new Error(`Playback timeout: ${JSON.stringify(s)}`);
}
const settled = (s: any) => s.generation === s.pendingGeneration && !s.lastError;
const control = (value: Record<string, unknown>) => call('spine_control_native_playback', { id, control: value });
const rates: any[] = [];
try {
  assert.equal((await call('spine_status', {})).serverVersion, VERSION); assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT);
  const demo = await call('spine_create_demo', {}), demoHash = await fileSha256(demo.path);
  const animated = await call('spine_apply_edits', { input: demo.path, output: path.join(demo.directory, 'playback.json'), edits: [{ type: 'add_animation', name: 'wave' }, { type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 120 }] }] });
  const started = await call('spine_start_native_preview', { input: animated.path, options: { animation: 'wave', time: 0.25, width: 160, height: 160, durationSeconds: 240 } }); id = started.id;
  const projectHash = await fileSha256(started.project); await until(s => settled(s) && s.workerAlive && s.supervisorAlive);
  for (const playbackFps of [4, 8, 12, 24]) {
    await control({ action: 'play', playbackFps, time: 0, loop: true }); const ready = await until(s => settled(s) && s.playback?.state === 'playing');
    const at = Date.now(); await sleep(2500); const after = await call('spine_get_native_preview', { id });
    const delta = after.playback.publishedFrames - ready.playback.publishedFrames, elapsedMs = Date.parse(after.publishedAt) - Date.parse(ready.publishedAt);
    assert.ok(delta >= playbackFps * 1.7, JSON.stringify(after));
    rates.push({ requestedPublicationFps: playbackFps, publishedFrames: delta, observedPublicationFps: Math.round(delta * 1000 / elapsedMs * 100) / 100, windowMs: Date.now() - at, cacheBuildMs: ready.playback.cacheBuildMs, cacheFrames: ready.playback.cacheFrames, cacheBytes: ready.playback.cacheBytes });
  }
  await control({ action: 'pause' }); const paused = await until(s => settled(s) && s.playback?.state === 'paused');
  await sleep(400); assert.equal(await fileSha256(paused.image), paused.textureSha256);
  await control({ action: 'seek', time: 0.75 }); const sought = await until(s => settled(s) && s.playback?.currentTime === 0.75); assert.equal(sought.playback.state, 'paused'); assert.equal(sought.playback.cacheKey, paused.playback.cacheKey);
  await connection.client.close(); connection = await connectSpine(); assert.equal((await call('spine_get_native_preview', { id })).workerPid, sought.workerPid);
  const edit = await call('spine_set_bone', { input: animated.path, output: path.join(demo.directory, 'edit.json'), bone: 'root', transform: { x: 12 } });
  const edited = await until(s => settled(s) && s.input === edit.path && s.playback?.state === 'paused'); assert.notEqual(edited.playback.cacheKey, sought.playback.cacheKey);
  await writeFile(path.join(demo.images, 'arm.png'), encodePng(120, 24, new Uint8Array(120 * 24 * 4).fill(175)));
  const resource = await until(s => settled(s) && s.playback?.state === 'paused' && s.playback.cacheKey !== edited.playback.cacheKey); assert.notEqual(resource.textureSha256, edited.textureSha256);
  await control({ action: 'play', start: 0.25, end: 0.75, playbackFps: 8, speed: 2, loop: false }); const complete = await until(s => settled(s) && s.playback?.state === 'completed'); assert.equal(complete.playback.currentTime, 0.75);
  await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive);
  await call('spine_resume_native_preview', { id }); const resumed = await until(s => settled(s) && s.playback?.state === 'completed'); assert.equal(resumed.playback.cacheReused, true); assert.equal(resumed.textureSha256, complete.textureSha256);
  await control({ action: 'stop' }); const restored = await until(s => settled(s) && !s.playback); assert.equal(restored.requestedPlayback, null);
  assert.equal(await fileSha256(demo.path), demoHash); assert.equal(await fileSha256(started.project), projectHash);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, newToolsInvoked: ['spine_control_native_playback'], rates, pausedImageStable: true, seekReusesCache: true, rangeSpeedAndNonLoopCompletionVerified: true, editInvalidatesCache: true, imageOnlyChangeInvalidatesCache: true, mcpDisconnectKeepsWorker: true, completedPlaybackResumedWithoutRestarting: true, persistentCacheReused: true, staticPoseRestored: true, sourceAndNativeProjectUnchanged: true, editorDisplayAcknowledged: false, nativeVisualVerification: 'Not inferred from PNG rates. Requires observing the opened dedicated native preview.', project: started.project };
  const reportPath = path.join(projectRoot, `work/native-playback-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, reportPath, rates }, null, 2));
} finally { if (id) { try { await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive); } catch {} } await connection.client.close(); }
