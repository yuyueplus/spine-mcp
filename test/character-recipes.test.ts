import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument, readDocument } from '../src/document.js';
import { encodePng } from '../src/raster.js';
import { prepareCharacter, buildPoseAnimation } from '../src/character-workflow.js';
import { animationSampler } from '../src/animation-sampler.js';
import { bakeFootContacts } from '../src/foot-contacts.js';
import { auditAnimation } from '../src/animation-audit.js';
import { fileSha256 } from '../src/file-hash.js';
import { MeshAttachment, RegionAttachment } from '@esotericsoftware/spine-core';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-recipe-'))), service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  await writeFile(path.join(root, 'art.png'), encodePng(4, 4, new Uint8Array(64).fill(255)));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.', fps: 60 }, bones: [{ name: 'root' }, { name: 'tail', parent: 'root', x: 1 }], slots: [{ name: 'art', bone: 'root', attachment: 'open' }], skins: [{ name: 'default', attachments: { art: { open: { path: 'art', width: 4, height: 4 }, closed: { path: 'art', width: 4, height: 4 } } } }], animations: { original: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 1 }] } } } } });
  return { service, data, input: (await writeDocument(service.workspace, 'source.json', data)).path };
}
test('layer binding preserves setup artwork geometry and original PNG bytes', async () => {
  const f = await fixture(), hash = await fileSha256(f.input), imageHash = await fileSha256(path.join(f.service.workspace.root, 'art.png'));
  const result = await prepareCharacter(f.service, { input: f.input, output: 'rig.json', bones: [{ name: 'upper', parent: 'root', transform: { length: 2 } }, { name: 'lower', parent: 'upper', transform: { x: 2, length: 2 } }], bindings: [{ slot: 'art', attachment: 'open', bones: ['upper', 'lower'], columns: 1, rows: 1 }] });
  const rig = await readDocument(result.path), before = animationSampler(f.data).sample(0), after = animationSampler(rig).sample(0), region = before.slots[0]!.appliedPose.attachment as RegionAttachment, mesh = after.slots[0]!.appliedPose.attachment as MeshAttachment, v = new Array<number>(8), w = new Array<number>(8);
  region.computeWorldVertices(before.slots[0]!, region.getOffsets(before.slots[0]!.appliedPose), v, 0, 2); mesh.computeWorldVertices(after, after.slots[0]!, 0, 8, w, 0, 2);
  const sorted = (p: number[]) => Array.from({ length: p.length / 2 }, (_, i) => [p[i * 2]!, p[i * 2 + 1]!]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  const originalPoints = sorted(v).flat(), boundPoints = sorted(w).flat(); assert.ok(Math.max(...originalPoints.map((x, i) => Math.abs(x - boundPoints[i]!))) < 0.000001); assert.equal(await fileSha256(f.input), hash); assert.equal(await fileSha256(path.join(f.service.workspace.root, 'art.png')), imageHash);
});
test('pose recipes retain original animation and bound delayed motion and blink windows', async () => {
  const f = await fixture(), result = await buildPoseAnimation(f.service, { input: f.input, output: 'poses.json', name: 'gesture', poses: [{ time: 0, bones: { root: { rotation: 0 } } }, { time: 1, bones: { root: { rotation: 20 } } }], secondary: [{ bones: ['tail'], driver: 'root', maxAngle: 5, gain: 4 }], blinks: [{ slot: 'art', open: 'open', closed: 'closed', times: [0.5] }] });
  const d = await readDocument(result.path); assert.deepEqual(d.animations!.original, f.data.animations!.original);
  const sample = animationSampler(d, 'gesture'), sk = sample.sample(0.55); assert.equal(sk.slots[0]!.appliedPose.attachment!.name, 'closed'); assert.ok(Math.abs(sk.bones[1]!.pose.rotation) <= 5.00001);
  assert.ok(Math.abs(sample.sample(0.5).bones[0]!.pose.rotation - 10) < 0.001);
  await assert.rejects(buildPoseAnimation(f.service, { input: f.input, output: 'bad.json', name: 'bad', poses: [{ time: 0, bones: {} }, { time: 1, bones: {} }], blinks: [{ slot: 'art', open: 'open', closed: 'closed', times: [0] }] }), /Blink windows/);
});
test('foot contact baking locks a drifting leg and preserves unrelated channels and original animation', async () => {
  const f = await fixture(), leg = parseDocument({ skeleton: { spine: '4.3.23', fps: 60 }, bones: [{ name: 'root' }, { name: 'hips', parent: 'root', y: 4 }, { name: 'upper', parent: 'hips', rotation: -70, length: 2 }, { name: 'lower', parent: 'upper', x: 2, rotation: -35, length: 2 }, { name: 'foot', parent: 'lower', x: 2, length: 1 }, { name: 'head', parent: 'hips', y: 1 }], animations: { walk: { bones: { hips: { translate: [{ time: 0 }, { time: 0.5, x: 0.2, y: -0.2 }, { time: 1 }] }, head: { rotate: [{ time: 0 }, { time: 1, value: 12 }] } } } } });
  const input = (await writeDocument(f.service.workspace, 'leg.json', leg)).path, hash = await fileSha256(input), result = await bakeFootContacts(f.service, { input, output: 'planted.json', animation: 'walk', newName: 'planted', fps: 60, tolerance: 0.01, chains: [{ upper: 'upper', lower: 'lower', foot: 'foot', contacts: [{ start: 0, end: 1 }] }] });
  const d = await readDocument(result.path); assert.deepEqual(d.animations!.walk, leg.animations!.walk); assert.deepEqual((d.animations!.planted!.bones as any).head, (leg.animations!.walk!.bones as any).head); assert.equal(await fileSha256(input), hash);
  const audit = await auditAnimation(f.service, { input: result.path, options: { animation: 'planted', fps: 120, preview: 'none', contacts: [{ bone: 'foot', start: 0, end: 1, tolerance: 0.01 }] } }); assert.equal(audit.checksPassed, true); assert.ok(audit.metrics.maxContactDrift < 0.01);
  await assert.rejects(bakeFootContacts(f.service, { input, output: 'unreachable.json', animation: 'walk', newName: 'bad', chains: [{ upper: 'upper', lower: 'lower', foot: 'foot', contacts: [{ start: 0, end: 1, x: 100 }] }] }), /unreachable/);
});
