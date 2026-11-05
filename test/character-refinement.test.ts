import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, readDocument, writeDocument } from '../src/document.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { prepareLayerHandoff, importLayerHandoff } from '../src/layer-handoff.js';
import { exactPng, alignmentMatrix, compositeRepaintPixels, composeLayerRepaint } from '../src/repaint-composition.js';
import { planBatchImageReplacement, applyBatchImageReplacement } from '../src/batch-image-replacement.js';
import { readCandidate, promoteCandidate } from '../src/character-candidates.js';
import { buildRepairData, createAnimationRepair, repairSchema } from '../src/animation-repair.js';
import { setConstraint } from '../src/constraint-edits.js';
import { sampleArtwork } from '../src/scene-preview.js';

async function fixture(mesh = false, linked = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-refinement-'))), config = { workspaceRoot: root, targetVersion: '4.3.23' as const, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }, service = new SpineService(config);
  const png = async (name: string, width = 8, height = 8, pixel: (x: number, y: number) => number[] = () => [255, 255, 255, 255]) => { const bytes = new Uint8Array(width * height * 4); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set(pixel(x, y), (y * width + x) * 4); const file = path.join(root, name); await writeFile(file, encodePng(width, height, bytes)); return file; };
  const image = await png('art.png'), red = await png('red.png', 8, 8, () => [250, 20, 40, 255]), blue = await png('blue.png', 8, 8, () => [20, 80, 250, 255]);
  const artwork = mesh ? { type: 'mesh', path: 'art', width: 8, height: 8, uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, vertices: [1, 1, -4, 4, 1, 1, 1, 4, 4, 1, 1, 1, 4, -4, 1, 1, 1, -4, -4, 1] } : { path: 'art', width: 8, height: 8, x: 2 };
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.', fps: 60 }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 10 }, { name: 'target', parent: 'root', x: 10 }], slots: [{ name: 'head', bone: 'arm', attachment: 'art' }, { name: 'hair', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { head: { art: artwork }, hair: { art: linked ? { type: 'mesh', source: 'art', skin: 'default', slot: 'head', path: 'art' } : { ...structuredClone(artwork), x: 3 } } } }], animations: { wave: { bones: { arm: { rotate: [{ value: 0 }, { time: 0.5, value: 60 }, { time: 1, value: 0 }] }, target: { translate: [{ y: 0 }, { time: 0.5, y: 8 }, { time: 1, y: 0 }] } } }, idle: { bones: { root: { translate: [{ x: 0 }, { time: 1, x: 0.1 }] } } } } });
  if (mesh) (data.animations!.wave as any).attachments = { default: { head: { art: { deform: [{ vertices: [0, 0, 0, 0, 0, 0, 0, 0] }, { time: 1, vertices: [0.1, 0, 0, 0, 0, 0, 0, 0] }] } } } };
  const input = (await writeDocument(service.workspace, 'source.json', data)).path; return { root, config, service, data, input, image, red, blue, png };
}
async function handoff() {
  const f = await fixture(), base = await f.png('base.png', 8, 8, (x, y) => x === 0 && y === 0 ? [17, 31, 65, 37] : x === 1 && y === 0 ? [99, 22, 44, 0] : [255, 255, 255, x === 3 && y === 3 ? 0 : 255]), mask = await f.png('mask.png', 8, 8, (x, y) => [0, 0, 0, x >= 2 && x < 6 && y >= 2 && y < 6 ? 255 : 0]), protection = await f.png('protection.png', 8, 8, (x, y) => [0, 0, 0, y === 0 || x === 4 && y === 4 ? 1 : 0]), generated = await f.png('generated.png', 16, 16, () => [20, 80, 240, 255]);
  const h = await prepareLayerHandoff(f.service, { requestId: randomUUID(), original: f.image, layers: [{ name: 'body', image: base, x: 0, y: 0, pivot: { x: 2, y: 6 }, repaintMask: mask, protectedMask: protection }] });
  return { ...f, h, base, mask, protection, generated, args: { requestId: randomUUID(), handoff: h.handoff, expectedSha256: h.handoffSha256, repaints: [{ layer: 'body', image: generated }] } };
}
const imageRows = (f: Awaited<ReturnType<typeof fixture>>, extra = {}) => [{ slot: 'head', attachment: 'art', image: f.red, ...extra }, { slot: 'hair', attachment: 'art', image: f.blue, ...extra }];
async function batch(f: Awaited<ReturnType<typeof fixture>>, replacements = imageRows(f)) { const plan = await planBatchImageReplacement(f.service, { input: f.input, replacements }), args = { requestId: randomUUID(), plan: plan.plan, expectedSha256: plan.planSha256 }; return { plan, args, candidate: await applyBatchImageReplacement(f.service, args) }; }
const promotion = (c: { candidate: string; candidateSha256: string }, extra = {}) => ({ requestId: randomUUID(), candidate: c.candidate, expectedSha256: c.candidateSha256, confirmation: 'use_reviewed_candidate' as const, note: 'Synthetic fixture selected to verify the exact pipeline.', native: false, ...extra });
const repairArgs = (f: Awaited<ReturnType<typeof fixture>>, extra = {}) => repairSchema.parse({ requestId: randomUUID(), input: f.input, animation: 'wave', newName: 'repaired', rotations: [{ bone: 'arm', min: -20, max: 20 }], comparison: { width: 32, height: 32, fps: 2, video: false }, ...extra });

test('lossless PNG decoding retains transparent RGB and partially transparent channels exactly', async () => {
  const f = await handoff(), p = await exactPng(f.service, f.base); assert.deepEqual([...p.pixels.subarray(0, 8)], [17, 31, 65, 37, 99, 22, 44, 0]);
});
test('repaint aligns a larger generated canvas and preserves every protected/outside-mask RGBA tuple', async () => {
  const f = await handoff(), before = await exactPng(f.service, f.base), result = await composeLayerRepaint(f.service, f.args), after = await exactPng(f.service, result.replacements[0]!.image), mask = await exactPng(f.service, f.mask), protect = await exactPng(f.service, f.protection);
  assert.equal(result.checksPassed, true); assert.equal(after.width, 8); assert.equal(result.layers[0]!.protectedPixelChanges, 0);
  for (let i = 0; i < before.pixels.length; i += 4) if (!mask.pixels[i + 3] || protect.pixels[i + 3]) assert.deepEqual(after.pixels.subarray(i, i + 4), before.pixels.subarray(i, i + 4));
  assert.equal(after.pixels[(3 * 8 + 3) * 4 + 3], 255); assert.equal((await composeLayerRepaint(f.service, f.args)).reused, true); const imported = await importLayerHandoff(f.service, { requestId: randomUUID(), handoff: f.h.handoff, expectedSha256: f.h.handoffSha256, replacements: result.replacements }); assert.equal(imported.checksPassed, true);
});
test('one-alpha protection locks pixels even inside a full repaint selection', async () => {
  const f = await handoff(), r = await composeLayerRepaint(f.service, f.args), p = await exactPng(f.service, r.replacements[0]!.image); assert.deepEqual([...p.pixels.subarray((4 * 8 + 4) * 4, (4 * 8 + 4) * 4 + 4)], [255, 255, 255, 255]);
});
for (const fit of ['contain', 'cover', 'stretch', 'exact'] as const) test('canvas alignment defines an explicit ' + fit + ' policy', () => {
  const s = fit === 'exact' ? { width: 8, height: 8 } : { width: 16, height: 8 }, m = alignmentMatrix(s, { width: 8, height: 8, pivot: { x: 4, y: 4 } }, { mode: 'canvas', fit, offsetX: 0, offsetY: 0 }); assert.ok(Object.values(m).every(Number.isFinite)); if (fit === 'contain') { assert.equal(m.a, 0.5); assert.equal(m.y, 2); } if (fit === 'cover') { assert.equal(m.a, 1); assert.equal(m.x, -4); } if (fit === 'stretch') assert.equal(m.d, 1);
});
test('two explicit correspondences derive scale/rotation while one correspondence can use the recorded pivot', () => {
  const target = { width: 8, height: 8, pivot: { x: 2, y: 6 } }, m = alignmentMatrix({ width: 16, height: 16 }, target, { mode: 'anchors', from: { x: 2, y: 2 }, to: { x: 2, y: 6 }, from2: { x: 4, y: 2 }, to2: { x: 2, y: 2 }, scale: 1, rotation: 0 }); assert.ok(Math.abs(m.a * 2 + m.c * 2 + m.x - 2) < 1e-8); assert.ok(Math.abs(m.b * 2 + m.d * 2 + m.y - 6) < 1e-8); const one = alignmentMatrix({ width: 16, height: 16 }, target, { mode: 'anchors', from: { x: 8, y: 8 }, scale: 0.5, rotation: 0 }); assert.equal(one.x, -2); assert.equal(one.y, 2);
});
test('alignment rejects inconsistent anchors, degenerate pairs and changed exact canvas sizes', () => {
  const s = { width: 8, height: 8 }, t = { ...s, pivot: { x: 4, y: 4 } }; assert.throws(() => alignmentMatrix(s, t, { mode: 'anchors', from: { x: 0, y: 0 }, from2: { x: 0, y: 0 }, to2: { x: 4, y: 4 }, scale: 1, rotation: 0 }), /degenerate/); assert.throws(() => alignmentMatrix(s, t, { mode: 'anchors', from: { x: 10, y: 0 }, scale: 1, rotation: 0 }), /inside/); assert.throws(() => alignmentMatrix(s, t, { mode: 'anchors', from: { x: 0, y: 0 }, from2: { x: 1, y: 1 }, scale: 1, rotation: 0 }), /both/); assert.throws(() => alignmentMatrix({ width: 16, height: 8 }, t, { mode: 'canvas', fit: 'exact', offsetX: 0, offsetY: 0 }), /equal dimensions/);
});
test('bilinear sampling uses premultiplied alpha so transparent colored texels do not introduce halos', async () => {
  const f = await fixture(), base = await exactPng(f.service, await f.png('empty.png', 1, 1, () => [0, 0, 0, 0])), mask = await exactPng(f.service, await f.png('select.png', 1, 1)), generated = await exactPng(f.service, await f.png('edge.png', 2, 1, x => x ? [0, 0, 255, 0] : [255, 0, 0, 255]));
  const r = compositeRepaintPixels(base, generated, mask, undefined, { a: 0.5, b: 0, c: 0, d: 1, x: 0, y: 0 }, 'bilinear', 'replace'); assert.deepEqual([...r.pixels], [255, 0, 0, 128]);
});
test('over blending and soft repaint alpha retain the correct source contribution', async () => {
  const f = await fixture(), base = await exactPng(f.service, await f.png('one.png', 1, 1, () => [0, 0, 255, 255])), mask = await exactPng(f.service, await f.png('half.png', 1, 1, () => [0, 0, 0, 128])), generated = await exactPng(f.service, await f.png('one-red.png', 1, 1, () => [255, 0, 0, 128])); const r = compositeRepaintPixels(base, generated, mask, undefined, { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }, 'nearest', 'over'); assert.ok(Math.abs(r.pixels[0]! - 64) <= 1); assert.equal(r.pixels[3], 255);
});
test('failed or cropped repaint coverage remains a failed handoff rather than a visual approval', async () => {
  const f = await handoff(), transparent = await f.png('transparent.png', 8, 8, () => [240, 10, 60, 0]), result = await composeLayerRepaint(f.service, { ...f.args, repaints: [{ layer: 'body', image: transparent }] }); assert.equal(result.checksPassed, false); assert.equal(result.visualAcceptance, 'pending'); await assert.rejects(importLayerHandoff(f.service, { requestId: randomUUID(), handoff: f.h.handoff, expectedSha256: f.h.handoffSha256, replacements: result.replacements }), /failed checks/);
});
test('composition rejects unknown/repeated layers and stale handoff hashes', async () => {
  const f = await handoff(); await assert.rejects(composeLayerRepaint(f.service, { ...f.args, expectedSha256: '0'.repeat(64) }), /changed/); await assert.rejects(composeLayerRepaint(f.service, { ...f.args, requestId: randomUUID(), repaints: [{ layer: 'missing', image: f.generated }] }), /explicit repaintMask/); await assert.rejects(composeLayerRepaint(f.service, { ...f.args, requestId: randomUUID(), repaints: [f.args.repaints[0]!, f.args.repaints[0]!] }), /Repeated/);
});
test('exact composition rejects non-eight-bit input and CRC corruption', async () => {
  const f = await fixture(), bytes = Buffer.from(await readFile(f.red)); bytes[24] = 16; const bad = path.join(f.root, 'depth.png'); await writeFile(bad, bytes); await assert.rejects(exactPng(f.service, bad), /8-bit/); const crc = Buffer.from(await readFile(f.red)); crc[crc.length - 1] = crc[crc.length - 1]! ^ 1; await writeFile(bad, crc); await assert.rejects(exactPng(f.service, bad), /crc/i);
});
test('composition exact retries reject changed arguments or altered output pixels', async () => {
  const f = await handoff(), r = await composeLayerRepaint(f.service, f.args); await assert.rejects(composeLayerRepaint(f.service, { ...f.args, repaints: [{ layer: 'body', image: f.red }] }), /different character workflow/); await writeFile(r.replacements[0]!.image, await readFile(f.red)); await assert.rejects(composeLayerRepaint(f.service, f.args), /changed/);
});

test('two-image batch yields one portable candidate with original bones and animations intact', async () => {
  const f = await fixture(), before = await fileSha256(f.input), r = await batch(f), d = await readDocument(r.candidate.json); assert.deepEqual(d.animations, f.data.animations); assert.deepEqual(d.bones, f.data.bones); assert.equal(r.candidate.details.applied.length, 2); assert.equal(r.candidate.details.imageCopies, 2); assert.equal((await readCandidate(f.service, { candidate: r.candidate.candidate })).sourceChanged, false); assert.equal(await fileSha256(f.input), before);
});
test('one missing batch image blocks every row without changing a formal session', async () => {
  const f = await fixture(), session = await f.service.projectSessions.create({ input: f.input, name: 'batch' }), p = await planBatchImageReplacement(f.service, { input: f.input, replacements: [imageRows(f)[0]!, { ...imageRows(f)[1]!, image: 'missing.png' }] }); assert.equal(p.checksPassed, false); assert.equal(p.inputErrors.length, 1); await assert.rejects(applyBatchImageReplacement(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }), /blocked/); assert.equal((await f.service.projectSessions.get(session.id)).revision, 0);
});
test('batch preflight rejects duplicate attachment selectors before collection', async () => {
  const f = await fixture(), p = await planBatchImageReplacement(f.service, { input: f.input, replacements: [imageRows(f)[0]!, imageRows(f)[0]!] }); assert.equal(p.checksPassed, false); assert.match(p.blockers.join(), /Repeated/);
});
test('batch reports retain original row indices when an earlier input is missing', async () => {
  const f = await fixture(), p = await planBatchImageReplacement(f.service, { input: f.input, replacements: [{ ...imageRows(f)[0]!, image: 'missing.png' }, imageRows(f)[1]!] }); assert.equal(p.inputErrors[0]!.index, 0); assert.equal(p.reports[0]!.index, 1); assert.equal(p.checksPassed, false);
});
test('batch reports all source canvas/aspect problems rather than committing an early valid image', async () => {
  const f = await fixture(), wide = await f.png('wide.png', 16, 8), p = await planBatchImageReplacement(f.service, { input: f.input, replacements: [{ ...imageRows(f)[0]!, image: wide }, imageRows(f)[1]!] }); assert.equal(p.checksPassed, false); assert.ok(p.blockers.some(s => s.includes('canvas'))); assert.ok(p.blockers.some(s => s.includes('aspect')));
});
test('batch deduplicates equal image contents from different input files', async () => {
  const f = await fixture(), clone = path.join(f.root, 'clone.png'); await writeFile(clone, await readFile(f.red)); const r = await batch(f, [imageRows(f)[0]!, { ...imageRows(f)[1]!, image: clone }]); assert.equal(r.candidate.details.imageCopies, 1); assert.equal(r.candidate.details.applied[0]!.image.sha256, r.candidate.details.applied[1]!.image.sha256);
});
test('compatible linked-UV changes merge once instead of being applied sequentially twice', async () => {
  const f = await fixture(true, true), large = await f.png('large.png', 16, 16), mapping = { oldAnchor: { x: 0, y: 0 }, replacementAnchor: { x: 4, y: 4 } }, rows = imageRows(f, { image: large, resizePolicy: 'preserve-geometry', uvMapping: mapping, propagateLinkedUVs: true }), r = await batch(f, rows), d = await readDocument(r.candidate.json); assert.deepEqual((d.skins as any)[0].attachments.head.art.uvs, [0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75]); assert.deepEqual(d.animations, f.data.animations);
});
test('incompatible shared UV changes block the entire batch', async () => {
  const f = await fixture(true, true), large = await f.png('large.png', 16, 16), rows = imageRows(f, { image: large, resizePolicy: 'preserve-geometry', uvMapping: { oldAnchor: { x: 0, y: 0 }, replacementAnchor: { x: 4, y: 4 } }, propagateLinkedUVs: true }); (rows[1] as any).uvMapping = { oldAnchor: { x: 0, y: 0 }, replacementAnchor: { x: 6, y: 4 } }; const p = await planBatchImageReplacement(f.service, { input: f.input, replacements: rows }); assert.equal(p.checksPassed, false); assert.match(p.blockers.join(), /Conflicting/);
});
test('weighted batch replacements preserve deforms and sampled world vertices', async () => {
  const f = await fixture(true), r = await batch(f), d = await readDocument(r.candidate.json); assert.deepEqual(d.animations, f.data.animations); for (const t of [0, 0.35, 0.9]) { const a = await sampleArtwork(f.service.workspace, f.data, f.input, 'wave', [t]), b = await sampleArtwork(f.service.workspace, d, r.candidate.json, 'wave', [t]); for (let i = 0; i < a.frames[0]!.slots.length; i++) assert.deepEqual(a.frames[0]!.slots[i]!.vertices, b.frames[0]!.slots[i]!.vertices); }
});
for (const target of ['source', 'first_image', 'last_image'] as const) test('batch pins reject changes to ' + target + ' before apply', async () => {
  const f = await fixture(), p = await planBatchImageReplacement(f.service, { input: f.input, replacements: imageRows(f) }); await writeFile(target === 'source' ? f.input : target === 'first_image' ? f.red : f.blue, target === 'source' ? JSON.stringify({ ...f.data, skeleton: { ...f.data.skeleton, fps: 30 } }) : encodePng(8, 8, new Uint8Array(256).fill(180))); await assert.rejects(applyBatchImageReplacement(f.service, { requestId: randomUUID(), plan: p.plan, expectedSha256: p.planSha256 }), /changed/);
});
test('batch plan pins reject tampering and completed requests do not rebuild their candidates', async () => {
  const f = await fixture(), r = await batch(f); assert.equal((await applyBatchImageReplacement(f.service, r.args)).reused, true); await assert.rejects(applyBatchImageReplacement(f.service, { ...r.args, requestId: randomUUID(), expectedSha256: '0'.repeat(64) }), /plan changed/);
});
test('promoting a whole outfit creates one session version and retries never split it into partial edits', async () => {
  const f = await fixture(), session = await f.service.projectSessions.create({ input: f.input, name: 'outfit' }), r = await batch(f), args = promotion(r.candidate, { session: { id: session.id, expectedRevision: 0 } }), selected = await promoteCandidate(f.service, args); assert.equal(selected.session!.revision, 1); assert.equal(selected.session!.versions.length, 2); assert.equal((await promoteCandidate(f.service, args)).reused, true); assert.equal((await f.service.projectSessions.get(session.id)).revision, 1);
});
test('batch applies to explicit named-only skins without moving prior placeholders', async () => {
  const f = await fixture(); (f.data.skins as any[])[0].name = 'outfit'; await writeFile(f.input, JSON.stringify(f.data)); const r = await batch(f, imageRows(f, { skin: 'outfit' })), d = await readDocument(r.candidate.json); assert.equal((d.skins as any[])[0].name, 'outfit'); assert.deepEqual(d.animations, f.data.animations);
});

for (const kind of ['ik', 'transform'] as const) test('explicit constraint baking supports local angle repair with ' + kind + ' and preserves unrelated world poses', async () => {
  const f = await fixture(), source = setConstraint(f.data, kind === 'ik' ? { type: 'ik', name: 'aim', bones: ['arm'], target: 'target' } : { type: 'transform', name: 'follow', source: 'target', bones: ['arm'], properties: { rotate: { to: { rotate: {} } } } }), r = buildRepairData(source, repairArgs(f, { constraintMode: 'bake', bakeTolerance: 0.1 })); assert.deepEqual(r.data.constraints, source.constraints); assert.deepEqual(r.data.animations!.wave, source.animations!.wave); assert.equal(r.report.constraintOrder[0]!.type, kind); assert.ok(r.report.constraintBake); assert.ok(r.report.constraintWorldVerification!.maxUnselectedWorldError <= 0.1); assert.ok(r.report.maxLimitExcess < 1e-4);
});
test('constrained repairs still reject without explicit bake mode', async () => {
  const f = await fixture(), source = setConstraint(f.data, { type: 'ik', name: 'aim', bones: ['arm'], target: 'target' }); assert.throws(() => buildRepairData(source, repairArgs(f)), /constraintMode=bake/);
});
test('repair sampling coalesces native float32 bake keys with mathematically equal FPS samples', async () => {
  const f = await fixture(), source = setConstraint(f.data, { type: 'ik', name: 'aim', bones: ['arm'], target: 'target' }), r = buildRepairData(source, repairArgs(f, { constraintMode: 'bake', bakeTolerance: 0.1 })), keys = (r.data.animations!.repaired!.bones as any).arm.rotate as { time?: number }[], nativeTimes = keys.map(k => Number((k.time ?? 0).toFixed(7))); assert.equal(new Set(nativeTimes).size, keys.length); assert.ok(keys.length <= 65);
});
test('rotation repair rejects inactive optional bones before creating ineffective tracks', async () => {
  const f = await fixture(), source = structuredClone(f.data); source.bones.push({ name: 'optional', parent: 'root', skin: true }); assert.throws(() => buildRepairData(source, repairArgs(f, { rotations: [{ bone: 'optional', min: -20, max: 20 }] })), /active bone/);
});
test('ordered interacting constraints are reported and source definitions/animations remain unchanged', async () => {
  const f = await fixture(); let source = setConstraint(f.data, { type: 'transform', name: 'move_target', source: 'root', bones: ['target'], properties: { x: { to: { x: { offset: 10 } } } } }); source = setConstraint(source, { type: 'ik', name: 'aim', bones: ['arm'], target: 'target' }); const before = JSON.stringify(source), r = buildRepairData(source, repairArgs(f, { constraintMode: 'bake', bakeTolerance: 0.1 })); assert.equal(JSON.stringify(source), before); assert.deepEqual(r.report.constraintOrder.map(c => c.name), ['move_target', 'aim']); assert.equal(r.report.constraintWorldVerification!.constraintDefinitionsPreserved, true);
});
test('constraint-baked bounded repairs preserve outside-window world motion', async () => {
  const f = await fixture(); (f.data.animations!.wave!.bones as any).target.translate = [{ y: 0 }, { time: 0.2, y: 0 }, { time: 0.5, y: 8 }, { time: 0.8, y: 0 }, { time: 1, y: 0 }]; const source = setConstraint(f.data, { type: 'ik', name: 'aim', bones: ['arm'], target: 'target' }), r = buildRepairData(source, repairArgs(f, { constraintMode: 'bake', bakeTolerance: 0.1, rotations: [{ bone: 'arm', min: -10, max: 15, start: 0.2, end: 0.8 }] })); assert.ok(r.report.constraintWorldVerification!.maxOutsideWorldError <= 0.1); assert.ok(r.report.maxOutsideRotationError < 1e-4);
});
test('path-constraint repair bakes the path influence only in the new candidate', async () => {
  const f = await fixture(), d = structuredClone(f.data); d.slots!.push({ name: 'path', bone: 'root', attachment: 'curve' }); (d.skins as any)[0].attachments.path = { curve: { type: 'path', vertexCount: 6, vertices: [-10, 0, 0, 0, 3.3, 0, 6.6, 0, 10, 0, 11, 0], lengths: [10], constantSpeed: true } }; const source = setConstraint(parseDocument(d), { type: 'path', name: 'path_follow', bones: ['arm'], slot: 'path', position: 0.5, positionMode: 'percent' }), r = buildRepairData(source, repairArgs(f, { constraintMode: 'bake', bakeTolerance: 0.1 })); assert.ok(r.report.constraintBake); assert.equal(r.report.constraintOrder[0]!.type, 'path'); assert.deepEqual(r.data.animations!.idle, source.animations!.idle);
});
test('physics repairs capture explicit reset simulation and verify unrelated poses with the same source history', async () => {
  const f = await fixture(), source = setConstraint(f.data, { type: 'physics', name: 'spring', bone: 'arm', rotate: 1, strength: 20, damping: 0.8, inertia: 1, gravity: 0.1, wind: 0.1 }), r = buildRepairData(source, repairArgs(f, { constraintMode: 'bake', physics: true, fps: 20, bakeTolerance: 0.2 })); assert.equal(r.report.physicsCaptured, true); assert.ok(r.report.constraintWorldVerification!.independentResetIntegrationSteps > 0); assert.deepEqual(r.data.constraints, source.constraints); assert.deepEqual(r.data.animations!.wave, source.animations!.wave);
});
test('double-FPS verification rejects excessive unrelated-world error rather than certifying sparse capture', async () => {
  const f = await fixture(), d = structuredClone(f.data); d.bones.push({ name: 'other', parent: 'root', length: 10 }); let source = setConstraint(d, { type: 'ik', name: 'other_aim', bones: ['other'], target: 'target' }); assert.throws(() => buildRepairData(source, repairArgs(f, { constraintMode: 'bake', fps: 2, bakeTolerance: 0.0001 })), /world-pose tolerance|bake|error/i);
});
test('constraint repair candidates retain shared-camera comparisons and explicit pending selection', async () => {
  const f = await fixture(), d = setConstraint(f.data, { type: 'ik', name: 'aim', bones: ['arm'], target: 'target' }); await writeFile(f.input, JSON.stringify(d)); const r = await createAnimationRepair(f.service, repairArgs(f, { constraintMode: 'bake', bakeTolerance: 0.1 })); assert.equal(r.checksPassed, true); assert.equal(r.visualAcceptance, 'pending'); assert.equal(r.details.comparison.afterPhysics, false); assert.ok(r.details.verification.constraintWorldVerification); assert.equal((await readCandidate(f.service, { candidate: r.candidate })).sourceChanged, false);
});
test('refinement workflows reject workspace-escaping input junctions', async () => {
  const f = await handoff(), outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-refinement-outside-'))); await writeFile(path.join(outside, 'art.png'), await readFile(f.generated)); await symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(composeLayerRepaint(f.service, { ...f.args, repaints: [{ layer: 'body', image: path.join(f.root, 'escape', 'art.png') }] }), /outside/);
});
