import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpineService } from '../src/service.js';
import { parseDocument, readDocument, writeDocument } from '../src/document.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';
import { resourceRefs } from '../src/production-assets.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-session-'))), config = { workspaceRoot: root, targetVersion: '4.3.23' as const, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }, service = new SpineService(config);
  const image = path.join(root, 'art.png'); await writeFile(image, encodePng(4, 4, new Uint8Array(64).fill(255)));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { path: 'art', width: 4, height: 4 } } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 10 }] } } } } });
  const input = (await writeDocument(service.workspace, 'source.json', data)).path;
  return { root, config, service, sessions: service.projectSessions, input, image, data };
}
const edit = (id: string, revision: number, output: string, x: number, requestId = randomUUID()) => ({ id, requestId, expectedRevision: revision, output, edits: [{ type: 'set_bone' as const, bone: 'root', transform: { x } }] });

test('session creation and explicit branch context survive reconnect without duplicating creation', async () => {
  const f = await fixture(), requestId = randomUUID(), args = { input: f.input, name: 'Character', requestId }, s = await f.sessions.create(args);
  assert.equal(s.revision, 0); assert.equal(s.versions.length, 1); assert.equal(s.editorStateRead, false);
  const second = new SpineService(f.config), reused = await second.projectSessions.create(args); assert.equal(reused.id, s.id); assert.equal(reused.reused, true);
  assert.equal((await second.projectSessions.list()).total, 1);
  await assert.rejects(second.projectSessions.create({ ...args, name: 'Other' }), /different arguments/);
});
test('completed edit retries reuse their historical receipt and never rewind a newer branch', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Edit' }), hash = await fileSha256(f.input), firstArgs = edit(s.id, 0, 'first.json', 12), first = await f.sessions.edit(firstArgs);
  const second = await f.sessions.edit(edit(s.id, 1, 'second.json', 24)), replay = await new SpineService(f.config).projectSessions.edit(firstArgs);
  assert.equal(replay.requestReceipt.reused, true); assert.equal(replay.currentInput, second.currentInput); assert.equal(replay.output, first.output); assert.equal(replay.versions.length, 3); assert.equal(replay.revision, 2); assert.equal(await fileSha256(f.input), hash);
  assert.equal((await readDocument(second.output!)).bones[0]!.x, 24);
  await assert.rejects(f.sessions.edit({ ...firstArgs, edits: [{ type: 'set_bone', bone: 'root', transform: { x: 99 } }] }), /another session operation/);
});
test('parallel exact retries commit one version and conflicting stale edits reject', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Parallel' }), args = edit(s.id, 0, 'parallel.json', 1);
  const results = await Promise.all([f.sessions.edit(args), new SpineService(f.config).projectSessions.edit(args)]);
  assert.equal(results.filter(r => r.requestReceipt.reused).length, 1); assert.equal((await f.sessions.get(s.id)).versions.length, 2);
  await assert.rejects(f.sessions.edit(edit(s.id, 0, 'stale.json', 2)), /revision is stale/);
});
test('external image drift blocks edits until an explicit checkpoint acknowledges it', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Drift' }); await writeFile(f.image, encodePng(4, 4, new Uint8Array(64).fill(128)));
  const drift = await f.sessions.get(s.id); assert.equal(drift.inSync, false); assert.equal(drift.externalChangesCount, 1);
  await assert.rejects(f.sessions.edit(edit(s.id, 0, 'blocked.json', 5)), /changed outside/);
  await assert.rejects(f.sessions.checkpoint({ id: s.id, requestId: randomUUID(), expectedRevision: 0 }), /changed outside/);
  const checkpoint = await f.sessions.checkpoint({ id: s.id, requestId: randomUUID(), expectedRevision: 0, acceptExternalChanges: true, note: 'Saved edited PNG' }); assert.equal(checkpoint.revision, 1); assert.equal((await f.sessions.get(s.id)).inSync, true);
  const diff = await f.sessions.compare(s.id, s.versions[0]!.id); assert.ok(diff.resourceDiff.total > 0);
});
test('historical restore recovers original PNG/audio bytes even when current resources are missing', async () => {
  const f = await fixture(); await writeFile(path.join(f.root, 'step.wav'), Buffer.from('historical-event-audio'));
  f.data.skeleton.audio = '.'; f.data.events = { step: { audio: 'step.wav' } }; f.data.animations!.idle!.events = [{ time: 0.2, name: 'step' }];
  await writeFile(f.input, JSON.stringify(f.data)); const hash = await fileSha256(f.image), audioHash = await fileSha256(path.join(f.root, 'step.wav')), s = await f.sessions.create({ input: f.input, name: 'Recovery' });
  await unlink(f.image); await unlink(path.join(f.root, 'step.wav'));
  const args = { id: s.id, requestId: randomUUID(), expectedRevision: 0, versionId: s.versions[0]!.id, output: 'restored.json' };
  await assert.rejects(f.sessions.restore(args), /changed outside/);
  const restored = await f.sessions.restore({ ...args, acceptExternalChanges: true }), data = await readDocument(restored.output!), refs = await resourceRefs(f.service.workspace, data, restored.output!);
  assert.equal(await fileSha256(refs.refs.find(r => r.kind === 'images')!.path), hash); assert.equal(await fileSha256(refs.refs.find(r => r.kind === 'audio')!.path), audioHash);
  assert.equal(restored.versions.at(-1)!.restoredFrom, s.versions[0]!.id); assert.equal((await f.sessions.get(s.id)).inSync, true);
  const diff = await f.sessions.compare(s.id, s.versions[0]!.id); assert.equal(diff.dataDiff.total, 0); assert.equal(diff.resourceDiff.total, 0);
});
test('restoring a version writes a new branch, normalizes relocated resources and preserves edit history', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Restore' }), first = await f.sessions.edit(edit(s.id, 0, 'changed.json', 7));
  const difference = await f.sessions.compare(s.id, s.versions[0]!.id); assert.ok(difference.dataDiff.changes.some(c => c.path.endsWith('/x')));
  const args = { id: s.id, requestId: randomUUID(), expectedRevision: 1, versionId: s.versions[0]!.id, output: 'restored.json' }, restored = await f.sessions.restore(args);
  assert.equal(restored.versions.length, 3); assert.equal((await readDocument(first.output!)).bones[0]!.x, 7); assert.equal((await f.sessions.compare(s.id, s.versions[0]!.id)).dataDiff.total, 0);
  assert.equal((await f.sessions.restore(args)).requestReceipt.reused, true);
});
test('corrupt historical PNG is rejected before creating a restored project', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Corrupt' }), entries = await f.sessions.portable((await f.sessions.read(s.id)).versions[0]!), d = await readDocument(entries[0]!.input), refs = await resourceRefs(f.service.workspace, d, entries[0]!.input);
  await writeFile(refs.refs[0]!.path, Buffer.from('corrupt'));
  await assert.rejects(f.sessions.restore({ id: s.id, requestId: randomUUID(), expectedRevision: 0, versionId: s.versions[0]!.id, output: 'bad.json' }), /archive is damaged/);
  await assert.rejects(readFile(path.join(f.root, 'bad.json')), /ENOENT/);
});
test('explicit preview binding advances that preview and old session receipts do not replay it', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Preview' }), previewId = randomUUID(); let generation = 1, calls = 0, latestInput: string | undefined;
  Object.defineProperty(f.service.nativePreviews, 'get', { value: async () => ({ pendingGeneration: generation }) });
  Object.defineProperty(f.service.nativePreviews, 'update', { value: async (_id: string, input: string, _changes: unknown, conditions: { expectedGeneration: number }) => { assert.equal(conditions.expectedGeneration, generation); calls++; latestInput = input; return { requestReceipt: { generation: ++generation } }; } });
  const binding = await f.sessions.bind({ id: s.id, requestId: randomUUID(), expectedRevision: 0, previewId }); assert.equal(binding.preview?.generation, 2);
  const args = edit(s.id, 1, 'preview-1.json', 1); await f.sessions.edit(args); await f.sessions.edit(edit(s.id, 2, 'preview-2.json', 2)); const prior = latestInput;
  await f.sessions.edit(args); assert.equal(calls, 3); assert.equal(latestInput, prior);
  generation++; await assert.rejects(f.sessions.edit(edit(s.id, 3, 'external-preview.json', 3)), /preview changed externally/);
});
test('failed preview publication retains the committed saved output and can be explicitly rebound', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Retain' }), previewId = randomUUID();
  Object.defineProperty(f.service.nativePreviews, 'get', { value: async () => ({ pendingGeneration: 1 }) });
  Object.defineProperty(f.service.nativePreviews, 'update', { value: async () => { throw new Error('Preview expired'); } });
  const bound = await f.sessions.bind({ id: s.id, requestId: randomUUID(), expectedRevision: 0, previewId }); assert.equal(bound.requestReceipt.preview.state, 'failed');
  const edited = await f.sessions.edit(edit(s.id, 1, 'committed.json', 9)); assert.equal(edited.requestReceipt.preview.state, 'failed'); assert.equal((await readDocument(edited.output!)).bones[0]!.x, 9);
  const unbound = await f.sessions.bind({ id: s.id, requestId: randomUUID(), expectedRevision: 2, previewId: null }); assert.equal(unbound.preview, null);
});
test('version/output/path guards retain prior data and reject existing files and workspace escapes', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Limits', maxVersions: 2 });
  await assert.rejects(f.sessions.edit(edit(s.id, 0, f.input, 2)), /Output exists/);
  await assert.rejects(f.sessions.edit(edit(s.id, 0, '../outside.json', 2)), /outside/);
  await f.sessions.edit(edit(s.id, 0, 'last.json', 2)); await assert.rejects(f.sessions.edit(edit(s.id, 1, 'over-limit.json', 3)), /version limit/);
  assert.equal((await f.sessions.get(s.id)).versions.length, 2);
});
