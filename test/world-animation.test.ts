import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from '../src/document.js';
import { worldMirror, retargetAnimation, planRetarget, bakeAllConstraints, bakingTimes, coalesceBakingTimes } from '../src/world-animation.js';
import { matrix, skeletonState, stateDifference } from '../src/animation-baking.js';
import { sampleSkeleton } from '../src/runtime.js';
import { setConstraint } from '../src/constraint-edits.js';

function rig() { return parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm_L', parent: 'root', x: 10, length: 10 }, { name: 'arm_R', parent: 'root', x: -10, length: 10 }], slots: [{ name: 'art', bone: 'arm_L', attachment: 'region' }], skins: [{ name: 'default', attachments: { art: { region: { width: 10, height: 4, x: 5 } } } }], animations: { move: { bones: { root: { translate: [{ time: 0 }, { time: 1, x: 5 }] }, arm_L: { rotate: [{ time: 0 }, { time: 1, value: 90 }] }, arm_R: { translate: [{ time: 0 }, { time: 1, y: 3 }] } } } } }); }
const near = (a: number, b: number, epsilon = 0.001) => assert.ok(Math.abs(a - b) < epsilon, `${a} vs ${b}`);
test('world mirror reflects complete world bone matrices and artwork around a pivot', () => {
  const data = rig(), original = JSON.stringify(data), result = worldMirror(data, 'move', 'mirrored', { axis: 'x', pivotX: 4, fps: 10 });
  for (const time of [0, 0.2, 0.7, 1]) { const a = sampleSkeleton(data, 'move', time), b = sampleSkeleton(result.data, 'mirrored', time); for (let i = 0; i < a.bones.length; i++) { const p = a.bones[i]!.appliedPose, q = b.bones[i]!.appliedPose; near(q.worldX, 8 - p.worldX); near(q.worldY, p.worldY); near(q.a, -p.a); near(q.b, -p.b); near(q.c, p.c); near(q.d, p.d); } }
  assert.equal(JSON.stringify(data), original); assert.deepEqual(result.data.animations!.move, data.animations!.move);
});
test('world mirror swaps named left/right bones before solving their target parents', () => {
  const data = rig(), result = worldMirror(data, 'move', 'swapped', { axis: 'x', swapSides: true, fps: 10 });
  assert.equal(result.report.mapping.arm_L, 'arm_R'); const a = sampleSkeleton(data, 'move', 0.5), b = sampleSkeleton(result.data, 'swapped', 0.5); near(b.bones[2]!.appliedPose.worldX, -a.bones[1]!.appliedPose.worldX); near(b.bones[2]!.appliedPose.worldY, a.bones[1]!.appliedPose.worldY);
});
test('automatic retarget planning matches side spelling and reports ambiguous matches', () => {
  const source = rig(), target = rig(); target.bones[1]!.name = 'arm left'; target.slots![0]!.bone = 'arm left'; delete target.animations;
  const plan = planRetarget(source, target); assert.equal(plan.mapping.arm_L, 'arm left'); target.bones.push({ name: 'left arm', parent: 'root' }); assert.equal(planRetarget(source, target).ambiguous.length, 1);
});
test('retarget adapts setup proportions and root translation on a differently scaled rig', () => {
  const source = rig(), target = rig(); target.bones[1]!.x = 20; target.bones[1]!.length = 20; target.bones[2]!.x = -20; target.bones[2]!.length = 20; target.animations = {};
  const result = retargetAnimation(source, target, 'move', 'retargeted', { fps: 10 }); assert.equal(result.report.rootTranslationScale, 2);
  for (const time of [0, 0.2, 0.7, 1]) { const a = sampleSkeleton(source, 'move', time), b = sampleSkeleton(result.data, 'retargeted', time); for (let i = 0; i < a.bones.length; i++) { near(b.bones[i]!.appliedPose.worldX, a.bones[i]!.appliedPose.worldX * 2); near(b.bones[i]!.appliedPose.worldY, a.bones[i]!.appliedPose.worldY * 2); near(b.bones[i]!.appliedPose.getWorldRotationX(), a.bones[i]!.appliedPose.getWorldRotationX()); } }
});
test('retarget spans unmapped intermediate target bones and rejects reversed ancestry', () => {
  const source = rig(), target = rig(); target.bones.splice(1, 0, { name: 'helper', parent: 'root', x: 2 }); target.bones[2]!.parent = 'helper'; target.bones[2]!.x = 18; target.animations = {};
  const result = retargetAnimation(source, parseDocument(target), 'move', 'retargeted', { fps: 10, translationScale: 1 }); near(sampleSkeleton(result.data, 'retargeted', 0.5).bones[2]!.appliedPose.worldX, 22.5);
  assert.ok(planRetarget(source, target, { root: 'arm_L', arm_L: 'root' }, false).hierarchyConflicts.length); assert.throws(() => retargetAnimation(source, target, 'move', 'bad', { boneMap: { root: 'arm_L', arm_L: 'root' }, autoMap: false }), /ancestor/);
});
test('full constraint baking retains the rig and reproduces world poses in a separate animation', () => {
  const source = setConstraint(rig(), { type: 'ik', name: 'aim', bones: ['arm_L'], target: 'arm_R' }), original = JSON.stringify(source), result = bakeAllConstraints(source, 'move', 'baked', { fps: 10 });
  assert.equal(JSON.stringify(source), original); assert.deepEqual(result.data.constraints, source.constraints);
  for (const time of [0, 0.2, 0.7, 1]) near(stateDifference(skeletonState(sampleSkeleton(source, 'move', time)), skeletonState(sampleSkeleton(result.data, 'baked', time))), 0);
});
test('full baking omits inactive skin bone channels that native import would discard', () => {
  const source = rig(); source.bones.push({ name: 'optional', parent: 'root', skin: true });
  const baked = bakeAllConstraints(parseDocument(source), 'move', 'baked', { fps: 2 });
  assert.equal(Object.hasOwn(baked.data.animations!.baked!.bones as object, 'optional'), false);
});
test('baking zeros only actual transform property outputs for native 4.3 imports', () => {
  const source = setConstraint(rig(), { type: 'transform', name: 'drive', source: 'arm_R', bones: ['arm_L'], properties: { x: { to: { y: {} } } } }), result = bakeAllConstraints(source, 'move', 'baked', { fps: 2 });
  assert.deepEqual((result.data.animations!.baked!.transform as any).drive, [{ time: 0, mixY: 0 }]);
  for (const time of [0, 0.5, 1]) near(stateDifference(skeletonState(sampleSkeleton(source, 'move', time)), skeletonState(sampleSkeleton(result.data, 'baked', time))), 0);
});
test('baking coalesces binary/JSON float-time noise while retaining zero and final samples', () => {
  const source = rig(); (source.animations!.move!.bones as any).arm_L.rotate.splice(1, 0, { time: Math.fround(14 / 30), value: 20 }); source.animations!.move!.slots = { art: { rgba: [{ time: 0.4666667, color: 'ffffffff' }] } };
  const times = bakingTimes(source, 'move', 10); assert.equal(times.filter(time => Math.abs(time - 14 / 30) < 0.000001).length, 1); assert.equal(times[0], 0); assert.equal(times.at(-1), 1);
  assert.deepEqual(coalesceBakingTimes([0, 0.0000005, 1]), [0, 1]); assert.throws(() => coalesceBakingTimes([1, 1.0000008, 1.0000016]), /cluster/);
});
