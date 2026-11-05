import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/config.js';
import { writeDocument, type SpineDocument } from '../src/document.js';
import { setAttachment, setAttachmentTimeline } from '../src/geometry-edits.js';
import { cropAnimation, sampleTimes } from '../src/advanced-animation.js';
import { sampleSkeleton } from '../src/runtime.js';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { verifyRoundTrip, editProject } from '../src/project-workflow.js';
import { buildProject } from '../src/multi-project.js';
import { setConstraint, setConstraintTimeline } from '../src/constraint-edits.js';
import { retimeAnimation } from '../src/animation-edits.js';
import type { SpineCli } from '../src/cli.js';

function fixture(): SpineDocument { return { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 100 }], slots: [{ name: 'art', bone: 'arm' }], skins: [{ name: 'default', attachments: {} }] }; }
test('fractional frame ranges never create duplicate float32 times', () => {
  const times = sampleTimes(0.2, 0.8, 20);
  assert.equal(times.length, 13); assert.equal(times.at(-1), 0.8); assert.equal(new Set(times.map(Math.fround)).size, times.length);
});
test('cropped mesh deformation follows runtime easing at the sample boundaries', () => {
  let data = setAttachment(fixture(), 'default', 'art', 'mesh', { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 20, 0, 0, 20], triangles: [0, 1, 2] }, false, true);
  data = setAttachmentTimeline(data, 'bend', 'default', 'art', 'mesh', 'deform', [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, vertices: [0, 0, 0, 8, 0, 8] }]);
  const cropped = cropAnimation(data, 'bend', 'cropped', 0.2, 0.8, 30);
  const geometry = (value: SpineDocument, animation: string, time: number) => { const skeleton = sampleSkeleton(value, animation, time), slot = skeleton.slots[0]!, attachment = slot.appliedPose.attachment as MeshAttachment, vertices = new Array<number>(6); attachment.computeWorldVertices(skeleton, slot, 0, 6, vertices, 0, 2); return vertices; };
  for (const time of [0, 0.2, 0.6]) {
    const a = geometry(data, 'bend', time + 0.2), b = geometry(cropped, 'cropped', time);
    assert.ok(a.every((value, index) => Math.abs(value - b[index]!) < 0.03));
  }
});
test('round-trip verification rejects changed geometry and deformation while accepting constant linear/stepped equivalence', () => {
  let data = setAttachment(fixture(), 'default', 'art', 'mesh', { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 20, 0, 0, 20], triangles: [0, 1, 2] }, false, true);
  data = setAttachmentTimeline(data, 'bend', 'default', 'art', 'mesh', 'deform', [{ time: 0 }, { time: 1, vertices: [1] }]);
  const geometry = structuredClone(data); (geometry.skins as any)[0].attachments.art.mesh.vertices[2] = 99;
  assert.throws(() => verifyRoundTrip(data, geometry, 'a.json', 'a.json'), /Vertices/);
  const deformation = structuredClone(data); (deformation.animations!.bend!.attachments as any).default.art.mesh.deform[1].vertices[0] = 2;
  assert.throws(() => verifyRoundTrip(data, deformation, 'a.json', 'a.json'), /Attachment keys/);
  data.animations!.constant = { bones: { arm: { rotate: [{ time: 0 }, { time: 1 }] } } };
  const stepped = structuredClone(data); (stepped.animations!.constant!.bones as any).arm.rotate[0].curve = 'stepped';
  assert.equal(verifyRoundTrip(data, stepped, 'a.json', 'a.json').passed, true);
});

test('native constant-deform linear/step normalization is accepted while changed interpolation rejects', () => {
  let data = setAttachment(fixture(), 'default', 'art', 'mesh', { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 20, 0, 0, 20], triangles: [0, 1, 2] }, false, true);
  data = setAttachmentTimeline(data, 'constant', 'default', 'art', 'mesh', 'deform', [{ time: 0 }, { time: 1 }]); const native = structuredClone(data), keys = (native.animations!.constant!.attachments as any).default.art.mesh.deform; keys[0].curve = 'stepped'; assert.equal(verifyRoundTrip(data, native, 'a.json', 'a.json').passed, true);
  (data.animations!.constant!.attachments as any).default.art.mesh.deform[1].vertices = [3]; keys[1].vertices = [3]; assert.throws(() => verifyRoundTrip(data, native, 'a.json', 'a.json'), /Attachment keys/);
});
test('global physics parameter timelines remain global when retimed', () => {
  let data = setConstraint(fixture(), { type: 'physics', name: 'spring', bone: 'arm', rotate: 1, windGlobal: true });
  data = setConstraintTimeline(data, 'wind', '', 'wind', [{ time: 0, value: 0 }, { time: 1, value: 20 }]);
  const result = retimeAnimation(data, 'wind', 2, 0.1);
  assert.deepEqual((result.animations!.wind!.physics as any)[''].wind.map((key: any) => key.time), [0.1, 2.1]);
});
test('multi-skeleton verification prevents publication when an untouched skeleton is corrupted', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-multi-check-'))), workspace = new Workspace(root);
  const a = await writeDocument(workspace, 'a.json', fixture()), b = await writeDocument(workspace, 'b.json', fixture());
  const originals = await Promise.all([readFile(a.path, 'utf8'), readFile(b.path, 'utf8')]);
  const mock = { importSkeletons: async (_entries: unknown, output: string) => { await writeFile(output, 'mock-project'); }, exportData: async () => {
    const corrupt = fixture(); corrupt.bones[1]!.x = 999;
    return { files: [(await writeDocument(workspace, 'out/a.json', fixture())).path, (await writeDocument(workspace, 'out/b.json', corrupt)).path] };
  } } as unknown as SpineCli;
  await assert.rejects(buildProject(workspace, mock, [{ input: a.path, name: 'a' }, { input: b.path, name: 'b' }], 'result.spine'), /verification failed/);
  await assert.rejects(stat(path.join(root, 'result.spine')), /ENOENT/);
  assert.deepEqual(await Promise.all([readFile(a.path, 'utf8'), readFile(b.path, 'utf8')]), originals);
});
test('cooperative cancellation immediately before publishing leaves final project absent', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-cancel-check-'))), workspace = new Workspace(root), input = await writeDocument(workspace, 'source.json', fixture());
  const source = fixture(); source.bones[1]!.x = 5;
  const actual = await writeDocument(workspace, 'actual.json', source);
  const mock = { importProject: async (_input: string, output: string) => { await writeFile(output, 'mock-project'); }, exportData: async () => ({ files: [actual.path] }) };
  await assert.rejects(editProject(workspace, mock as any, input.path, 'result.spine', [{ type: 'set_bone', bone: 'arm', transform: { x: 5 } }], undefined, { checkpoint: async progress => { if (progress.phase === 'publish') throw new Error('MCP_JOB_CANCELLED'); } }), /CANCELLED/);
  await assert.rejects(stat(path.join(root, 'result.spine')), /ENOENT/);
});
