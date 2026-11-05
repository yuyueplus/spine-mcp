import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { canonicalizeWeights } from '../src/weight-order.js';
import { parseDocument, type SpineDocument } from '../src/document.js';
import { setAttachment, setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { sampleSkeleton } from '../src/runtime.js';
import { verifyRoundTrip } from '../src/project-workflow.js';
import { remapBoneIndices } from '../src/structure.js';
import { sourceMesh } from '../src/attachment-data.js';

function fixture(): SpineDocument {
  let source = setAttachment({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'z', parent: 'root' }, { name: 'a', parent: 'root', x: 50, rotation: 30 }], slots: [{ name: 'art', bone: 'z' }, { name: 'link', bone: 'root' }], skins: [{ name: 'default', attachments: {} }], animations: {} }, 'default', 'art', 'mesh', { type: 'mesh', path: 'art', uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 20, 0, 0, 20], triangles: [0, 1, 2] }, false, true);
  source = setWeights(source, 'default', 'art', 'mesh', Array.from({ length: 3 }, () => [{ bone: 'z', weight: 0.7 }, { bone: 'a', weight: 0.3 }]));
  source = setAttachment(source, 'default', 'link', 'copy', { type: 'mesh', source: 'mesh', slot: 'art', path: 'art', timelines: false }, false, true);
  source = setAttachmentTimeline(source, 'bend', 'default', 'art', 'mesh', 'deform', [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, offset: 1, vertices: [3, 5, 7, 11, 13] }]);
  return setAttachmentTimeline(source, 'bend', 'default', 'link', 'copy', 'deform', [{ time: 0 }, { time: 1, offset: 3, vertices: [2, 4, 6, 8] }]);
}
function positions(data: SpineDocument, time: number) {
  const skeleton = sampleSkeleton(data, 'bend', time);
  return skeleton.slots.flatMap(slot => { const mesh = slot.appliedPose.attachment as MeshAttachment, values = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, values.length, values, 0, 2); return values; });
}
test('weight ordering transposes sparse source and independent linked deformation coordinates', () => {
  const source = fixture(), snapshot = structuredClone(source), unsorted = canonicalizeWeights(source, true), canonical = canonicalizeWeights(unsorted);
  assert.equal((sourceMesh(unsorted, 'default', 'art', 'mesh').vertices as number[])[1], 2);
  assert.equal((sourceMesh(canonical, 'default', 'art', 'mesh').vertices as number[])[1], 1);
  for (const time of [0, 0.25, 0.75, 1]) {
    const expected = positions(source, time), actual = positions(unsorted, time), imported = positions(canonical, time);
    assert.ok(actual.every((value, index) => Math.abs(value - expected[index]!) < 0.00001));
    assert.ok(imported.every((value, index) => Math.abs(value - expected[index]!) < 0.00001));
  }
  assert.deepEqual(source, snapshot); assert.doesNotThrow(() => parseDocument(canonical));
});
test('round-trip verification accepts equivalent influence order and reordered bone indices', () => {
  const source = fixture(), reordered = structuredClone(source);
  reordered.bones = [source.bones[0]!, source.bones[2]!, source.bones[1]!].map(bone => ({ ...bone })); remapBoneIndices(reordered, source.bones);
  const actual = canonicalizeWeights(reordered);
  assert.equal(verifyRoundTrip(source, actual, 'a.json', 'a.json').passed, true);
});
test('round-trip verification still rejects a deformation that was not transposed', () => {
  const source = fixture(), corrupted = canonicalizeWeights(source, true);
  corrupted.animations = structuredClone(source.animations);
  assert.throws(() => verifyRoundTrip(source, corrupted, 'a.json', 'a.json'), /Attachment keys/);
});
test('ordering leaves already sorted meshes and empty deformation frames intact', () => {
  const source = fixture(); assert.equal(canonicalizeWeights(source), source);
  const ordered = canonicalizeWeights(source, true);
  assert.deepEqual((ordered.animations!.bend!.attachments as any).default.link.copy.deform[0], { time: 0 });
});
