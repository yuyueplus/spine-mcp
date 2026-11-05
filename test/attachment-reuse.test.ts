import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshAttachment, RegionAttachment, VertexAttachment } from '@esotericsoftware/spine-core';
import { copyAttachment, linkMesh, unlinkMesh, type AttachmentRef } from '../src/attachment-reuse.js';
import { attachmentEntries, attachmentTracks } from '../src/attachment-data.js';
import { setAttachment, setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { parseDocument, type SpineDocument } from '../src/document.js';
import { sampleSkeleton } from '../src/runtime.js';
import { addSkin } from '../src/slot-edits.js';
import { setConstraint, setSkinMembers } from '../src/constraint-edits.js';
import { applyEdits, editSchema } from '../src/edits.js';

const from = { skin: 'default', slot: 'art', name: 'visual' };
const to = { skin: 'default', slot: 'target', name: 'copied' };
const same = { skin: 'default', slot: 'same', name: 'linked' };
function region(): SpineDocument {
  return parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root', x: 7, y: -9, rotation: 17, shearY: 13 }, { name: 'source', parent: 'root', x: 25, y: 4, rotation: 11, scaleX: 1.2, scaleY: 0.8 }, { name: 'target', parent: 'root', x: -30, y: 20, rotation: -23, scaleX: -0.9, scaleY: 1.35, shearX: 9 }], slots: [{ name: 'art', bone: 'source', attachment: 'visual' }, { name: 'same', bone: 'source' }, { name: 'target', bone: 'target' }, { name: 'spare', bone: 'source' }], skins: [{ name: 'default', attachments: { art: { visual: { path: 'arm', width: 120, height: 24, x: 60, y: 12, rotation: 27, scaleX: -0.9, scaleY: 1.2, color: 'aabbccdd' } } } }], animations: {} });
}
function mesh(weighted = false): SpineDocument {
  let data = setAttachment(region(), 'default', 'art', 'visual', { type: 'mesh', path: 'arm', width: 120, height: 24, color: 'aabbccdd', uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, -12, 0, 12, 120, 12, 120, -12], triangles: [0, 1, 2, 0, 2, 3], hull: 4 }, true, true);
  if (weighted) data = setWeights(data, 'default', 'art', 'visual', Array.from({ length: 4 }, () => [{ bone: 'source', weight: 0.7 }, { bone: 'target', weight: 0.3 }]));
  return setAttachmentTimeline(data, 'bend', 'default', 'art', 'visual', 'deform', [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, offset: 3, vertices: [11, -3, 13] }]);
}
function value(data: SpineDocument, ref: AttachmentRef) { return attachmentEntries(data).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name)!.value; }
function geometry(data: SpineDocument, ref: AttachmentRef, time = 0, animation = 'bend') {
  const skeleton = sampleSkeleton(data, Object.hasOwn(data.animations ?? {}, animation) ? animation : undefined, time, ref.skin), slot = skeleton.slots.find(item => item.data.name === ref.slot)!, attachment = skeleton.data.findSkin(ref.skin)!.getAttachment(slot.data.index, ref.name);
  if (attachment instanceof RegionAttachment) { const values = new Array<number>(8); attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), values, 0, 2); return values; }
  const vertex = attachment as VertexAttachment, values = new Array<number>(vertex.worldVerticesLength); vertex.computeWorldVertices(skeleton, slot, 0, values.length, values, 0, 2); return values;
}
function close(a: number[], b: number[]) { assert.equal(a.length, b.length); assert.ok(a.every((value, index) => Math.abs(value - b[index]!) < 0.0001), JSON.stringify({ a, b })); }
function channels(data: SpineDocument, ref: AttachmentRef, animation = 'bend') { return (data.animations?.[animation]?.attachments as any)?.[ref.skin]?.[ref.slot]?.[ref.name]; }

test('same-bone region copy preserves region type, image path, tint and source data', () => {
  const source = region(), snapshot = structuredClone(source), target = { ...same, name: 'region-copy' }, output = copyAttachment(source, from, target, { setAsSetup: true });
  assert.equal(value(output, target).type, undefined); assert.equal(value(output, target).path, 'arm'); assert.equal(value(output, target).color, 'aabbccdd'); close(geometry(source, from), geometry(output, target)); assert.deepEqual(source, snapshot);
});
test('cross-bone region copy becomes a four-vertex mesh and preserves sheared/reflected setup corners', () => {
  const source = region(), output = copyAttachment(source, from, to, { setAsSetup: true });
  assert.equal(value(output, to).type, 'mesh'); assert.equal(value(output, to).hull, 4); close(geometry(source, from), geometry(output, to));
  const local = copyAttachment(source, from, to, { preserveWorld: false }); assert.equal(value(local, to).type, undefined); assert.equal(value(local, to).x, 60);
});
test('unweighted copy transforms sparse odd-offset deformation vectors and preserves curve motion', () => {
  const source = mesh(), output = copyAttachment(source, from, to, { setAsSetup: true });
  for (const time of [0, 0.2, 0.5, 0.8, 1]) close(geometry(source, from, time), geometry(output, to, time));
  assert.deepEqual(channels(output, to).deform[0].curve, [0.2, 0, 0.8, 1]);
});
test('weighted copy retains influence layout, weights and animated deformation', () => {
  const source = mesh(true), output = copyAttachment(source, from, to, { setAsSetup: true });
  for (const time of [0, 0.25, 0.5, 1]) close(geometry(source, from, time), geometry(output, to, time));
  assert.equal((value(output, to).vertices as number[])[0], 2);
});
test('copy between skins rebases weighted bind points when skin constraints change bone poses', () => {
  let source = mesh(true); source = addSkin(source, 'variant');
  source = setConstraint(source, { type: 'transform', name: 'skin-follow', bones: ['source'], source: 'target', skin: true, properties: { x: { to: { x: {} } }, y: { to: { y: {} } } } });
  source = setSkinMembers(source, 'variant', undefined, ['skin-follow']);
  const target = { ...to, skin: 'variant' }, output = copyAttachment(source, from, target, { setAsSetup: true }); close(geometry(source, from), geometry(output, target));
  assert.equal(value(output, target).name, 'variant/copied');
});
test('sequence region copy preserves resolved frame indices after cross-bone mesh conversion', () => {
  const source = region(); value(source, from).sequence = { count: 3, start: 1, digits: 0, setup: 0 };
  const animated = setAttachmentTimeline(source, 'cycle', from.skin, from.slot, from.name, 'sequence', [{ time: 0, mode: 'loop', delay: 0.25 }]), output = copyAttachment(animated, from, to, { setAsSetup: true });
  for (const time of [0, 0.25, 0.5, 1.25]) {
    const index = (data: SpineDocument, ref: AttachmentRef) => { const skeleton = sampleSkeleton(data, 'cycle', time, ref.skin), slot = skeleton.slots.find(item => item.data.name === ref.slot)!, attachment = slot.appliedPose.attachment as RegionAttachment | MeshAttachment; return attachment.sequence.resolveIndex(slot.appliedPose); };
    assert.equal(index(animated, from), index(output, to)); close(geometry(animated, from, time, 'cycle'), geometry(output, to, time, 'cycle'));
  }
});
test('copyTimelines=false omits attachment channels while keeping source animation untouched', () => {
  const source = mesh(), output = copyAttachment(source, from, to, { copyTimelines: false }); assert.equal(channels(output, to), undefined); assert.deepEqual(channels(output, from), channels(source, from));
});
test('linked creation explicitly names a non-default source and inherits deform timelines across slots', () => {
  const source = mesh(); (source.skins as any[])[0].name = 'base'; source.animations!.bend!.attachments = { base: (source.animations!.bend!.attachments as any).default };
  const a = { ...from, skin: 'base' }, b = { ...same, skin: 'base' }, output = linkMesh(source, a, b, { setAsSetup: true });
  assert.equal(value(output, b).skin, 'base'); assert.equal(value(output, b).slot, 'art'); assert.equal(value(output, b).source, 'visual');
  for (const time of [0, 0.25, 0.5, 1]) close(geometry(source, a, time), geometry(output, b, time));
});
test('independent linked channels can be copied and edited without replacing source keys', () => {
  const source = mesh(), output = linkMesh(source, from, same, { inheritTimelines: false, copyTimelines: true, setAsSetup: true });
  for (const time of [0, 0.5, 1]) close(geometry(source, from, time), geometry(output, same, time));
  channels(output, same).deform[1].vertices[0] = 99; assert.equal(channels(output, from).deform[1].vertices[0], 11);
});
test('world-preserving links reject unweighted placement changes but support shared weighted geometry', () => {
  assert.throws(() => linkMesh(mesh(), from, to, { preserveWorld: true }), /independent copy/);
  assert.doesNotThrow(() => linkMesh(mesh(), from, to));
  assert.doesNotThrow(() => linkMesh(mesh(true), from, to, { preserveWorld: true }));
  assert.throws(() => linkMesh(region(), from, to), /non-linked source mesh/);
  assert.throws(() => linkMesh(mesh(), from, same, { copyTimelines: true }), /inheritTimelines=false/);
});
for (const weighted of [false, true]) test(`unlink preserves inherited ${weighted ? 'weighted' : 'unweighted'} geometry, deformation curves and other links`, () => {
  let source = linkMesh(mesh(weighted), from, same, { setAsSetup: true }); const other = { skin: 'default', slot: 'spare', name: 'other-link' }; source = linkMesh(source, from, other, { setAsSetup: true });
  value(source, same).path = 'alternate'; value(source, same).color = '6699ccff'; const snapshot = structuredClone(source), output = unlinkMesh(source, same);
  assert.equal(value(output, same).source, undefined); assert.equal(value(output, same).path, 'alternate'); assert.equal(value(output, same).color, '6699ccff'); assert.ok(value(output, other).source);
  for (const time of [0, 0.2, 0.5, 0.8, 1]) { close(geometry(source, same, time), geometry(output, same, time)); close(geometry(source, other, time), geometry(output, other, time)); }
  assert.deepEqual(source, snapshot); assert.deepEqual(channels(output, same).deform, channels(source, from).deform);
});
test('unlink keeps independent own channels, or explicitly clears only the selected attachment', () => {
  let source = linkMesh(mesh(), from, same, { inheritTimelines: false, copyTimelines: true, setAsSetup: true });
  source = setAttachmentTimeline(source, 'bend', same.skin, same.slot, same.name, 'deform', [{ time: 0 }, { time: 1, vertices: [9, 8] }]);
  const output = unlinkMesh(source, same); assert.deepEqual(channels(output, same), channels(source, same));
  const cleared = unlinkMesh(source, same, false); assert.equal(channels(cleared, same), undefined); assert.deepEqual(channels(cleared, from), channels(source, from));
});
test('unlink replaces ignored own channels with the effective inherited animation', () => {
  const linked = linkMesh(mesh(), from, same, { setAsSetup: true }), source = setAttachmentTimeline(linked, 'bend', same.skin, same.slot, same.name, 'deform', [{ time: 0, vertices: [-9, -8] }]);
  const output = unlinkMesh(source, same); assert.deepEqual(channels(output, same), channels(source, from)); close(geometry(source, same, 0.5), geometry(output, same, 0.5));
});
test('unlink materializes effective sequence keys, omits them for static links and guards count mismatch', () => {
  let source = mesh(); value(source, from).sequence = { count: 3, setup: 0 };
  source = setAttachmentTimeline(source, 'cycle', from.skin, from.slot, from.name, 'sequence', [{ time: 0, mode: 'hold', index: 2 }]);
  const linked = linkMesh(source, from, same, { setAsSetup: true });
  assert.deepEqual(channels(unlinkMesh(linked, same), same, 'cycle'), channels(linked, from, 'cycle'));
  const staticLink = structuredClone(linked); delete value(staticLink, same).sequence;
  assert.equal(channels(unlinkMesh(staticLink, same), same, 'cycle'), undefined);
  const mismatch = structuredClone(linked); value(mismatch, same).sequence = { count: 2 };
  assert.throws(() => unlinkMesh(mismatch, same), /matching source\/target sequence counts/);
  assert.doesNotThrow(() => unlinkMesh(mismatch, same, false));
});
test('copying a linked mesh materializes its effective channels without preserving the link', () => {
  const source = linkMesh(mesh(true), from, same, { setAsSetup: true }), output = copyAttachment(source, same, to, { setAsSetup: true });
  assert.equal(value(output, to).source, undefined);
  for (const time of [0, 0.5, 1]) close(geometry(source, same, time), geometry(output, to, time));
});
test('polygon/path copy projects setup vertices while non-constant-speed path conversion is guarded', () => {
  for (const attachment of [
    { type: 'boundingbox', vertexCount: 3, vertices: [0, 0, 20, 0, 0, 20] },
    { type: 'clipping', vertexCount: 3, vertices: [0, 0, 20, 0, 0, 20], end: 'spare', convex: true },
    { type: 'path', vertexCount: 6, vertices: [-10, 0, 0, 0, 33, 0, 66, 0, 100, 0, 110, 0], lengths: [100], constantSpeed: true },
  ]) {
    const source = setAttachment(region(), from.skin, from.slot, from.name, attachment, true), output = copyAttachment(source, from, to, { setAsSetup: true }); close(geometry(source, from), geometry(output, to));
    if (attachment.type === 'path') { value(source, from).constantSpeed = false; assert.throws(() => copyAttachment(source, from, to), /Non-constant-speed/); assert.doesNotThrow(() => copyAttachment(source, from, to, { preserveWorld: false })); }
  }
});
test('point copy preserves setup-world position and direction under reflected target axes', () => {
  const source = setAttachment(region(), from.skin, from.slot, from.name, { type: 'point', x: 13, y: 21, rotation: 31 }, true), output = copyAttachment(source, from, to);
  const pose = (data: SpineDocument, ref: AttachmentRef) => { const skeleton = sampleSkeleton(data, undefined, 0, ref.skin), slot = skeleton.slots.find(slot => slot.data.name === ref.slot)!, record = value(data, ref), bone = slot.bone.appliedPose, r = Number(record.rotation) * Math.PI / 180, x = Number(record.x), y = Number(record.y), a = bone.a * Math.cos(r) + bone.b * Math.sin(r), b = bone.c * Math.cos(r) + bone.d * Math.sin(r); return [bone.a * x + bone.b * y + bone.worldX, bone.c * x + bone.d * y + bone.worldY, Math.atan2(b, a)]; };
  close(pose(source, from), pose(output, to));
});
test('copy/link guard occupied targets, default fallback collisions, singular transforms and link chains', () => {
  const source = mesh(), linked = linkMesh(source, from, same);
  assert.throws(() => copyAttachment(source, from, from), /differ/); assert.throws(() => linkMesh(linked, from, same), /already exists/); assert.throws(() => linkMesh(linked, same, to), /non-linked source/); assert.throws(() => unlinkMesh(source, from), /existing linked/);
  const variant = addSkin(source, 'variant'); assert.throws(() => copyAttachment(variant, from, { ...from, skin: 'variant' }), /Default attachment/);
  source.bones[2]!.scaleX = 0; assert.throws(() => copyAttachment(source, from, to), /nonsingular/);
});
test('ordered edit dispatch supports copy, create-link and detach without a CLI', async () => {
  const source = mesh(true), snapshot = structuredClone(source), output = await applyEdits(source, [
    { type: 'copy_attachment', from, to, setAsSetup: true },
    { type: 'link_mesh', from, to: same, setAsSetup: true },
    { type: 'unlink_mesh', ...same },
  ].map(raw => editSchema.parse(raw)));
  assert.equal(value(output, same).source, undefined); assert.equal(attachmentTracks(output, output.animations!.bend!).length, 3); assert.deepEqual(source, snapshot);
});
