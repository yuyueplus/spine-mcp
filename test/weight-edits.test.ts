import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { cleanWeights, inspectWeights, smoothWeights } from '../src/weight-edits.js';
import { attachmentEntries, attachmentTracks, sourceMesh } from '../src/attachment-data.js';
import { setAttachment, setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { parseDocument, type SpineDocument } from '../src/document.js';
import { sampleSkeleton } from '../src/runtime.js';
import { applyEdits, editSchema } from '../src/edits.js';

function fixture(): SpineDocument {
  const source: SpineDocument = { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root', x: 7, y: -9, rotation: 20 }, { name: 'arm', parent: 'root', x: 20, rotation: 12, scaleX: 1.3, scaleY: 0.8, shearY: 10 }, { name: 'tip', parent: 'arm', x: 80, rotation: -15 }], slots: [{ name: 'art', bone: 'arm' }, { name: 'copy', bone: 'root' }], skins: [{ name: 'default', attachments: {} }], animations: {} };
  return setAttachment(source, 'default', 'art', 'mesh', { type: 'mesh', path: 'art', uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, -12, 0, 12, 120, 12, 120, -12], triangles: [0, 1, 2, 0, 2, 3], hull: 4 }, false, true);
}
function weighted() {
  const source = fixture();
  return setWeights(source, 'default', 'art', 'mesh', [
    [{ bone: 'tip', weight: 0.001, x: 18, y: -20 }, { bone: 'arm', weight: 0.7, x: -5, y: -12 }, { bone: 'root', weight: 0.299, x: 30, y: -4 }],
    [{ bone: 'arm', weight: 1 }], [{ bone: 'tip', weight: 1 }], [{ bone: 'tip', weight: 0.7 }, { bone: 'arm', weight: 0.3 }],
  ]);
}
function world(data: SpineDocument) {
  const skeleton = sampleSkeleton(data, undefined, 0), slot = skeleton.slots[0]!, mesh = slot.appliedPose.attachment as MeshAttachment;
  const vertices = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2); return vertices;
}
function sameGeometry(before: SpineDocument, after: SpineDocument) {
  const expected = world(before), actual = world(after);
  assert.ok(actual.every((value, index) => Math.abs(value - expected[index]!) < 0.0001), JSON.stringify({ expected, actual }));
}

test('weight inspection paginates bind coordinates, sums and linked-source identities', () => {
  const source = weighted(), info = inspectWeights(source, 'default', 'art', 'mesh', 0, 2);
  assert.equal(info.vertexCount, 4); assert.equal(info.nextOffset, 2); assert.equal(info.maxInfluences, 3); assert.equal(info.weighted, true);
  assert.deepEqual(info.vertices[0]!.influences.map(item => item.bone), ['root', 'arm', 'tip']);
  assert.equal(inspectWeights(source, 'default', 'art', 'mesh', 2, 2).nextOffset, null);
  assert.equal(inspectWeights(fixture(), 'default', 'art', 'mesh').weighted, false);
  const linked = setAttachment(source, 'default', 'copy', 'linked', { type: 'mesh', path: 'art', source: 'mesh', slot: 'art' }, false, true);
  assert.deepEqual(inspectWeights(linked, 'default', 'copy', 'linked').source, { skin: 'default', slot: 'art', name: 'mesh' });
  assert.throws(() => inspectWeights(source, 'default', 'art', 'mesh', 5, 1), /offset/);
});

test('cleanup prunes and normalizes without moving setup geometry or mutating source', () => {
  const source = weighted(), snapshot = structuredClone(source);
  const output = cleanWeights(source, 'default', 'art', 'mesh', { minWeight: 0.01, maxInfluences: 1 });
  sameGeometry(source, output); assert.deepEqual(source, snapshot);
  const info = inspectWeights(output, 'default', 'art', 'mesh');
  assert.equal(info.maxInfluences, 1); assert.deepEqual(info.weightSumRange, [1, 1]);
  const fallback = cleanWeights(source, 'default', 'art', 'mesh', { minWeight: 1, maxInfluences: 16 });
  assert.equal(inspectWeights(fallback, 'default', 'art', 'mesh').vertices[0]!.influences[0]!.bone, 'arm');
  sameGeometry(source, fallback);
});

test('selected cleanup leaves other vertex weights and bind coordinates unchanged', () => {
  const source = weighted(), before = inspectWeights(source, 'default', 'art', 'mesh').vertices;
  const output = cleanWeights(source, 'default', 'art', 'mesh', { vertices: [0], maxInfluences: 1 });
  assert.deepEqual(inspectWeights(output, 'default', 'art', 'mesh').vertices.slice(1), before.slice(1)); sameGeometry(source, output);
});

test('smoothing uses synchronous triangle adjacency and respects selected vertices', () => {
  const source = setWeights(fixture(), 'default', 'art', 'mesh', [[{ bone: 'arm', weight: 1 }], [{ bone: 'arm', weight: 1 }], [{ bone: 'tip', weight: 1 }], [{ bone: 'tip', weight: 1 }]]);
  const output = smoothWeights(source, 'default', 'art', 'mesh', { vertices: [1], strength: 1, iterations: 1, minWeight: 0, maxInfluences: 2 });
  const rows = inspectWeights(output, 'default', 'art', 'mesh').vertices;
  assert.deepEqual(rows[1]!.influences.map(({ bone, weight }) => ({ bone, weight })), [{ bone: 'arm', weight: 0.5 }, { bone: 'tip', weight: 0.5 }]);
  assert.deepEqual(rows[0], inspectWeights(source, 'default', 'art', 'mesh').vertices[0]); sameGeometry(source, output);
  const all = smoothWeights(source, 'default', 'art', 'mesh', { strength: 1, iterations: 1, minWeight: 0, maxInfluences: 2 });
  assert.ok(Math.abs(inspectWeights(all, 'default', 'art', 'mesh').vertices[0]!.influences[0]!.weight - 1 / 3) < 1e-12);
  sameGeometry(source, all); assert.deepEqual(smoothWeights(source, 'default', 'art', 'mesh', { strength: 0 }), source);
});

test('disconnected vertices keep their weights and smoothing never crosses components', () => {
  let source = fixture(); const value = sourceMesh(source, 'default', 'art', 'mesh');
  (value.uvs as number[]).push(0.5, 0.5); (value.vertices as number[]).push(60, 0);
  source = setWeights(source, 'default', 'art', 'mesh', Array.from({ length: 5 }, (_, index) => [{ bone: index === 4 ? 'tip' : 'arm', weight: 1 }]));
  const output = smoothWeights(source, 'default', 'art', 'mesh', { strength: 1, iterations: 5 });
  assert.deepEqual(inspectWeights(output, 'default', 'art', 'mesh').vertices[4], inspectWeights(source, 'default', 'art', 'mesh').vertices[4]);
  sameGeometry(source, output);
});

test('weight edits guard source and independent linked deforms, clearing only related keys', () => {
  let source = setAttachment(weighted(), 'default', 'copy', 'linked', { type: 'mesh', path: 'art', source: 'mesh', slot: 'art', timelines: false }, false, true);
  source = setAttachment(source, 'default', 'art', 'other', { type: 'mesh', path: 'art', uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 20, 0, 0, 20], triangles: [0, 1, 2] });
  source = setAttachmentTimeline(source, 'bend', 'default', 'copy', 'linked', 'deform', [{ time: 0 }, { time: 1, vertices: [1, 2] }]);
  source = setAttachmentTimeline(source, 'bend', 'default', 'art', 'other', 'deform', [{ time: 0 }]);
  assert.throws(() => cleanWeights(source, 'default', 'art', 'mesh'), /linked.*clearDeform/);
  assert.throws(() => smoothWeights(source, 'default', 'art', 'mesh'), /clearDeform/);
  const output = cleanWeights(source, 'default', 'art', 'mesh', { clearDeform: true, maxInfluences: 1 });
  assert.deepEqual(attachmentTracks(output, output.animations!.bend!).map(track => track.name), ['other']); sameGeometry(source, output);
  assert.equal(attachmentTracks(source, source.animations!.bend!).length, 2);
});

test('weight edits reject invalid selections, duplicate bones, unweighted and linked targets', () => {
  const source = weighted();
  assert.throws(() => cleanWeights(fixture(), 'default', 'art', 'mesh'), /weighted non-linked/);
  for (const vertices of [[], [0, 0], [4], [-1]]) assert.throws(() => cleanWeights(source, 'default', 'art', 'mesh', { vertices }), /distinct valid/);
  assert.throws(() => smoothWeights(source, 'default', 'art', 'mesh', { iterations: 21 }), /iterations/);
  assert.throws(() => cleanWeights(source, 'default', 'art', 'mesh', { minWeight: -1 }), /minWeight/);
  const linked = setAttachment(source, 'default', 'copy', 'linked', { type: 'mesh', path: 'art', source: 'mesh', slot: 'art' });
  assert.throws(() => cleanWeights(linked, 'default', 'copy', 'linked'), /source mesh/);
  const corrupt = structuredClone(source), packed = attachmentEntries(corrupt)[0]!.value.vertices as number[]; packed[5] = packed[1]!;
  assert.throws(() => parseDocument(corrupt), /repeat the same bone/);
});

test('ordered edit schema exposes cleanup and smoothing with defaults', async () => {
  const source = weighted();
  const output = await applyEdits(source, [editSchema.parse({ type: 'clean_weights', skin: 'default', slot: 'art', name: 'mesh', maxInfluences: 2 }), editSchema.parse({ type: 'smooth_weights', skin: 'default', slot: 'art', name: 'mesh' })]);
  sameGeometry(source, output); assert.ok(inspectWeights(output, 'default', 'art', 'mesh').maxInfluences <= 4);
});
