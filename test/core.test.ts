import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, symlink, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/config.js';
import { parseDocument, setTimeline, setBone, addBone, addAnimation, writeDocument, readDocument, loopCheck, type SpineDocument } from '../src/document.js';
import { samplePose } from '../src/preview.js';
import { runProcess, SpineCli } from '../src/cli.js';

function fixture(): SpineDocument {
  return { skeleton: { spine: '4.3.23', images: './images/' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 100, rotation: 10 }], events: { sound: {} }, animations: { existing: { events: [{ time: 0, name: 'sound' }] } }, customMetadata: { preserve: [1, 2, 3] } };
}

test('edits preserve input, other animation channels and unknown metadata', () => {
  const source = fixture();
  const snapshot = JSON.stringify(source);
  const next = setTimeline(source, 'wave', 'arm', 'rotate', [{ time: 0, value: 0 }, { time: 1, value: 30 }]);
  assert.equal(JSON.stringify(source), snapshot);
  assert.deepEqual(next.customMetadata, source.customMetadata);
  assert.deepEqual(next.animations?.existing, source.animations?.existing);
  const extended = setTimeline(next, 'wave', 'arm', 'translate', [{ time: 0, x: 0, y: 0 }, { time: 1, x: 4, y: 8 }]);
  assert.deepEqual((extended.animations!.wave!.bones as any).arm.rotate, (next.animations!.wave!.bones as any).arm.rotate);
});
test('rejects wrong versions and invalid hierarchy or slot references', () => {
  assert.throws(() => parseDocument({ ...fixture(), skeleton: { spine: '4.2.0' } }), /Expected Spine/);
  assert.throws(() => parseDocument({ ...fixture(), bones: [{ name: 'root' }, { name: 'root' }] }), /Duplicate/);
  assert.throws(() => parseDocument({ ...fixture(), bones: [{ name: 'arm', parent: 'root' }, { name: 'root' }] }), /parent/);
  assert.throws(() => parseDocument({ ...fixture(), slots: [{ name: 'slot', bone: 'missing' }] }), /reference/);
});
test('rejects duplicate and out-of-order key times, wrong values and malformed curves', () => {
  for (const keys of [[{ time: 0, value: 0 }, { time: 0, value: 10 }], [{ time: 1, value: 0 }, { time: 0.5, value: 10 }]]) assert.throws(() => setTimeline(fixture(), 'wave', 'arm', 'rotate', keys), /increasing/);
  assert.throws(() => setTimeline(fixture(), 'wave', 'arm', 'rotate', [{ time: 0, x: 1, y: 1 }]), /needs value/);
  assert.throws(() => setTimeline(fixture(), 'wave', 'arm', 'scale', [{ time: 0, value: 1 }]), /needs x and y/);
  assert.throws(() => setTimeline(fixture(), 'wave', 'arm', 'rotate', [{ time: 0, value: NaN }]), /finite/);
  assert.throws(() => setTimeline(fixture(), 'wave', 'arm', 'rotate', [{ time: 0, value: 0, curve: [0, 1] }, { time: 1, value: 20 }]), /requires 4/);
});
test('4.3 runtime samples offsets and interpolation quantitatively', () => {
  const animated = setTimeline(fixture(), 'wave', 'arm', 'rotate', [{ time: 0, value: 0 }, { time: 1, value: 30 }]);
  const arm = samplePose(animated, 'wave', 0.5).find(b => b.name === 'arm')!;
  assert.ok(Math.abs(arm.rotation - 25) < 0.0001);
  assert.ok(Math.abs(arm.endX - Math.cos(25 * Math.PI / 180) * 100) < 0.001);
  assert.ok(Math.abs(arm.endY - Math.sin(25 * Math.PI / 180) * 100) < 0.001);
});
test('4.3 runtime respects stepped keyframes and scale', () => {
  let data = setTimeline(fixture(), 'hold', 'arm', 'rotate', [{ time: 0, value: 0, curve: 'stepped' }, { time: 1, value: 40 }]);
  data = setTimeline(data, 'hold', 'arm', 'scale', [{ time: 0, x: 1, y: 1 }, { time: 1, x: 2, y: 2 }]);
  const arm = samplePose(data, 'hold', 0.5).find(b => b.name === 'arm')!;
  assert.ok(Math.abs(arm.rotation - 10) < 0.001);
  assert.ok(Math.abs(Math.hypot(arm.endX - arm.x, arm.endY - arm.y) - 150) < 0.001);
});
test('new bones and copied animations preserve references and are independent', () => {
  assert.throws(() => addBone(fixture(), 'new', 'missing', {}), /Parent/);
  const data = addBone(fixture(), 'tip', 'arm', { x: 100 });
  assert.equal(data.bones.at(-1)?.parent, 'arm');
  const copied = addAnimation(data, 'copy', 'existing');
  assert.deepEqual(copied.animations!.copy, data.animations!.existing);
  assert.notEqual(copied.animations!.copy, copied.animations!.existing);
  assert.throws(() => setBone(data, 'missing', { x: 1 }), /not found/);
});
test('loop check reports endpoint mismatch', () => {
  const data = setTimeline(fixture(), 'wave', 'arm', 'rotate', [{ time: 0, value: 0 }, { time: 1, value: 30 }]);
  assert.equal(loopCheck(data, 'wave').endpointMismatches.length, 1);
});
test('animation names do not resolve inherited JavaScript properties', () => {
  const data = setTimeline(fixture(), 'toString', 'arm', 'rotate', [{ time: 0, value: 1 }]);
  assert.ok(Object.hasOwn(data.animations!, 'toString'));
  assert.throws(() => addAnimation(data, '__proto__'), /reserved/);
});
test('new outputs never overwrite source files', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-files-')));
  const workspace = new Workspace(root);
  const original = await writeDocument(workspace, 'original.json', fixture());
  const before = await readFile(original.path, 'utf8');
  await assert.rejects(writeDocument(workspace, 'original.json', setBone(fixture(), 'arm', { x: 20 })), /EEXIST/);
  assert.equal(await readFile(original.path, 'utf8'), before);
  assert.equal((await readDocument(original.path)).skeleton.spine, '4.3.23');
});
test('moving generated JSON preserves the target of relative resource paths', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-resources-')));
  const workspace = new Workspace(root);
  await mkdir(path.join(root, 'source/images'), { recursive: true });
  const output = await writeDocument(workspace, 'edits/deep/copy.json', fixture(), path.join(root, 'source'));
  const data = await readDocument(output.path);
  assert.equal(path.resolve(path.dirname(output.path), data.skeleton.images as string), path.join(root, 'source/images'));
});
test('workspace rejects traversal and junction escapes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-path-')));
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-outside-')));
  const workspace = new Workspace(root);
  await assert.rejects(workspace.resolve('../escape.json', false), /outside/);
  await assert.rejects(workspace.resolve('\\\\server\\share\\file.json', false), /local path/);
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.resolve('link/escape.json', false), /outside/);
});
test('process arguments remain literal and child output is bounded by timeout', async () => {
  const argument = '中文 path with spaces & $(literal)';
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument], 3000);
  assert.equal(result.stdout, argument);
  const unicode = await runProcess(process.execPath, ['-e', 'const b=Buffer.from("中文");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.end(b.subarray(1)),20)'], 3000);
  assert.equal(unicode.stdout, '中文');
  const failure = await runProcess(process.execPath, ['-e', 'process.stderr.write("test failure");process.exit(7)'], 3000);
  assert.equal(failure.exitCode, 7);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 300), /timed out/);
});
test('batch entrypoints reject shell metacharacters before starting a process', { skip: process.platform !== 'win32' }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-batch-')));
  const workspace = new Workspace(root);
  const input = await writeDocument(workspace, 'unsafe&name.json', fixture());
  const script = path.join(root, 'test.cmd');
  await writeFile(script, '@echo should-not-run');
  const cli = new SpineCli({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: script, guiExecutable: null, cliTimeoutMs: 3000 }, workspace);
  await assert.rejects(cli.projectInfo(input.path), /CMD metacharacters/);
});
