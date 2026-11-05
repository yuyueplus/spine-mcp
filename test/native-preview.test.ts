import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { SpineService } from '../src/service.js';
import { nativePreviewOptions, nativePreviewChanges, nativePreviewResumeOptions, runNativePreview } from '../src/native-preview.js';
import { atomicJson } from '../src/jobs.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';
import { nativePreviewWaitOptions } from '../src/native-preview-wait.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-native-preview-'))), service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }), demo = await service.createDemo(), id = randomUUID(), folder = path.join(await service.nativePreviews.root(), id);
  await mkdir(path.join(folder, 'images'), { recursive: true }); service.nativePreviews.kick = async () => undefined;
  await writeFile(path.join(folder, 'MCP-preview.spine'), 'unit-test project placeholder: CLI is not invoked');
  const options = nativePreviewOptions.parse({ width: 160, height: 160, viewport: { minX: -40, maxX: 200, minY: -120, maxY: 120 } }), expiresAt = new Date(Date.now() + 60000).toISOString();
  await atomicJson(path.join(folder, 'request.json'), { id, input: demo.path, sources: [demo.path], generation: 1, options, expiresAt });
  await atomicJson(path.join(folder, 'status.json'), { id, state: 'starting', input: demo.path, generation: 0, project: path.join(folder, 'MCP-preview.spine'), projectSha256: await fileSha256(path.join(folder, 'MCP-preview.spine')), image: path.join(folder, 'images/preview.png'), updatedAt: new Date().toISOString(), expiresAt });
  const worker = runNativePreview(service, folder);
  return { service, demo, id, folder, worker };
}
async function until(f: Awaited<ReturnType<typeof fixture>>, predicate: (status: Awaited<ReturnType<SpineService['nativePreviews']['get']>>) => boolean, ms = 12000) {
  const deadline = Date.now() + ms; let status = await f.service.nativePreviews.get(f.id);
  while (!predicate(status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 80)); status = await f.service.nativePreviews.get(f.id); }
  assert.ok(predicate(status), JSON.stringify(status)); return status;
}
async function stop(f: Awaited<ReturnType<typeof fixture>>) { await f.service.nativePreviews.stop(f.id); await f.worker; }

test('lease path rejection stays handled while preview root resolution is delayed', async () => {
  const f = await fixture();
  const previews = f.service.nativePreviews, originalRoot = previews.root.bind(previews);
  const lock = path.join(f.folder, 'worker.lock'); let linked = false;
  try {
    await until(f, s => s.generation === 1); await stop(f);
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-outside-preview-')));
    await symlink(outside, lock, process.platform === 'win32' ? 'junction' : 'dir'); linked = true;
    previews.root = async () => { await new Promise(resolve => setTimeout(resolve, 60)); return originalRoot(); };
    await assert.rejects(previews.get(f.id), /symbolic link or junction points outside/);
  } finally {
    previews.root = originalRoot;
    if (linked) await unlink(lock);
    await stop(f);
  }
});

async function freeze(f: Awaited<ReturnType<typeof fixture>>) {
  await stop(f);
  const requestFile = path.join(f.folder, 'request.json'), request = JSON.parse(await readFile(requestFile, 'utf8')); delete request.stop; await atomicJson(requestFile, request);
  const statusFile = path.join(f.folder, 'status.json'), status = JSON.parse(await readFile(statusFile, 'utf8')); status.state = 'watching'; await atomicJson(statusFile, status);
}

test('wait returns a verified static publication, then follows the exact edited source and generation', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.service.nativePreviews.wait(f.id, { waitMs: 10000 }); assert.equal(first.outcome, 'published'); assert.equal(first.resourcesVerified, true); assert.equal(first.imageSetVerified, true); assert.equal(first.editorDisplayAcknowledged, false); assert.equal(first.editorProjectReloaded, false);
    const edited = await f.service.editBone(f.demo.path, path.join(f.demo.directory, 'wait-edit.json'), 'root', { x: 25 }), generation = edited.nativePreview!.sessions[0]!.generation;
    const result = await f.service.nativePreviews.wait(f.id, { generation, sourceSha256: await fileSha256(edited.path), waitMs: 10000 });
    assert.equal(result.outcome, 'published'); assert.equal(result.input, edited.path); assert.equal(result.generation, generation);
    assert.equal((await f.service.nativePreviews.wait(f.id, { generation: first.generation, waitMs: 0 })).outcome, 'superseded');
  } finally { await stop(f); }
});

test('wait does not grant resource verification for an inactive missing attachment', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    await until(f, s => s.generation === 1); await freeze(f);
    const source = JSON.parse(await readFile(f.demo.path, 'utf8')); source.skins[0].attachments['arm-slot'].unused = { path: 'inactive-missing-image', width: 10, height: 10 }; await writeFile(f.demo.path, JSON.stringify(source));
    f.worker = runNativePreview(f.service, f.folder);
    await until(f, s => Boolean(s.publishedRevision?.missing.length));
    const receipt = await f.service.nativePreviews.wait(f.id, { waitMs: 0 }); assert.equal(receipt.outcome, 'error'); assert.equal(receipt.resourcesVerified, false); assert.match(receipt.reason!, /missing resource/);
  } finally { await stop(f); }
});

test('wait has bounded polling and does not confuse an older render error with a newer pending request', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    await until(f, s => s.generation === 1); await freeze(f);
    const statusFile = path.join(f.folder, 'status.json'), old = JSON.parse(await readFile(statusFile, 'utf8')); old.lastError = 'old error'; old.lastErrorGeneration = 1; await atomicJson(statusFile, old);
    await f.service.nativePreviews.update(f.id, undefined, {});
    const pending = await f.service.nativePreviews.wait(f.id, { generation: 2, waitMs: 20 }); assert.equal(pending.outcome, 'timeout'); assert.equal(pending.sourceVerified, false);
    await assert.rejects(f.service.nativePreviews.wait(f.id, { generation: 3, waitMs: 0 }), /future generation/);
    for (const invalid of [{ waitMs: -1 }, { waitMs: 30001 }, { generation: 0 }, { sourceSha256: 'wrong' }, { unknown: true }]) assert.equal(nativePreviewWaitOptions.safeParse(invalid).success, false);
  } finally { await stop(f); }
});

test('wait refuses stale resources and damaged image bytes, and accepts the repaired renderer output', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const first = await until(f, s => s.generation === 1); await freeze(f);
    await writeFile(path.join(f.demo.images, 'arm.png'), encodePng(120, 24, new Uint8Array(120 * 24 * 4).fill(180)));
    assert.equal((await f.service.nativePreviews.wait(f.id, { waitMs: 0 })).outcome, 'timeout');
    await writeFile(first.image, 'damaged image'); assert.equal((await f.service.nativePreviews.wait(f.id, { waitMs: 0 })).outcome, 'timeout');
    f.worker = runNativePreview(f.service, f.folder);
    const repaired = await f.service.nativePreviews.wait(f.id, { generation: 1, waitMs: 10000 }); assert.equal(repaired.outcome, 'published'); assert.equal(repaired.resourcesVerified, true);
  } finally { await stop(f); }
});

test('wait reports old manifests, changed source, changed native project and experimental playback honestly', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const first = await until(f, s => s.generation === 1); await freeze(f);
    const statusFile = path.join(f.folder, 'status.json'), status = JSON.parse(await readFile(statusFile, 'utf8')), legacy = { ...status }; delete legacy.publishedRevision; await atomicJson(statusFile, legacy);
    assert.equal((await f.service.nativePreviews.wait(f.id, { waitMs: 0 })).outcome, 'unverified'); await atomicJson(statusFile, status);
    assert.equal((await f.service.nativePreviews.wait(f.id, { sourceSha256: '0'.repeat(64), waitMs: 0 })).outcome, 'source_changed');
    await writeFile(first.project, 'user modified native project'); const changed = await f.service.nativePreviews.wait(f.id, { waitMs: 0 }); assert.equal(changed.outcome, 'error'); assert.match(changed.reason!, /project changed/);
    const requestFile = path.join(f.folder, 'request.json'), request = JSON.parse(await readFile(requestFile, 'utf8')); request.playback = {}; await atomicJson(requestFile, request);
    await assert.rejects(f.service.nativePreviews.wait(f.id, { waitMs: 0 }), /experimental/);
  } finally { await stop(f); }
});

test('native preview bounds and changes reject invalid requests without silently enabling rig reload', () => {
  assert.equal(nativePreviewOptions.parse({}).durationSeconds, 3600);
  for (const raw of [{ viewport: { minX: 1, maxX: 0, minY: 0, maxY: 1 } }, { width: 2048 }, { time: -1 }, { durationSeconds: 28801 }, { unknown: true }]) assert.equal(nativePreviewOptions.safeParse(raw).success, false);
  assert.deepEqual(nativePreviewChanges.parse({ animation: null, skin: null }), { animation: null, skin: null, refit: false });
  assert.equal(nativePreviewChanges.safeParse({ width: 320 }).success, false);
  for (const raw of [{ durationSeconds: 4 }, { durationSeconds: 28801 }, { width: 320 }]) assert.equal(nativePreviewResumeOptions.safeParse(raw).success, false);
});

test('one damaged preview session is reported without preventing another session from following edits', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    await until(f, s => s.generation === 1);
    const badId = randomUUID(), bad = path.join(await f.service.nativePreviews.root(), badId); await mkdir(bad);
    await writeFile(path.join(bad, 'status.json'), '{partial');
    const listing = await f.service.nativePreviews.list(); assert.ok(listing.errors.some(item => item.id === badId));
    const edited = await f.service.editBone(f.demo.path, path.join(f.demo.directory, 'valid-edit.json'), 'root', { x: 15 });
    assert.equal(edited.nativePreview?.sessions[0]?.id, f.id); assert.ok(edited.nativePreview?.errors.some(message => message.includes(badId)));
    const result = await until(f, s => s.generation === 2); assert.equal(result.input, edited.path);
  } finally { await stop(f); }
});

test('native preview resumes the same stopped/expired project, pose and fixed image', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    await until(f, s => s.generation === 1);
    const animated = await f.service.editFile(f.demo.path, path.join(f.demo.directory, 'resume-wave.json'), [{ type: 'add_animation', name: 'resume-wave' }, { type: 'set_timeline', animation: 'resume-wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 45 }] }]);
    await f.service.nativePreviews.update(f.id, animated.path, { animation: 'resume-wave', time: 0.4, fps: 30 });
    const before = await until(f, s => s.generation === s.pendingGeneration), projectHash = await fileSha256(before.project);
    await stop(f);
    const stoppedResume = await f.service.nativePreviews.resume(f.id, { durationSeconds: 60 });
    assert.equal(stoppedResume.project, before.project); assert.equal(stoppedResume.image, before.image);
    assert.equal(stoppedResume.options.time, 0.4); assert.equal(stoppedResume.options.fps, 30);
    assert.equal(stoppedResume.options.animation, 'resume-wave'); assert.deepEqual(stoppedResume.options.viewport, before.options.viewport);
    f.worker = runNativePreview(f.service, f.folder);
    const resumed = await until(f, s => s.generation === stoppedResume.pendingGeneration);
    assert.equal(resumed.textureSha256, before.textureSha256);
    const filename = path.join(f.folder, 'request.json'), expiredRequest = JSON.parse(await readFile(filename, 'utf8'));
    expiredRequest.expiresAt = new Date(Date.now() - 1).toISOString(); await atomicJson(filename, expiredRequest); await f.worker;
    assert.equal((await f.service.nativePreviews.get(f.id)).state, 'expired');
    await f.service.nativePreviews.resume(f.id, { durationSeconds: 120 }); f.worker = runNativePreview(f.service, f.folder);
    const renewed = await until(f, s => s.generation === s.pendingGeneration && s.generation > resumed.generation);
    assert.equal(renewed.project, before.project); assert.equal(renewed.textureSha256, before.textureSha256);
    assert.equal(await fileSha256(before.project), projectHash);
  } finally { await stop(f); }
});

test('renewal racing a pose edit retains both the lifetime and the new pose', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const before = await until(f, s => s.generation === 1);
    await Promise.all([f.service.nativePreviews.resume(f.id, { durationSeconds: 180 }), f.service.nativePreviews.update(f.id, undefined, { time: 0.3, fps: 30 })]);
    const result = await until(f, s => s.generation === s.pendingGeneration && s.generation === 3);
    assert.equal(result.options.time, 0.3); assert.equal(result.options.fps, 30); assert.equal(result.options.durationSeconds, 180);
    assert.ok(Date.parse(result.expiresAt) - Date.now() > 170000); assert.equal(result.project, before.project);
  } finally { await stop(f); }
});

test('edits persist the newest branch while a renderer is interrupted', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    await until(f, s => s.generation === 1); await stop(f);
    const requestFile = path.join(f.folder, 'request.json'), request = JSON.parse(await readFile(requestFile, 'utf8'));
    request.stop = false; await atomicJson(requestFile, request);
    const statusFile = path.join(f.folder, 'status.json'), oldStatus = JSON.parse(await readFile(statusFile, 'utf8'));
    oldStatus.state = 'watching'; oldStatus.workerPid = 0; oldStatus.updatedAt = new Date(Date.now() - 10000).toISOString(); await atomicJson(statusFile, oldStatus);
    assert.equal((await f.service.nativePreviews.get(f.id)).state, 'interrupted');
    const a = await f.service.editBone(f.demo.path, path.join(f.demo.directory, 'interrupted-a.json'), 'root', { x: 12 });
    const b = await f.service.editBone(a.path, path.join(f.demo.directory, 'interrupted-b.json'), 'root', { x: 44 });
    assert.equal(a.nativePreview?.sessions[0]?.id, f.id); assert.equal(b.nativePreview?.sessions[0]?.id, f.id);
    f.worker = runNativePreview(f.service, f.folder);
    const recovered = await until(f, s => s.generation === s.pendingGeneration && s.generation === 3);
    assert.equal(recovered.input, b.path);
  } finally { await stop(f); }
});

test('resume refuses to replace a changed generated project or missing image', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const before = await until(f, s => s.generation === 1); await stop(f);
    await writeFile(before.project, 'user changed this generated project');
    await assert.rejects(f.service.nativePreviews.resume(f.id), /project changed/);
    assert.equal(await readFile(before.project, 'utf8'), 'user changed this generated project');
    assert.equal(await fileSha256(before.image), before.textureSha256);
    await unlink(before.image);
    await assert.rejects(f.service.nativePreviews.resume(f.id), /image is missing/);
  } finally { await stop(f); }
});

test('renderer restart reconciles an image publication whose status was not committed', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const before = await until(f, s => s.generation === 1); await stop(f);
    const requestFile = path.join(f.folder, 'request.json'), request = JSON.parse(await readFile(requestFile, 'utf8'));
    request.stop = false; await atomicJson(requestFile, request);
    await writeFile(before.image, encodePng(2, 2, new Uint8Array(16).fill(180)));
    assert.notEqual(await fileSha256(before.image), before.textureSha256);
    f.worker = runNativePreview(f.service, f.folder);
    const reconciled = await until(f, s => s.generation === 1 && (s.textureRevision ?? 0) > (before.textureRevision ?? 0));
    assert.equal(reconciled.textureSha256, before.textureSha256); assert.equal(await fileSha256(before.image), before.textureSha256);
  } finally { await stop(f); }
});

test('resuming an inactive preview enforces the shared four-session capacity without changing its request', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    await until(f, s => s.generation === 1); await stop(f);
    const requestFile = path.join(f.folder, 'request.json'), originalRequest = await readFile(requestFile, 'utf8');
    const state = JSON.parse(await readFile(path.join(f.folder, 'status.json'), 'utf8'));
    const controls: string[] = [];
    for (let n = 0; n < 4; n++) {
      const id = randomUUID(), folder = path.join(await f.service.nativePreviews.root(), id); await mkdir(path.join(folder, 'images'), { recursive: true });
      const project = path.join(folder, 'MCP-preview.spine'), image = path.join(folder, 'images/preview.png');
      await writeFile(project, 'capacity fixture'); await writeFile(image, await readFile(state.image));
      await atomicJson(path.join(folder, 'request.json'), { ...JSON.parse(originalRequest), id, stop: false, expiresAt: new Date(Date.now() + 60000).toISOString() });
      await atomicJson(path.join(folder, 'status.json'), { ...state, id, state: 'watching', project, image, projectSha256: await fileSha256(project), workerPid: 0 }); controls.push(folder);
    }
    await assert.rejects(f.service.nativePreviews.resume(f.id), /more than four/);
    assert.equal(await readFile(requestFile, 'utf8'), originalRequest);
    const releaseRequest = path.join(controls[0]!, 'request.json'), released = JSON.parse(await readFile(releaseRequest, 'utf8')); released.stop = true; await atomicJson(releaseRequest, released);
    const resumed = await f.service.nativePreviews.resume(f.id, { durationSeconds: 60 }); assert.equal(resumed.stopRequested, false);
    f.worker = runNativePreview(f.service, f.folder); await until(f, s => s.generation === s.pendingGeneration);
  } finally { await stop(f); }
});

test('native preview follows rapid JSON branches and preserves original inputs', { timeout: 18000 }, async () => {
  const f = await fixture(), original = await fileSha256(f.demo.path);
  try {
    const first = await until(f, s => s.generation === 1), a = path.join(f.demo.directory, 'a.json'), b = path.join(f.demo.directory, 'b.json');
    assert.equal(first.editorDisplayAcknowledged, false); assert.equal(first.editorProjectReloaded, false);
    const left = await f.service.editBone(f.demo.path, a, 'root', { x: 10 }); assert.equal(left.nativePreview?.sessions.length, 1);
    await f.service.editFile(a, b, [{ type: 'set_bone', bone: 'root', transform: { x: 40 } }]);
    const latest = await until(f, s => s.generation === 3); assert.equal(latest.input, b); assert.notEqual(latest.textureSha256, first.textureSha256);
    const branch = path.join(f.demo.directory, 'branch.json'); await f.service.editBone(f.demo.path, branch, 'root', { x: -20 });
    const branched = await until(f, s => s.generation === 4); assert.equal(branched.input, branch); assert.notEqual(branched.textureSha256, latest.textureSha256); assert.equal(await fileSha256(f.demo.path), original);
    const other = await f.service.createDemo(), unrelated = await f.service.editBone(other.path, path.join(other.directory, 'unrelated.json'), 'root', { x: 33 }); assert.equal(unrelated.nativePreview, undefined);
  } finally { await stop(f); }
});

test('native preview keeps the last good PNG on rendering failure and recovers after correction', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const first = await until(f, s => s.generation === 1), imageHash = first.textureSha256;
    await f.service.nativePreviews.update(f.id, undefined, { animation: 'missing' });
    const failed = await until(f, s => Boolean(s.lastError)); assert.equal(failed.generation, 1); assert.match(failed.lastError!, /Animation not found/); assert.equal(await fileSha256(first.image), imageHash);
    assert.equal((await f.service.nativePreviews.wait(f.id, { generation: 2, waitMs: 100 })).outcome, 'error');
    await f.service.nativePreviews.update(f.id, undefined, { animation: null });
    const recovered = await until(f, s => s.generation === 3 && !s.lastError); assert.equal(recovered.textureSha256, imageHash);
  } finally { await stop(f); }
});

test('native preview detects texture-only changes without project reload or another edit notification', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const first = await until(f, s => s.generation === 1); await writeFile(path.join(f.demo.images, 'arm.png'), encodePng(120, 24, new Uint8Array(120 * 24 * 4).fill(180)));
    const changed = await until(f, s => (s.textureRevision ?? 0) > (first.textureRevision ?? 0)); assert.notEqual(changed.textureSha256, first.textureSha256); assert.equal(changed.generation, 1); assert.equal(changed.editorProjectReloaded, false);
  } finally { await stop(f); }
});

test('native preview stop and expiry retain the final image and reject new requests', { timeout: 18000 }, async () => {
  const f = await fixture();
  try {
    const first = await until(f, s => s.generation === 1); await stop(f); assert.equal((await f.service.nativePreviews.get(f.id)).state, 'stopped');
    await f.service.editBone(f.demo.path, path.join(f.demo.directory, 'after-stop.json'), 'root', { x: 66 }); assert.equal(await fileSha256(first.image), first.textureSha256);
    await assert.rejects(f.service.nativePreviews.update(f.id, undefined), /stopped/);
    const bytes = await readFile(first.image); assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  } finally { await stop(f); }
  const expired = await fixture();
  try { await until(expired, s => s.generation === 1); const filename = path.join(expired.folder, 'request.json'), request = JSON.parse(await readFile(filename, 'utf8')); request.expiresAt = new Date(Date.now() - 1).toISOString(); await atomicJson(filename, request); await expired.worker; assert.equal((await expired.service.nativePreviews.get(expired.id)).state, 'expired'); }
  finally { await stop(expired); }
});
