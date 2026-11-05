import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { SpineService } from '../src/service.js';
import { fileSha256 } from '../src/file-hash.js';
import { atomicJson } from '../src/jobs.js';
import { previewRequestId, previewMutationOptions } from '../src/preview-requests.js';
import { encodePng } from '../src/raster.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
interface Controls { imports: number; exports: number; kicks: number; beforeImport?: () => Promise<void>; afterImport?: () => Promise<void> }
function serviceAt(root: string, controls: Controls) {
  const service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  service.nativePreviews.kick = async () => { controls.kicks++; };
  // Unit tests exercise the request lifecycle; real 4.3.23 import/export is
  // independently exercised by preview-requests-smoke through MCP.
  service.cli.importProject = async (json, project) => {
    controls.imports++; await controls.beforeImport?.(); await copyFile(json, project); await controls.afterImport?.(); return {} as any;
  };
  service.cli.exportData = async project => {
    controls.exports++; const directory = path.join(root, `export-${randomUUID()}`); await mkdir(directory);
    const data = JSON.parse(await readFile(project, 'utf8')); data.skeleton.images = path.join(path.dirname(project), 'images');
    const file = path.join(directory, 'preview.json'); await writeFile(file, JSON.stringify(data)); return { directory, files: [file] } as any;
  };
  return service;
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-preview-requests-'))), controls: Controls = { imports: 0, exports: 0, kicks: 0 }, service = serviceAt(root, controls), demo = await service.createDemo();
  const id = randomUUID(), options = { width: 128, height: 128, durationSeconds: 60 };
  const start = () => service.nativePreviews.start(demo.path, options, undefined, id);
  return { root, controls, service, demo, id, options, start };
}

test('same creation key shares an in-flight build and completed replays never rewrite images or import twice', async () => {
  const f = await fixture(), entered = deferred(), gate = deferred(); f.controls.beforeImport = async () => { entered.resolve(); await gate.promise; };
  const first = f.start(); await entered.promise;
  try {
    const concurrent = await f.start(); assert.equal(concurrent.id, f.id); assert.equal(concurrent.creationPending, true); assert.equal(concurrent.creation?.ownerAlive, true); assert.equal(concurrent.resumable, false);
    await assert.rejects(f.service.nativePreviews.update(f.id, undefined, {}), /creation is importing/);
    await assert.rejects(f.service.nativePreviews.resume(f.id), /creation is importing/);
    await assert.rejects(f.service.nativePreviews.controlPlayback(f.id, { action: 'play' }), /creation is importing/);
    gate.resolve(); const complete = await first, imageTime = (await stat(complete.image)).mtimeMs, before = await fileSha256(complete.project), kicks = f.controls.kicks;
    const replay = await serviceAt(f.root, f.controls).nativePreviews.start(f.demo.path, f.options, undefined, f.id);
    assert.equal(replay.id, f.id); assert.equal(replay.creationReused, true); assert.equal(replay.creationPending, false); assert.equal(replay.pendingGeneration, 1);
    assert.equal(f.controls.imports, 1); assert.equal(f.controls.kicks, kicks); assert.equal(await fileSha256(replay.project), before); assert.equal((await stat(replay.image)).mtimeMs, imageTime);
    assert.deepEqual((await readdir(path.join(f.root, '.native-previews'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name), [f.id]);
  } finally { gate.resolve(); await first.catch(() => undefined); }
});

test('interrupted completed import is independently verified and reused by a new service instance', async () => {
  const f = await fixture(); f.controls.afterImport = async () => { throw new Error('response lost after native import'); };
  await assert.rejects(f.start(), /response lost/); const failed = await f.service.nativePreviews.get(f.id), before = await fileSha256(failed.project); assert.equal(failed.creation?.phase, 'failed');
  delete f.controls.afterImport;
  const resumed = await serviceAt(f.root, f.controls).nativePreviews.start(f.demo.path, f.options, undefined, f.id);
  assert.equal(resumed.creation?.phase, 'ready'); assert.equal(resumed.creation?.attempts, 2); assert.equal(resumed.creationReused, true); assert.equal(f.controls.imports, 1); assert.equal(f.controls.exports, 1); assert.equal(await fileSha256(resumed.project), before);
});

test('supervisor startup failure after durable creation preserves the ready record and allows explicit resume', async () => {
  const f = await fixture(); f.service.nativePreviews.kick = async () => { throw new Error('supervisor launch unavailable'); };
  await assert.rejects(f.start(), /supervisor launch unavailable/);
  const created = await f.service.nativePreviews.get(f.id), hash = await fileSha256(created.project), imageTime = (await stat(created.image)).mtimeMs;
  assert.equal(created.creation?.phase, 'ready'); assert.equal(created.resumable, true);
  const service = serviceAt(f.root, f.controls), replay = await service.nativePreviews.start(f.demo.path, f.options, undefined, f.id);
  assert.equal(replay.creationReused, true); assert.equal(replay.creation?.attempts, 1); assert.equal(f.controls.imports, 1); assert.equal(await fileSha256(replay.project), hash); assert.equal((await stat(replay.image)).mtimeMs, imageTime);
  const resumed = await service.nativePreviews.resume(f.id, {}, { requestId: randomUUID(), expectedGeneration: 1 }); assert.equal(resumed.pendingGeneration, 2);
});

test('creation request keys bind parameters and original source/resource revision', async () => {
  const f = await fixture(), created = await f.start(), before = await fileSha256(created.project), image = await fileSha256(created.image);
  await assert.rejects(f.service.nativePreviews.start(f.demo.path, { ...f.options, width: 160 }, undefined, f.id), /different preview/);
  await writeFile(path.join(f.demo.images, 'arm.png'), encodePng(120, 24, new Uint8Array(120 * 24 * 4).fill(170)));
  await assert.rejects(f.start(), /different preview/);
  assert.equal(await fileSha256(created.project), before); assert.equal(await fileSha256(created.image), image); assert.equal(f.controls.imports, 1);
});

test('prepared JSON, uncertain native contents and completed native contents are not overwritten', async () => {
  const f = await fixture(); f.controls.beforeImport = async () => { throw new Error('before import'); }; await assert.rejects(f.start(), /before import/);
  const failed = await f.service.nativePreviews.get(f.id), json = path.join(failed.directory, 'preview.json'); await writeFile(json, '{"external":true}');
  delete f.controls.beforeImport; await assert.rejects(f.start(), /Prepared preview JSON changed/); assert.equal(await readFile(json, 'utf8'), '{"external":true}');
  const g = await fixture(); g.controls.afterImport = async () => { throw new Error('after import'); }; await assert.rejects(g.start(), /after import/); const uncertain = await g.service.nativePreviews.get(g.id);
  const wrong = JSON.parse(await readFile(uncertain.project, 'utf8')); wrong.bones[0].x = 777; await writeFile(uncertain.project, JSON.stringify(wrong)); const changed = await fileSha256(uncertain.project); delete g.controls.afterImport;
  await assert.rejects(g.start(), /Bone root.x differs/); assert.equal(g.controls.imports, 1); assert.equal(await fileSha256(uncertain.project), changed);
  const h = await fixture(), ready = await h.start(); await writeFile(ready.project, 'user native change'); await assert.rejects(h.start(), /native project changed/); assert.equal(await readFile(ready.project, 'utf8'), 'user native change');
});

test('stopping an in-flight creation is cooperative and stable retries preserve cancellation and stop receipt', async () => {
  const f = await fixture(), entered = deferred(), gate = deferred(), stopId = randomUUID(); f.controls.beforeImport = async () => { entered.resolve(); await gate.promise; };
  const first = f.start(); const failure = assert.rejects(first, /cancelled/); await entered.promise;
  await f.service.nativePreviews.stop(f.id, { requestId: stopId, expectedGeneration: 1 }); gate.resolve(); await failure;
  const replay = await f.start(); assert.equal(replay.state, 'stopped'); assert.equal(replay.creation?.phase, 'cancelled'); assert.equal(replay.creationPending, false); assert.equal(f.controls.imports, 1); assert.equal(f.controls.kicks, 0);
  const stopped = await f.service.nativePreviews.stop(f.id, { requestId: stopId, expectedGeneration: 1 }); assert.equal(stopped.requestReceipt.reused, true);
});

test('duplicate updates commit only once, while concurrent generation guards accept only one new request', async () => {
  const f = await fixture(); await f.start(); const key = randomUUID(), conditions = { requestId: key, expectedGeneration: 1 };
  const pair = await Promise.all([f.service.nativePreviews.update(f.id, undefined, { time: 0.25 }, conditions), f.service.nativePreviews.update(f.id, undefined, { time: 0.25 }, conditions)]);
  assert.deepEqual(pair.map(r => r.requestReceipt.generation), [2, 2]); assert.equal(pair.filter(r => r.requestReceipt.reused).length, 1);
  const options = await f.service.nativePreviews.request(await f.service.nativePreviews.folder(f.id)); assert.equal(options.generation, 2); assert.equal(options.mutationReceipts?.length, 1);
  const competing = await Promise.allSettled([f.service.nativePreviews.update(f.id, undefined, { time: 0.5 }, { requestId: randomUUID(), expectedGeneration: 2 }), f.service.nativePreviews.update(f.id, undefined, { time: 0.75 }, { requestId: randomUUID(), expectedGeneration: 2 })]);
  assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1); assert.match(String((competing.find(r => r.status === 'rejected') as PromiseRejectedResult).reason), /generation conflict/);
  const file = path.join(await f.service.nativePreviews.folder(f.id), 'request.json'), before = await readFile(file, 'utf8');
  const historical = await serviceAt(f.root, f.controls).nativePreviews.update(f.id, undefined, { time: 0.25 }, conditions); assert.equal(historical.requestReceipt.generation, 2); assert.equal(historical.requestReceipt.reused, true); assert.equal(historical.pendingGeneration, 3); assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(f.service.nativePreviews.update(f.id, undefined, { time: 1 }, conditions), /different preview mutation/); assert.equal(await readFile(file, 'utf8'), before);
});

test('stale update, resume and stop requests leave exact request bytes unchanged', async () => {
  const f = await fixture(), created = await f.start(); await f.service.nativePreviews.update(f.id, undefined, { time: 0.25 }); const file = path.join(created.directory, 'request.json'), before = await readFile(file, 'utf8');
  for (const attempt of [() => f.service.nativePreviews.update(f.id, undefined, {}, { expectedGeneration: 1 }), () => f.service.nativePreviews.resume(f.id, {}, { expectedGeneration: 1 }), () => f.service.nativePreviews.stop(f.id, { expectedGeneration: 1 })]) { await assert.rejects(attempt(), /generation conflict/); assert.equal(await readFile(file, 'utf8'), before); }
});

test('replaying a stop never stops a later resume, and replaying a resume never extends its lifetime again', async () => {
  const f = await fixture(); await f.start(); const stop = { requestId: randomUUID(), expectedGeneration: 1 }, resume = { requestId: randomUUID(), expectedGeneration: 1 };
  await f.service.nativePreviews.stop(f.id, stop); const restored = await f.service.nativePreviews.resume(f.id, { durationSeconds: 90 }, resume), expiry = restored.expiresAt;
  const file = path.join(restored.directory, 'request.json'), before = await readFile(file, 'utf8');
  const oldStop = await f.service.nativePreviews.stop(f.id, stop); assert.equal(oldStop.requestReceipt.reused, true); assert.equal(oldStop.stopRequested, false); assert.equal(await readFile(file, 'utf8'), before);
  const oldResume = await serviceAt(f.root, f.controls).nativePreviews.resume(f.id, { durationSeconds: 90 }, resume); assert.equal(oldResume.requestReceipt.reused, true); assert.equal(oldResume.expiresAt, expiry); assert.equal(await readFile(file, 'utf8'), before);
  await assert.rejects(f.service.nativePreviews.stop(f.id, { requestId: resume.requestId }), /different preview mutation/);
});

test('historical update replay still works after its old input file has been removed', async () => {
  const f = await fixture(); await f.start(); const old = path.join(f.demo.directory, 'old.json'), next = path.join(f.demo.directory, 'next.json'); await copyFile(f.demo.path, old); await copyFile(f.demo.path, next);
  const conditions = { requestId: randomUUID(), expectedGeneration: 1 }; await f.service.nativePreviews.update(f.id, old, {}, conditions); await f.service.nativePreviews.update(f.id, next, {}); await unlink(old);
  const file = path.join(await f.service.nativePreviews.folder(f.id), 'request.json'), before = await readFile(file, 'utf8'), receipt = await f.service.nativePreviews.update(f.id, old, {}, conditions);
  assert.equal(receipt.requestReceipt.reused, true); assert.equal(receipt.pendingInput, next); assert.equal(await readFile(file, 'utf8'), before);
});

test('receipt capacity never evicts old keys and legacy updates can continue without requestId', async () => {
  const f = await fixture(); await f.start(); const conditions = { requestId: randomUUID(), expectedGeneration: 1 }; await f.service.nativePreviews.update(f.id, undefined, { time: 0.25 }, conditions);
  const folder = await f.service.nativePreviews.folder(f.id), file = path.join(folder, 'request.json'), request = await f.service.nativePreviews.request(folder), first = request.mutationReceipts![0]!;
  for (let i = 1; i < 1024; i++) request.mutationReceipts!.push({ ...first, requestId: randomUUID() }); await atomicJson(file, request); const before = await readFile(file, 'utf8');
  await assert.rejects(f.service.nativePreviews.update(f.id, undefined, { time: 0.5 }, { requestId: randomUUID(), expectedGeneration: 2 }), /1024 retained/); assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await f.service.nativePreviews.update(f.id, undefined, { time: 0.25 }, conditions)).requestReceipt.reused, true);
  const legacy = await f.service.nativePreviews.update(f.id, undefined, { time: 0.75 }); assert.equal(legacy.pendingGeneration, 3); assert.equal((await f.service.nativePreviews.request(folder)).mutationReceipts?.length, 1024);
});

test('creation IDs and generation preconditions reject invalid values', () => {
  assert.equal(previewRequestId.safeParse(randomUUID()).success, true);
  for (const key of ['../outside', '00000000-0000-7000-8000-000000000000', randomUUID().toUpperCase()]) assert.equal(previewRequestId.safeParse(key).success, false);
  for (const raw of [{ expectedGeneration: 0 }, { expectedGeneration: 1.5 }, { requestId: 'bad' }, { unknown: true }]) assert.equal(previewMutationOptions.safeParse(raw).success, false);
});
