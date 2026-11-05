import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, type SpineDocument } from '../src/document.js';
import { renameObject, deleteObject, reparentBone, setSlotOrder } from '../src/structure.js';
import { setDrawOrder } from '../src/animation-edits.js';
import { addSkin } from '../src/slot-edits.js';
import { decodeDrawOrder } from '../src/animation-data.js';
import { sampleSkeleton } from '../src/runtime.js';

function fixture(): SpineDocument {
  return { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', x: 15, y: 20, rotation: 20, length: 120 }, { name: 'tip', parent: 'arm', x: 120, length: 20 }, { name: 'other', parent: 'root', x: -15, y: -25, rotation: -35, scaleX: 1.5, scaleY: 0.75 }], slots: [{ name: 'art', bone: 'arm', attachment: 'image' }, { name: 'badge', bone: 'tip' }], skins: [{ name: 'default', attachments: { art: { image: { width: 120, height: 24 } } } }], animations: { wave: { bones: { arm: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 30 }] } }, slots: { art: { attachment: [{ name: 'image' }] } } } }, customMetadata: { preserve: 'arm' } };
}
test('bone and slot rename update known references without replacing arbitrary strings', () => {
  const source = fixture(), snapshot = JSON.stringify(source);
  let next = renameObject(source, { kind: 'bone', name: 'arm' }, 'upper-arm');
  assert.equal(next.bones.find(bone => bone.name === 'tip')!.parent, 'upper-arm');
  assert.equal(next.slots![0]!.bone, 'upper-arm'); assert.ok((next.animations!.wave!.bones as any)['upper-arm']);
  assert.equal((next.customMetadata as any).preserve, 'arm');
  next = renameObject(next, { kind: 'slot', name: 'art' }, 'main');
  assert.ok((next.skins as any)[0].attachments.main); assert.ok((next.animations!.wave!.slots as any).main);
  assert.equal(JSON.stringify(source), snapshot);
});
test('attachment placeholder rename preserves image paths and updates animation/setup references', () => {
  const next = renameObject(fixture(), { kind: 'attachment', skin: 'default', slot: 'art', name: 'image' }, 'new-image');
  assert.equal((next.skins as any)[0].attachments.art['new-image'].path, 'image');
  assert.equal((next.skins as any)[0].attachments.art['new-image'].name, 'new-image');
  assert.equal(next.slots![0]!.attachment, 'new-image');
  assert.equal((next.animations!.wave!.slots as any).art.attachment[0].name, 'new-image');
});
test('skin rename updates linked mesh and deform namespace references', () => {
  const input = fixture(); Object.assign((input.skins as any)[0].attachments.art.image, { type: 'mesh', uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, 0, 0, 24, 120, 24, 120, 0], triangles: [0, 1, 2, 0, 2, 3], hull: 4 });
  const source = addSkin(input, 'night', 'default', 'base');
  source.animations!.wave!.attachments = { night: { art: { image: { deform: [{ vertices: [0, 0] }] } } } };
  const next = renameObject(source, { kind: 'skin', name: 'night' }, 'dark');
  assert.ok((next.animations!.wave!.attachments as any).dark); assert.equal((next.animations!.wave!.attachments as any).night, undefined);
  assert.throws(() => renameObject(source, { kind: 'skin', name: 'base' }, 'default'), /reserved/);
});
test('reparenting preserves the complete setup world matrix including nonuniform scale', () => {
  const source = fixture(), before = sampleSkeleton(source, undefined, 0).bones.find(bone => bone.data.name === 'arm')!.appliedPose;
  const next = reparentBone(source, 'arm', 'other');
  assert.equal(next.bones.find(bone => bone.name === 'arm')!.parent, 'other');
  const after = sampleSkeleton(next, undefined, 0).bones.find(bone => bone.data.name === 'arm')!.appliedPose;
  for (const field of ['a', 'b', 'c', 'd', 'worldX', 'worldY'] as const) assert.ok(Math.abs(before[field] - after[field]) < 0.0001, field);
  assert.ok(next.bones.findIndex(bone => bone.name === 'other') < next.bones.findIndex(bone => bone.name === 'arm'));
  assert.throws(() => reparentBone(source, 'arm', 'tip'), /cycle/);
  assert.throws(() => reparentBone(source, 'root', 'other'), /root/);
});
test('bone reordering remaps weighted mesh indices while preserving bind coordinates', () => {
  const source = fixture();
  (source.skins as any)[0].attachments.art.mesh = { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], vertices: [1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 1, 3, 0, 0, 1] };
  const next = reparentBone(source, 'arm', 'other', false), vertices = (next.skins as any)[0].attachments.art.mesh.vertices;
  assert.equal(next.bones[vertices[1]]!.name, 'arm'); assert.equal(next.bones[vertices[6]]!.name, 'tip'); assert.equal(next.bones[vertices[11]]!.name, 'other');
});
test('setup slot reordering preserves each existing animated permutation', () => {
  const source = setDrawOrder(fixture(), 'wave', [{ time: 0, order: null }, { time: 1, order: ['badge', 'art'] }]);
  const next = setSlotOrder(source, ['badge', 'art']);
  assert.deepEqual(decodeDrawOrder(next, (next.animations!.wave!.drawOrder as any)[0]), ['art', 'badge']);
  assert.deepEqual(decodeDrawOrder(next, (next.animations!.wave!.drawOrder as any)[1]), ['badge', 'art']);
  assert.throws(() => setSlotOrder(source, ['art', 'art']), /every slot/);
});
test('cascade deletion removes child bones, slots, attachments and animation references', () => {
  const source = fixture();
  assert.throws(() => deleteObject(source, { kind: 'bone', name: 'arm' }), /dependencies/);
  const next = deleteObject(source, { kind: 'bone', name: 'arm' }, true);
  assert.deepEqual(next.bones.map(bone => bone.name), ['root', 'other']); assert.equal(next.slots!.length, 0);
  assert.equal((next.animations!.wave!.bones as any).arm, undefined); assert.equal((next.animations!.wave!.slots as any).art, undefined);
  assert.equal(parseDocument(next).bones.length, 2);
  assert.throws(() => deleteObject(source, { kind: 'bone', name: 'root' }, true), /root/);
});
test('deleting a slot rewrites draw-order keys and clears clipping end references', () => {
  const source = setDrawOrder(fixture(), 'wave', [{ time: 0, order: ['badge', 'art'] }, { time: 1, order: null }]);
  const next = deleteObject(source, { kind: 'slot', name: 'badge' }, true);
  assert.deepEqual(decodeDrawOrder(next, (next.animations!.wave!.drawOrder as any)[0]), ['art']);
  assert.equal(next.slots!.length, 1);
});
test('attachment deletion clears missing setup and keyed attachments but keeps other skins', () => {
  const source = fixture();
  assert.throws(() => deleteObject(source, { kind: 'attachment', skin: 'default', slot: 'art', name: 'image' }), /references/);
  const next = deleteObject(source, { kind: 'attachment', skin: 'default', slot: 'art', name: 'image' }, true);
  assert.equal(next.slots![0]!.attachment, undefined); assert.equal((next.animations!.wave!.slots as any).art.attachment[0].name, undefined);
});
