import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument, readDocument } from '../src/document.js';
import { saveCharacterTemplate, applyCharacterTemplate } from '../src/character-template.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { auditAnimation } from '../src/animation-audit.js';
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-template-'))), service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  await writeFile(path.join(root, 'art.png'), encodePng(4, 4, new Uint8Array(64).fill(255)));
  const data = (p: string) => parseDocument({ skeleton: { spine: '4.3.23', images: '.', fps: 60 }, bones: [{ name: p + 'root' }, { name: p + 'hips', parent: p + 'root', y: 4 }, { name: p + 'upper', parent: p + 'hips', rotation: -70, length: 2 }, { name: p + 'lower', parent: p + 'upper', x: 2, rotation: -35, length: 2 }, { name: p + 'foot', parent: p + 'lower', x: 2 }, { name: p + 'head', parent: p + 'hips', y: 1 }, { name: p + 'hair', parent: p + 'head' }], slots: [{ name: p + 'face', bone: p + 'head', attachment: p + 'open' }], skins: [{ name: 'default', attachments: { [p + 'face']: { [p + 'open']: { path: 'art', width: 4, height: 4 }, [p + 'closed']: { path: 'art', width: 4, height: 4 } } } }], animations: { original: { bones: { [p + 'head']: { rotate: [{ value: 0 }, { time: 1, value: 1 }] } } } } });
  const source = (await writeDocument(service.workspace, 'source.json', data(''))).path, targetData = data('T_'), target = (await writeDocument(service.workspace, 'target.json', targetData)).path;
  const roles = { body: 'hips', top: 'upper', bottom: 'lower', shoe: 'foot', head: 'head', hair: 'hair' }, slots = { face: { slot: 'face', attachments: { opened: 'open', closed: 'closed' } } }, recipe = { fps: 60, poses: [{ time: 0, bones: { body: { x: 0, y: 0 }, head: { rotation: 0 } } }, { time: 0.5, bones: { body: { x: 0.05, y: -0.05 }, head: { rotation: 10 } } }, { time: 1, bones: { body: { x: 0, y: 0 }, head: { rotation: 0 } } }], secondary: [{ bones: ['hair'], driver: 'head', gain: 0.3, maxAngle: 2 }], blinks: [{ slot: 'face', open: 'opened', closed: 'closed', times: [0.4] }] };
  return { service, source, target, targetData, roles, slots, recipe, capture: { input: source, output: 'templates/gesture.json', name: 'gesture', roles, slots, recipe, contacts: [{ upper: 'top', lower: 'bottom', foot: 'shoe', contacts: [{ start: 0, end: 1 }] }] } };
}
test('a reusable recipe remaps explicit bone/slot roles, timing, translations and secondary motion', async () => {
  const f = await fixture(), template = await saveCharacterTemplate(f.service, f.capture), templateHash = await fileSha256(template.path), sourceHash = await fileSha256(f.target);
  const result = await applyCharacterTemplate(f.service, { input: f.target, template: template.path, output: 'applied.json', animation: 'greeting', boneMap: Object.fromEntries(Object.entries(f.roles).map(([role, name]) => [role, 'T_' + name])), slotMap: { face: { slot: 'T_face', attachments: { opened: 'T_open', closed: 'T_closed' } } }, timeScale: 2, translationScale: 1.5 });
  const data = await readDocument(result.path), animation = data.animations!.greeting as any;
  assert.deepEqual(data.animations!.original, f.targetData.animations!.original); assert.equal(animation.bones.T_hips.translate[1].time, 1); assert.equal(animation.bones.T_hips.translate[1].x, 0.07500000000000001); assert.equal(animation.slots.T_face.attachment[1].time, 0.8); assert.equal(animation.slots.T_face.attachment[1].name, 'T_closed'); assert.ok(animation.bones.T_hair.rotate.every((k: any) => Math.abs(k.value) <= 2));
  assert.equal(await fileSha256(template.path), templateHash); assert.equal(await fileSha256(f.target), sourceHash); assert.equal((result.templateApplication as any).visualAcceptance, 'pending');
});
test('template contact anchors are resolved on the target rig and intermediate animations never leak', async () => {
  const f = await fixture(), template = await saveCharacterTemplate(f.service, f.capture), result = await applyCharacterTemplate(f.service, { input: f.source, template: template.path, output: 'planted.json', animation: 'planted', bakeContacts: true });
  const data = await readDocument(result.path); assert.deepEqual(Object.keys(data.animations!).sort(), ['original', 'planted']); assert.ok((result.templateApplication as any).contactVerification.maxContactError < 0.1);
  const audit = await auditAnimation(f.service, { input: result.path, options: { animation: 'planted', preview: 'none', fps: 120, contacts: [{ bone: 'foot', start: 0, end: 1, tolerance: 0.1 }] } }); assert.equal(audit.checksPassed, true);
});
test('template capture and application reject missing/duplicate mappings, absolute anchors and overwrite', async () => {
  const f = await fixture(), template = await saveCharacterTemplate(f.service, f.capture);
  await assert.rejects(saveCharacterTemplate(f.service, f.capture), /EEXIST/);
  await assert.rejects(saveCharacterTemplate(f.service, { ...f.capture, output: 'bad.json', roles: { ...f.roles, extra: 'hips' } }), /duplicated/);
  await assert.rejects(saveCharacterTemplate(f.service, { ...f.capture, output: 'bad.json', contacts: [{ upper: 'top', lower: 'bottom', foot: 'shoe', contacts: [{ start: 0, end: 1, x: 1 }] }] }), /timing windows only/);
  const args = { input: f.source, template: template.path, output: 'bad.json', animation: 'bad' };
  await assert.rejects(applyCharacterTemplate(f.service, { ...args, boneMap: { unknown: 'hips' } }), /Unknown bone role/);
  await assert.rejects(applyCharacterTemplate(f.service, { ...args, physics: true }), /bakeContacts=true/);
  await assert.rejects(applyCharacterTemplate(f.service, { ...args, animation: 'original' }), /new animation/);
});
