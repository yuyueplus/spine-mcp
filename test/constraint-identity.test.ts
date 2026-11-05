import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, type SpineDocument, type JsonObject } from '../src/document.js';
import { setConstraint, setConstraintTimeline, setSkinMembers } from '../src/constraint-edits.js';
import { constraintList, constraintTypes } from '../src/constraint-data.js';
import { deleteObject, renameObject } from '../src/structure.js';
import { verifyRoundTrip } from '../src/project-workflow.js';
import { applyEdits } from '../src/edits.js';
import { sampleSkeleton } from '../src/runtime.js';

function fixture(): SpineDocument {
  return parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 100 }, { name: 'target', parent: 'root', x: 60, y: 80 }], slots: [{ name: 'path-slot', bone: 'root', attachment: 'curve' }], skins: [{ name: 'default', attachments: { 'path-slot': { curve: { type: 'path', vertexCount: 6, vertices: [-10, 0, 0, 0, 33, 0, 66, 0, 100, 0, 110, 0], lengths: [100] } } } }, { name: 'active', attachments: {} }], animations: { pose: {} }, constraints: [
    { type: 'ik', name: '控制', bones: ['arm'], target: 'target', mix: 0 },
    { type: 'transform', name: '控制', bones: ['arm'], source: 'target', mixRotate: 0, mixX: 0, mixY: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 },
    { type: 'path', name: '控制', bones: ['arm'], slot: 'path-slot', mixRotate: 0, mixX: 0, mixY: 0 },
    { type: 'physics', name: '控制', bone: 'arm', mix: 0 },
    { type: 'slider', name: '控制', animation: 'pose', mix: 0 },
  ] });
}

test('all five constraint types can share a name; same-type duplicates still fail', () => {
  const source = fixture(); assert.equal(constraintList(source).length, 5);
  assert.doesNotThrow(() => sampleSkeleton(source, undefined, 0));
  const changed = setConstraint(source, { name: '控制', type: 'ik', mix: 0.25 });
  assert.equal(constraintList(changed).length, 5);
  assert.equal(constraintList(changed)[0]!.mix, 0.25);
  assert.equal(constraintList(changed)[4]!.mix, 0);
  assert.throws(() => parseDocument({ ...source, constraints: [...constraintList(source), constraintList(source)[0]] }), /Duplicate ik/);
});

test('timeline and skin selectors require a type only for ambiguous names', async () => {
  const source = fixture();
  assert.throws(() => setConstraintTimeline(source, 'motion', '控制', 'parameters', [{ time: 0 }]), /Ambiguous.*constraintType/);
  assert.throws(() => setSkinMembers(source, 'active', undefined, ['控制']), /Ambiguous/);
  assert.throws(() => setConstraintTimeline(source, 'motion', '', 'mix', [{ time: 0 }], 'slider'), /global physics/);
  const typed = await applyEdits(source, [
    { type: 'set_constraint_timeline', animation: 'motion', constraint: '控制', constraintType: 'ik', channel: 'parameters', keyframes: [{ time: 0, mix: 0.5 }] },
    { type: 'set_constraint_timeline', animation: 'motion', constraint: '控制', constraintType: 'slider', channel: 'mix', keyframes: [{ time: 0, value: 0.25 }] },
    { type: 'set_skin_members', skin: 'active', constraints: constraintTypes.map(type => ({ name: '控制', type })) },
  ]);
  assert.deepEqual((typed.animations!.motion!.ik as JsonObject)['控制'], [{ time: 0, mix: 0.5 }]);
  for (const type of constraintTypes) assert.deepEqual((typed.skins as JsonObject[])[1]![type], ['控制']);
  assert.throws(() => setSkinMembers(typed, 'active', undefined, [{ name: '控制', type: 'ik' }, { name: '控制', type: 'ik' }]), /Duplicate/);
});

test('scoped rename/delete preserve other same-name constraints, tracks and memberships', () => {
  let source = setSkinMembers(fixture(), 'active', undefined, [{ name: '控制', type: 'ik' }, { name: '控制', type: 'slider' }]);
  source = setConstraintTimeline(source, 'motion', '控制', 'parameters', [{ time: 0 }], 'ik');
  source = setConstraintTimeline(source, 'motion', '控制', 'mix', [{ time: 0 }], 'slider');
  assert.throws(() => renameObject(source, { kind: 'constraint', name: '控制' }, 'look'), /Ambiguous/);
  assert.throws(() => deleteObject(source, { kind: 'constraint', name: '控制' }, true), /Ambiguous/);
  const renamed = renameObject(source, { kind: 'constraint', name: '控制', constraintType: 'ik' }, 'look');
  assert.deepEqual((renamed.skins as JsonObject[])[1]!.ik, ['look']);
  assert.deepEqual((renamed.skins as JsonObject[])[1]!.slider, ['控制']);
  assert.ok((renamed.animations!.motion!.slider as JsonObject)['控制']);
  const removed = deleteObject(renamed, { kind: 'constraint', name: 'look', constraintType: 'ik' }, true);
  assert.equal(constraintList(removed).length, 4);
  assert.ok((removed.animations!.motion!.slider as JsonObject)['控制']);
  assert.equal(constraintList(source)[0]!.name, '控制');
});

test('cascading animation, bone and slot deletion removes only the linked constraint type', () => {
  const source = fixture();
  const noPose = deleteObject(source, { kind: 'animation', name: 'pose' }, true);
  assert.deepEqual(constraintList(noPose).map(item => item.type), ['ik', 'transform', 'path', 'physics']);
  const noPath = deleteObject(source, { kind: 'slot', name: 'path-slot' }, true);
  assert.deepEqual(constraintList(noPath).map(item => item.type), ['ik', 'transform', 'physics', 'slider']);
  const noTarget = deleteObject(source, { kind: 'bone', name: 'target' }, true);
  assert.deepEqual(constraintList(noTarget).map(item => item.type), ['path', 'physics', 'slider']);
});

test('round-trip checks distinguish same-name definitions and execution order', () => {
  const source = fixture(); assert.equal(verifyRoundTrip(source, source, 'a.json', 'a.json').passed, true);
  const reordered = structuredClone(source), list = constraintList(reordered); [list[0], list[1]] = [list[1]!, list[0]!]; reordered.constraints = list;
  assert.throws(() => verifyRoundTrip(source, reordered, 'a.json', 'a.json'), /execution order/);
  const changed = structuredClone(source); constraintList(changed)[4]!.time = 0.5;
  assert.throws(() => verifyRoundTrip(source, changed, 'a.json', 'a.json'), /definition differs/);
});
