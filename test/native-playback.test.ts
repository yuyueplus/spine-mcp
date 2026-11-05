import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { SpineService } from '../src/service.js';
import { nativePreviewOptions, runNativePreview, type NativePreviewStatus } from '../src/native-preview.js';
import { NativePlaybackRunner, nativePlaybackControl, playbackPlan, playbackPosition } from '../src/native-playback.js';
import { atomicJson } from '../src/jobs.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';
import { auditAssets } from '../src/production-assets.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-playback-'))), service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  const demo = await service.createDemo(), animated = await service.editFile(demo.path, path.join(demo.directory, 'wave.json'), [{ type: 'add_animation', name: 'wave' }, { type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }] }]);
  const id = randomUUID(), folder = path.join(await service.nativePreviews.root(), id); await mkdir(path.join(folder, 'images'), { recursive: true });
  service.nativePreviews.kick = async () => undefined;
  const options = nativePreviewOptions.parse({ animation: 'wave', time: 0.25, width: 128, height: 128, viewport: { minX: -40, maxX: 180, minY: -50, maxY: 160 } }), expiresAt = new Date(Date.now() + 120000).toISOString();
  const project = path.join(folder, 'MCP-preview.spine'); await writeFile(project, 'CLI-free test fixture');
  await atomicJson(path.join(folder, 'request.json'), { id, input: animated.path, sources: [animated.path], options, expiresAt, generation: 1, recoveryEpoch: randomUUID(), projectSha256: await fileSha256(project) });
  await atomicJson(path.join(folder, 'status.json'), { id, input: animated.path, project, image: path.join(folder, 'images/preview.png'), generation: 0, state: 'starting', expiresAt, updatedAt: new Date().toISOString() });
  return { service, demo, animated, id, folder, worker: runNativePreview(service, folder) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function until(f: Fixture, predicate: (s: Awaited<ReturnType<SpineService['nativePreviews']['get']>>) => boolean, ms = 18000) {
  const deadline = Date.now() + ms;
  do { const s = await f.service.nativePreviews.get(f.id); if (predicate(s)) return s; if (s.state === 'failed') assert.fail(JSON.stringify(s)); await new Promise(r => setTimeout(r, 35)); } while (Date.now() < deadline);
  assert.fail(JSON.stringify(await f.service.nativePreviews.get(f.id)));
}
const settled = (s: Awaited<ReturnType<SpineService['nativePreviews']['get']>>) => s.generation === s.pendingGeneration && !s.lastError;
async function close(f: Fixture) { await f.service.nativePreviews.stop(f.id); await f.worker; }
const control = (f: Fixture, value: unknown) => f.service.nativePreviews.controlPlayback(f.id, value);

test('playback clock loops and completes at exact endpoints; control validation keeps physics FPS separate', () => {
  assert.deepEqual(playbackPosition(0.5, 1000, { start: 0, end: 1, speed: 2, loop: true }), { time: 0.5, completed: false });
  assert.deepEqual(playbackPosition(0, 2000, { start: 0, end: 1, speed: 0.5, loop: false }), { time: 1, completed: true });
  for (const raw of [{ action: 'seek' }, { action: 'play', playbackFps: 25 }, { action: 'play', speed: 0 }, { action: 'pause', speed: 2 }, { action: 'stop', time: 0 }, { action: 'play', fps: 30 }]) assert.equal(nativePlaybackControl.safeParse(raw).success, false);
});

test('cached playback pauses, seeks, changes speed/range, completes and restores the exact static pose', { timeout: 25000 }, async () => {
  const f = await fixture(), changedFiles = new Set<string>();
  const watcher = watch(path.join(f.folder, 'images'), (_event, name) => { if (name) changedFiles.add(String(name)); });
  try {
    const before = await until(f, settled), projectHash = await fileSha256(before.project);
    await control(f, { action: 'play', playbackFps: 8 });
    const playing = await until(f, s => settled(s) && s.playback?.state === 'playing' && s.playback.publishedFrames >= 3 && s.textureSha256 !== before.textureSha256), cacheKey = playing.playback!.cacheKey;
    assert.notEqual(playing.textureSha256, before.textureSha256); assert.equal(playing.options.fps, 60); assert.equal(playing.playback!.playbackFps, 8);
    await control(f, { action: 'pause' }); const paused = await until(f, s => settled(s) && s.playback?.state === 'paused');
    await new Promise(r => setTimeout(r, 350)); assert.equal(await fileSha256(paused.image), paused.textureSha256);
    await control(f, { action: 'seek', time: 0.75 }); const seek = await until(f, s => settled(s) && s.playback?.currentTime === 0.75);
    assert.equal(seek.playback!.state, 'paused'); assert.equal(seek.playback!.cacheKey, cacheKey); assert.notEqual(seek.textureSha256, paused.textureSha256);
    await control(f, { action: 'play', start: 0.25, end: 0.75, speed: 2, loop: false, playbackFps: 8 });
    const complete = await until(f, s => settled(s) && s.playback?.state === 'completed'); assert.equal(complete.playback!.currentTime, 0.75);
    const revision = complete.textureRevision; await new Promise(r => setTimeout(r, 300)); assert.equal((await f.service.nativePreviews.get(f.id)).textureRevision, revision);
    await control(f, { action: 'stop' }); const restored = await until(f, s => settled(s) && !s.playback);
    assert.equal(restored.textureSha256, before.textureSha256); assert.equal(await fileSha256(before.project), projectHash);
    assert.deepEqual([...changedFiles], ['preview.png'], 'Only the final PNG may generate events in the watched image directory.');
  } finally { watcher.close(); await close(f); }
});

test('editing and image-only changes invalidate a paused cache; errors retain the last good image', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    await until(f, settled); await control(f, { action: 'play', playbackFps: 4 }); await until(f, s => settled(s) && s.playback?.state === 'playing');
    await control(f, { action: 'pause' }); const paused = await until(f, s => settled(s) && s.playback?.state === 'paused');
    const a = await f.service.editBone(f.animated.path, path.join(f.demo.directory, 'edit-a.json'), 'root', { x: 10 });
    const b = await f.service.editBone(a.path, path.join(f.demo.directory, 'edit-b.json'), 'root', { x: 30 });
    const edited = await until(f, s => settled(s) && s.input === b.path && s.playback?.state === 'paused');
    assert.notEqual(edited.playback!.cacheKey, paused.playback!.cacheKey); assert.notEqual(edited.textureSha256, paused.textureSha256);
    await writeFile(path.join(f.demo.images, 'arm.png'), encodePng(120, 24, new Uint8Array(120 * 24 * 4).fill(160)));
    const resource = await until(f, s => settled(s) && s.playback?.state === 'paused' && s.playback.cacheKey !== edited.playback!.cacheKey);
    assert.notEqual(resource.textureSha256, edited.textureSha256);
    await f.service.nativePreviews.update(f.id, undefined, { animation: 'missing-animation' });
    const error = await until(f, s => !!s.lastError); assert.equal(await fileSha256(error.image), resource.textureSha256); assert.equal(error.playback?.state, 'error');
    await f.service.nativePreviews.update(f.id, undefined, { animation: 'wave' }); await until(f, s => settled(s) && s.playback?.state === 'paused');
    assert.equal((await readdir(f.folder)).filter(name => /^playback-[a-f0-9-]{36}$/.test(name)).length, 1);
  } finally { await close(f); }
});

test('a prepared paused cache stays building until its selected PNG is actually published', async () => {
  const f = await fixture();
  try {
    await until(f, settled); await close(f); await f.service.nativePreviews.resume(f.id);
    const request = await f.service.nativePreviews.request(f.folder);
    request.playback = { state: 'paused', start: 0, end: 1, playbackFps: 1, speed: 1, loop: true, time: 0.25, revision: randomUUID() };
    await atomicJson(path.join(f.folder, 'request.json'), request);
    const status = JSON.parse(await readFile(path.join(f.folder, 'status.json'), 'utf8')) as NativePreviewStatus;
    const oldImageHash = await fileSha256(status.image), loaded = await f.service.load(request.input);
    let publications = 0;
    const runner = new NativePlaybackRunner(f.service, f.folder, status,
      () => atomicJson(path.join(f.folder, 'status.json'), status),
      async (source, destination) => { publications++; await copyFile(source, destination); });
    await runner.ensure(request, { signature: 'paused-cache-boundary', sourceHash: await fileSha256(request.input), loaded,
      assets: await auditAssets(f.service.workspace, loaded.data, loaded.jsonPath, false) });
    assert.equal(publications, 0); assert.equal(await fileSha256(status.image), oldImageHash);
    assert.equal(status.playback?.state, 'building');
    const persisted = JSON.parse(await readFile(path.join(f.folder, 'status.json'), 'utf8'));
    assert.equal(persisted.playback.state, 'building');
    await runner.tick(request);
    assert.equal(publications, 1); assert.equal(status.playback?.state, 'paused');
    assert.equal(status.textureSha256, await fileSha256(status.image));
  } finally { await close(f); }
});

test('worker restart reuses a verified cache and last committed paused frame; corrupt cached frames are rebuilt', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    await until(f, settled); await control(f, { action: 'play', playbackFps: 4 }); await until(f, s => settled(s) && s.playback?.state === 'playing');
    await control(f, { action: 'pause' }); const paused = await until(f, s => settled(s) && s.playback?.state === 'paused');
    const manifest = JSON.parse(await readFile(path.join(f.folder, 'playback-cache.json'), 'utf8'));
    await close(f); await f.service.nativePreviews.resume(f.id); f.worker = runNativePreview(f.service, f.folder);
    const resumed = await until(f, s => settled(s) && s.playback?.state === 'paused'); assert.equal(resumed.textureSha256, paused.textureSha256); assert.equal(resumed.playback?.cacheReused, true);
    await close(f); await writeFile(path.join(manifest.directory, 'frame-0000.png'), 'damaged cache');
    await f.service.nativePreviews.resume(f.id); f.worker = runNativePreview(f.service, f.folder);
    const rebuilt = await until(f, s => settled(s) && s.playback?.state === 'paused'); assert.equal(rebuilt.textureSha256, paused.textureSha256); assert.equal(rebuilt.playback?.cacheReused, false);
  } finally { await close(f); }
});

test('stopping during cache preparation cancels stale publication and removes the incomplete cache', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    const before = await until(f, settled); await control(f, { action: 'play', playbackFps: 24 }); await until(f, s => s.playback?.state === 'building');
    await control(f, { action: 'stop' }); const restored = await until(f, s => settled(s) && !s.playback);
    assert.equal(restored.textureSha256, before.textureSha256);
    assert.equal((await readdir(f.folder)).filter(name => /^playback-[a-f0-9-]{36}$/.test(name)).length, 0);
  } finally { await close(f); }
});

test('playing worker resumes at the last committed time and completed non-looping playback does not restart', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    await until(f, settled); await control(f, { action: 'play', playbackFps: 4, loop: false });
    await until(f, s => settled(s) && (s.playback?.currentTime ?? 0) >= 0.5);
    await close(f); const committed = await f.service.nativePreviews.get(f.id);
    await f.service.nativePreviews.resume(f.id); f.worker = runNativePreview(f.service, f.folder);
    const resumed = await until(f, settled); assert.ok(resumed.playback!.currentTime >= committed.playback!.currentTime); assert.equal(resumed.playback!.cacheReused, true);
    await until(f, s => s.playback?.state === 'completed'); await close(f);
    await f.service.nativePreviews.resume(f.id); f.worker = runNativePreview(f.service, f.folder);
    const completed = await until(f, settled); assert.equal(completed.playback?.state, 'completed'); assert.equal(completed.playback?.currentTime, 1);
  } finally { await close(f); }
});

test('out-of-range or oversized playback is rejected before changing the request or image', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    const before = await until(f, settled), request = await readFile(path.join(f.folder, 'request.json'), 'utf8');
    for (const value of [{ action: 'play', start: 0.8, end: 0.4 }, { action: 'play', end: 1.1 }, { action: 'play', time: 2 }]) await assert.rejects(control(f, value), /Playback/);
    assert.equal(await readFile(path.join(f.folder, 'request.json'), 'utf8'), request); assert.equal(await fileSha256(before.image), before.textureSha256);
    const data = (await f.service.load(f.animated.path)).data, r = JSON.parse(request); r.playback = { state: 'playing', start: 0, end: 1, playbackFps: 120, speed: 1, loop: true, time: 0, revision: 'test' };
    assert.throws(() => playbackPlan(data, r), /120 frames/);
  } finally { await close(f); }
});
