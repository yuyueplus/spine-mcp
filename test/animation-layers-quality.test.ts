import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, setTimeline, type JsonObject } from '../src/document.js';
import { composeAnimation } from '../src/animation-layers.js';
import { compareAdaptive, simplifyAdaptive, checkPhysicsCycles } from '../src/animation-quality.js';
import { bakeAllConstraints } from '../src/world-animation.js';
import { selectiveBake } from '../src/production-quality.js';
import { sampleSkeleton } from '../src/runtime.js';
import { setConstraint } from '../src/constraint-edits.js';

function rig() { return parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', x: 5, length: 5 }], slots: [{ name: 'art', bone: 'arm', attachment: 'a' }], skins: [{ name: 'default', attachments: { art: { a: { width: 10, height: 4 }, b: { width: 5, height: 3 } } } }], events: { step: {} }, animations: { base: { bones: { root: { translate: [{ time: 0 }, { time: 1, x: 10 }] }, arm: { translate: [{ time: 0 }, { time: 1, y: 4 }] } }, slots: { art: { attachment: [{ time: 0, name: 'a' }] } } }, overlay: { bones: { root: { translate: [{ time: 0 }, { time: 1, x: 10 }] }, arm: { rotate: [{ time: 0 }, { time: 1, value: 90 }] } }, slots: { art: { attachment: [{ time: 0, name: 'b' }] } }, events: [{ time: 0.5, name: 'step' }] }, constant: { bones: { root: { translate: [{ time: 0, x: 10 }, { time: 1, x: 10 }] } } } } }); }
const near = (a: number, b: number, e = 0.005) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
test('layered override preserves channels outside a bone mask', () => {
  const data = rig(), original = JSON.stringify(data), result = composeAnimation(data, 'mixed', [{ animation: 'base' }, { animation: 'overlay', bones: ['arm'], weight: 0.5 }], { fps: 20 }), sample = sampleSkeleton(result.data, 'mixed', 0.5);
  near(sample.bones[0]!.appliedPose.worldX, 5); near(sample.bones[1]!.appliedPose.y, 2); near(sample.bones[1]!.appliedPose.rotation, 22.5); assert.equal(sample.slots[0]!.appliedPose.attachment!.name, 'a'); assert.equal(JSON.stringify(data), original);
});
test('additive layers and fade envelopes use the official timeline mixer', () => {
  const data = rig(), add = composeAnimation(data, 'add', [{ animation: 'base' }, { animation: 'overlay', bones: ['root'], mode: 'additive', weight: 0.5 }], { fps: 20 }); near(sampleSkeleton(add.data, 'add', 0.5).bones[0]!.appliedPose.x, 7.5);
  const fade = composeAnimation(data, 'fade', [{ animation: 'constant', fadeIn: 0.5, fadeOut: 0.5 }], { fps: 20 }); for (const time of [0, 0.25, 0.5, 0.75, 1]) near(sampleSkeleton(fade.data, 'fade', time).bones[0]!.appliedPose.x, 10 * Math.min(time * 2, (1 - time) * 2));
});
test('discrete layer threshold, loop events and fractional duration are explicit', () => {
  const data = rig(), low = composeAnimation(data, 'low', [{ animation: 'base' }, { animation: 'overlay', weight: 0.4 }], { fps: 10 }), high = composeAnimation(data, 'high', [{ animation: 'base' }, { animation: 'overlay', weight: 0.6 }], { fps: 10 });
  assert.equal(sampleSkeleton(low.data, 'low', 0.5).slots[0]!.appliedPose.attachment!.name, 'a'); assert.equal(sampleSkeleton(high.data, 'high', 0.5).slots[0]!.appliedPose.attachment!.name, 'b');
  const loop = composeAnimation(data, 'loop', [{ animation: 'overlay', loop: true, end: 2 }], { fps: 10 }); assert.deepEqual((loop.data.animations!.loop!.events as JsonObject[]).map(k => k.time), [0.5, 1.5]);
  const fractional = composeAnimation(data, 'fractional', [{ animation: 'constant', end: 1.2 }], { fps: 10 }); near(sampleSkeleton(fractional.data, 'fractional', 1.2).bones[0]!.appliedPose.x, 10);
});
test('layer validation rejects invalid masks, ranges and weights without mutating the source', () => {
  const data = rig(), original = JSON.stringify(data); for (const layer of [{ animation: 'missing' }, { animation: 'base', bones: ['missing'] }, { animation: 'base', fadeIn: 2 }, { animation: 'base', weight: -1 }]) assert.throws(() => composeAnimation(data, 'bad', [layer], {})); assert.equal(JSON.stringify(data), original);
});
test('adaptive validation detects between-key Bezier peaks and reports a sample budget failure', () => {
  const data = setTimeline(rig(), 'curve', 'arm', 'rotate', [{ time: 0, value: 0, curve: [0.2, 200, 0.8, -200] }, { time: 1, value: 0 }]), zero = setTimeline(data, 'zero', 'arm', 'rotate', [{ time: 0, value: 0 }, { time: 1, value: 0 }]);
  const report = compareAdaptive(zero, 'curve', zero, 'zero', { tolerance: 0.001, maxSamples: 1000 }); assert.equal(report.withinTolerance, false); assert.ok(report.maxSampledError! > 0.1); assert.ok(report.samples > 3);
  const budget = compareAdaptive(data, 'base', data, 'base', { maxSamples: 5, minDepth: 3 }); assert.equal(budget.complete, false); assert.equal(budget.withinTolerance, false); assert.equal(budget.budgetExhausted, true);
});
test('identical discrete states pass adaptive comparison and numeric reduction is verified', () => {
  const data = rig(); (data.animations!.base!.slots as any).art.attachment.push({ time: 0.5, name: 'b' }); const report = compareAdaptive(data, 'base', data, 'base'); assert.equal(report.withinTolerance, true);
  const dense = setTimeline(data, 'dense', 'arm', 'rotate', Array.from({ length: 61 }, (_, i) => ({ time: i / 60, value: i }))), reduced = simplifyAdaptive(dense, 'dense', 'reduced', { tolerance: 0.001 }); assert.equal(reduced.report.adaptiveValidation.withinTolerance, true); assert.ok(reduced.report.removedKeys! > 0);
});
test('multi-cycle physics retains solver history and reports measured phase convergence', () => {
  const data = setConstraint(rig(), { type: 'physics', name: 'spring', bone: 'arm', x: 1, y: 1, rotate: 1, strength: 10, damping: 0.1, gravity: 1 }), report = checkPhysicsCycles(data, 'base', { fps: 30, warmupCycles: 0, checkedCycles: 3, tolerance: 1e-8 });
  assert.equal(report.simulatedCycles, 3); assert.equal(report.comparisons.length, 2); assert.ok(report.maxCycleDifference! > 0); assert.equal(report.converged, false);
  const stable = checkPhysicsCycles(rig(), 'base', { fps: 10, warmupCycles: 1, checkedCycles: 3 }); near(stable.maxCycleDifference!, 0); assert.equal(stable.converged, true);
});
test('full rig bake supports Slider sources that also animate slot colors', () => {
  const data = rig(); data.animations!.pose = { slots: { art: { rgba: [{ time: 0, color: 'ffffffff' }, { time: 1, color: 'ff0000ff' }] } } }; const constrained = setConstraint(data, { type: 'slider', name: 'tint', animation: 'pose', time: 0.5, mix: 1 });
  assert.throws(() => selectiveBake(constrained, 'base', 'old', ['slider/tint'], { fps: 10 }), /bone-only/);
  const result = bakeAllConstraints(constrained, 'base', 'baked', { fps: 10, tolerance: 0.01 }); for (const time of [0, 0.3, 1]) near(sampleSkeleton(result.data, 'baked', time).slots[0]!.appliedPose.color.g, sampleSkeleton(constrained, 'base', time).slots[0]!.appliedPose.color.g);
});
