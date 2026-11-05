import test from 'node:test';
import assert from 'node:assert/strict';
import { setConstraint, setConstraintTimeline, setSkinMembers } from '../src/constraint-edits.js';
import { setTimeline, type SpineDocument } from '../src/document.js';
import { samplePose } from '../src/preview.js';
import { sampleSkeleton } from '../src/runtime.js';
import { retimeAnimation } from '../src/animation-edits.js';
import { addSkin } from '../src/slot-edits.js';
import { renameObject, deleteObject } from '../src/structure.js';

function fixture(): SpineDocument { return { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 100 }, { name: 'target', parent: 'root', x: 60, y: 80 }], animations: {} }; }
test('one-bone IK reaches target direction and animated mix interpolates', () => {
  const source = fixture(), ik = setConstraint(source, { name: 'aim', type: 'ik', bones: ['arm'], target: 'target' });
  assert.equal(source.constraints, undefined);
  const expected = Math.atan2(80, 60) * 180 / Math.PI;
  assert.ok(Math.abs(samplePose(ik, undefined, 0)[1]!.rotation - expected) < 0.0001);
  const animated = setConstraintTimeline(ik, 'mix', 'aim', 'parameters', [{ time: 0, mix: 0 }, { time: 1, mix: 1 }]);
  assert.ok(Math.abs(samplePose(animated, 'mix', 0.5)[1]!.rotation - expected / 2) < 0.001);
  const retimed = retimeAnimation(animated, 'mix', 2, 0.25);
  assert.ok(Math.abs(samplePose(retimed, 'mix', 1.25)[1]!.rotation - expected / 2) < 0.001);
});
test('transform mapping follows source position with the 4.3 properties layout', () => {
  const data = setConstraint(fixture(), { name: 'follow', type: 'transform', bones: ['arm'], source: 'target', properties: { x: { to: { x: {} } }, y: { to: { y: {} } } } });
  const arm = samplePose(data, undefined, 0).find(bone => bone.name === 'arm')!;
  assert.ok(Math.abs(arm.x - 60) < 0.0001); assert.ok(Math.abs(arm.y - 80) < 0.0001);
});
test('constraint references, chain shape, mix ranges and curves are checked', () => {
  assert.throws(() => setConstraint(fixture(), { name: 'bad', type: 'ik', bones: ['arm'], target: 'missing' }), /missing bone/);
  assert.throws(() => setConstraint(fixture(), { name: 'bad', type: 'ik', bones: ['arm', 'target'], target: 'root' }), /chain/);
  const data = setConstraint(fixture(), { name: 'aim', type: 'ik', bones: ['arm'], target: 'target' });
  assert.throws(() => setConstraintTimeline(data, 'wave', 'aim', 'parameters', [{ time: 0, mix: 2 }]), /between/);
  assert.throws(() => setConstraintTimeline(data, 'wave', 'aim', 'parameters', [{ time: 0, mix: 0, curve: [0, 0, 1, 1] }, { time: 1, mix: 1 }]), /8/);
});
test('physics preview is deterministic, bounded and differs from disabled physics', () => {
  let data = setConstraint(fixture(), { name: 'spring', type: 'physics', bone: 'arm', rotate: 1, strength: 20, damping: 0.8, inertia: 1, gravity: 40, wind: 20 });
  data = setTimeline(data, 'move', 'root', 'translate', [{ time: 0, x: 0, y: 0 }, { time: 0.5, x: 80, y: 60 }, { time: 1, x: 0, y: 0 }]);
  const a = samplePose(data, 'move', 0.75, undefined, { physics: true }), b = samplePose(data, 'move', 0.75, undefined, { physics: true });
  assert.deepEqual(a, b); assert.ok(a.every(bone => Number.isFinite(bone.rotation)));
  assert.ok(Math.abs(a[1]!.rotation - samplePose(data, 'move', 0.75)[1]!.rotation) > 0.001);
  assert.throws(() => samplePose(data, 'move', 300, undefined, { physics: true }), /6000/);
});
test('skin membership and constraint renaming/deletion update all 4.3 namespaces', () => {
  let data = setConstraint(fixture(), { name: 'aim', type: 'ik', bones: ['arm'], target: 'target', skin: true });
  data = addSkin(data, 'active'); data = setSkinMembers(data, 'active', ['arm'], ['aim']);
  data = setConstraintTimeline(data, 'wave', 'aim', 'parameters', [{ time: 0, mix: 1 }]);
  data = renameObject(data, { kind: 'constraint', name: 'aim' }, 'look');
  assert.deepEqual((data.skins as any)[0].ik, ['look']); assert.ok((data.animations!.wave!.ik as any).look);
  assert.throws(() => deleteObject(data, { kind: 'constraint', name: 'look' }), /tracks/);
  const removed = deleteObject(data, { kind: 'constraint', name: 'look' }, true);
  assert.equal((removed.constraints as any[]).length, 0);
});
