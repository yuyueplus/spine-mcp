import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, readdir, stat, unlink, mkdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, readDocument, writeDocument } from '../src/document.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { prepareQualityWaiver, approveQualityWaiver } from '../src/quality-waivers.js';
import { checkPublishQuality } from '../src/publish-quality.js';
import { auditAnimatedSeams } from '../src/animated-seams.js';
import { ArchiveMaintenance } from '../src/archive-maintenance.js';
import { archiveProject, verifyArchive } from '../src/original-archive.js';

async function fixture(kind: 'region' | 'fold' | 'seams' = 'region') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-maintenance-'))), config = { workspaceRoot: root, targetVersion: '4.3.23' as const, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }, service = new SpineService(config);
  const image = path.join(root, 'art.png'); await writeFile(image, encodePng(8, 8, new Uint8Array(256).fill(255)));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root' }, { name: 'corner', parent: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: kind === 'fold' ? { type: 'mesh', path: 'art', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, vertices: [1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, -1, 1, 1, 1, 0, -1, 1] } : { path: 'art', width: 8, height: 8, x: kind === 'seams' ? -3 : 0 } } } }], animations: { move: { bones: { corner: { translate: [{ x: 0 }, { time: 1, x: kind === 'fold' ? 2 : 10 }] } } } } });
  if (kind === 'seams') { data.slots!.push({ name: 'other', bone: 'corner', attachment: 'art' }); (data.skins as any)[0].attachments.other = { art: { path: 'art', width: 8, height: 8, x: 3 } }; }
  const input = (await writeDocument(service.workspace, 'source.json', data)).path;
  return { root, config, service, sessions: service.projectSessions, input, image, data, maintenance: new ArchiveMaintenance(service) };
}
const identity = (id: string, expectedRevision: number) => ({ id, expectedRevision, requestId: randomUUID() });
const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
async function approved(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  const draft = await prepareQualityWaiver(f.service, { input: f.input, animation: 'move', quality: { fps: 4 }, selections: [{ subject: 'art', start: 0, end: 1, triangles: [0, 1] }], ...extra });
  const args = { draft: draft.draftPath, expectedSha256: draft.draftSha256, requestId: randomUUID(), confirmation: 'reviewed_exact_report' as const, reason: 'Controlled synthetic fold fixture reviewed for this exact regression test.' }, approval = await approveQualityWaiver(f.service, args);
  return { draft, args, approval };
}

test('v1 session migration retains exact metadata and files, then persists a guarded v2 header', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Migrate' }), filename = path.join(await f.sessions.folder(s.id), 'state.json'), legacy = await read(filename); legacy.schema = 'spine-project-session/1'; delete legacy.minimumWriterVersion; delete legacy.receiptIndex; delete legacy.receiptSegments;
  const bytes = Buffer.from(JSON.stringify(legacy)); await writeFile(filename, bytes); assert.equal((await f.sessions.get(s.id)).migrationRequired, true); assert.ok((await readFile(filename)).equals(bytes));
  const args = identity(s.id, 0), migrated = await f.sessions.migrate(args); assert.equal(migrated.storageSchema, 'spine-project-session/2'); assert.equal(migrated.migrationRequired, false); assert.equal(migrated.requestReceipt.preview.state, 'not_required'); assert.equal(migrated.versions.length, 1);
  const backups = await readdir(path.join(path.dirname(filename), 'migrations')); assert.equal(backups.length, 1); assert.ok((await readFile(path.join(path.dirname(filename), 'migrations', backups[0]!))).equals(bytes)); assert.equal((await f.sessions.migrate(args)).requestReceipt.reused, true);
  const future = await read(filename); future.minimumWriterVersion = '999.0.0'; await writeFile(filename, JSON.stringify(future)); await assert.rejects(f.sessions.get(s.id), /newer writer/);
});

test('segmented receipt history exceeds 1024 operations without losing old idempotency or creation identity', async () => {
  const f = await fixture(), create = { input: f.input, name: 'Long session', requestId: randomUUID() }, s = await f.sessions.create(create), first = { ...identity(s.id, 0), name: 'name-0' };
  await f.sessions.configure(first); for (let i = 1; i < 1050; i++) await f.sessions.configure({ ...identity(s.id, i), name: 'name-' + i });
  const storage = await f.sessions.storage(s.id); assert.equal(storage.requestReceipts, 1050); assert.ok(storage.archivedReceipts > 0); assert.ok(storage.inlineReceipts <= 256); assert.equal(storage.requestReceiptLimit, 100000);
  const fresh = new SpineService(f.config), replay = await fresh.projectSessions.configure(first); assert.equal(replay.requestReceipt.reused, true); assert.equal(replay.revision, 1050); assert.equal(replay.name, 'name-1049'); assert.equal(replay.versions.length, 1); assert.equal((await fresh.projectSessions.create(create)).reused, true);
  await assert.rejects(fresh.projectSessions.configure({ ...first, name: 'different' }), /another session operation/);
});

test('damaged receipt segments reject before replaying a historical mutation', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Receipts' }), first = { ...identity(s.id, 0), name: 'first' }; await f.sessions.configure(first); for (let i = 1; i < 4; i++) await f.sessions.configure({ ...identity(s.id, i), name: 'next-' + i });
  await f.sessions.compact({ ...identity(s.id, 4), keepRecent: 1 }); const state = await f.sessions.read(s.id), hash = state.receiptIndex[first.requestId]!; assert.ok(hash); await writeFile(path.join(await f.sessions.folder(s.id), 'receipts', hash + '.json'), '{}'); await assert.rejects(f.sessions.configure(first), /segment is damaged/); assert.equal((await f.sessions.get(s.id)).name, 'next-3');
});

test('waivers require an exact reviewed draft and preserve raw findings while allowing known locations', async () => {
  const f = await fixture('fold'), before = await fileSha256(f.input), a = await approved(f); assert.equal(a.draft.requiresExplicitReview, true); assert.equal((await approveQualityWaiver(f.service, a.args)).waiver.sha256, a.approval.waiver.sha256);
  const q = await checkPublishQuality(f.service, f.input, { fps: 4, waivers: [a.approval.waiver] }); assert.equal(q.checksPassed, true); assert.ok(q.reports[0]!.findingCounts!.mesh_fold); assert.equal(q.reports[0]!.waivers!.rawChecksPassed, false); assert.ok(q.reports[0]!.waivers!.waivedCount > 0); assert.equal(q.visualAcceptance, 'pending'); assert.equal(await fileSha256(f.input), before);
  const unapproved = await checkPublishQuality(f.service, f.input, { fps: 4, waivers: [{ path: a.draft.draftPath, sha256: a.draft.draftSha256 }] }); assert.equal(unapproved.checksPassed, false); assert.match(unapproved.errors.join(), /not been explicitly approved/);
  const relocated = (await writeDocument(f.service.workspace, 'relocated/source.json', await readDocument(f.input), f.root)).path; assert.equal((await checkPublishQuality(f.service, relocated, { fps: 4, waivers: [a.approval.waiver] })).checksPassed, true);
});

test('stale data, resources, sampling profile, draft hashes and changed approved files cannot keep a waiver', async () => {
  const f = await fixture('fold'), a = await approved(f);
  assert.equal((await checkPublishQuality(f.service, f.input, { fps: 2, waivers: [a.approval.waiver] })).checksPassed, false);
  const original = await readFile(f.input), changed = JSON.parse(original.toString()); changed.bones[0].x = 1; await writeFile(f.input, JSON.stringify(changed)); const stale = await checkPublishQuality(f.service, f.input, { fps: 4, waivers: [a.approval.waiver] }); assert.equal(stale.checksPassed, false); assert.match(stale.errors.join(), /stale/); await writeFile(f.input, original);
  await writeFile(f.image, encodePng(8, 8, new Uint8Array(256).fill(190))); assert.equal((await checkPublishQuality(f.service, f.input, { fps: 4, waivers: [a.approval.waiver] })).checksPassed, false);
  await assert.rejects(approveQualityWaiver(f.service, { ...a.args, expectedSha256: '0'.repeat(64) }), /draft changed/);
  await writeFile(a.approval.waiver.path, '{}'); assert.equal((await checkPublishQuality(f.service, f.input, { fps: 4, waivers: [a.approval.waiver] })).checksPassed, false);
});

test('partial time-range waivers leave other folds blocking publication', async () => {
  const f = await fixture('fold'), a = await approved(f, { selections: [{ subject: 'art', start: 1, end: 1, triangles: [1] }] });
  const q = await checkPublishQuality(f.service, f.input, { fps: 4, waivers: [a.approval.waiver] }); assert.equal(q.checksPassed, false); assert.ok(q.reports[0]!.waivers!.waivedCount > 0); assert.ok(q.reports[0]!.waivers!.blockingCount > 0);
});

test('enforced session checkpoints keep an approved exact-version waiver across archival resource relocation', async () => {
  const f = await fixture('fold'), a = await approved(f), s = await f.sessions.create({ input: f.input, name: 'Exact reviewed snapshot', quality: { fps: 4, waivers: [a.approval.waiver] } }), committed = await f.sessions.checkpoint(identity(s.id, 0)); assert.equal(committed.versions.at(-1)!.quality!.checksPassed, true); assert.equal(committed.versions.at(-1)!.quality!.mode, 'enforce');
});

test('waivers do not suppress explicit foot-contact diagnostics', async () => {
  const f = await fixture('fold'); (f.data.animations!.move!.bones as Record<string, unknown>).root = { translate: [{ x: 0 }, { time: 1, x: 5 }] }; await writeFile(f.input, JSON.stringify(f.data));
  const quality = { fps: 4, rules: [{ animation: 'move', contacts: [{ bone: 'root', start: 0, end: 1, tolerance: 0.1 }] }] }, a = await approved(f, { quality });
  const q = await checkPublishQuality(f.service, f.input, { ...quality, waivers: [a.approval.waiver] }); assert.equal(q.checksPassed, false); assert.ok(q.reports[0]!.findingCounts!.foot_slide); assert.ok(q.reports[0]!.waivers!.waivedCount > 0);
});

test('animated seam sampling detects motion-only gaps and writes marked joint crops', async () => {
  const f = await fixture('seams'), hash = await fileSha256(f.input), options = { input: f.input, animation: 'move', fps: 4, seams: [{ name: 'joint', a: { slot: 'art' }, b: { slot: 'other' }, bone: 'root', radius: 2 }] }, result = await auditAnimatedSeams(f.service, options);
  assert.equal(result.rows[0]!.passed, true); assert.equal(result.checksPassed, false); assert.ok(result.findings.some(f => f.time > 0 && f.unionFraction < 0.85)); assert.ok(result.previews.length); assert.ok((await stat(result.previews[0]!.marked)).size); assert.equal(await fileSha256(f.input), hash);
  await assert.rejects(auditAnimatedSeams(f.service, { ...options, maxSamples: 2 }), /budget/); await assert.rejects(auditAnimatedSeams(f.service, { ...options, seams: [{ ...options.seams[0]!, bone: 'missing' }] }), /anchor bone missing/);
});

test('seam windows include off-grid boundaries and missing attachments remain findings', async () => {
  const f = await fixture('seams'); f.data.animations!.move!.slots = { other: { attachment: [{ name: 'art' }, { time: 0.5, name: null }] } }; await writeFile(f.input, JSON.stringify(f.data));
  const r = await auditAnimatedSeams(f.service, { input: f.input, animation: 'move', fps: 1, maxPreviewPoses: 0, seams: [{ name: 'joint', a: { slot: 'art' }, b: { slot: 'other' }, bone: 'root', radius: 2, start: 0.2, end: 0.8 }] }); assert.equal(r.samples, 4); assert.ok(r.findings.some(f => f.missingLayer)); assert.ok(r.rows.some(f => f.time === 0.2));
});

async function orphan(f: Awaited<ReturnType<typeof fixture>>) { const a = await archiveProject(f.service, f.input); return { ...a, id: path.basename(a.directory).slice(9) }; }
test('cleanup protects retained session history and shared PNG/audio reference metadata', async () => {
  const f = await fixture(), session = await f.sessions.create({ input: f.input, name: 'Protected' }), state = await f.sessions.read(session.id), id = path.basename(path.dirname(state.versions[0]!.manifest)).slice(9), a = await orphan(f);
  const shared = path.join(f.root, 'shared.json'); await writeFile(shared, JSON.stringify({ images: path.join(a.directory, 'preview-0/images/art.png'), audio: path.join(a.directory, 'preview-0/audio/step.wav') }));
  const plan = await f.maintenance.plan({ archiveIds: [id, a.id], minAgeHours: 0 }); assert.ok(plan.candidates.every(c => !c.eligible)); assert.ok(plan.candidates.find(c => c.id === id)!.references.some(p => p.endsWith('state.json'))); assert.ok(plan.candidates.find(c => c.id === a.id)!.references.includes(shared)); await unlink(shared);
  assert.equal((await f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 })).candidates[0]!.eligible, true);
});

test('quarantine is reversible and exact retries never move a restored archive again', async () => {
  const f = await fixture(), a = await orphan(f), plan = await f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 }), args = { planId: plan.id, expectedPlanSha256: plan.planSha256, requestId: randomUUID() }, moved = await f.maintenance.apply(args);
  assert.equal(moved.state, 'quarantined'); assert.equal(moved.physicalBytesReclaimed, 0); await assert.rejects(stat(a.directory), /ENOENT/); assert.equal((await f.maintenance.apply(args)).reused, true);
  const restore = { cleanupId: moved.id, requestId: randomUUID() }; assert.equal((await f.maintenance.restore(restore)).state, 'restored'); assert.equal((await f.maintenance.restore(restore)).reused, true); assert.equal((await verifyArchive(f.service, a.manifestPath)).valid, true); assert.equal((await f.maintenance.apply(args)).state, 'restored');
});

test('new references and changed plans block cleanup without losing the source archive', async () => {
  const f = await fixture(), a = await orphan(f), plan = await f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 }), args = { planId: plan.id, expectedPlanSha256: plan.planSha256, requestId: randomUUID() };
  await assert.rejects(f.maintenance.apply({ ...args, expectedPlanSha256: '0'.repeat(64) }), /plan changed/); await writeFile(path.join(f.root, 'new-reference.json'), JSON.stringify({ input: a.original })); await assert.rejects(f.maintenance.apply(args), /gained a saved reference/); assert.equal((await verifyArchive(f.service, a.manifestPath)).valid, true);
});

test('interruption after the first real directory move recovers the same quarantine journal', async () => {
  const f = await fixture(), a = await orphan(f), b = await orphan(f), plan = await f.maintenance.plan({ archiveIds: [a.id, b.id], minAgeHours: 0 }), args = { planId: plan.id, expectedPlanSha256: plan.planSha256, requestId: randomUUID() }, payload = path.join(await f.maintenance.root(), 'interruption.json'); await writeFile(payload, JSON.stringify({ config: f.config, args }));
  const script = `import{readFile}from'node:fs/promises';import{SpineService}from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)};import{ArchiveMaintenance}from ${JSON.stringify(new URL('../src/archive-maintenance.js', import.meta.url).href)};const p=JSON.parse(await readFile(process.argv[1],'utf8'));await new ArchiveMaintenance(new SpineService(p.config)).apply(p.args,{checkpoint:async r=>{if(r.phase==='archive-quarantine')process.exit(74)}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, payload], { encoding: 'utf8', windowsHide: true }); assert.equal(child.status, 74, child.stderr); const recovered = await f.maintenance.apply(args); assert.equal(recovered.state, 'quarantined'); assert.ok(recovered.entries.every(e => e.state === 'moved')); await f.maintenance.restore({ cleanupId: plan.id, requestId: randomUUID() }); assert.equal((await verifyArchive(f.service, b.manifestPath)).valid, true);
});

test('permanent purge requires the exact fingerprint and refuses newly referenced quarantine', async () => {
  const f = await fixture(), a = await orphan(f), plan = await f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 }), moved = await f.maintenance.apply({ planId: plan.id, expectedPlanSha256: plan.planSha256, requestId: randomUUID() }), args = { cleanupId: plan.id, requestId: randomUUID(), expectedFingerprint: moved.purgeFingerprint, confirmation: 'permanently_delete_quarantined_archives' as const };
  await assert.rejects(f.maintenance.purge({ ...args, expectedFingerprint: '0'.repeat(64) }), /fingerprint/); const ref = path.join(f.root, 'late-reference.json'); await writeFile(ref, JSON.stringify({ image: path.join(a.directory, 'preview-0/images/art.png') })); await assert.rejects(f.maintenance.purge(args), /Saved references/); await unlink(ref);
  const purged = await f.maintenance.purge(args); assert.equal(purged.state, 'purged'); assert.ok(purged.physicalBytesReclaimed > 0); assert.equal((await f.maintenance.purge(args)).reused, true); await assert.rejects(f.maintenance.restore({ cleanupId: plan.id, requestId: randomUUID() }), /restoration is unavailable/);
});

test('reference scan budgets and malformed JSON fail closed', async () => {
  const f = await fixture(), a = await orphan(f); await writeFile(path.join(f.root, 'broken.json'), '{'); await assert.rejects(f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 }), /Cannot parse reference JSON/); await unlink(path.join(f.root, 'broken.json'));
  await mkdir(path.join(f.root, 'many')); for (let i = 0; i < 101; i++) await writeFile(path.join(f.root, 'many', String(i)), 'x'); await assert.rejects(f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0, maxFiles: 100 }), /file budget/);
});

test('cleanup never removes files added outside an archive manifest', async () => {
  const f = await fixture(), a = await orphan(f); await writeFile(path.join(a.directory, 'user-note.txt'), 'Keep this unrecorded file.'); await assert.rejects(f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 }), /unrecorded files/); assert.equal(await readFile(path.join(a.directory, 'user-note.txt'), 'utf8'), 'Keep this unrecorded file.');
});

test('real project JSON in the reports directory still protects shared archive resources', async () => {
  const f = await fixture(), a = await orphan(f); await mkdir(path.join(f.root, 'reports')); const data = await readDocument(f.input); data.skeleton.images = path.join(a.directory, 'preview-0/images'); await writeFile(path.join(f.root, 'reports', 'saved-project.json'), JSON.stringify(data)); const plan = await f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 }); assert.equal(plan.candidates[0]!.eligible, false);
});

test('native multi-skeleton reference exports are scanned and their budget remains strict', async () => {
  const f = await fixture(), a = await orphan(f), native = path.join(f.root, 'source.spine'); await writeFile(native, 'opaque native fixture'); const exported = path.join(await f.maintenance.root(), 'exported.json'); await writeFile(exported, JSON.stringify({ skeleton: { images: path.join(a.directory, 'preview-0/images') }, bones: [{ name: 'root' }] })); f.service.cli.exportData = (async () => ({ files: [f.input, exported] })) as any;
  const plan = await f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 }); assert.equal(plan.scannedNativeProjects, 1); assert.equal(plan.candidates[0]!.eligible, false); assert.ok(plan.candidates[0]!.references.includes(native)); await assert.rejects(f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0, maxNativeProjects: 0 }), /Native project reference budget/);
});

test('cleanup journals cannot substitute an archive that was absent from the reviewed plan', async () => {
  const f = await fixture(), a = await orphan(f), b = await orphan(f), plan = await f.maintenance.plan({ archiveIds: [a.id], minAgeHours: 0 }); await f.maintenance.apply({ planId: plan.id, expectedPlanSha256: plan.planSha256, requestId: randomUUID() }); const p = path.join(await f.maintenance.root(), plan.id + '.json'), journal = await read(p); journal.entries[0].id = b.id; await writeFile(p, JSON.stringify(journal)); await assert.rejects(f.maintenance.restore({ cleanupId: plan.id, requestId: randomUUID() }), /entries differ/); assert.equal((await verifyArchive(f.service, b.manifestPath)).valid, true);
});

test('archive-root junctions are rejected even when their target remains inside the workspace', async () => {
  const f = await fixture(), a = await orphan(f), aliasId = randomUUID(); await symlink(a.directory, path.join(f.root, 'archives', 'original-' + aliasId), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(f.maintenance.plan({ archiveIds: [aliasId], minAgeHours: 0 }), /symbolic links\/junctions at the archive root/); assert.equal((await verifyArchive(f.service, a.manifestPath)).valid, true);
});

test('migration backup junctions cannot copy session bytes outside the workspace', async () => {
  const f = await fixture(), s = await f.sessions.create({ input: f.input, name: 'Migration containment' }), folder = await f.sessions.folder(s.id), file = path.join(folder, 'state.json'), legacy = await read(file); legacy.schema = 'spine-project-session/1'; delete legacy.minimumWriterVersion; await writeFile(file, JSON.stringify(legacy)); const before = await fileSha256(file), outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-backup-outside-'))); await symlink(outside, path.join(folder, 'migrations'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(f.sessions.migrate(identity(s.id, 0)), /outside the workspace/); assert.equal(await fileSha256(file), before); assert.equal((await readdir(outside)).length, 0);
});

test('waiver output links cannot read or overwrite an external file', async () => {
  const f = await fixture('fold'), draft = await prepareQualityWaiver(f.service, { input: f.input, animation: 'move', quality: { fps: 4 }, selections: [{ subject: 'art', start: 0, end: 1, triangles: [1] }] }), requestId = randomUUID(), folder = path.join(f.root, '.quality-waivers'); await mkdir(folder); const outsideRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-waiver-outside-'))), outside = path.join(outsideRoot, 'keep.json'); await writeFile(outside, '{}'); await symlink(outside, path.join(folder, requestId + '.json'), process.platform === 'win32' ? 'file' : undefined); await assert.rejects(approveQualityWaiver(f.service, { draft: draft.draftPath, expectedSha256: draft.draftSha256, requestId, confirmation: 'reviewed_exact_report', reason: 'Synthetic reviewed fixture.' }), /outside the workspace/); assert.equal(await readFile(outside, 'utf8'), '{}');
});
