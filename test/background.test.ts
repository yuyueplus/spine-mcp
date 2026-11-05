import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Resvg } from '@resvg/resvg-js';
import { SpineService } from '../src/service.js';
import { Workspace } from '../src/config.js';
import { BackgroundJobs } from '../src/jobs.js';
import { setAttachment, setAttachmentTimeline } from '../src/geometry-edits.js';
import { setSlotOrder } from '../src/structure.js';
import { sampleArtwork, renderArtwork } from '../src/artwork-preview.js';
import { readDocument } from '../src/document.js';
import { validateResourcePaths } from '../src/resource-paths.js';
import { compositeOpaque } from '../src/raster.js';

async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-background-')));
  const service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  const demo = await service.createDemo(); return { root, service, demo, workspace: service.workspace, data: await readDocument(demo.path) };
}
test('clipping preview masks actual artwork pixels and ends at the specified slot', async () => {
  const { workspace, demo, data } = await setup();
  data.slots!.push({ name: 'mask', bone: 'root' });
  let clipped = setAttachment(data, 'default', 'mask', 'mask', { type: 'clipping', end: 'arm-slot', vertexCount: 4, vertices: [0, -20, 0, 20, 60, 20, 60, -20] }, false, true);
  clipped = setSlotOrder(clipped, ['mask', 'arm-slot']);
  const preview = await renderArtwork(workspace, clipped, demo.path, undefined, [0]);
  const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="300"><image width="320" height="300" href="data:image/png;base64,${(await readFile(preview.path)).toString('base64')}"/></svg>`).render();
  const pixel = (x: number) => [...raster.pixels.subarray((158 * 320 + x) * 4, (158 * 320 + x) * 4 + 4)];
  assert.notDeepEqual(pixel(110), [32, 43, 55, 255]); assert.deepEqual(pixel(210), [32, 43, 55, 255]);
});
test('image sequence playback uses the selected PNG at runtime sample times', async () => {
  const { workspace, demo, data } = await setup();
  for (let index = 1; index <= 2; index++) await writeFile(path.join(demo.images, `seq${index}.png`), await readFile(path.join(demo.images, 'arm.png')));
  let next = setAttachment(data, 'default', 'arm-slot', 'seq', { path: 'seq', x: 60, width: 120, height: 24, sequence: { count: 2 } }, false, true);
  next = setAttachmentTimeline(next, 'play', 'default', 'arm-slot', 'seq', 'sequence', [{ time: 0, mode: 'loop', delay: 0.25 }]);
  const { frames } = await sampleArtwork(workspace, next, demo.path, 'play', [0, 0.25, 0.5]);
  assert.deepEqual(frames.map(frame => path.basename(frame.slots[0]!.image!)), ['seq1.png', 'seq2.png', 'seq1.png']);
});
test('opaque CPU compositing follows normal, additive, multiply and screen equations', () => {
  const expected = { normal: 100, additive: 150, multiply: 70, screen: 130 };
  for (const [blend, value] of Object.entries(expected)) {
    const destination = new Uint8Array([100, 100, 100, 255]); compositeOpaque(destination, new Uint8Array([50, 50, 50, 128]), blend);
    assert.ok(Math.abs(destination[0]! - value) <= 1); assert.equal(destination[3], 255);
  }
});
test('continuous export includes both endpoints and writes fixed viewport frames plus an offline player', async () => {
  const { service, demo } = await setup();
  const frames = await service.exportFrames(demo.path, { start: 0, end: 0.1, fps: 20, kind: 'artwork' });
  assert.equal(frames.frameCount, 3);
  const manifest = JSON.parse(await readFile(frames.manifestPath, 'utf8'));
  assert.deepEqual(manifest.times, [0, 0.05, 0.1]); assert.match(await readFile(frames.player, 'utf8'), /frame-0000.png/);
});
test('persistent worker processes queued jobs, records failure, honors cancellation and continues after failure', { timeout: 20000 }, async () => {
  const { service, demo } = await setup(), jobs = service.jobs;
  jobs.kick = () => undefined; // Control start so queued cancellation is deterministic.
  const cancelled = await jobs.submit({ operation: 'batch', args: { inputs: [demo.path], action: 'validate', format: 'json', stopOnError: false } });
  await jobs.cancel(cancelled.id);
  const failed = await jobs.submit({ operation: 'export_frames', args: { input: 'missing.json', options: { start: 0, end: 1, fps: 10, kind: 'bones', physics: false } } });
  const valid = await jobs.submit({ operation: 'batch', args: { inputs: [demo.path], action: 'inspect', format: 'json', stopOnError: false } });
  const root = await jobs.root(); await mkdir(path.join(root, 'worker.lock'));
  await writeFile(path.join(root, 'worker.lock', 'owner.json'), JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: 'interrupted-test-worker' }));
  assert.equal((await jobs.resume()).pending.length, 3);
  BackgroundJobs.prototype.kick.call(jobs, await jobs.root());
  let status = await jobs.get(valid.id, true);
  for (let index = 0; index < 80 && ['queued', 'running'].includes(status.state); index++) { await new Promise(resolve => setTimeout(resolve, 150)); status = await jobs.get(valid.id, true); }
  assert.equal(status.state, 'succeeded', JSON.stringify(status));
  assert.equal((await jobs.get(cancelled.id)).state, 'cancelled'); assert.equal((await jobs.get(failed.id)).state, 'failed');
  assert.equal((await jobs.list()).total, 3);
  assert.equal((await jobs.cancel(valid.id)).cancellationAccepted, false);
  await assert.rejects(jobs.get('../../escape'), /Invalid job/);
});
test('CLI resource validation rejects directory and attachment path escapes before executing the editor', async () => {
  const { workspace, demo, data } = await setup();
  data.skeleton.images = '../../../outside';
  await assert.rejects(validateResourcePaths(workspace, data, demo.path), /outside/);
  data.skeleton.images = demo.images; (data.skins as any)[0].attachments['arm-slot'].arm.path = '../../../../escape';
  await assert.rejects(validateResourcePaths(workspace, data, demo.path), /outside/);
});
