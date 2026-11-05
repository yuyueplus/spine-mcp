import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument, readDocument } from '../src/document.js';
import { setConstraint } from '../src/constraint-edits.js';
import { bakeFootContacts } from '../src/foot-contacts.js';
import { auditAnimation } from '../src/animation-audit.js';
import { fileSha256 } from '../src/file-hash.js';
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-constrained-contact-'))), service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  let data = parseDocument({ skeleton: { spine: '4.3.23', fps: 60 }, bones: [{ name: 'root' }, { name: 'hips', parent: 'root', y: 4 }, { name: 'upper', parent: 'hips', rotation: -70, length: 2 }, { name: 'lower', parent: 'upper', x: 2, rotation: -35, length: 2 }, { name: 'foot', parent: 'lower', x: 2, length: 1 }, { name: 'head', parent: 'hips', y: 1 }, { name: 'target', parent: 'root', x: 0.1, y: 0.3 }, { name: 'control', parent: 'root', y: 4 }], animations: { walk: { bones: { hips: { translate: [{ time: 0 }, { time: 0.5, x: 0.1, y: -0.15 }, { time: 1 }] }, head: { rotate: [{ time: 0 }, { time: 1, value: 12 }] }, control: { translate: [{ time: 0 }, { time: 0.5, x: 0.1, y: -0.05 }, { time: 1 }] } } } } });
  data = setConstraint(data, { name: 'leg-ik', type: 'ik', bones: ['upper', 'lower'], target: 'target', mix: 0.5, bendPositive: false });
  data = setConstraint(data, { name: 'body-follow', type: 'transform', bones: ['hips'], source: 'control', mixX: 0.5, mixY: 0.5, mixRotate: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0, properties: { x: { to: { x: {} } }, y: { to: { y: {} } } } });
  const input = (await writeDocument(service.workspace, 'source.json', data)).path;
  return { service, data, input, args: { input, output: 'planted.json', animation: 'walk', newName: 'planted', fps: 60, tolerance: 0.01, chains: [{ upper: 'upper', lower: 'lower', foot: 'foot', contacts: [{ start: 0, end: 1 }] }] } };
}
test('explicit constraint baking supports interacting IK and transform chains without changing originals', async () => {
  const f = await fixture(), hash = await fileSha256(f.input), result = await bakeFootContacts(f.service, { ...f.args, constraintMode: 'bake' }), data = await readDocument(result.path);
  assert.deepEqual(data.constraints, f.data.constraints); assert.deepEqual(data.animations!.walk, f.data.animations!.walk); assert.deepEqual(Object.keys(data.animations!).sort(), ['planted', 'walk']); assert.equal(await fileSha256(f.input), hash);
  const details = result.contactVerification as any; assert.equal(details.constraintBake.fullRigCapture, true); assert.equal(details.constraintBake.constraintsDisabledOnlyInNewAnimation, true); assert.ok(details.maxUnrelatedWorldError < 0.01); assert.ok(details.maxShoeOrientationErrorDegrees < 0.1);
  const audit = await auditAnimation(f.service, { input: result.path, options: { animation: 'planted', fps: 120, preview: 'none', contacts: [{ bone: 'foot', start: 0, end: 1, tolerance: 0.01 }] } }); assert.equal(audit.checksPassed, true);
});
test('constraint mode stays opt-in and unreachable targets still reject before publication', async () => {
  const f = await fixture(); await assert.rejects(bakeFootContacts(f.service, f.args), /constraintMode=bake/);
  await assert.rejects(bakeFootContacts(f.service, { ...f.args, constraintMode: 'bake', chains: [{ upper: 'upper', lower: 'lower', foot: 'foot', contacts: [{ start: 0, end: 1, x: 100 }] }] }), /unreachable/);
});
