import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument } from '../src/document.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-session-life-'))), config = { workspaceRoot: root, targetVersion: '4.3.23' as const, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }, service = new SpineService(config);
  const image = path.join(root, 'art.png'); await writeFile(image, encodePng(4, 4, new Uint8Array(64).fill(255)));
  const input = (await writeDocument(service.workspace, 'source.json', parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { path: 'art', width: 4, height: 4 } } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 10 }] } } } } }))).path;
  return { root, config, service, sessions: service.projectSessions, input, image };
}
const identity = (id: string, expectedRevision: number) => ({ id, expectedRevision, requestId: randomUUID() });
const edit = (id: string, revision: number, output: string) => ({ ...identity(id, revision), output, edits: [{ type: 'set_bone' as const, bone: 'root', transform: { x: 1 } }] });

test('renaming and capacity changes preserve creation identity and old mutation receipts', async () => {
  const f = await fixture(), args = { input: f.input, name: 'Original', requestId: randomUUID(), maxVersions: 2 }, s = await f.sessions.create(args), firstArgs = edit(s.id, 0, 'first.json'); await f.sessions.edit(firstArgs);
  await assert.rejects(f.sessions.edit(edit(s.id, 1, 'full.json')), /version limit/);
  const configureArgs = { ...identity(s.id, 1), name: 'Renamed', maxVersions: 4 }, renamed = await f.sessions.configure(configureArgs); assert.equal(renamed.name, 'Renamed'); assert.equal(renamed.requestReceipt.preview.state, 'not_required');
  const second = new SpineService(f.config).projectSessions; assert.equal((await second.create(args)).reused, true); assert.equal((await second.configure(configureArgs)).requestReceipt.reused, true); assert.equal((await second.edit(firstArgs)).name, 'Renamed');
  const third = await second.edit(edit(s.id, 2, 'third.json')); assert.equal(third.versions.length, 3);
  await assert.rejects(second.configure({ ...identity(s.id, 3), maxVersions: 2, name: 'Should not apply' }), /below retained/); assert.equal((await second.get(s.id)).name, 'Renamed');
  const storage = await second.storage(s.id); assert.equal(storage.versions, 3); assert.equal(storage.versionsRemaining, 1); assert.equal(storage.requestReceipts, 3); assert.equal(storage.archivesDeleted, false);
});

test('archive hides sessions and blocks work without deleting history; unarchive does not bind a preview', async () => {
  const f = await fixture(), hash = await fileSha256(f.input), imageHash = await fileSha256(f.image), s = await f.sessions.create({ input: f.input, name: 'Archive' });
  const archived = await f.sessions.archive({ ...identity(s.id, 0), archived: true }); assert.equal(archived.archived, true); assert.equal((await f.sessions.list()).total, 0); assert.equal((await f.sessions.list()).archivedCount, 1); assert.equal((await f.sessions.list(50, true)).total, 1);
  await assert.rejects(f.sessions.touch(identity(s.id, 1)), /archived/); await assert.rejects(f.sessions.edit(edit(s.id, 1, 'blocked.json')), /archived/);
  const state = await f.sessions.read(s.id); assert.ok((await stat(state.versions[0]!.manifest)).size); assert.equal((await f.sessions.compare(s.id, s.currentVersionId)).dataDiff.total, 0);
  const active = await f.sessions.archive({ ...identity(s.id, 1), archived: false }); assert.equal(active.preview, null); assert.equal(active.revision, 2); assert.equal(active.versions.length, 1); assert.equal(await fileSha256(f.input), hash); assert.equal(await fileSha256(f.image), imageHash);
});

async function expiredPreview(lostReply = false) {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Lease', previewLease: { durationSeconds: 30, renewBeforeSeconds: 5 } }), id = randomUUID();
  let generation = 1, state = 'expired', expiresAt = new Date(Date.now() - 1000).toISOString(), resumes = 0, updates = 0, firstReply = true;
  const committed = new Map<string, number>(), resumeRequests: string[] = [];
  Object.defineProperty(f.service.nativePreviews, 'get', { value: async () => ({ id, pendingGeneration: generation, state, expiresAt, stopRequested: state === 'stopped' }) });
  Object.defineProperty(f.service.nativePreviews, 'resume', { configurable: true, value: async (_id: string, _options: unknown, conditions: { requestId: string; expectedGeneration: number }) => {
    resumeRequests.push(conditions.requestId);
    if (committed.has(conditions.requestId)) return { requestReceipt: { generation: committed.get(conditions.requestId)!, reused: true } };
    assert.equal(conditions.expectedGeneration, generation); resumes++; generation++; committed.set(conditions.requestId, generation); state = 'watching'; expiresAt = new Date(Date.now() + 30_000).toISOString();
    if (lostReply && firstReply) { firstReply = false; throw new Error('lost committed resume reply'); }
    return { requestReceipt: { generation } };
  } });
  Object.defineProperty(f.service.nativePreviews, 'update', { value: async (_id: string, _input: string, _options: unknown, conditions: { expectedGeneration: number }) => { if (state !== 'watching') throw new Error(state); assert.equal(conditions.expectedGeneration, generation); updates++; return { requestReceipt: { generation: ++generation } }; } });
  const bound = await f.sessions.bind({ ...identity(s.id, 0), previewId: id }); assert.equal(bound.requestReceipt.preview.state, 'failed');
  return { ...f, s: bound, previewId: id, stats: () => ({ resumes, updates, generation, resumeRequests }), setState: (value: string) => { state = value; }, bump: () => { generation++; } };
}

test('activity renews an expired preview once, updates the same preview and survives exact retries', async () => {
  const f = await expiredPreview(), args = identity(f.s.id, 1), touched = await f.sessions.touch(args); assert.equal(touched.preview!.id, f.previewId); assert.equal(touched.requestReceipt.preview.state, 'requested'); assert.equal(touched.versions.length, 1); assert.ok(touched.lastRenewalAt);
  await f.sessions.touch(args); assert.equal(f.stats().resumes, 1); assert.equal(f.stats().updates, 1); assert.equal((await f.sessions.get(f.s.id)).previewStatus!.state, 'watching');
  const metadata = await f.sessions.configure({ ...identity(f.s.id, 2), name: 'Lease renamed' }); assert.equal(metadata.requestReceipt.preview.state, 'not_required'); assert.equal(f.stats().updates, 1);
});

test('explicit stop and a disabled lease never restart a bound preview', async () => {
  for (const stopped of [true, false]) {
    const f = await expiredPreview(); let revision = 1;
    if (stopped) f.setState('stopped'); else { await f.sessions.configure({ ...identity(f.s.id, revision++), previewLease: { enabled: false } }); }
    const touched = await f.sessions.touch(identity(f.s.id, revision)); assert.equal(touched.requestReceipt.preview.state, 'failed'); assert.equal(f.stats().resumes, 0);
    const saved = await f.sessions.edit(edit(f.s.id, revision + 1, 'saved.json')); assert.equal(saved.versions.length, 2); assert.equal(saved.requestReceipt.preview.state, 'failed'); assert.equal(f.stats().resumes, 0);
  }
});

test('external preview generations reject before renewal and archival detaches without stopping a shared worker', async () => {
  const f = await expiredPreview(); f.bump(); await assert.rejects(f.sessions.touch(identity(f.s.id, 1)), /changed externally/); assert.equal(f.stats().resumes, 0);
  const archived = await f.sessions.archive({ ...identity(f.s.id, 1), archived: true }); assert.equal(archived.preview, null); assert.equal(f.stats().resumes, 0); assert.equal(f.stats().updates, 0);
});

test('lost committed renewal replies recover the durable resume identity before one file commit', async () => {
  const f = await expiredPreview(true), args = edit(f.s.id, 1, 'recovered.json'); await assert.rejects(f.sessions.edit(args), /changed externally/);
  const pending = await f.sessions.read(f.s.id); assert.ok(pending.pendingRenewal); assert.match(pending.renewalError!, /lost committed/); assert.equal(pending.revision, 1); await assert.rejects(stat(path.join(f.root, 'recovered.json')), /ENOENT/);
  const recovered = await f.sessions.edit(args); assert.equal(recovered.revision, 2); assert.equal(recovered.versions.length, 2); assert.equal(f.stats().resumes, 1); assert.equal(f.stats().updates, 1); assert.equal(new Set(f.stats().resumeRequests).size, 1); assert.equal((await f.sessions.read(f.s.id)).pendingRenewal, undefined);
  await f.sessions.edit(args); assert.equal(f.stats().resumes, 1); assert.equal(f.stats().updates, 1);
});

test('manual stop after an uncommitted renewal failure clears its pending intent without restarting', async () => {
  const f = await expiredPreview(); let attempts = 0;
  Object.defineProperty(f.service.nativePreviews, 'resume', { configurable: true, value: async () => { attempts++; throw new Error('failed before commit'); } });
  Object.defineProperty(f.service.nativePreviews, 'request', { value: async () => ({ mutationReceipts: [] }) });
  Object.defineProperty(f.service.nativePreviews, 'folder', { value: async () => f.root });
  const first = await f.sessions.touch(identity(f.s.id, 1)); assert.equal(first.requestReceipt.preview.state, 'failed'); assert.ok((await f.sessions.read(f.s.id)).pendingRenewal); f.setState('stopped');
  await f.sessions.touch(identity(f.s.id, 2)); assert.equal(attempts, 1); assert.equal((await f.sessions.read(f.s.id)).pendingRenewal, undefined);
});

test('manual stop after a lost committed renewal reply only replays its receipt, never restarts', async () => {
  const f = await expiredPreview(true), args = identity(f.s.id, 1); await assert.rejects(f.sessions.touch(args), /changed externally/); f.setState('stopped');
  const pending = (await f.sessions.read(f.s.id)).pendingRenewal!;
  Object.defineProperty(f.service.nativePreviews, 'request', { value: async () => ({ mutationReceipts: [{ requestId: pending.requestId, operation: 'resume' }] }) });
  Object.defineProperty(f.service.nativePreviews, 'folder', { value: async () => f.root });
  const after = await f.sessions.touch(args); assert.equal(after.requestReceipt.preview.state, 'failed'); assert.equal(f.stats().resumes, 1); assert.equal(f.stats().updates, 0); assert.equal((await f.sessions.get(f.s.id)).previewStatus!.explicitlyStopped, true); assert.equal((await f.sessions.read(f.s.id)).pendingRenewal, undefined);
});

test('multi-skeleton quality shares a strict budget including zero remaining poses and report-mode failures', async () => {
  for (const mode of ['enforce', 'report'] as const) {
    const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Shared sample budget', quality: { mode, fps: 1, maxSamples: 2 } }), state = await f.sessions.read(s.id);
    Object.defineProperty(f.sessions, 'portable', { value: async () => [{ name: 'first', input: f.input }, { name: 'second', input: f.input }] });
    if (mode === 'enforce') await assert.rejects(f.sessions.quality(state, state.versions[0]!), /quality gate failed/);
    else {
      const summary = await f.sessions.quality(state, state.versions[0]!); assert.equal(summary.checksPassed, false); assert.equal(summary.reports.length, 2);
      const reports = await Promise.all(summary.reports.map(async p => JSON.parse(await readFile(p, 'utf8'))));
      assert.equal(reports[0].sampledPoses, 2); assert.equal(reports[1].sampleBudget, 0); assert.equal(reports[1].sampledPoses, 0); assert.equal(reports[1].publishingAllowed, true); assert.match(reports[1].errors.join(), /sample budget/); assert.equal(reports.reduce((n, r) => n + r.budgetedSamples, 0), 2);
    }
  }
});
