import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument } from '../src/document.js';
import { auditAnimation } from '../src/animation-audit.js';
import { encodePng } from '../src/raster.js';

async function service() { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-audit-'))); return new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }); }
test('diagnostics report contact, joint, separation, crossing and pose-step failures without granting visual acceptance', async () => {
  const s = await service(), data = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'a0', parent: 'root', x: -1, y: -1 }, { name: 'a1', parent: 'root', x: 1, y: 1 }, { name: 'b0', parent: 'root', x: -1, y: 1 }, { name: 'b1', parent: 'root', x: 1, y: -1 }], animations: { a: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 20 }], translate: [{ x: 0 }, { time: 1, x: 1 }] } } } } });
  const input = (await writeDocument(s.workspace, 'input.json', data)).path;
  const r = await auditAnimation(s, { input, options: { animation: 'a', fps: 10, contacts: [{ bone: 'a1', start: 0, end: 1, tolerance: 0.01 }], joints: [{ bone: 'root', min: -10, max: 10 }], separation: [{ left: 'b0', right: 'a0', axis: 'y', minDistance: 1 }], limbPairs: [{ a: ['a0', 'a1'], b: ['b0', 'b1'] }], stepBones: ['root'], maxStep: 0.01, preview: 'none' } });
  assert.equal(r.checksPassed, false); assert.equal(r.visualAcceptance, 'pending'); for (const code of ['foot_slide', 'joint_limit', 'limb_separation', 'limb_crossing', 'pose_step']) assert.ok(r.findingCounts[code], code); assert.ok(r.reportPath.endsWith('audit.json'));
});
test('weighted mesh folding is detected through texture alpha, while whole-rig reflection is not a fold', async () => {
  const s = await service(); await writeFile(path.join(s.workspace.root, 'art.png'), encodePng(4, 4, new Uint8Array(64).fill(255)));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root' }, { name: 'corner', parent: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { type: 'mesh', path: 'art', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, vertices: [1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, -1, 1, 1, 1, 0, -1, 1] } } } }], animations: { fold: { bones: { corner: { translate: [{ x: 0 }, { time: 1, x: 2 }] } } }, reflect: { bones: { root: { scalex: [{ value: 1 }, { time: 1, value: -1 }] } } } } });
  const input = (await writeDocument(s.workspace, 'mesh.json', data)).path;
  assert.ok((await auditAnimation(s, { input, options: { animation: 'fold', fps: 2, preview: 'none' } })).findingCounts.mesh_fold);
  const reflection = await auditAnimation(s, { input, options: { animation: 'reflect', fps: 1, preview: 'none' } }); assert.equal(reflection.findingCounts.mesh_fold, undefined);
  const hidden = structuredClone(data); hidden.slots![0]!.color = 'ffffff00';
  const hiddenInput = (await writeDocument(s.workspace, 'hidden.json', hidden)).path;
  assert.equal((await auditAnimation(s, { input: hiddenInput, options: { animation: 'fold', fps: 2, preview: 'none' } })).findingCounts.mesh_fold, undefined);
  assert.ok((await auditAnimation(s, { input: hiddenInput, options: { animation: 'fold', fps: 2, preview: 'none', alphaThreshold: 0 } })).findingCounts.mesh_fold);
});
test('audit rejects invalid character rules instead of silently skipping them', async () => {
  const s = await service(), input = (await writeDocument(s.workspace, 'a.json', parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], animations: { a: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 1 }] } } } } }))).path;
  await assert.rejects(auditAnimation(s, { input, options: { animation: 'a', contacts: [{ bone: 'missing', start: 0, end: 1 }] } }), /bone not found/);
  await assert.rejects(auditAnimation(s, { input, options: { animation: 'a', joints: [{ bone: 'root', min: 20, max: 10 }] } }), /reversed/);
});
