import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshAttachment, RegionAttachment } from '@esotericsoftware/spine-core';
import { meshFromRegion, autoWeights } from '../src/mesh-generation.js';
import { sampleSkeleton } from '../src/runtime.js';
import { parseDocument, type SpineDocument } from '../src/document.js';
import { setAttachmentTimeline } from '../src/geometry-edits.js';
import { setFolderDrawOrder, setDrawOrder } from '../src/animation-edits.js';
import { deleteObject } from '../src/structure.js';
import { vertexLayout } from '../src/attachment-data.js';

function fixture(): SpineDocument { return { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'left', parent: 'root', length: 40 }, { name: 'right', parent: 'root', x: 80, length: 40 }], slots: [{ name: 'art', bone: 'root', attachment: 'arm' }], skins: [{ name: 'default', attachments: { art: { arm: { x: 60, width: 120, height: 24, color: 'aabbccff' } } } }], animations: {} }; }
function world(data: SpineDocument) {
  const skeleton = sampleSkeleton(data, undefined, 0, 'default'), slot = skeleton.slots[0]!, attachment = slot.appliedPose.attachment;
  const vertices = new Array<number>(attachment instanceof RegionAttachment ? 8 : (attachment as MeshAttachment).worldVerticesLength);
  if (attachment instanceof RegionAttachment) attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), vertices, 0, 2);
  else (attachment as MeshAttachment).computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2);
  return vertices;
}
test('region conversion preserves rotated, sheared, reflected world corners and source data', () => {
  const source = fixture(); source.bones[0]!.rotation = 17; source.bones[0]!.shearY = 23;
  Object.assign((source.skins as any)[0].attachments.art.arm, { rotation: 35, scaleX: -1.2, scaleY: 0.8 });
  const snapshot = JSON.stringify(source), result = meshFromRegion(source, 'default', 'art', 'arm', 1, 1), a = world(source), b = world(result);
  assert.ok(a.every((value, index) => Math.abs(value - b[index]!) < 0.0001)); assert.equal(JSON.stringify(source), snapshot);
  assert.equal((result.skins as any)[0].attachments.art.arm.color, 'aabbccff');
});
test('grid conversion emits hull-first topology, complete triangles and normalized UVs', () => {
  const result = meshFromRegion(fixture(), 'default', 'art', 'arm', 3, 2), mesh = (result.skins as any)[0].attachments.art.arm;
  assert.equal(vertexLayout(result, mesh).count, 12); assert.equal(mesh.hull, 10); assert.equal(mesh.triangles.length, 36);
  for (const index of mesh.triangles) assert.ok(index >= 0 && index < 12);
  assert.ok(mesh.uvs.every((value: number) => value >= 0 && value <= 1));
  assert.throws(() => meshFromRegion(result, 'default', 'art', 'arm'), /region/);
});
test('automatic nearest-bone binding preserves geometry and chooses spatially closest segments', () => {
  const source = meshFromRegion(fixture(), 'default', 'art', 'arm', 1, 1), before = world(source);
  const result = autoWeights(source, 'default', 'art', 'arm', ['right', 'left'], 1), mesh = (result.skins as any)[0].attachments.art.arm;
  assert.deepEqual([mesh.vertices[1], mesh.vertices[6], mesh.vertices[11], mesh.vertices[16]], [1, 1, 2, 2]);
  assert.ok(world(result).every((value, index) => Math.abs(value - before[index]!) < 0.0001));
  const blended = autoWeights(source, 'default', 'art', 'arm', ['right', 'left'], 2);
  assert.equal(vertexLayout(blended, (blended.skins as any)[0].attachments.art.arm).deformLength, 16);
});
test('automatic binding protects existing deforms and rejects invalid candidate bones', () => {
  let source = meshFromRegion(fixture(), 'default', 'art', 'arm');
  source = setAttachmentTimeline(source, 'bend', 'default', 'art', 'arm', 'deform', [{ time: 0 }]);
  assert.throws(() => autoWeights(source, 'default', 'art', 'arm', ['left']), /clearDeform/);
  assert.doesNotThrow(() => autoWeights(source, 'default', 'art', 'arm', ['left'], 2, 2, true));
  assert.throws(() => autoWeights(source, 'default', 'art', 'arm', ['missing']), /missing/);
});
function slots(): SpineDocument { return { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], slots: ['a', 'b', 'c', 'd'].map(name => ({ name, bone: 'root' })), animations: {} }; }
const draw = (data: SpineDocument, time: number) => sampleSkeleton(data, 'layers', time).drawOrder.appliedPose.map(slot => slot.data.name);
test('disjoint folder draw-order groups reorder only their own members', () => {
  const result = setFolderDrawOrder(slots(), 'layers', [{ slots: ['c', 'a'], keyframes: [{ time: 0, order: null }, { time: 0.5, order: ['c', 'a'] }] }, { slots: ['b', 'd'], keyframes: [{ time: 0, order: ['d', 'b'] }] }]);
  assert.deepEqual(draw(result, 0), ['a', 'd', 'c', 'b']); assert.deepEqual(draw(result, 0.5), ['c', 'd', 'a', 'b']);
  assert.deepEqual((result.animations!.layers!.drawOrderFolder as any[])[0].slots, ['a', 'c']);
});
test('folder edits preserve global draw-order keys and can clear all groups', () => {
  const source = setDrawOrder(slots(), 'layers', [{ time: 0, order: ['d', 'c', 'b', 'a'] }]);
  const result = setFolderDrawOrder(source, 'layers', [{ slots: ['a', 'c'], keyframes: [{ time: 0, order: ['a', 'c'] }] }]);
  assert.deepEqual(draw(result, 0), ['d', 'a', 'b', 'c']);
  const cleared = setFolderDrawOrder(result, 'layers', []); assert.deepEqual(draw(cleared, 0), ['d', 'c', 'b', 'a']);
});
test('folder edits reject overlaps and incomplete permutations before output', () => {
  assert.throws(() => setFolderDrawOrder(slots(), 'layers', [{ slots: ['a', 'b'], keyframes: [{ time: 0, order: ['a'] }] }]), /every slot/);
  assert.throws(() => setFolderDrawOrder(slots(), 'layers', [{ slots: ['a', 'b'], keyframes: [] }, { slots: ['b'], keyframes: [] }]), /Overlapping/);
});
test('empty raw folder timelines are rejected and cascading the last member removes the timeline', () => {
  const bad = slots(); bad.animations!.layers = { drawOrderFolder: [{ slots: [], keys: [{ time: 0 }] }] };
  assert.throws(() => parseDocument(bad), /nonempty/);
  const source = setFolderDrawOrder(slots(), 'layers', [{ slots: ['a'], keyframes: [{ time: 0, order: null }] }]);
  const result = deleteObject(source, { kind: 'slot', name: 'a' }, true);
  assert.equal(result.animations!.layers!.drawOrderFolder, undefined); assert.deepEqual(draw(result, 0), ['b', 'c', 'd']);
});
test('folder editing retains animation references used by existing Slider constraints', () => {
  const source = slots(); source.animations!.pose = { bones: { root: { rotate: [{ time: 0 }, { time: 1, value: 10 }] } } };
  source.constraints = [{ type: 'slider', name: 'driver', animation: 'pose', time: 0.25 }];
  const result = setFolderDrawOrder(source, 'layers', [{ slots: ['a', 'b'], keyframes: [{ time: 0, order: ['b', 'a'] }] }]);
  assert.deepEqual(result.constraints, source.constraints); assert.deepEqual(result.animations!.pose, source.animations!.pose);
  assert.deepEqual(draw(result, 0), ['b', 'a', 'c', 'd']);
});
