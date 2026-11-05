import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { setAttachment, setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { vertexLayout } from '../src/attachment-data.js';
import { sampleSkeleton } from '../src/runtime.js';
import { type SpineDocument } from '../src/document.js';
import { retimeAnimation } from '../src/animation-edits.js';
import { setConstraint, setConstraintTimeline } from '../src/constraint-edits.js';
import { samplePose } from '../src/preview.js';

function fixture(): SpineDocument { return { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 120 }, { name: 'control', parent: 'root', x: 60, y: 20 }], slots: [{ name: 'art', bone: 'arm' }], skins: [{ name: 'default', attachments: {} }], animations: {} }; }
function mesh() { return setAttachment(fixture(), 'default', 'art', 'mesh', { type: 'mesh', path: 'arm', width: 120, height: 24, uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, -12, 0, 12, 120, 12, 120, -12], triangles: [0, 1, 2, 0, 2, 3], hull: 4 }, false, true); }
function vertices(data: SpineDocument, animation?: string, time = 0) {
  const skeleton = sampleSkeleton(data, animation, time), slot = skeleton.slots[0]!, attachment = slot.appliedPose.attachment as MeshAttachment, values = new Array<number>(attachment.worldVerticesLength);
  attachment.computeWorldVertices(skeleton, slot, 0, values.length, values, 0, 2); return values;
}
test('mesh vertices and sparse deformation use official runtime geometry', () => {
  const source = mesh(), before = vertices(source);
  let animated = setAttachmentTimeline(source, 'bend', 'default', 'art', 'mesh', 'deform', [{ time: 0 }, { time: 1, offset: 2, vertices: [0, 20, 0, 20] }]);
  const actual = vertices(animated, 'bend', 0.5);
  assert.ok(Math.abs(actual[3]! - before[3]! - 10) < 0.0001); assert.ok(Math.abs(actual[5]! - before[5]! - 10) < 0.0001);
  animated = retimeAnimation(animated, 'bend', 2, 0.25);
  assert.deepEqual(vertices(animated, 'bend', 1.25), actual);
});
test('automatic weighted binding preserves setup world geometry and normalizes weights', () => {
  const source = mesh(), before = vertices(source), weighted = setWeights(source, 'default', 'art', 'mesh', Array.from({ length: 4 }, () => [{ bone: 'arm', weight: 2 }, { bone: 'control', weight: 2 }]));
  const after = vertices(weighted), value = (weighted.skins as any)[0].attachments.art.mesh;
  assert.ok(after.every((value, index) => Math.abs(value - before[index]!) < 0.0001));
  assert.equal(vertexLayout(weighted, value).deformLength, 16); assert.equal(value.vertices[4], 0.5);
  const animated = setAttachmentTimeline(source, 'bend', 'default', 'art', 'mesh', 'deform', [{ time: 0 }]);
  assert.throws(() => setWeights(animated, 'default', 'art', 'mesh', Array.from({ length: 4 }, () => [{ bone: 'arm', weight: 1 }])), /clearDeform/);
});
test('mesh validation rejects invalid triangles, weights and deform bounds', () => {
  assert.throws(() => setAttachment(fixture(), 'default', 'art', 'bad', { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 3] }), /triangles/);
  assert.throws(() => setAttachmentTimeline(mesh(), 'bad', 'default', 'art', 'mesh', 'deform', [{ time: 0, offset: 8, vertices: [1] }]), /exceeds/);
  assert.throws(() => setWeights(mesh(), 'default', 'art', 'mesh', Array.from({ length: 4 }, () => [{ bone: 'missing', weight: 1 }])), /missing/);
});
test('linked meshes share source geometry and named references are checked', () => {
  const source = mesh(); source.slots!.push({ name: 'linked', bone: 'root' });
  const linked = setAttachment(source, 'default', 'linked', 'copy', { type: 'mesh', source: 'mesh', slot: 'art', path: 'arm', width: 120, height: 24 }, false, true);
  const skeleton = sampleSkeleton(linked, undefined, 0), attachment = skeleton.slots[1]!.appliedPose.attachment as MeshAttachment;
  assert.equal(attachment.worldVerticesLength, 8);
  assert.throws(() => setAttachment(source, 'default', 'linked', 'bad', { type: 'mesh', source: 'missing' }), /source/);
});
test('path constraint follows an actual cubic attachment and slider drives animation time', () => {
  let data = fixture(); data.slots!.push({ name: 'path', bone: 'root' });
  data = setAttachment(data, 'default', 'path', 'curve', { type: 'path', vertexCount: 6, vertices: [-10, 0, 0, 0, 33, 0, 66, 0, 100, 0, 110, 0], lengths: [100], constantSpeed: true }, false, true);
  data = setConstraint(data, { type: 'path', name: 'follow', bones: ['arm'], slot: 'path', position: 0.5, positionMode: 'percent' });
  const arm = samplePose(data, undefined, 0)[1]!; assert.ok(Math.abs(arm.x - 50) < 1); assert.ok(Math.abs(arm.y) < 0.001);
  let slider = fixture(); slider.animations!.wave = { bones: { arm: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 50 }] } } };
  slider = setConstraint(slider, { type: 'slider', name: 'driver', animation: 'wave', time: 0.5 });
  assert.ok(Math.abs(samplePose(slider, undefined, 0)[1]!.rotation - 25) < 0.001);
  slider = setConstraintTimeline(slider, 'control', 'driver', 'time', [{ time: 0, value: 0 }, { time: 1, value: 1 }]);
  assert.ok(Math.abs(samplePose(slider, 'control', 0.5)[1]!.rotation - 25) < 0.001);
});
