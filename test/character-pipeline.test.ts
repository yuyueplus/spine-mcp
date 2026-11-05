import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument, readDocument } from '../src/document.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { prepareLayerHandoff, auditLayerHandoff, importLayerHandoff } from '../src/layer-handoff.js';
import { planImageReplacement, applyImageReplacement, replacementData, planReplacementSchema } from '../src/image-replacement.js';
import { buildRepairData, repairSchema, createAnimationRepair } from '../src/animation-repair.js';
import { readCandidate, promoteCandidate, decodePng } from '../src/character-candidates.js';
import { sampleArtwork } from '../src/scene-preview.js';
import { animationSampler } from '../src/animation-sampler.js';

async function fixture(mesh = false, linked = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-character-pipeline-'))), config = { workspaceRoot: root, targetVersion: '4.3.23' as const, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }, service = new SpineService(config);
  const png = async (name: string, w = 8, h = 8, pixel: (x: number, y: number) => number[] = () => [255, 255, 255, 255]) => { const p = path.join(root, name), pixels = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.set(pixel(x, y), (y * w + x) * 4); await writeFile(p, encodePng(w, h, pixels)); return p; };
  const image = await png('art.png'), replacement = await png('new.png', 8, 8, () => [180, 220, 240, 255]);
  const attachment = mesh ? { type: 'mesh', path: 'art', width: 8, height: 8, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, vertices: [-4, 4, 4, 4, 4, -4, -4, -4] } : { path: 'art', width: 8, height: 8, rotation: 27, scaleX: -1.5, scaleY: 2, x: 3, y: 1 };
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.', fps: 60 }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', x: 2 }], slots: [{ name: 'art', bone: 'arm', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: attachment } } }], animations: { wave: { bones: { arm: { rotate: [{ value: 0 }, { time: 0.5, value: 60 }, { time: 1, value: 0 }], translate: [{ x: 0 }, { time: 1, x: 3 }] } } }, idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 2 }] } } } } });
  if (mesh) (data.animations!.wave as any).attachments = { default: { art: { art: { deform: [{ vertices: [0, 0, 0, 0, 0, 0, 0, 0] }, { time: 1, vertices: [0.1, 0, 0, 0, 0, 0, 0, 0] }] } } } };
  if (linked) { data.slots!.push({ name: 'other', bone: 'root', attachment: 'linked' }); (data.skins as any)[0].attachments.other = { linked: { type: 'mesh', source: 'art', slot: 'art', skin: 'default', path: 'art' } }; }
  const input = (await writeDocument(service.workspace, 'source.json', data)).path;
  return { root, service, config, data, input, image, replacement, png };
}
async function handoffFixture() {
  const f = await fixture(), base = await f.png('base.png', 8, 8, (x, y) => [255, 255, 255, x === 4 && y === 4 ? 0 : 255]), repaintMask = await f.png('repaint.png', 8, 8, (x, y) => [255, 255, 255, x === 4 && y === 4 ? 255 : 0]), protectedMask = await f.png('protected.png', 8, 8, (x, y) => [0, 0, 0, x === 0 && y === 0 ? 255 : 0]);
  const args = { requestId: randomUUID(), original: f.image, layers: [{ name: 'body', image: base, x: 0, y: 0, pivot: { x: 2, y: 6 }, repaintMask, protectedMask }] }, h = await prepareLayerHandoff(f.service, args);
  return { ...f, h, args, base, repaintMask, protectedMask, auditArgs: { handoff: h.handoff, expectedSha256: h.handoffSha256 } };
}
const replacementArgs = (f: Awaited<ReturnType<typeof fixture>>, extra = {}) => ({ input: f.input, skin: 'default', slot: 'art', attachment: 'art', image: f.replacement, ...extra });
async function replaced(f: Awaited<ReturnType<typeof fixture>>, extra = {}) { const plan = await planImageReplacement(f.service, replacementArgs(f, extra)), args = { requestId: randomUUID(), plan: plan.plan, expectedSha256: plan.planSha256 }, candidate = await applyImageReplacement(f.service, args); return { plan, args, candidate }; }
const promotionArgs = (candidate: { candidate: string; candidateSha256: string }, extra = {}) => ({ requestId: randomUUID(), candidate: candidate.candidate, expectedSha256: candidate.candidateSha256, confirmation: 'use_reviewed_candidate' as const, note: 'Synthetic regression candidate explicitly selected for testing.', native: false, ...extra });

test('handoff records immutable copies, canvas positions, pivots and external Codex generation guidance', async () => {
  const f = await handoffFixture(), h = JSON.parse(await readFile(f.h.handoff, 'utf8')); assert.equal(h.width, 8); assert.deepEqual(h.layers[0].pivot, { x: 2, y: 6 }); assert.equal(h.generationHandoff.semanticSegmentationOrAnatomyInferred, false); assert.notEqual(h.layers[0].image, f.base); assert.equal(await fileSha256(h.layers[0].image), await fileSha256(f.base)); assert.equal((await prepareLayerHandoff(f.service, f.args)).reused, true);
});
test('handoff rejects unfilled explicit repaint areas and blocks import', async () => {
  const f = await handoffFixture(), audit = await auditLayerHandoff(f.service, f.auditArgs); assert.equal(audit.checksPassed, false); assert.ok(audit.findings.some(x => x.kind === 'unfilled_repaint_mask')); await assert.rejects(importLayerHandoff(f.service, { ...f.auditArgs, requestId: randomUUID() }), /failed checks/);
});
test('handoff accepts filled alpha but retains an explicit pending visual review', async () => {
  const f = await handoffFixture(), audit = await auditLayerHandoff(f.service, { ...f.auditArgs, replacements: [{ layer: 'body', image: f.image }] }); assert.equal(audit.checksPassed, true); assert.equal(audit.layers[0]!.coverage, 1); assert.equal(audit.meanCompositeError, 0); assert.equal(audit.visualAcceptance, 'pending'); assert.equal((await decodePng(f.service, audit.compositePath)).width, 8);
});
test('handoff rejects repaint results that alter protected pixels', async () => {
  const f = await handoffFixture(), bad = await f.png('bad.png', 8, 8, (x, y) => [x === 0 && y === 0 ? 0 : 255, 255, 255, 255]), a = await auditLayerHandoff(f.service, { ...f.auditArgs, replacements: [{ layer: 'body', image: bad }] }); assert.equal(a.checksPassed, false); assert.equal(a.layers[0]!.protectedChanged, 1);
});
test('handoff validates replacement identity, dimensions and duplicate selectors', async () => {
  const f = await handoffFixture(); await assert.rejects(auditLayerHandoff(f.service, { ...f.auditArgs, replacements: [{ layer: 'unknown', image: f.image }] }), /Unknown/); await assert.rejects(auditLayerHandoff(f.service, { ...f.auditArgs, replacements: [{ layer: 'body', image: f.image }, { layer: 'body', image: f.image }] }), /repeated/); const big = await f.png('big.png', 9, 8); await assert.rejects(auditLayerHandoff(f.service, { ...f.auditArgs, replacements: [{ layer: 'body', image: big }] }), /canvas changed/);
});
test('handoff rejects mask dimensions and pivots outside the layer canvas', async () => {
  const f = await fixture(), mask = await f.png('small-mask.png', 2, 2); await assert.rejects(prepareLayerHandoff(f.service, { requestId: randomUUID(), original: f.image, layers: [{ name: 'a', image: f.image, x: 0, y: 0, repaintMask: mask }] }), /Masks must match/); await assert.rejects(prepareLayerHandoff(f.service, { requestId: randomUUID(), original: f.image, layers: [{ name: 'a', image: f.image, x: 0, y: 0, pivot: { x: 9, y: 0 } }] }), /pivot/);
});
test('handoff hashes reject modified manifests and masks', async () => {
  const f = await handoffFixture(); await assert.rejects(auditLayerHandoff(f.service, { ...f.auditArgs, expectedSha256: '0'.repeat(64) }), /changed/); const h = JSON.parse(await readFile(f.h.handoff, 'utf8')); await writeFile(h.layers[0].repaintMask, await readFile(f.image)); await assert.rejects(auditLayerHandoff(f.service, f.auditArgs), /changed/);
});
test('layer import preserves positions and provides a portable pivot rig', async () => {
  const f = await handoffFixture(), args = { ...f.auditArgs, requestId: randomUUID(), replacements: [{ layer: 'body', image: f.image }] }, c = await importLayerHandoff(f.service, args), d = await readDocument(c.json), bone = d.bones.find(b => b.name === 'layer_body_bone')!; assert.equal(bone.x, -2); assert.equal(bone.y, 2); const art = await sampleArtwork(f.service.workspace, d, c.json, undefined, [0]); assert.ok(art.frames[0]!.slots[0]!.vertices!.every((n, i) => Math.abs(n - [-4, 0, -4, 8, 4, 8, 4, 0][i]!) < 1e-5)); assert.equal((await importLayerHandoff(f.service, args)).candidate, c.candidate);
});
test('layer import appends to saved projects without changing existing animation tracks', async () => {
  const f = await handoffFixture(), c = await importLayerHandoff(f.service, { ...f.auditArgs, requestId: randomUUID(), input: f.input, replacements: [{ layer: 'body', image: f.image }] }), d = await readDocument(c.json); assert.deepEqual(d.animations, f.data.animations); assert.deepEqual(d.bones.slice(0, 2), f.data.bones); await assert.rejects(importLayerHandoff(f.service, { ...f.auditArgs, requestId: randomUUID(), parent: 'missing', replacements: [{ layer: 'body', image: f.image }] }), /parent/);
});
test('layer import creates the missing default skin in a root-only saved project', async () => {
  const f = await handoffFixture(), source = (await writeDocument(f.service.workspace, 'empty.json', parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }] }))).path;
  const c = await importLayerHandoff(f.service, { ...f.auditArgs, requestId: randomUUID(), input: source, replacements: [{ layer: 'body', image: f.image }] }), d = await readDocument(c.json); assert.equal((d.skins as any[]).some(s => s.name === 'default'), true); assert.equal(d.slots!.length, 1); assert.equal((await readCandidate(f.service, { candidate: c.candidate })).sourceChanged, false);
});
test('layer import retains existing named-only skins while adding the fallback layer collection', async () => {
  const f = await handoffFixture(); (f.data.skins as any[])[0].name = 'outfit'; await writeFile(f.input, JSON.stringify(f.data));
  const c = await importLayerHandoff(f.service, { ...f.auditArgs, requestId: randomUUID(), input: f.input, replacements: [{ layer: 'body', image: f.image }] }), d = await readDocument(c.json); assert.equal((d.skins as any[]).some(s => s.name === 'outfit'), true); assert.equal((d.skins as any[]).some(s => s.name === 'default'), true); assert.deepEqual(d.animations, f.data.animations); assert.equal(d.slots!.length, 2);
});
test('replacement plans preserve all animation data and apply to isolated image copies', async () => {
  const f = await fixture(), sourceHash = await fileSha256(f.input), oldImage = await fileSha256(f.image), r = await replaced(f), d = await readDocument(r.candidate.json); assert.equal(r.plan.checksPassed, true); assert.deepEqual(d.bones, f.data.bones); assert.deepEqual(d.animations, f.data.animations); assert.equal(await fileSha256(f.input), sourceHash); assert.equal(await fileSha256(f.image), oldImage); assert.equal((await readCandidate(f.service, { candidate: r.candidate.candidate })).sourceChanged, false); assert.equal((await applyImageReplacement(f.service, r.args)).reused, true);
});
test('resized images require an explicit reviewed geometry policy', async () => {
  const f = await fixture(), image = await f.png('large.png', 16, 16), p = await planImageReplacement(f.service, replacementArgs(f, { image })); assert.equal(p.checksPassed, false); await assert.rejects(applyImageReplacement(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }), /blockers/);
});
test('preserve-geometry maintains rotated/reflected region world vertices at sampled times', async () => {
  const f = await fixture(), image = await f.png('large.png', 16, 16), r = await replaced(f, { image, resizePolicy: 'preserve-geometry' }), d = await readDocument(r.candidate.json); for (const time of [0, 0.3, 0.9]) { const before = await sampleArtwork(f.service.workspace, f.data, f.input, 'wave', [time]), after = await sampleArtwork(f.service.workspace, d, r.candidate.json, 'wave', [time]); assert.deepEqual(after.frames[0]!.slots[0]!.vertices, before.frames[0]!.slots[0]!.vertices); }
});
test('aspect-ratio changes require an explicit additional choice', async () => {
  const f = await fixture(), image = await f.png('wide.png', 16, 8), bad = await planImageReplacement(f.service, replacementArgs(f, { image, resizePolicy: 'preserve-geometry' })); assert.equal(bad.checksPassed, false); const ok = await planImageReplacement(f.service, replacementArgs(f, { image, resizePolicy: 'preserve-geometry', allowAspectChange: true })); assert.equal(ok.checksPassed, true); assert.ok(ok.report.warnings.length);
});
test('region anchor alignment adjusts only its center and retains rig/animation', async () => {
  const f = await fixture(), args = planReplacementSchema.parse(replacementArgs(f, { anchors: { old: { x: 0, y: 0 }, replacement: { x: 4, y: 4 } } })), r = replacementData(f.data, args, { width: 8, height: 8 }, { width: 8, height: 8 }), v = (r.data.skins as any)[0].attachments.art.art, a = (f.data.skins as any)[0].attachments.art.art, rad = a.rotation * Math.PI / 180; assert.ok(Math.abs(v.x - (a.x + -4 * a.scaleX * Math.cos(rad) - 4 * a.scaleY * Math.sin(rad))) < 1e-9); assert.deepEqual(r.data.animations, f.data.animations); assert.deepEqual(r.data.bones, f.data.bones);
});
test('mesh image replacement retains vertices, UVs, weight layout and deform keys', async () => {
  const f = await fixture(true), image = await f.png('large.png', 16, 16), r = await replaced(f, { image, resizePolicy: 'preserve-geometry' }), d = await readDocument(r.candidate.json), a = (f.data.skins as any)[0].attachments.art.art, b = (d.skins as any)[0].attachments.art.art; for (const k of ['vertices', 'uvs', 'triangles', 'hull']) assert.deepEqual(b[k], a[k]); assert.deepEqual(d.animations, f.data.animations);
});
test('weighted meshes retain bone influences, world motion and animated deformation during image replacement', async () => {
  const f = await fixture(true), attachment = (f.data.skins as any)[0].attachments.art.art, points = attachment.vertices as number[]; attachment.vertices = [];
  for (let i = 0; i < points.length; i += 2) attachment.vertices.push(1, 1, points[i], points[i + 1], 1);
  await writeFile(f.input, JSON.stringify(parseDocument(f.data))); const r = await replaced(f), d = await readDocument(r.candidate.json); assert.deepEqual((d.skins as any)[0].attachments.art.art.vertices, attachment.vertices); assert.deepEqual(d.animations, f.data.animations);
  for (const t of [0, 0.35, 0.9]) { const a = await sampleArtwork(f.service.workspace, f.data, f.input, 'wave', [t]), b = await sampleArtwork(f.service.workspace, d, r.candidate.json, 'wave', [t]); assert.deepEqual(a.frames[0]!.slots[0]!.vertices, b.frames[0]!.slots[0]!.vertices); }
});
test('handoff composites multiple positioned layers in explicit back-to-front order', async () => {
  const f = await fixture(), top = await f.png('top.png', 2, 2, () => [255, 0, 0, 255]), original = await f.png('assembled.png', 8, 8, (x, y) => x >= 3 && x < 5 && y >= 1 && y < 3 ? [255, 0, 0, 255] : [255, 255, 255, 255]), h = await prepareLayerHandoff(f.service, { requestId: randomUUID(), original, maxCompositeError: 0, layers: [{ name: 'back', image: f.image, x: 0, y: 0 }, { name: 'front', image: top, x: 3, y: 1 }] }); const a = await auditLayerHandoff(f.service, { handoff: h.handoff, expectedSha256: h.handoffSha256 }); assert.equal(a.meanCompositeError, 0); assert.equal(a.checksPassed, true);
});
test('candidate validation refuses an incomplete pinned resource inventory', async () => {
  const f = await fixture(), r = await replaced(f), c = JSON.parse(await readFile(r.candidate.candidate, 'utf8')); c.files = c.files.filter((p: any) => !p.path.endsWith('.png')); await writeFile(r.candidate.candidate, JSON.stringify(c)); await assert.rejects(readCandidate(f.service, { candidate: r.candidate.candidate }), /inventory is incomplete/);
});
test('handoff refuses an incomplete pinned image inventory', async () => {
  const f = await handoffFixture(), h = JSON.parse(await readFile(f.h.handoff, 'utf8')); h.files = []; await writeFile(f.h.handoff, JSON.stringify(h)); await assert.rejects(auditLayerHandoff(f.service, { handoff: f.h.handoff, expectedSha256: await fileSha256(f.h.handoff) }), /inventory is incomplete/);
});
test('constrained rotation repair requires a supported explicit alternative', async () => {
  const f = await fixture(), data = structuredClone(f.data); data.constraints = [{}]; assert.throws(() => buildRepairData(data, repairSchema.parse({ requestId: randomUUID(), input: f.input, animation: 'wave', newName: 'candidate', rotations: [{ bone: 'arm', min: 0, max: 20 }] })), /unconstrained rig/);
});
test('mesh UV remapping is explicit and rejects UVs outside the new canvas', async () => {
  const f = await fixture(true), image = await f.png('pad.png', 16, 16), mapping = { oldAnchor: { x: 0, y: 0 }, replacementAnchor: { x: 4, y: 4 }, pixelScale: 1 }, good = await replaced(f, { image, resizePolicy: 'preserve-geometry', uvMapping: mapping }), d = await readDocument(good.candidate.json); assert.deepEqual((d.skins as any)[0].attachments.art.art.uvs, [0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75]); const bad = await planImageReplacement(f.service, replacementArgs(f, { uvMapping: mapping })); assert.equal(bad.checksPassed, false);
});
test('linked UV families require explicit propagation while normalized image replacement stays isolated', async () => {
  const f = await fixture(true, true), image = await f.png('pad.png', 16, 16), params = { image, resizePolicy: 'preserve-geometry', uvMapping: { oldAnchor: { x: 0, y: 0 }, replacementAnchor: { x: 4, y: 4 } } }, p = await planImageReplacement(f.service, replacementArgs(f, params)); assert.equal(p.checksPassed, false); assert.equal(p.report.affectedUVs.length, 2); assert.equal((await planImageReplacement(f.service, replacementArgs(f, { ...params, propagateLinkedUVs: true }))).checksPassed, true); const isolated = await replaced(f); assert.equal(isolated.candidate.checksPassed, true);
});
test('static PNG replacement refuses animated sequences', async () => {
  const f = await fixture(); (f.data.skins as any)[0].attachments.art.art.sequence = { count: 1, start: 0, digits: 1 }; await f.png('art0.png'); await writeFile(f.input, JSON.stringify(f.data)); assert.equal((await planImageReplacement(f.service, replacementArgs(f))).checksPassed, false);
});
for (const target of ['source', 'replacement'] as const) test('replacement rejects changed ' + target + ' after planning', async () => {
  const f = await fixture(), p = await planImageReplacement(f.service, replacementArgs(f)); await writeFile(target === 'source' ? f.input : f.replacement, target === 'source' ? JSON.stringify({ ...f.data, skeleton: { ...f.data.skeleton, fps: 50 } }) : encodePng(8, 8, new Uint8Array(256).fill(222))); await assert.rejects(applyImageReplacement(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }), /changed/);
});
test('candidate artifacts and damaged operation receipts reject rather than silently replaying', async () => {
  const f = await fixture(), r = await replaced(f), file = path.join(f.root, '.character-operations', r.args.requestId + '.json'), receipt = JSON.parse(await readFile(file, 'utf8')); receipt.result.checksPassed = false; await writeFile(file, JSON.stringify(receipt)); await assert.rejects(applyImageReplacement(f.service, r.args), /receipt is damaged/); await writeFile(r.candidate.json, '{}'); await assert.rejects(readCandidate(f.service, { candidate: r.candidate.candidate }), /changed/);
});
test('promotion checkpoints an exact candidate once and retains the previous session version', async () => {
  const f = await fixture(), s = await f.service.projectSessions.create({ input: f.input, name: 'Review session' }), r = await replaced(f), args = promotionArgs(r.candidate, { session: { id: s.id, expectedRevision: 0 } }), result = await promoteCandidate(f.service, args); assert.equal(result.session!.revision, 1); assert.equal(result.session!.versions.length, 2); assert.equal(result.output, r.candidate.json); assert.equal((await promoteCandidate(new SpineService(f.config), args)).reused, true); assert.equal((await f.service.projectSessions.get(s.id)).revision, 1);
});
test('interruption after session checkpoint recovers its exact request receipt without another version', async () => {
  const f = await fixture(), s = await f.service.projectSessions.create({ input: f.input, name: 'Recover' }), r = await replaced(f), args = promotionArgs(r.candidate, { session: { id: s.id, expectedRevision: 0 } }); await promoteCandidate(f.service, args); const file = path.join(f.root, '.character-operations', args.requestId + '.json'), receipt = JSON.parse(await readFile(file, 'utf8')); delete receipt.result; delete receipt.resultSha256; await writeFile(file, JSON.stringify(receipt)); const recovered = await promoteCandidate(new SpineService(f.config), args); assert.equal(recovered.session!.requestReceipt.reused, true); assert.equal(recovered.session!.versions.length, 2);
});
test('promotion rejects another session branch and stale revisions before committing', async () => {
  const f = await fixture(), other = (await writeDocument(f.service.workspace, 'other.json', f.data)).path, s = await f.service.projectSessions.create({ input: other, name: 'Other' }), r = await replaced(f); await assert.rejects(promoteCandidate(f.service, promotionArgs(r.candidate, { session: { id: s.id, expectedRevision: 0 } })), /does not match/); assert.equal((await f.service.projectSessions.get(s.id)).revision, 0);
});
test('candidate promotion rejects changed source and explicit hash mismatches', async () => {
  const f = await fixture(), r = await replaced(f); await assert.rejects(promoteCandidate(f.service, { ...promotionArgs(r.candidate), expectedSha256: '0'.repeat(64) }), /manifest changed/); await f.png('art.png', 8, 8, () => [0, 0, 0, 255]); assert.equal((await readCandidate(f.service, { candidate: r.candidate.candidate })).sourceChanged, true); await assert.rejects(promoteCandidate(f.service, promotionArgs(r.candidate)), /source\/resources changed/);
});
test('rotation candidates clamp explicit local windows and preserve original/unselected channels', async () => {
  const f = await fixture(), args = repairSchema.parse({ requestId: randomUUID(), input: f.input, animation: 'wave', newName: 'repaired', rotations: [{ bone: 'arm', min: -20, max: 20, start: 0, end: 1 }], comparison: { video: false } }), r = buildRepairData(f.data, args); assert.deepEqual(r.data.animations!.wave, f.data.animations!.wave); assert.deepEqual((r.data.animations!.repaired!.bones as any).arm.translate, (f.data.animations!.wave!.bones as any).arm.translate); assert.ok(r.report.maxLimitExcess < 1e-4); assert.equal(animationSampler(r.data, 'repaired').sample(0.5).bones[1]!.appliedPose.rotation, 20);
});
test('local rotation repairs retain curved motion outside a bounded repair interval', async () => {
  const f = await fixture(); (f.data.animations!.wave!.bones as any).arm.rotate = [{ value: 0 }, { time: 0.2, value: 0 }, { time: 0.5, value: 60 }, { time: 0.8, value: 0 }, { time: 1, value: 0 }]; const r = buildRepairData(f.data, repairSchema.parse({ requestId: randomUUID(), input: f.input, animation: 'wave', newName: 'limited', rotations: [{ bone: 'arm', min: 0, max: 15, start: 0.2, end: 0.8 }] })); assert.ok(r.report.maxOutsideRotationError < 1e-5); assert.ok(r.report.maxLimitExcess < 1e-5);
});
test('rotation repair rejects invalid boundary transitions instead of moving unselected time', async () => {
  const f = await fixture(); assert.throws(() => buildRepairData(f.data, repairSchema.parse({ requestId: randomUUID(), input: f.input, animation: 'wave', newName: 'bad', rotations: [{ bone: 'arm', min: 0, max: 10, start: 0.4, end: 0.6 }] })), /boundaries/);
});
test('repair requires explicit useful changes and a new animation name', async () => {
  const f = await fixture(); for (const a of [{ newName: 'new' }, { newName: 'wave', rotations: [{ bone: 'arm', min: 0, max: 20 }] }]) assert.throws(() => buildRepairData(f.data, repairSchema.parse({ requestId: randomUUID(), input: f.input, animation: 'wave', ...a })), /Provide explicit|NEW candidate/);
});
test('repair produces fixed-camera before/after reports, seekable frame player and a pending candidate', async () => {
  const f = await fixture(), args = { requestId: randomUUID(), input: f.input, animation: 'wave', newName: 'limited', rotations: [{ bone: 'arm', min: 0, max: 20 }], comparison: { width: 64, height: 64, fps: 4, video: false } }, c = await createAnimationRepair(f.service, args); assert.equal(c.checksPassed, true); assert.ok((c.details.before[0]!.findingCounts!.joint_limit ?? 0) > 0); assert.equal(c.details.after[0]!.checksPassed, true); assert.equal(c.details.comparison.fixedSharedCamera, true); const poster = await decodePng(f.service, c.details.comparison.poster); assert.equal(poster.width, 128); assert.equal(poster.height, 92); assert.match(await readFile(c.details.comparison.player, 'utf8'), /id="seek"/); assert.equal((await createAnimationRepair(f.service, args)).candidate, c.candidate); await assert.rejects(createAnimationRepair(f.service, { ...args, newName: 'other' }), /different character workflow/);
});
test('unresolved explicit audit failures keep a repair candidate unpromotable', async () => {
  const f = await fixture(), c = await createAnimationRepair(f.service, { requestId: randomUUID(), input: f.input, animation: 'wave', newName: 'limited', rotations: [{ bone: 'arm', min: 0, max: 20 }], audits: [{ separation: [{ left: 'root', right: 'arm', minDistance: 100 }], meshes: false, preview: 'none' }], comparison: { width: 32, height: 32, fps: 2, video: false } }); assert.equal(c.checksPassed, false); await assert.rejects(promoteCandidate(f.service, promotionArgs(c)), /failed checks/);
});
test('contact repair candidates retain the proven planted-foot solver and original animation', async () => {
  const f = await fixture(), leg = parseDocument({ skeleton: { spine: '4.3.23', fps: 60 }, bones: [{ name: 'root' }, { name: 'hips', parent: 'root', y: 4 }, { name: 'upper', parent: 'hips', rotation: -70, length: 2 }, { name: 'lower', parent: 'upper', x: 2, rotation: -35, length: 2 }, { name: 'foot', parent: 'lower', x: 2, length: 1 }], animations: { walk: { bones: { hips: { translate: [{ time: 0 }, { time: 0.5, x: 0.2, y: -0.2 }, { time: 1 }] } } } } }), r = buildRepairData(leg, repairSchema.parse({ requestId: randomUUID(), input: f.input, animation: 'walk', newName: 'planted', contacts: { chains: [{ upper: 'upper', lower: 'lower', foot: 'foot', contacts: [{ start: 0, end: 1 }] }], tolerance: 0.01 } })); assert.deepEqual(r.data.animations!.walk, leg.animations!.walk); assert.ok((r.report.contactVerification as any).maxContactError < 0.01);
});
test('image/handoff workflows reject outside workspace paths and escaping junctions', async () => {
  const f = await fixture(), outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-outside-art-'))); await writeFile(path.join(outside, 'art.png'), await readFile(f.image)); await symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(prepareLayerHandoff(f.service, { requestId: randomUUID(), original: path.join(f.root, 'escape', 'art.png'), layers: [{ name: 'a', image: f.image, x: 0, y: 0 }] }), /outside/); await assert.rejects(planImageReplacement(f.service, replacementArgs(f, { image: path.join(outside, 'art.png') })), /outside/);
});
