import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath } from 'node:fs/promises';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument } from '../src/document.js';
import { applyEdits, editSchema } from '../src/edits.js';
import { verifyRoundTrip } from '../src/project-workflow.js';

test('new production edits execute through the public edit router and preserve the source', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-router-'))), service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  const source = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], animations: { motion: { bones: { root: { translate: [{ time: 0, x: 0 }, { time: 1, x: 2 }] } } } } }), original = JSON.stringify(source), saved = await writeDocument(service.workspace, 'source.json', source);
  const variants = [
    { type: 'retarget_animation', source: saved.path, animation: 'motion', newName: 'result', fps: 2 },
    { type: 'world_mirror', animation: 'motion', newName: 'result', axis: 'x', fps: 2 },
    { type: 'compose_animation', newName: 'result', layers: [{ animation: 'motion' }], fps: 2 },
    { type: 'bake_constraints', animation: 'motion', newName: 'result', fps: 2 },
    { type: 'simplify_animation_adaptive', animation: 'motion', newName: 'result', fps: 2 },
  ];
  for (const raw of variants) { const result = await applyEdits(source, [editSchema.parse(raw)], { workspace: service.workspace, jsonPath: saved.path }); assert.ok(result.animations?.result, `${raw.type} failed to execute`); assert.equal(JSON.stringify(source), original); }
  await assert.rejects(applyEdits(source, [editSchema.parse({ type: 'bake_clipping', animation: 'motion', newName: 'result', fps: 2 })]), /resource context/i);
});

test('native constant slot-color step normalization is equivalent, changing gradients still reject', () => {
  const original = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root' }], animations: { color: { slots: { art: { rgba: [{ color: 'ffffffff' }, { time: 1, color: 'ffffffff' }] } } } } });
  const received = structuredClone(original), keys = ((received.animations!.color!.slots as any).art.rgba); keys[0].curve = 'stepped';
  assert.equal(verifyRoundTrip(original, received, 'same.json', 'same.json').passed, true);
  ((original.animations!.color!.slots as any).art.rgba)[1].color = 'ff0000ff'; keys[1].color = 'ff0000ff';
  assert.throws(() => verifyRoundTrip(original, received, 'same.json', 'same.json'), /Slot curve differs/);
  ((original.animations!.color!.slots as any).art.rgba)[1].color = 'ffffffff'; keys[1].color = 'ffffffff'; keys[0].curve = [0.2, 0.4, 0.8, 0.9];
  assert.throws(() => verifyRoundTrip(original, received, 'same.json', 'same.json'), /Slot curve differs/);
});
