import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument, type SpineDocument } from '../src/document.js';
import { setConstraint } from '../src/constraint-edits.js';
import { animationSampler } from '../src/animation-sampler.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { buildIkContactRepair, createIkContactRepair, ikContactRepairSchema } from '../src/ik-contact-repair.js';
import { createCharacterTask, getCharacterTask, runCharacterTask, reviewCharacterTask } from '../src/character-task.js';
import { planCharacterTaskBranch, applyCharacterTaskBranch } from '../src/character-task-branch.js';
import { digest, readCandidate } from '../src/character-candidates.js';
import { writePsd, type Layer, type Psd } from 'ag-psd';
import { planPsdImport, importPsd } from '../src/psd-import.js';
import { planPsdImportSchema } from '../src/psd-schema.js';
import { decodePng } from '../src/character-candidates.js';
import { jobSchema } from '../src/job-schema.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-branch-contact-'))), service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }); service.jobs.kick = () => undefined;
  await mkdir(path.join(root, 'images')); const image = path.join(root, 'images/art.png'), blue = path.join(root, 'blue.png');
  await writeFile(image, encodePng(8, 8, new Uint8Array(256).fill(255))); const pixels = new Uint8Array(256); for (let i = 0; i < pixels.length; i += 4) pixels.set([40, 100, 240, 255], i); await writeFile(blue, encodePng(8, 8, pixels));
  const data = setConstraint(parseDocument({ skeleton: { spine: '4.3.23', fps: 60, images: './images' }, bones: [{ name: 'root' }, { name: 'target', parent: 'root', x: 65, y: 20 }, { name: 'upper', parent: 'root', length: 50 }, { name: 'lower', parent: 'upper', x: 50, length: 40 }, { name: 'foot', parent: 'lower', x: 40, length: 25 }, { name: 'unrelated', parent: 'root', x: -20 }], slots: [{ name: 'art', bone: 'foot', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { path: 'art', width: 8, height: 8 } } } }], animations: { move: { bones: { root: { translate: [{ time: 0, x: 0 }, { time: 1, x: 5 }] }, target: { translate: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 5, y: 0 }] }, foot: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 10 }] }, unrelated: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 10 }] } } } } }), { type: 'ik', name: 'leg_ik', bones: ['upper', 'lower'], target: 'target' });
  const input = (await writeDocument(service.workspace, 'source.json', data)).path; return { root, service, data, input, image, blue };
}
const contactArgs = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) => ikContactRepairSchema.parse({ requestId: randomUUID(), input: f.input, animation: 'move', newName: 'planted', chains: [{ constraint: 'leg_ik', foot: 'foot', heel: { x: -8, y: -4 }, toe: { x: 20, y: -4 }, contacts: [{ start: 0.25, end: 0.7 }] }], comparison: { video: false, width: 64, height: 64, fps: 3 }, ...extra });
const select = (t: { id: string; planSha256: string }) => ({ id: t.id, expectedPlanSha256: t.planSha256 });
async function task(f: Awaited<ReturnType<typeof fixture>>) { const {requestId, input, ...contactRepair} = contactArgs(f); const t = await createCharacterTask(f.service, { requestId: randomUUID(), input: f.input, name: 'parent', assets: { outfit: f.blue, spare: f.image }, replacements: [{ slot: 'art', attachment: 'art', image: { asset: 'outfit' } }], contactRepair, reviewMedia: [], publication: { native: false } }); await runCharacterTask(f.service, select(t)); return t; }
test('live contact repair plants both sole landmarks and orientation, preserving the source and live IK', async () => {
  const f = await fixture(), before = JSON.stringify(f.data), r = buildIkContactRepair(f.data, contactArgs(f));
  assert.equal(JSON.stringify(f.data), before); assert.deepEqual(r.data.constraints, f.data.constraints); assert.deepEqual(r.data.animations!.move, f.data.animations!.move);
  assert.equal(r.report.baked, false); assert.equal(r.report.controllersEditable, true); assert.ok(r.report.maxAnchorError < 0.1); assert.ok(r.report.maxOrientationErrorDegrees < 0.25); assert.ok(r.report.maxOutsideWorldError < 0.1);
  const modified = structuredClone(r.data); for (const k of (modified.animations!.planted!.bones as any).target.translate) k.y += 4;
  const a = animationSampler(r.data, 'planted').sample(0.5).bones.find(b => b.data.name === 'foot')!.appliedPose.worldY, b = animationSampler(modified, 'planted').sample(0.5).bones.find(b => b.data.name === 'foot')!.appliedPose.worldY; assert.ok(Math.abs(a - b) > 3);
});
for (const mode of ['heel', 'toe'] as const) test('contact repair supports rolling about the '+ mode, async () => {
  const f = await fixture(), args = contactArgs(f), s = animationSampler(f.data, 'move').sample(0.25).bones.find(b => b.data.name === 'foot')!.appliedPose, angle = Math.atan2(s.c, s.a) * 180 / Math.PI;
  args.chains[0]!.contacts[0] = { start: 0.25, end: 0.7, mode, angles: [{ time: 0.25, degrees: angle }, { time: 0.7, degrees: angle + 15 }], transitionSeconds: 0.15 };
  const r = buildIkContactRepair(f.data, args); assert.ok(r.report.maxAnchorError < 0.1); assert.ok(r.report.maxOrientationErrorDegrees < 0.25);
});
for (const bad of ['landmarks', 'overlap', 'foot_origin', 'softness', 'mix', 'shear', 'nonuniform', 'unreachable', 'sole_roll'] as const) test('contact repair rejects '+bad+' without changing source', async () => {
  const f = await fixture(), args = contactArgs(f);
  if (bad === 'landmarks') args.chains[0]!.toe = { ...args.chains[0]!.heel };
  if (bad === 'overlap') args.chains[0]!.contacts.push({ ...args.chains[0]!.contacts[0]! });
  if (bad === 'foot_origin') f.data.bones.find(b => b.name === 'foot')!.x = 39;
  if (bad === 'softness') (f.data.constraints as any[])[0]!.softness = 5;
  if (bad === 'mix') (f.data.constraints as any[])[0]!.mix = 0.5;
  if (bad === 'shear') f.data.bones.find(b => b.name === 'foot')!.shearX = 10;
  if (bad === 'nonuniform') f.data.bones[0]!.scaleX = 2;
  if (bad === 'unreachable') args.chains[0]!.contacts[0]!.anchor = { x: 1000, y: 1000 };
  if (bad === 'sole_roll') args.chains[0]!.contacts[0]!.angles = [{ time: 0.25, degrees: 0 }, { time: 0.7, degrees: 20 }];
  const before = JSON.stringify(f.data); assert.throws(() => buildIkContactRepair(f.data, args)); assert.equal(JSON.stringify(f.data), before);
});
test('contact candidate and task contact stage create portable, pinned outputs', async () => {
  const f = await fixture(), c = await createIkContactRepair(f.service, contactArgs(f)); assert.equal((await readCandidate(f.service, { candidate: c.candidate, expectedSha256: c.candidateSha256 })).checksPassed, true);
  const t = await task(f), state = await getCharacterTask(f.service, select(t)); assert.equal(state.phase, 'awaiting_review'); assert.equal(state.steps.contact!.completed, true);
});
test('branching an unused asset reuses processing but creates a new candidate and review identity', async () => {
  const f = await fixture(), t = await task(f), parent = await getCharacterTask(f.service, select(t)), before = await fileSha256(path.join(f.root, '.character-tasks', t.id, 'state.json'));
  const p = await planCharacterTaskBranch(f.service, { ...select(t), patch: { assets: { spare: f.blue } } }); assert.equal(p.checksPassed, true); assert.ok(p.decisions.filter(d => ['plan', 'replace', 'contact'].includes(d.stage)).every(d => d.action === 'reuse'));
  const apply = { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }, child = await applyCharacterTaskBranch(f.service, apply), again = await applyCharacterTaskBranch(f.service, apply); assert.equal(again.id, child.id); assert.notEqual(child.id, t.id);
  await runCharacterTask(f.service, select(child)); const result = await getCharacterTask(f.service, select(child)); assert.equal(result.phase, 'awaiting_review'); assert.notEqual(result.candidate!.candidateSha256, parent.candidate!.candidateSha256); assert.equal(result.review, undefined); assert.equal(result.steps.contact!.inheritedFrom!.id, t.id); assert.equal(await fileSha256(path.join(f.root, '.character-tasks', t.id, 'state.json')), before);
});
test('changing the used image rebuilds its dependent processing; changing media reuses geometry', async () => {
  const f = await fixture(), t = await task(f), image = await planCharacterTaskBranch(f.service, { ...select(t), patch: { assets: { outfit: f.image } } });
  assert.ok(image.decisions.filter(d => ['plan', 'replace', 'contact'].includes(d.stage)).every(d => d.action === 'recompute'));
  const media = await planCharacterTaskBranch(f.service, { ...select(t), patch: { reviewMedia: [{ animation: 'planted', end: 0.5, fps: 2, width: 64, height: 64, formats: ['gif'] }] as any } }); assert.equal(media.decisions.find(d => d.stage === 'contact')!.action, 'reuse'); assert.equal(media.decisions.find(d => d.stage === 'media')!.action, 'recompute');
});
test('branch apply rejects mutable parent changes after planning', async () => {
  const f = await fixture(), t = await task(f), p = await planCharacterTaskBranch(f.service, select(t)), parent = await getCharacterTask(f.service, select(t)); await reviewCharacterTask(f.service, { ...select(t), requestId: randomUUID(), candidateSha256: parent.candidate!.candidateSha256, decision: 'accepted', note: 'Fixture caller acceptance.' });
  await assert.rejects(applyCharacterTaskBranch(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }), /changed|hash/i);
});
test('cross-version branch requires explicit consent and recomputes old numeric stages', async () => {
  const f = await fixture(), t = await task(f), folder = path.join(f.root, '.character-tasks', t.id), plan = JSON.parse(await readFile(path.join(folder, 'plan.json'), 'utf8')), state = JSON.parse(await readFile(path.join(folder, 'state.json'), 'utf8'));
  plan.version = '2.16.0'; delete plan.args.contactRepair; delete state.state.steps.contact; plan.args.ikRepair = { animation: 'move', newName: 'old_ik', windows: [{ constraint: 'leg_ik', start: 0.2, end: 0.8, motion: { mode: 'offset', x: 0, y: 0 } }], comparison: { video: false } }; await writeFile(path.join(folder, 'plan.json'), JSON.stringify(plan)); const sha = await fileSha256(path.join(folder, 'plan.json')); state.state.version = '2.16.0'; state.state.planSha256 = sha; state.sha256 = digest(state.state); await writeFile(path.join(folder, 'state.json'), JSON.stringify(state));
  // The test also works while developing the build before the version is bumped.
  const p = await planCharacterTaskBranch(f.service, { id: t.id, expectedPlanSha256: sha, allowVersionMigration: true }); assert.equal(p.checksPassed, true);
  assert.equal(p.resetReview, true); if (p.mode === 'migration_branch') assert.equal(p.decisions.find(d => d.stage === 'replace')!.action, 'recompute');
  if (p.mode === 'migration_branch') { const blocked = await planCharacterTaskBranch(f.service, { id: t.id, expectedPlanSha256: sha }); assert.equal(blocked.checksPassed, false); await assert.rejects(applyCharacterTaskBranch(f.service, { requestId: randomUUID(), plan: blocked.plan, expectedSha256: blocked.planSha256 }), /Blocked/); }
});
test('contact repair preserves curved foot rotation before and after the full transition window', async () => {
  const f = await fixture(), keys = [{ time: 0, value: -3, curve: [0.2, -1, 0.8, 9] }, { time: 1, value: 10 }]; (f.data.animations!.move!.bones as any).foot.rotate = keys; const r = buildIkContactRepair(f.data, contactArgs(f, { fps: 120 })); assert.ok(r.report.maxOutsideWorldError < 0.1); assert.deepEqual((r.data.animations!.move!.bones as any).foot.rotate, keys);
});
test('a full-clip planted sole has no undefined transition endpoint', async () => {
  const f = await fixture(), args = contactArgs(f); args.chains[0]!.contacts[0]!.start = 0; args.chains[0]!.contacts[0]!.end = 1; const r = buildIkContactRepair(f.data, args); assert.ok(r.report.maxAnchorError < 0.1); assert.ok(Number.isFinite(r.report.maxOrientationErrorDegrees));
});
test('sole repair rejects animated contact length instead of silently sliding a landmark', async () => {
  const f = await fixture(); (f.data.animations!.move!.bones as any).foot.scale = [{ time: 0, x: 1, y: 1 }, { time: 1, x: 1.3, y: 1.3 }]; assert.throws(() => buildIkContactRepair(f.data, contactArgs(f)), /length/);
});
test('source drift requires explicit acceptance and invalidates dependent branch stages', async () => {
  const f = await fixture(), t = await task(f), data = JSON.parse(await readFile(f.input, 'utf8')); data.bones[0].x = 2; await writeFile(f.input, JSON.stringify(data));
  const blocked = await planCharacterTaskBranch(f.service, select(t)); assert.equal(blocked.checksPassed, false); const p = await planCharacterTaskBranch(f.service, { ...select(t), acceptSourceDrift: true }); assert.equal(p.checksPassed, true); assert.ok(p.decisions.filter(d => ['plan', 'replace', 'contact'].includes(d.stage)).every(d => d.action === 'recompute'));
});
test('a corrupted intermediate plan invalidates its dependent output even with equal arguments', async () => {
  const f = await fixture(), t = await task(f), state = await getCharacterTask(f.service, select(t)); await writeFile(state.steps.plan!.result!.path, '{}'); const p = await planCharacterTaskBranch(f.service, select(t)); assert.equal(p.decisions.find(d => d.stage === 'plan')!.action, 'recompute'); assert.equal(p.decisions.find(d => d.stage === 'replace')!.reason, 'upstream_output_will_be_rebuilt'); assert.equal(p.decisions.find(d => d.stage === 'contact')!.action, 'recompute');
});

function psdLayer(name: string, extra: Partial<Layer> = {}): Layer { const data = new Uint8ClampedArray(8 * 8 * 4); for (let i = 0; i < data.length; i += 4) data.set([230, 80, 30, 255], i); return { name, left: 10, top: 8, imageData: { width: 8, height: 8, data }, ...extra }; }
async function psdFixture(children: Layer[], extra: Partial<Psd> = {}, compress = false) { const f = await fixture(), psd = path.join(f.root, 'layers.psd'); await writeFile(psd, Buffer.from(writePsd({ width: 64, height: 64, children, ...extra }, { noBackground: true, compress }))); return { ...f, psd }; }
test('PSD grouped raster import creates correct bones, layer order, placement and opacity in new pinned PNGs', async () => {
  const f = await psdFixture([{ name: 'Character [bone:body]', blendMode: 'pass through', children: [psdLayer('back'), psdLayer('face', { top: 4, left: 12, opacity: 0.5 })] }]), before = await fileSha256(f.psd), p = await planPsdImport(f.service, { input: f.psd, padding: 0 });
  assert.equal(p.checksPassed, true, JSON.stringify(p.blockers)); assert.deepEqual(p.data.slots!.map(s => s.name), ['back', 'face']); assert.deepEqual(p.data.bones.find(b => b.name === 'body'), { name: 'body', parent: 'root', x: -16, y: 24 });
  const args = { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }, c = await importPsd(f.service, args), retry = await importPsd(f.service, args); assert.equal(retry.candidate, c.candidate); assert.equal(retry.reused, true); assert.equal(c.kind, 'psd_import');
  assert.equal((await readCandidate(f.service, { candidate: c.candidate, expectedSha256: c.candidateSha256 })).checksPassed, true); const record = p.records.find(r => r.slot === 'face')!, image = await decodePng(f.service, path.join(path.dirname(c.json), record.image)); assert.equal(image.pixels[3], 128); assert.equal(await fileSha256(f.psd), before);
});
test('PSD tags support nested bones, shared slots, skins, logical folders, hidden/ignored layers and origin markers', async () => {
  const f = await psdFixture([psdLayer('Origin [origin]', { left: 28, top: 28 }), { name: 'Hidden [ignore]', children: [psdLayer('bad [merge]')] }, { name: 'Character [bone:body]', blendMode: 'pass through', children: [ { name: 'Red [skin:red]', children: [psdLayer('dress [slot:outfit] [folder:costume] [path:garment]')] }, { name: 'Blue [skin:blue]', children: [psdLayer('dress [slot:outfit] [folder:costume]', { opacity: 0.8 })] }, psdLayer('hidden', { hidden: true }) ] }]);
  const p = await planPsdImport(f.service, { input: f.psd, reviewSkin: 'blue', padding: 0 }); assert.equal(p.checksPassed, true, JSON.stringify(p.blockers)); assert.equal(p.records.length, 2); assert.deepEqual(p.origin, { x: 32, y: 32 }); assert.equal(p.data.slots![0]!.attachment, 'costume/dress'); assert.deepEqual((p.data.skins as any[]).map(s => s.name), ['red', 'blue']);
  const json = (await importPsd(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 })).json; assert.ok(json.endsWith('skeleton.json'));
  const names = (p.data.skins as any[]).map(s => s.attachments.outfit['costume/dress'].name); assert.equal(new Set(names).size, 2); assert.deepEqual(names, ['red/costume/dress', 'blue/costume/dress']); assert.equal(p.suggestedSkin, 'blue'); assert.equal(p.requiresSkinSelection, true);
});
test('PSD lazy ZIP decode, guide origin, canvas trim and units per pixel work without canvas or UI', async () => {
  const f = await psdFixture([psdLayer('part [trim:canvas] [pad:2]')], { imageResources: { gridAndGuidesInformation: { guides: [{ direction: 'vertical', location: 10 }, { direction: 'horizontal', location: 20 }] } } }, true), p = await planPsdImport(f.service, { input: f.psd, unitsPerPixel: 0.5 });
  assert.equal(p.checksPassed, true, JSON.stringify(p.blockers)); assert.deepEqual(p.origin, { x: 10, y: 20 }); assert.equal(p.records[0]!.width, 68); assert.equal((p.data.skins as any[])[0].attachments.part.part.width, 34); await importPsd(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 });
});
for (const mode of ['mask', 'vectorMask', 'effects', 'clipping', 'unknownTag', 'unsafePath', 'duplicate', 'blend', 'noPixels'] as const) test('PSD preflight reports and blocks unsupported '+mode, async () => {
  let children: Layer[] = [psdLayer('part')]; const layer = children[0]!;
  if (mode === 'mask') layer.mask = { top: 0, left: 0, bottom: 1, right: 1, defaultColor: 255 };
  if (mode === 'vectorMask') layer.vectorMask = { paths: [] };
  if (mode === 'effects') layer.effects = { scale: 1, solidFill: [{ enabled: true, color: { r: 255, g: 0, b: 0 }, opacity: 1, blendMode: 'normal' }] };
  if (mode === 'clipping') layer.clipping = true;
  if (mode === 'unknownTag') layer.name = 'part [mesh]';
  if (mode === 'unsafePath') layer.name = 'part [path:../escape]';
  if (mode === 'duplicate') children.push(psdLayer('part'));
  if (mode === 'blend') layer.blendMode = 'overlay';
  if (mode === 'noPixels') layer.imageData = undefined;
  const f = await psdFixture(children), p = await planPsdImport(f.service, { input: f.psd }); assert.equal(p.checksPassed, false, mode); assert.ok(p.blockers.length); await assert.rejects(importPsd(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }), /blocked/);
});
test('PSD source/plan hashes and workspace boundaries prevent stale imports', async () => {
  const f = await psdFixture([psdLayer('part')]), p = await planPsdImport(f.service, { input: f.psd }); await writeFile(f.psd, Buffer.from(writePsd({ width: 64, height: 64, children: [psdLayer('other')] })));
  await assert.rejects(importPsd(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }), /changed/); await assert.rejects(planPsdImport(f.service, { input: path.join(f.root, '..', 'outside.psd') }), /outside/);
});
for (const mode of ['depth', 'color', 'size', 'psb'] as const) test('PSD header guards reject '+mode+' before decoding', async () => {
  const f = await psdFixture([psdLayer('part')]), bytes = await readFile(f.psd); if (mode === 'depth') bytes.writeUInt16BE(16, 22); if (mode === 'color') bytes.writeUInt16BE(4, 24); if (mode === 'size') bytes.writeUInt32BE(1000000, 18); if (mode === 'psb') bytes.writeUInt16BE(2, 4); await writeFile(f.psd, bytes); await assert.rejects(planPsdImport(f.service, { input: f.psd }), /PSD/);
});
test('PSD import supports background job schema and cooperative cancellation before publication', async () => {
  const f = await psdFixture([psdLayer('part')]), p = await planPsdImport(f.service, { input: f.psd }), args = { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }; assert.equal(jobSchema.parse({ operation: 'import_psd', args }).operation, 'import_psd');
  await assert.rejects(importPsd(f.service, args, { checkpoint: async () => { throw new Error('MCP_JOB_CANCELLED'); } }), /CANCELLED/); const resumed = await importPsd(f.service, args); assert.equal(resumed.checksPassed, true);
});
test('PSD immediate child bone/slot tags work and ignored descendants still count toward the layer budget', async () => {
  const f = await psdFixture([{ name: 'Character [bones] [slots]', children: [psdLayer('arm'), psdLayer('body')] }]), p = await planPsdImport(f.service, { input: f.psd }); assert.equal(p.checksPassed, true); assert.equal(p.data.bones.length, 3); assert.deepEqual(p.data.slots!.map(s => s.bone), ['arm', 'body']);
  const many = await psdFixture([{ name: 'Ignored [ignore]', children: Array.from({ length: 256 }, (_, i) => psdLayer('layer'+i)) }]); await assert.rejects(planPsdImport(many.service, { input: many.psd }), /256/);
});
test('partial PSD import resumes exact PNGs after cancellation and refuses changed partial bytes', async () => {
  const f = await psdFixture([psdLayer('one'), psdLayer('two')]), p = await planPsdImport(f.service, { input: f.psd }), args = { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 };
  await assert.rejects(importPsd(f.service, args, { checkpoint: async v => { if (v.phase === 'psd:rasterize' && v.completed === 1) throw new Error('MCP_JOB_CANCELLED'); } }), /CANCELLED/);
  const partial = path.join(f.root, 'psd-imports', args.requestId, p.records[0]!.image), bytes = await readFile(partial); await writeFile(partial, 'changed'); await assert.rejects(importPsd(f.service, args), /no longer matches/); await writeFile(partial, bytes); const c = await importPsd(f.service, args); assert.equal(c.checksPassed, true); assert.deepEqual(await readFile(partial), bytes);
});
test('completed PSD retries still reject source drift and artifact tampering', async () => {
  const f = await psdFixture([psdLayer('part')]), p = await planPsdImport(f.service, { input: f.psd }), args = { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }, c = await importPsd(f.service, args), bytes = await readFile(f.psd); await writeFile(f.psd, Buffer.concat([bytes, Buffer.from([0])])); await assert.rejects(importPsd(f.service, args), /changed/); await writeFile(f.psd, bytes); await writeFile(path.join(path.dirname(c.json), p.records[0]!.image), 'changed'); await assert.rejects(importPsd(f.service, args), /changed/);
});
test('PSD preflight rejects default attachments colliding with named-skin placeholders', async () => {
  const f = await psdFixture([psdLayer('coat [slot:outfit]'), { name: 'Red [skin:red]', children: [psdLayer('coat [slot:outfit]')] }]), p = await planPsdImport(f.service, { input: f.psd }); assert.equal(p.checksPassed, false); assert.ok(p.blockers.some(b => b.reason.includes('Default attachment conflicts')));
});
test('PSD output rejects a junction escaping the workspace before creating external files', async () => {
  const f = await psdFixture([psdLayer('part')]), p = await planPsdImport(f.service, { input: f.psd }), requestId = randomUUID(), folder = path.join(f.root, 'psd-imports', requestId), outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'psd-outside-'))); await mkdir(folder, { recursive: true }); await symlink(outside, path.join(folder, 'images'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(importPsd(f.service, { requestId, plan: p.plan, expectedSha256: p.planSha256 }), /outside/); assert.deepEqual(await readdir(outside), []);
});
