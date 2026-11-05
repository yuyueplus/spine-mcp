import test from 'node:test';
import assert from 'node:assert/strict';
import { cropAnimation, mergeAnimations, mirrorAnimation, bakeAnimation } from '../src/advanced-animation.js';
import { sampleSkeleton } from '../src/runtime.js';
import { setTimeline, type SpineDocument } from '../src/document.js';
import { setConstraint } from '../src/constraint-edits.js';
function fixture() { return setTimeline({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 100 }] } as SpineDocument, 'move', 'arm', 'rotate', [{ time: 0, value: 0, curve: [0.2, 0, 0.6, 90] }, { time: 1, value: 90 }]); }
const angle = (data: SpineDocument, name: string, time: number) => sampleSkeleton(data, name, time).bones[1]!.appliedPose.rotation;
test('crop samples Bezier boundaries and original poses without modifying the source', () => {
  const source = fixture(), before = JSON.stringify(source), cropped = cropAnimation(source, 'move', 'slice', 0.23, 0.83, 60);
  for (const time of [0, 0.1, 0.35, 0.6]) assert.ok(Math.abs(angle(source, 'move', time + 0.23) - angle(cropped, 'slice', time)) < 0.08);
  assert.equal(JSON.stringify(source), before);
  assert.throws(() => cropAnimation(source, 'move', 'move', 0, 1), /already exists/);
});
test('concatenation resets the clip boundary, retains source clips and refuses missing track sets', () => {
  const data = fixture(); data.animations!.second = { bones: { arm: { rotate: [{ time: 0, value: -30 }, { time: 1, value: 0 }] } } };
  const merged = mergeAnimations(data, ['move', 'second'], 'combined', 0, 30);
  assert.ok(Math.abs(angle(merged, 'combined', 1) + 30) < 1e-4);
  assert.ok(Math.abs(angle(merged, 'combined', 1.5) + 15) < 1e-4);
  assert.ok(Math.abs(angle(merged, 'combined', 0.9998) - angle(data, 'move', 0.9998)) < 0.1, 'first clip keeps its endpoint motion until the cut');
  data.animations!.empty = { events: [] };
  assert.throws(() => mergeAnimations(data, ['move', 'empty'], 'bad'), /zero-duration/);
  data.animations!.empty = { bones: { root: { rotate: [{ time: 0 }, { time: 1, value: 3 }] } } };
  assert.throws(() => mergeAnimations(data, ['move', 'empty'], 'bad'), /same stateful/);
});
test('local motion mirroring negates curve values and selects only requested bones', () => {
  const source = fixture(), mirrored = mirrorAnimation(source, 'move', 'reverse', 'x', ['arm']);
  for (const time of [0.1, 0.3, 0.8]) assert.ok(Math.abs(angle(source, 'move', time) + angle(mirrored, 'reverse', time)) < 1e-4);
});
test('IK baking removes constraints in an isolated variant and preserves sampled world geometry', () => {
  let source = fixture(); source.bones.push({ name: 'target', parent: 'root', x: 40, y: 70 });
  source = setConstraint(source, { type: 'ik', name: 'aim', bones: ['arm'], target: 'target' });
  const baked = bakeAnimation(source, 'move', 'baked', 30);
  assert.equal(baked.constraints, undefined); assert.deepEqual(Object.keys(baked.animations!), ['baked']);
  for (const time of [0, 0.5, 1]) {
    const a = sampleSkeleton(source, 'move', time).bones[1]!.appliedPose, b = sampleSkeleton(baked, 'baked', time).bones[1]!.appliedPose;
    for (const field of ['a', 'b', 'c', 'd', 'worldX', 'worldY'] as const) assert.ok(Math.abs(a[field] - b[field]) < 0.001, field);
  }
});
