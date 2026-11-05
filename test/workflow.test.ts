import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/config.js';
import { applyEdits, type ProjectEdit } from '../src/edits.js';
import { readDocument, rebaseResources, writeDocument, type SpineDocument } from '../src/document.js';
import { editProject, fileSha256, verifyRoundTrip } from '../src/project-workflow.js';

function fixture(): SpineDocument {
  return { skeleton: { spine: '4.3.23', images: './images/' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 100 }], slots: [], skins: [], animations: {} };
}
const edits: ProjectEdit[] = [{ type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 35 }] }];

test('verification accepts Spine omitted defaults but catches lost keys and wrong values', async () => {
  const expected = await applyEdits(fixture(), edits);
  const actual = structuredClone(expected);
  const keys = (actual.animations!.wave!.bones as any).arm.rotate;
  keys[0] = {};
  keys[1].value = 35.000001;
  assert.equal(verifyRoundTrip(expected, actual, 'source.json', 'source.json').passed, true);
  keys[1].value = 0;
  assert.throws(() => verifyRoundTrip(expected, actual, 'source.json', 'source.json'), /Keyframe.*differs/);
  keys.pop();
  assert.throws(() => verifyRoundTrip(expected, actual, 'source.json', 'source.json'), /Keyframe count/);
});
test('verification rejects lost attachments and moved resources', () => {
  const expected = fixture();
  expected.skins = [{ name: 'default', attachments: { slot: { art: {} } } }];
  const actual = structuredClone(expected);
  actual.skins = [{ name: 'default', attachments: {} }];
  assert.throws(() => verifyRoundTrip(expected, actual, 'source.json', 'source.json'), /attachments/);
  assert.throws(() => verifyRoundTrip(fixture(), fixture(), 'source/source.json', 'moved/result.json'), /resource path/);
});

async function setup(tamper: boolean, concurrentChange = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-workflow-')));
  const workspace = new Workspace(root);
  const original = await writeDocument(workspace, 'original.json', fixture());
  const candidates: string[] = [];
  const fakeCli = {
    async importProject(input: string, output: string) {
      const data = rebaseResources(await readDocument(input), path.dirname(input));
      await writeFile(output, JSON.stringify(data), { flag: 'wx' });
      candidates.push(output);
      return { path: output, log: '', warning: '' };
    },
    async exportData(input: string) {
      const data = await readDocument(input);
      if (tamper) (data.animations!.wave!.bones as any).arm.rotate[1].value = 0;
      if (concurrentChange) await writeFile(original.path, `${await readFile(original.path, 'utf8')} `);
      const exported = await writeDocument(workspace, `exports/${randomUUID()}.json`, data);
      return { files: [exported.path], outputDirectory: path.dirname(exported.path), log: '', warning: undefined };
    },
  };
  return { workspace, original, fakeCli, destination: path.join(root, 'edited.spine'), candidates };
}
test('workflow publishes only verified output and preserves the source bytes', async () => {
  const { workspace, original, fakeCli, destination, candidates } = await setup(false);
  const before = await fileSha256(original.path);
  const result = await editProject(workspace, fakeCli, original.path, destination, edits);
  assert.equal(result.published, true);
  assert.equal(result.verification.passed, true);
  assert.ok((await stat(destination)).size > 0);
  assert.equal(await fileSha256(original.path), before);
  assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).published, true);
  for (const candidate of candidates) await assert.rejects(stat(candidate), /ENOENT/);
});
test('workflow keeps final output absent when re-exported values are wrong', async () => {
  const { workspace, original, fakeCli, destination, candidates } = await setup(true);
  const before = await fileSha256(original.path);
  await assert.rejects(editProject(workspace, fakeCli, original.path, destination, edits), /verification failed/);
  await assert.rejects(stat(destination), /ENOENT/);
  assert.equal(await fileSha256(original.path), before);
  for (const candidate of candidates) await assert.rejects(stat(candidate), /ENOENT/);
});
test('workflow detects concurrent source changes instead of publishing a stale result', async () => {
  const { workspace, original, fakeCli, destination } = await setup(false, true);
  await assert.rejects(editProject(workspace, fakeCli, original.path, destination, edits), /source file changed/i);
  await assert.rejects(stat(destination), /ENOENT/);
});
