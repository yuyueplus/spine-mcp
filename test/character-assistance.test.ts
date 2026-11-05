import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument, readDocument } from '../src/document.js';
import { encodePng } from '../src/raster.js';
import { auditCharacterLayers, suggestCharacterRig } from '../src/character-assistance.js';
import { prepareCharacter } from '../src/character-workflow.js';
import { sampleSkeleton } from '../src/runtime.js';
import { fileSha256 } from '../src/file-hash.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-assist-'))), service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  await writeFile(path.join(root, 'part.png'), encodePng(16, 16, new Uint8Array(16 * 16 * 4).fill(255)));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root', x: 3, y: -2, rotation: 15, scaleX: 1.5, scaleY: 0.8 }], slots: [{ name: 'upper', bone: 'root', attachment: 'upper' }, { name: 'lower', bone: 'root', attachment: 'lower' }], skins: [{ name: 'default', attachments: { upper: { upper: { path: 'part', x: 0, y: 8, width: 16, height: 16 } }, lower: { lower: { path: 'part', x: 0, y: -4, width: 16, height: 16 } } } }], animations: {} });
  return { root, service, data, input: (await writeDocument(service.workspace, 'source.json', data)).path };
}
const upper = { slot: 'upper' }, lower = { slot: 'lower' };
test('joint alpha audit distinguishes a covered overlapping seam from a remote gap', async () => {
  const f = await fixture(), hash = await fileSha256(f.input), image = await fileSha256(path.join(f.root, 'part.png'));
  const report = await auditCharacterLayers(f.service, { input: f.input, seams: [{ name: 'joint', a: upper, b: lower, point: { x: 2.6, y: -0.45 }, radius: 0.5 }, { name: 'gap', a: upper, b: lower, point: { x: 100, y: 100 }, radius: 2 }] });
  assert.equal(report.seams[0]!.passed, true); assert.equal(report.seams[1]!.passed, false); assert.equal(report.seams[1]!.unionFraction, 0); assert.ok(report.findings.some(f => f.kind === 'uncovered_joint_area'));
  assert.equal(await fileSha256(f.input), hash); assert.equal(await fileSha256(path.join(f.root, 'part.png')), image); assert.equal(report.visualAcceptance, 'pending');
});
test('transparent texture holes affect joint coverage rather than only bounding rectangles', async () => {
  const f = await fixture(), pixels = new Uint8Array(16 * 16 * 4).fill(255);
  for (let y = 0; y < 16; y++) for (let x = 6; x < 10; x++) pixels[(y * 16 + x) * 4 + 3] = 0;
  await writeFile(path.join(f.root, 'part.png'), encodePng(16, 16, pixels));
  const center = sampleSkeleton(f.data, undefined, 0).bones[0]!.appliedPose.localToWorld({ x: 0, y: 2 } as any);
  const report = await auditCharacterLayers(f.service, { input: f.input, seams: [{ name: 'cutout', a: upper, b: lower, point: center, radius: 0.3 }] });
  assert.equal(report.seams[0]!.unionFraction, 0); assert.equal(report.checksPassed, false);
});
test('empty layers remain reportable without inventing an anatomical axis', async () => {
  const f = await fixture(); await writeFile(path.join(f.root, 'part.png'), encodePng(16, 16, new Uint8Array(1024)));
  const report = await auditCharacterLayers(f.service, { input: f.input }); assert.equal(report.layers[0]!.centroid, null); assert.ok(report.findings.some(f => f.kind === 'empty_layer'));
  await assert.rejects(suggestCharacterRig(f.service, { input: f.input, output: 'rig.json', chains: [{ namePrefix: 'limb', parent: 'root', layers: [upper] }] }), /stable alpha axis/);
});
test('explicit world landmarks become correct editable bones through rotated nonuniform parent transforms', async () => {
  const f = await fixture(), points = [{ x: 6, y: 10 }, { x: 2, y: 0 }, { x: 4, y: -12 }], sourceHash = await fileSha256(f.input);
  const suggestion = await suggestCharacterRig(f.service, { input: f.input, output: 'rig.json', chains: [{ namePrefix: 'limb', parent: 'root', layers: [upper, lower], points }] });
  assert.equal(suggestion.projectWritten, false); assert.equal(suggestion.requiresReview, true); assert.equal(suggestion.anatomyInference, false);
  assert.ok(suggestion.recipe.bindings.every(b => b.minWeight === 0.00001));
  const built = await prepareCharacter(f.service, suggestion.recipe), sk = sampleSkeleton(await readDocument(built.path), undefined, 0);
  for (let i = 0; i < 2; i++) { const pose = sk.bones.find(b => b.data.name === `limb_${i + 1}`)!.appliedPose, origin = pose.localToWorld({ x: 0, y: 0 } as any); assert.ok(Math.hypot(origin.x - points[i]!.x, origin.y - points[i]!.y) < 1e-5); }
  assert.equal(await fileSha256(f.input), sourceHash);
  const meshAudit = await auditCharacterLayers(f.service, { input: built.path }); assert.ok(meshAudit.layers.every(l => l.geometry === 'mesh')); assert.equal(meshAudit.originalUnchanged, true);
});
test('geometry-derived chain candidates are labelled and usable as a reviewed preparation recipe', async () => {
  const f = await fixture(), s = await suggestCharacterRig(f.service, { input: f.input, output: 'suggested.json', chains: [{ namePrefix: 'arm', parent: 'root', layers: [upper, lower] }] });
  assert.equal(s.chains[0]!.basis, 'alpha_principal_axes_and_geometry_bounds'); assert.equal(s.chains[0]!.worldLandmarks.length, 3); assert.equal(s.recipe.bindings.length, 2); assert.equal(s.recipe.bones.length, 2);
  const built = await prepareCharacter(f.service, s.recipe); assert.ok((await readDocument(built.path)).bones.some(b => b.name === 'arm_2'));
});
test('layer suggestion rejects invalid selectors, duplicate bindings, collisions and coincident landmarks', async () => {
  const f = await fixture(), base = { input: f.input, output: 'bad.json' };
  await assert.rejects(suggestCharacterRig(f.service, { ...base, chains: [{ namePrefix: 'limb', parent: 'missing', layers: [upper] }] }), /does not exist/);
  await assert.rejects(suggestCharacterRig(f.service, { ...base, chains: [{ namePrefix: 'limb', parent: 'root', layers: [upper, upper] }] }), /only one chain/);
  await assert.rejects(suggestCharacterRig(f.service, { ...base, chains: [{ namePrefix: 'limb', parent: 'root', layers: [upper], points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }] }), /degenerate/);
  await assert.rejects(auditCharacterLayers(f.service, { input: f.input, layers: [{ slot: 'missing' }] }), /active setup/);
  await assert.rejects(auditCharacterLayers(f.service, { input: f.input, seams: [{ name: 'same', a: upper, b: upper, radius: 1 }] }), /two different/);
  await assert.rejects(auditCharacterLayers(f.service, { input: f.input, samplesPerAxis: 8 }), /odd sample/);
});
