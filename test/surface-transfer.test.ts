import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { parseDocument, type SpineDocument } from '../src/document.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { transferWeights, replaceMeshTopology } from '../src/production-mesh.js';
import { inspectWeights } from '../src/weight-edits.js';
import { sampleSkeleton } from '../src/runtime.js';
import { surfaceSampler } from '../src/surface-sampling.js';
import { editSchema } from '../src/edits.js';

const from = { skin: 'default', slot: 'art', name: 'mesh' }, to = { skin: 'default', slot: 'target', name: 'target' };
function fixture(weighted = true): SpineDocument {
  let data = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root', x: 5, y: 7, rotation: 20, scaleX: 1.3, scaleY: 0.8 }, { name: 'a', parent: 'root' }, { name: 'b', parent: 'root', x: 12 }, { name: 'c', parent: 'root', y: 12 }], slots: [{ name: 'art', bone: 'root', attachment: 'mesh' }, { name: 'target', bone: 'root', attachment: 'target' }], skins: [{ name: 'default', attachments: { art: { mesh: { type: 'mesh', path: 'art', width: 12, height: 12, vertices: [0, 0, 12, 0, 0, 12], uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3 } }, target: { target: { type: 'mesh', path: 'art', width: 12, height: 12, vertices: [3, 3, 6, 0, 0, 6], uvs: [0.25, 0.25, 0.5, 0, 0, 0.5], triangles: [0, 1, 2], hull: 3 } } } }], animations: { move: { bones: { a: { rotate: [{ time: 0 }, { time: 1, value: 100 }] }, b: { translate: [{ time: 0 }, { time: 1, x: 6, y: 2 }] }, c: { scale: [{ time: 0 }, { time: 1, x: 1.5, y: 0.8 }] } } } } });
  if (weighted) data = setWeights(data, from.skin, from.slot, from.name, [[{ bone: 'a', weight: 1 }], [{ bone: 'b', weight: 1 }], [{ bone: 'c', weight: 1 }]]);
  return data;
}
function vertices(data: SpineDocument, ref = from, time = 0) {
  const skeleton = sampleSkeleton(data, time ? 'move' : undefined, time, ref.skin), slot = skeleton.slots.find(slot => slot.data.name === ref.slot)!, mesh = skeleton.data.findSkin(ref.skin)!.getAttachment(slot.data.index, ref.name);
  assert.ok(mesh instanceof MeshAttachment); const world = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2); return world;
}
function near(a: number[], b: number[], tolerance = 0.0001) { assert.equal(a.length, b.length); a.forEach((value, index) => assert.ok(Math.abs(value - b[index]!) < tolerance, `${index}: ${value} vs ${b[index]}`)); }
function mesh(data: SpineDocument) { return attachmentEntries(data).find(item => item.slot === from.slot && item.name === from.name)!.value; }

test('surface weights interpolate three bone fields, retaining the target setup geometry', () => {
  const data = fixture(), original = JSON.stringify(data), result = transferWeights(data, from, to, { method: 'surface', maxDistance: 1e-8 });
  const rows = inspectWeights(result, to.skin, to.slot, to.name).vertices;
  assert.deepEqual(rows[0]!.influences.map(item => item.bone), ['a', 'b', 'c']); near(rows[0]!.influences.map(item => item.weight), [0.5, 0.25, 0.25]);
  near(vertices(data, to), vertices(result, to)); assert.equal(JSON.stringify(data), original);
  assert.equal(inspectWeights(transferWeights(data, from, to, {}), to.skin, to.slot, to.name).vertices[0]!.influences.length, 1);
});
test('surface projection uses boundary interpolation outside the mesh and enforces distance limits', () => {
  const data = fixture(); (attachmentEntries(data).find(item => item.slot === to.slot)!.value.vertices as number[]).splice(0, 2, 6, -2);
  assert.throws(() => transferWeights(data, from, to, { method: 'surface', maxDistance: 0.1 }), /vertex 0.*maxDistance/);
  const row = inspectWeights(transferWeights(data, from, to, { method: 'surface' }), to.skin, to.slot, to.name).vertices[0]!.influences;
  near(row.map(item => item.weight), [0.5, 0.5]);
});
test('surface transfer maps names, preserves locked weights, and rejects invalid maps', () => {
  const data = setWeights(fixture(), to.skin, to.slot, to.name, Array.from({ length: 3 }, () => [{ bone: 'root', weight: 0.3 }, { bone: 'c', weight: 0.7 }]));
  const result = transferWeights(data, from, to, { method: 'surface', lockedBones: ['root'], boneMap: { c: 'b' } }), row = inspectWeights(result, to.skin, to.slot, to.name).vertices[0]!.influences;
  near(row.map(item => item.weight), [0.3, 0.35, 0.35]);
  assert.throws(() => transferWeights(data, from, to, { method: 'surface', boneMap: { a: 'missing' } }), /Bone map/);
  assert.throws(() => transferWeights(data, from, to, { method: 'surface', lockedBones: ['root', 'root'] }), /distinct/);
});
test('surface transfer mirrors query positions in target slot coordinates', () => {
  const data = fixture(); (attachmentEntries(data).find(item => item.slot === to.slot)!.value.vertices as number[]).splice(0, 4, -3, 3, -6, 0);
  const row = inspectWeights(transferWeights(data, from, to, { method: 'surface', mirror: 'x', maxDistance: 1e-8 }), to.skin, to.slot, to.name).vertices[0]!.influences;
  near(row.map(item => item.weight), [0.5, 0.25, 0.25]);
});
test('tiny-weight cleanup is explicit and preserves locked target influences', () => {
  let data = fixture(), raw = attachmentEntries(data).find(item => item.slot === to.slot)!.value.vertices as number[]; raw[0] = 1e-8; raw[1] = 3;
  data = setWeights(data, to.skin, to.slot, to.name, Array.from({ length: 3 }, () => [{ bone: 'root', weight: 0.2 }, { bone: 'a', weight: 0.8 }]));
  const all = inspectWeights(transferWeights(data, from, to, { method: 'surface', lockedBones: ['root'] }), to.skin, to.slot, to.name).vertices[0]!.influences;
  assert.ok(all.some(item => item.bone === 'b' && item.weight > 0 && item.weight < 1e-6));
  const cleaned = inspectWeights(transferWeights(data, from, to, { method: 'surface', minWeight: 1e-6, lockedBones: ['root'] }), to.skin, to.slot, to.name).vertices[0]!.influences;
  assert.equal(cleaned.some(item => item.bone === 'b'), false); near(cleaned.map(item => item.weight), [0.2, 0.6, 0.2]);
  assert.throws(() => transferWeights(data, from, to, { method: 'surface', minWeight: 1 }), /every transferable/);
});
test('surface interpolation rejects influence overflow without modifying the source', () => {
  let data = fixture(false); data.bones.push(...Array.from({ length: 18 }, (_, i) => ({ name: `joint${i}`, parent: 'root' })));
  data = setWeights(data, from.skin, from.slot, from.name, Array.from({ length: 3 }, (_, row) => Array.from({ length: 6 }, (_, i) => ({ bone: `joint${row * 6 + i}`, weight: 1 / 6 }))));
  const original = JSON.stringify(data); assert.throws(() => transferWeights(data, from, to, { method: 'surface' }), /more than 16 influences/);
  assert.throws(() => replaceMeshTopology(data, from, topology, 'interpolate'), /1–16 positive influences/); assert.equal(JSON.stringify(data), original);
});
test('surface queries handle winding, degenerates, shared edges, ambiguity and budgets', () => {
  const points = [0, 0, 1, 0, 0, 1, 1, 1], result = surfaceSampler(points, [0, 0, 1, 2, 1, 0, 1, 2, 3], 1);
  assert.equal(result.skippedDegenerate, 1); const sample = result.locate(0.5, 0.5); assert.equal(sample.ambiguous, false); near(sample.factors, [0.5, 0.5, 0]);
  assert.throws(() => result.locate(0, 0), /budget/);
  assert.throws(() => surfaceSampler(points, [0, 0, 1], 1), /nondegenerate/);
  assert.throws(() => surfaceSampler(points, [0, 1, 2], 5000001), /five million/);
  const overlapped = surfaceSampler([...points, 0, 0, 1, 0, 0, 1], [0, 1, 2, 4, 5, 6], 1).locate(0.2, 0.3); assert.equal(overlapped.ambiguous, true);
});

const topology = { vertices: [0, 0, 12, 0, 0, 12, 4, 4], uvs: [0, 0, 1, 0, 0, 1, 1 / 3, 1 / 3], triangles: [0, 1, 3, 1, 2, 3, 2, 0, 3], hull: 3 };
for (const weighted of [false, true]) test(`UV retopology transports ${weighted ? 'weighted' : 'unweighted'} sparse deformation and curves`, () => {
  const data = setAttachmentTimeline(fixture(weighted), 'move', from.skin, from.slot, from.name, 'deform', [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, offset: 1, vertices: [2, 4, 6, 8] }]), original = JSON.stringify(data), result = replaceMeshTopology(data, from, topology, 'interpolate');
  for (const time of [0, 0.1, 0.3, 0.7, 1]) {
    const before = vertices(data, from, time), after = vertices(result, from, time); near(after.slice(0, 6), before);
    near(after.slice(6), [0, 1].map(axis => (before[axis]! + before[2 + axis]! + before[4 + axis]!) / 3));
  }
  assert.equal(JSON.stringify(data), original); assert.deepEqual((result.animations!.move!.attachments as any).default.art.mesh.deform[0].curve, [0.2, 0, 0.8, 1]);
});
test('interpolated retopology keeps explicitly requested setup positions', () => {
  const data = fixture(), changed = structuredClone(topology); changed.vertices[6] = 6; changed.vertices[7] = 5;
  const result = replaceMeshTopology(data, from, changed, 'interpolate'), direct = replaceMeshTopology(fixture(false), from, changed, 'clear'); near(vertices(result), vertices(direct));
});
test('interpolated retopology transports independent linked deformation along with its source', () => {
  let data = fixture(); data.slots!.push({ name: 'linked', bone: 'root', attachment: 'copy' }); (data.skins as any[])[0].attachments.linked = { copy: { type: 'linkedmesh', path: 'art', source: 'mesh', slot: 'art', timelines: false } };
  data = setAttachmentTimeline(parseDocument(data), 'move', 'default', 'linked', 'copy', 'deform', [{ time: 0 }, { time: 1, vertices: [1, 2, 3, 4, 5, 6] }]);
  const result = replaceMeshTopology(data, from, topology, 'interpolate'), ref = { skin: 'default', slot: 'linked', name: 'copy' };
  for (const time of [0.2, 0.8, 1]) { const before = vertices(data, ref, time), after = vertices(result, ref, time); near(after.slice(0, 6), before); near(after.slice(6), [0, 1].map(axis => (before[axis]! + before[2 + axis]! + before[4 + axis]!) / 3)); }
});
test('interpolated retopology rejects extrapolation, overlapping UVs and supplied packed weights', () => {
  const data = fixture(), outside = structuredClone(topology); outside.uvs[6] = 1; outside.uvs[7] = 1; assert.throws(() => replaceMeshTopology(data, from, outside, 'interpolate'), /outside/);
  const packed = { ...topology, vertices: mesh(data).vertices as number[] }; assert.throws(() => replaceMeshTopology(data, from, packed, 'interpolate'), /unweighted new/);
  const overlap = fixture(false), old = mesh(overlap); old.vertices = [...old.vertices as number[], 0, 0, 12, 0, 0, 12]; old.uvs = [...old.uvs as number[], 0, 0, 1, 0, 0, 1]; old.triangles = [0, 1, 2, 3, 4, 5];
  assert.throws(() => replaceMeshTopology(parseDocument(overlap), from, topology, 'interpolate'), /ambiguous/);
});
test('new options are accepted by the shared edit schema used by native and background workflows', () => {
  const transfer = editSchema.parse({ type: 'transfer_weights', from, to, method: 'surface', maxDistance: 3 }); assert.equal(transfer.type, 'transfer_weights'); if (transfer.type === 'transfer_weights') assert.equal(transfer.method, 'surface');
  const retopology = editSchema.parse({ type: 'replace_mesh_topology', ...from, mesh: topology, deformPolicy: 'interpolate' }); assert.equal(retopology.type, 'replace_mesh_topology'); if (retopology.type === 'replace_mesh_topology') assert.equal(retopology.deformPolicy, 'interpolate');
});
