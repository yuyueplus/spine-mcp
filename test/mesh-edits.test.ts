import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { inspectMesh, transformMesh, refineMesh } from '../src/mesh-edits.js';
import { attachmentEntries, normalizedAttachmentKeys, attachmentTracks } from '../src/attachment-data.js';
import { parseDocument, type SpineDocument } from '../src/document.js';
import { setAttachment, setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { linkMesh, type AttachmentRef } from '../src/attachment-reuse.js';
import { meshFromRegion } from '../src/mesh-generation.js';
import { canonicalizeWeights } from '../src/weight-order.js';
import { sampleSkeleton } from '../src/runtime.js';
import { applyEdits, editSchema } from '../src/edits.js';

const ref = { skin: 'base', slot: 'art', name: 'visual' }, inherited = { skin: 'base', slot: 'linked', name: 'inherited' }, own = { skin: 'base', slot: 'own', name: 'own' };
function fixture(weighted = false, boneAnimation = true): SpineDocument {
  let data = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root', x: 7, y: -9, rotation: 17, shearY: 13 }, { name: 'z-source', parent: 'root', x: 25, y: 4, rotation: 11, scaleX: 1.2, scaleY: 0.8 }, { name: 'a-tip', parent: 'root', x: -30, y: 20, rotation: -23, scaleX: -0.9, scaleY: 1.35, shearX: 9 }], slots: [{ name: 'art', bone: 'z-source', attachment: 'visual' }, { name: 'linked', bone: 'a-tip' }, { name: 'own', bone: 'root' }], skins: [{ name: 'base', attachments: { art: { visual: { type: 'mesh', name: 'base/visual', path: 'arm', width: 120, height: 24, color: 'aabbccdd', sequence: { count: 3 }, uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, -12, 0, 12, 120, 12, 120, -12], triangles: [0, 1, 2, 0, 2, 3], hull: 4 } } } }], animations: {} });
  if (weighted) {
    data = setWeights(data, ref.skin, ref.slot, ref.name, [
      [{ bone: 'z-source', weight: 1 }], [{ bone: 'z-source', weight: 0.8 }, { bone: 'a-tip', weight: 0.2 }],
      [{ bone: 'z-source', weight: 0.2 }, { bone: 'a-tip', weight: 0.8 }], [{ bone: 'a-tip', weight: 1 }],
    ]);
    data = canonicalizeWeights(data, true);
  }
  data = setAttachmentTimeline(data, 'bend', ref.skin, ref.slot, ref.name, 'deform', [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 0.5, offset: 1, vertices: [2, 3, 4, 5, 6] }, { time: 1 }]);
  data = setAttachmentTimeline(data, 'bend', ref.skin, ref.slot, ref.name, 'sequence', [{ time: 0, mode: 'loop', delay: 0.25 }]);
  if (boneAnimation) data.animations!.bend!.bones = { 'z-source': { rotate: [{ time: 0 }, { time: 1, value: 35 }] }, 'a-tip': { translate: [{ time: 0 }, { time: 1, x: 5, y: -7 }] } };
  data = linkMesh(data, ref, inherited, { setAsSetup: true });
  data = linkMesh(data, ref, own, { inheritTimelines: false, copyTimelines: true, setAsSetup: true });
  return setAttachmentTimeline(data, 'bend', own.skin, own.slot, own.name, 'deform', [{ time: 0 }, { time: 1, offset: 3, vertices: [-8, 5, 3] }]);
}
function record(data: SpineDocument, selected = ref) { return attachmentEntries(data).find(item => item.skin === selected.skin && item.slot === selected.slot && item.name === selected.name)!.value; }
function sample(data: SpineDocument, selected: AttachmentRef, time: number) {
  const skeleton = sampleSkeleton(data, 'bend', time, selected.skin), slot = skeleton.slots.find(item => item.data.name === selected.slot)!, mesh = slot.appliedPose.attachment as MeshAttachment;
  assert.ok(mesh instanceof MeshAttachment); const world = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2);
  return { skeleton, slot, mesh, world, frame: mesh.sequence.resolveIndex(slot.appliedPose), uv: Array.from(mesh.regionUVs), triangles: mesh.triangles };
}
function close(a: number[], b: number[], tolerance = 0.00015) { assert.equal(a.length, b.length); assert.ok(a.every((value, index) => Number.isFinite(value) && Math.abs(value - b[index]!) < tolerance), JSON.stringify({ a, b })); }
function interpolate(uv: number[], triangles: ArrayLike<number>, world: number[], u: number, v: number) {
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const a = triangles[offset]!, b = triangles[offset + 1]!, c = triangles[offset + 2]!, ax = uv[a * 2]!, ay = uv[a * 2 + 1]!, bx = uv[b * 2]!, by = uv[b * 2 + 1]!, cx = uv[c * 2]!, cy = uv[c * 2 + 1]!;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy), wa = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / det, wb = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / det, wc = 1 - wa - wb;
    if (Math.min(wa, wb, wc) >= -1e-7) return [0, 1].map(axis => world[a * 2 + axis]! * wa + world[b * 2 + axis]! * wb + world[c * 2 + axis]! * wc);
  }
  throw new Error('Test UV outside reference mesh.');
}
function sameSurface(source: SpineDocument, output: SpineDocument, selected: AttachmentRef) {
  for (const time of [0, 0.17, 0.5, 0.83, 1]) {
    const a = sample(source, selected, time), b = sample(output, selected, time); assert.equal(a.frame, b.frame);
    for (let index = 0; index < b.uv.length; index += 2) close(b.world.slice(index, index + 2), interpolate(a.uv, a.triangles, a.world, b.uv[index]!, b.uv[index + 1]!));
    // Interior samples ensure the new triangles cover the same UV surface.
    for (const [u, v] of [[0.1, 0.2], [0.2, 0.9], [0.5, 0.5], [0.9, 0.8]]) close(interpolate(a.uv, a.triangles, a.world, u!, v!), interpolate(b.uv, b.triangles, b.world, u!, v!));
  }
}
function affineLocal(x: number, y: number) {
  const radians = 31 * Math.PI / 180, px = x - 40, py = y - 2;
  return [7 + 40 + Math.cos(radians) * px * -0.8 - Math.sin(radians) * py * 1.3, -5 + 2 + Math.sin(radians) * px * -0.8 + Math.cos(radians) * py * 1.3];
}

test('mesh inspection paginates vertices/triangles and resolves shared source topology without mutation', () => {
  const source = fixture(true), snapshot = structuredClone(source), info = inspectMesh(source, inherited, { offset: 1, limit: 2, triangleOffset: 1, triangleLimit: 1 });
  assert.deepEqual(info.source, ref); assert.equal(info.weighted, true); assert.equal(info.refinable, true); assert.equal(info.vertexCount, 4); assert.equal(info.edgeCount, 5); assert.equal(info.boundaryEdges, 4);
  assert.equal(info.nextOffset, 3); assert.equal(info.nextTriangleOffset, null); assert.equal(info.vertices[0]!.index, 1); assert.equal(info.triangles[0]!.index, 1); assert.equal(info.relatedDeformTracks, 2); assert.equal(info.linkedMeshCount, 2);
  close(info.vertices[0]!.world!, sample(source, inherited, 0).world.slice(2, 4)); assert.deepEqual(source, snapshot);
});
test('inspection reports topology defects and malformed coordinate-index manual edges', () => {
  const source = fixture(), mesh = record(source); mesh.triangles = [0, 1, 2, 0, 1, 2, 0, 0, 1]; mesh.edges = [0, 3];
  const info = inspectMesh(source, ref); assert.equal(info.refinable, false); assert.equal(info.issues.duplicateTriangles.count, 1); assert.equal(info.issues.repeatedVertexTriangles.count, 1); assert.equal(info.issues.unusedVertices.count, 1); assert.ok(info.issues.nonManifoldEdges.count > 0); assert.equal(info.issues.invalidManualEdges.count, 1);
});
test('inspection marks inactive geometry unavailable and rejects invalid pages', () => {
  const source = fixture(); source.bones[1]!.skin = true;
  const info = inspectMesh(source, ref); assert.equal(info.setupGeometryAvailable, false); assert.equal(info.vertices[0]!.world, null);
  assert.throws(() => inspectMesh(source, ref, { offset: 5 }), /pages/); assert.throws(() => inspectMesh(source, ref, { triangleOffset: 3 }), /pages/); assert.throws(() => inspectMesh(source, ref, { limit: 0 }), /pages/);
});
for (const weighted of [false, true]) test(`${weighted ? 'weighted' : 'unweighted'} vertex transform follows slot-local affine geometry and deform vectors`, () => {
  const source = fixture(weighted, false), snapshot = structuredClone(source), output = transformMesh(source, ref, { x: 7, y: -5, rotation: 31, scaleX: -0.8, scaleY: 1.3, pivotX: 40, pivotY: 2 }, [1, 2]);
  for (const time of [0, 0.2, 0.5, 0.8, 1]) {
    const a = sample(source, ref, time), b = sample(output, ref, time), p = a.slot.bone.appliedPose, det = p.a * p.d - p.b * p.c;
    const expected = [...a.world];
    for (const index of [1, 2]) {
      const wx = a.world[index * 2]! - p.worldX, wy = a.world[index * 2 + 1]! - p.worldY;
      const [x, y] = affineLocal((p.d * wx - p.b * wy) / det, (p.a * wy - p.c * wx) / det);
      expected[index * 2] = p.a * x! + p.b * y! + p.worldX; expected[index * 2 + 1] = p.c * x! + p.d * y! + p.worldY;
    }
    close(b.world, expected);
  }
  assert.deepEqual(record(output).uvs, record(source).uvs); assert.deepEqual(record(output).triangles, record(source).triangles); assert.deepEqual(record(output).sequence, record(source).sequence);
  assert.deepEqual(source, snapshot);
  const oldTracks = attachmentTracks(source, source.animations!.bend!), newTracks = attachmentTracks(output, output.animations!.bend!);
  for (const track of oldTracks) assert.deepEqual(newTracks.find(item => item.name === track.name && item.channel === track.channel)!.frames.map(key => [key.time, key.curve]), track.frames.map(key => [key.time, key.curve]));
});
test('shared unweighted transform updates independent-link deforms and inherited geometry', () => {
  const source = fixture(false, false), output = transformMesh(source, ref, { scaleY: 2 }, [1]);
  for (const selected of [ref, inherited, own]) for (const time of [0, 0.5, 1]) {
    const a = sample(source, selected, time), b = sample(output, selected, time), p = a.slot.bone.appliedPose, det = p.a * p.d - p.b * p.c, expected = [...a.world];
    const wx = a.world[2]! - p.worldX, wy = a.world[3]! - p.worldY, x = (p.d * wx - p.b * wy) / det, y = (p.a * wy - p.c * wx) / det * 2;
    expected[2] = p.a * x + p.b * y + p.worldX; expected[3] = p.c * x + p.d * y + p.worldY; close(b.world, expected);
  }
});
test('translation does not translate deformation offsets, and transformDeform=false retains original keys', () => {
  const source = fixture(), translated = transformMesh(source, ref, { x: 11, y: -7 }), unchangedOffsets = transformMesh(source, ref, { scaleY: 2 }, undefined, false);
  assert.deepEqual(translated.animations, source.animations); assert.deepEqual(unchangedOffsets.animations, source.animations); assert.notDeepEqual(record(unchangedOffsets).vertices, record(source).vertices);
});
test('mesh transform rejects linked targets, invalid selections, singular or inactive weighted bones and overflow', () => {
  const source = fixture(true);
  assert.throws(() => transformMesh(source, inherited, {}), /unlink_mesh/);
  for (const vertices of [[], [0, 0], [-1], [4], [1.5]]) assert.throws(() => transformMesh(source, ref, {}, vertices), /distinct valid/);
  assert.throws(() => transformMesh(source, ref, { x: Infinity }), /finite/);
  assert.throws(() => transformMesh(source, ref, { rotation: Number.MAX_VALUE }), /invalid|non-finite/);
  const singular = structuredClone(source); singular.bones[2]!.scaleX = 0; assert.throws(() => transformMesh(singular, ref, { x: 1 }), /nonsingular/);
  const inactive = structuredClone(source); inactive.bones[2]!.skin = true; assert.throws(() => transformMesh(inactive, ref, { x: 1 }), /active/);
});
for (const weighted of [false, true]) for (const iterations of [1, 2]) test(`${weighted ? 'weighted' : 'unweighted'} refinement ${iterations} preserves animated surface, linked deforms and sequences`, () => {
  const source = fixture(weighted), snapshot = structuredClone(source), output = refineMesh(source, ref, iterations), info = inspectMesh(output, ref);
  assert.equal(info.triangleCount, 2 * 4 ** iterations); assert.equal(info.hullVertices, 4 * 2 ** iterations); assert.equal(info.vertexCount, (2 ** iterations + 1) ** 2); assert.equal(info.refinable, true);
  for (const selected of [ref, inherited, own]) sameSurface(source, output, selected);
  assert.deepEqual(record(output).sequence, record(source).sequence); assert.equal(record(output).path, 'arm'); assert.equal(record(output).color, 'aabbccdd'); assert.deepEqual(source, snapshot);
});
test('refinement preserves source/independent-link curve times and changes only related geometry tracks', () => {
  let source = fixture(true); const spare = { skin: 'base', slot: 'unrelated', name: 'spare' };
  source.slots!.push({ name: spare.slot, bone: 'root' });
  source = setAttachment(source, spare.skin, spare.slot, spare.name, { ...record(source), name: 'base/spare' }, false, true);
  source = setAttachmentTimeline(source, 'bend', spare.skin, spare.slot, spare.name, 'deform', [{ time: 0 }, { time: 1, offset: 1, vertices: [5, -2, 7] }]);
  const output = refineMesh(transformMesh(source, ref, { scaleY: 1.2 }, [1, 2]), ref), a = attachmentTracks(source, source.animations!.bend!), b = attachmentTracks(output, output.animations!.bend!);
  assert.equal(a.length, b.length);
  for (const track of a) {
    const next = b.find(item => item.name === track.name && item.channel === track.channel)!;
    if (track.channel === 'sequence') assert.deepEqual(normalizedAttachmentKeys(next), normalizedAttachmentKeys(track));
    else assert.deepEqual(next.frames.map(key => [key.time, key.curve]), track.frames.map(key => [key.time, key.curve]));
  }
  assert.deepEqual(output.animations!.bend!.bones, source.animations!.bend!.bones); assert.equal(record(output, inherited).source, ref.name); assert.equal(record(output, own).timelines, false);
  assert.deepEqual(record(output, spare), record(source, spare));
  assert.deepEqual(b.find(track => track.name === spare.name), a.find(track => track.name === spare.name));
  for (const time of [0, 0.5, 1]) close(sample(output, spare, time).world, sample(source, spare, time).world);
});
test('refinement checks hull, UV degeneracy, manual edge layout and linked-target ambiguity', () => {
  const source = fixture(); assert.throws(() => refineMesh(source, inherited), /unlink_mesh/);
  for (const change of [(data: SpineDocument) => { record(data).hull = 3; }, (data: SpineDocument) => { record(data).uvs = [0, 0, 0, 0, 1, 0, 1, 1]; }, (data: SpineDocument) => { record(data).edges = [0, 3]; }]) {
    const invalid = structuredClone(source); change(invalid); assert.throws(() => refineMesh(invalid, ref), /topology first/);
  }
  assert.throws(() => refineMesh(source, ref, 0), /1–3/); assert.throws(() => refineMesh(source, ref, 4), /1–3/);
});
test('refinement rejects midpoint influence overflow without pruning or mutating source', () => {
  let source = fixture(); source.animations = {};
  for (let index = 0; index < 32; index++) source.bones.push({ name: `extra-${index}`, parent: 'root' });
  source = setWeights(source, ref.skin, ref.slot, ref.name, Array.from({ length: 4 }, (_, vertex) => Array.from({ length: 16 }, (_, bone) => ({ bone: `extra-${bone + (vertex % 2) * 16}`, weight: 1 / 16 }))));
  const snapshot = structuredClone(source); assert.throws(() => refineMesh(source, ref), /more than 16/); assert.deepEqual(source, snapshot);
});
test('subdivision refuses excessive vertex and deformation work before publishing any data', () => {
  const gridSource = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'visual' }], skins: [{ name: 'base', attachments: { art: { visual: { width: 120, height: 24 } } } }], animations: {} });
  assert.throws(() => refineMesh(meshFromRegion(gridSource, ref.skin, ref.slot, ref.name, 64, 64), ref), /10,000 vertices/);
  let source = fixture(); source.animations = {};
  source = setWeights(source, ref.skin, ref.slot, ref.name, Array.from({ length: 4 }, () => [{ bone: 'z-source', weight: 0.7 }, { bone: 'a-tip', weight: 0.3 }]));
  source = setAttachmentTimeline(source, 'bend', ref.skin, ref.slot, ref.name, 'deform', Array.from({ length: 10000 }, (_, index) => ({ time: index / 1000 })));
  const snapshot = structuredClone(source); assert.throws(() => refineMesh(source, ref, 3), /5,000,000/); assert.deepEqual(source, snapshot);
});
test('ordered editing exposes selection/defaults and combines refinement with transformed independent geometry', async () => {
  const source = fixture(true), edits = [{ type: 'refine_mesh', ...ref }, { type: 'unlink_mesh', ...own }, { type: 'transform_mesh', ...own, transform: { y: 2 }, vertices: [0, 1] }].map(raw => editSchema.parse(raw));
  assert.equal(edits[0]!.type, 'refine_mesh'); const output = await applyEdits(source, edits);
  assert.equal(inspectMesh(output, ref).vertexCount, 9); assert.equal(record(output, own).source, undefined); assert.notDeepEqual(record(output).vertices, record(output, own).vertices);
  sameSurface(source, output, ref);
});
