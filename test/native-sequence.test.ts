import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { SpineService } from '../src/service.js';
import { nativePreviewOptions, runNativePreview } from '../src/native-preview.js';
import { sequenceLayout, nativeSequenceRange, nativeSequenceTimes, nativeSequenceDocument } from '../src/native-sequence.js';
import { atomicJson } from '../src/jobs.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';

async function fixture(duration = 1, nativeFps = 4, maxFrames = 120, chunkFrames = 30) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-native-sequence-'))), service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  const demo = await service.createDemo(), animated = await service.editFile(demo.path, path.join(demo.directory, 'wave.json'), [{ type: 'add_animation', name: 'wave' }, { type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: duration, value: 100 }] }]);
  const options = nativePreviewOptions.parse({ animation: 'wave', width: 128, height: 128, viewport: { minX: -50, maxX: 180, minY: -30, maxY: 170 } }), data = (await service.load(animated.path)).data, layout = sequenceLayout(data, 'wave', nativeSequenceRange.parse({ nativeFps, maxFrames, chunkFrames }), 128, 128);
  const id = randomUUID(), folder = path.join(await service.nativePreviews.root(), id); await mkdir(path.join(folder, 'images'), { recursive: true }); service.nativePreviews.kick = async () => undefined;
  const project = path.join(folder, 'MCP-sequence.spine'), expiresAt = new Date(Date.now() + 120000).toISOString(); await writeFile(project, 'CLI-free sequence fixture');
  await atomicJson(path.join(folder, 'request.json'), { id, input: animated.path, sources: [animated.path], generation: 1, options, sequence: layout, projectSha256: await fileSha256(project), expiresAt });
  await atomicJson(path.join(folder, 'status.json'), { id, project, image: path.join(folder, 'images/preview.png'), generation: 0, state: 'starting', input: animated.path, updatedAt: new Date().toISOString(), expiresAt });
  return { root, demo, animated, data, options, layout, service, id, folder, worker: runNativePreview(service, folder) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function until(f: Fixture, predicate: (s: Awaited<ReturnType<SpineService['nativePreviews']['get']>>) => boolean) { for (const deadline = Date.now() + 18000; Date.now() < deadline;) { const s = await f.service.nativePreviews.get(f.id); if (predicate(s)) return s; if (s.state === 'failed') assert.fail(JSON.stringify(s)); await new Promise(r => setTimeout(r, 60)); } assert.fail(JSON.stringify(await f.service.nativePreviews.get(f.id))); }
const ready = (s: Awaited<ReturnType<SpineService['nativePreviews']['get']>>) => s.generation === s.pendingGeneration && s.sequence?.state === 'ready' && !s.lastError;
async function close(f: Fixture) { await f.service.nativePreviews.stop(f.id); await f.worker; }

test('sequence wait verifies every frame and never grants a receipt while a publication journal exists', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    const initial = await f.service.nativePreviews.wait(f.id, { waitMs: 10000 }); assert.equal(initial.outcome, 'published'); assert.equal(initial.sequencePublication?.frameCount, 4);
    await close(f);
    const requestFile = path.join(f.folder, 'request.json'), request = JSON.parse(await readFile(requestFile, 'utf8')); delete request.stop; await atomicJson(requestFile, request);
    const statusFile = path.join(f.folder, 'status.json'), status = JSON.parse(await readFile(statusFile, 'utf8')); status.state = 'watching'; await atomicJson(statusFile, status);
    const damaged = path.join(f.folder, 'images/frame-0002.png'); await writeFile(damaged, 'damaged later frame');
    assert.equal((await f.service.nativePreviews.wait(f.id, { waitMs: 0 })).outcome, 'timeout');
    const journalFile = path.join(f.folder, 'sequence-publication.json'); await atomicJson(journalFile, {});
    assert.equal((await f.service.nativePreviews.wait(f.id, { waitMs: 0 })).outcome, 'timeout'); await unlink(journalFile);
    f.worker = runNativePreview(f.service, f.folder);
    assert.equal((await f.service.nativePreviews.wait(f.id, { waitMs: 10000 })).outcome, 'published');
  } finally { await close(f); }
});

test('native sequence uses endpoint-exclusive frames and a genuine native animation/sequence timeline', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    assert.deepEqual(nativeSequenceTimes(f.layout), [0, 0.25, 0.5, 0.75]);
    const doc = nativeSequenceDocument(f.options, f.layout); assert.equal(doc.skins[0]!.attachments.preview.preview.sequence.count, 4); assert.equal(doc.animations['MCP-playback'].attachments.default.preview.preview.sequence[0]!.delay, 0.25); assert.equal(doc.animations['MCP-playback'].bones.root.rotate[1]!.time, 1);
    const rounded = structuredClone(f.data); (rounded.animations!.wave!.bones as any).arm.rotate[1].time = 0.6666667;
    assert.equal(sequenceLayout(rounded, 'wave', nativeSequenceRange.parse({ nativeFps: 30 }), 128, 128).frameCount, 20);
    assert.throws(() => sequenceLayout(f.data, 'missing', nativeSequenceRange.parse({}), 128, 128), /existing animation/); assert.throws(() => sequenceLayout(f.data, 'wave', nativeSequenceRange.parse({ end: 2 }), 128, 128), /duration/);
  } finally { await close(f); }
});

test('steady native sequence playback produces NO image writes; resume reuses cached frames', { timeout: 25000 }, async () => {
  const f = await fixture(); let watcher: ReturnType<typeof watch> | undefined;
  try {
    const before = await until(f, ready), changes: string[] = []; watcher = watch(path.join(f.folder, 'images'), (_e, name) => changes.push(String(name)));
    await new Promise(r => setTimeout(r, 2600)); assert.deepEqual(changes, []); const idle = await f.service.nativePreviews.get(f.id); assert.equal(idle.textureRevision, before.textureRevision); assert.equal(idle.mode, 'native-image-sequence'); assert.match(idle.instructions, /start playback ONCE/);
    watcher.close(); watcher = undefined; await close(f); await f.service.nativePreviews.resume(f.id); f.worker = runNativePreview(f.service, f.folder); const resumed = await until(f, ready); assert.equal(resumed.sequence?.cacheReused, true); assert.equal(resumed.textureSha256, before.textureSha256);
    await assert.rejects(f.service.nativePreviews.controlPlayback(f.id, { action: 'play' }), /Spine timeline/); await assert.rejects(f.service.nativePreviews.update(f.id, undefined, { time: 0.5 }), /Spine timeline/);
    await unlink(path.join(f.folder, 'images/frame-0002.png')); await until(f, s => ready(s) && (s.textureRevision ?? 0) > (resumed.textureRevision ?? 0)); assert.equal((await readdir(path.join(f.folder, 'images'))).filter(name => name.startsWith('frame-')).length, 4);
  } finally { watcher?.close(); await close(f); }
});

test('ordinary edits and resource changes update the same native sequence; invalid animation retains all old frames', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    const first = await until(f, ready), projectHash = await fileSha256(first.project);
    const a = await f.service.editBone(f.animated.path, path.join(f.demo.directory, 'a.json'), 'root', { x: 10 }), b = await f.service.editBone(a.path, path.join(f.demo.directory, 'b.json'), 'root', { x: 30 });
    const edited = await until(f, s => ready(s) && s.input === b.path); assert.notEqual(edited.sequence!.cacheKey, first.sequence!.cacheKey);
    await writeFile(path.join(f.demo.images, 'arm.png'), encodePng(120, 24, new Uint8Array(120 * 24 * 4).fill(160)));
    const resource = await until(f, s => ready(s) && s.sequence!.cacheKey !== edited.sequence!.cacheKey);
    const frameHash = await fileSha256(path.join(f.folder, 'images/frame-0002.png'));
    await f.service.nativePreviews.update(f.id, undefined, { animation: 'missing' }); await until(f, s => !!s.lastError); assert.equal(await fileSha256(path.join(f.folder, 'images/frame-0002.png')), frameHash);
    await f.service.nativePreviews.update(f.id, undefined, { animation: 'wave' }); const recovered = await until(f, ready); assert.equal(recovered.sequence!.cacheKey, resource.sequence!.cacheKey); assert.equal(await fileSha256(first.project), projectHash);
  } finally { await close(f); }
});

test('incremental sequence rebuilding reuses unchanged poses and avoids writes for unrelated animation edits', { timeout: 25000 }, async () => {
  const f = await fixture(); let watcher: ReturnType<typeof watch> | undefined;
  try {
    await until(f, ready);
    const changed = await f.service.editFile(f.animated.path, path.join(f.demo.directory, 'local-change.json'), [{ type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 50 }, { time: 1, value: 120 }] }]);
    const local = await until(f, s => ready(s) && s.input === changed.path); assert.equal(local.sequence!.renderedFrames, 1); assert.equal(local.sequence!.reusedFrames, 3); assert.equal(local.sequence!.publishedChangedFrames, 1);
    const events: string[] = []; watcher = watch(path.join(f.folder, 'images'), (_type, file) => events.push(String(file)));
    const unrelated = await f.service.editFile(changed.path, path.join(f.demo.directory, 'unrelated.json'), [{ type: 'add_animation', name: 'other' }]);
    const reused = await until(f, s => ready(s) && s.input === unrelated.path); assert.equal(reused.sequence!.renderedFrames, 0); assert.equal(reused.sequence!.reusedFrames, 4); assert.equal(reused.sequence!.publishedChangedFrames, 0); assert.deepEqual(events, []);
  } finally { watcher?.close(); await close(f); }
});

test('explicit long sequences prepare more than 120 frames in bounded chunks', { timeout: 30000 }, async () => {
  const f = await fixture(5, 30, 600, 20);
  try {
    const status = await until(f, ready); assert.equal(status.sequence!.layout.frameCount, 150); assert.equal(status.sequence!.chunks!.length, 8); assert.equal(status.sequence!.renderedFrames, 150); assert.equal(status.sequence!.chunks!.at(-1)!.endFrame, 149);
    assert.throws(() => sequenceLayout(f.data, 'wave', nativeSequenceRange.parse({ nativeFps: 30 }), 128, 128), /maxFrames/);
    assert.throws(() => sequenceLayout(f.data, 'wave', nativeSequenceRange.parse({ nativeFps: 30, maxFrames: 600 }), 1024, 1024), /64 million/);
    const request = await f.service.nativePreviews.request(f.folder), source = await f.service.load(request.input); assert.equal(sequenceLayout(source.data, 'wave', request.sequence!, 128, 128).frameCount, 150);
  } finally { await close(f); }
});

test('identical sampled frames deduplicate within a fresh cache without discarding cache validation', { timeout: 25000 }, async () => {
  const f = await fixture();
  try {
    await until(f, ready);
    const changed = await f.service.editFile(f.animated.path, path.join(f.demo.directory, 'constant.json'), [{ type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 12 }, { time: 1, value: 12 }] }]);
    const status = await until(f, s => ready(s) && s.input === changed.path); assert.equal(status.sequence!.renderedFrames, 1); assert.equal(status.sequence!.deduplicatedFrames, 3);
    const cache = JSON.parse(await readFile(path.join(f.folder, 'sequence-cache.json'), 'utf8')); await writeFile(path.join(cache.directory, 'frame-0000.png'), 'corrupt cache');
    await f.service.nativePreviews.update(f.id, undefined, { time: undefined }); const recovered = await until(f, s => ready(s) && s.generation > status.generation); assert.equal(recovered.sequence!.cacheReused, false); assert.equal(recovered.sequence!.renderedFrames, 1); assert.equal(recovered.sequence!.deduplicatedFrames, 3);
  } finally { await close(f); }
});
