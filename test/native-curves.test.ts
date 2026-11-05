import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from '../src/document.js';
import { verifyRoundTrip } from '../src/project-workflow.js';

const fixture = (frames: unknown[], channel = 'rotate') => parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], animations: { a: { bones: { root: { [channel]: frames } } } } });
test('native flat and near-flat Beziers normalize with a bounded reported value error', () => {
  for (const frames of [
    [{ time: 0, value: 2, curve: [0.3, 2, 0.7, 2] }, { time: 1, value: 2 }],
    [{ time: 0, value: -0.000008, curve: [0.3, -0.0000128333, 0.7, -0.0000026666] }, { time: 1, value: 0 }],
    [{ time: 0, value: 0.000026, curve: [0.3, 0.000031, 0.7, 0.0000221666] }, { time: 1, value: 0.000018 }],
  ]) {
    const a = fixture(frames), b = structuredClone(a); ((b.animations!.a!.bones as any).root.rotate[0]).curve = 'stepped';
    const r = verifyRoundTrip(a, b, 'same.json', 'same.json'); assert.equal(r.passed, true); assert.equal(r.nativeCurveNormalization!.segments, 1); assert.ok(r.nativeCurveNormalization!.maxPerComponentValueBound <= 0.00004);
  }
});
test('zero endpoints cannot conceal a material interior excursion', () => {
  const a = fixture([{ value: 0, curve: [0.3, 0.01, 0.7, -0.01] }, { time: 1, value: 0 }]), b = structuredClone(a);
  ((b.animations!.a!.bones as any).root.rotate[0]).curve = 'stepped';
  assert.throws(() => verifyRoundTrip(a, b, 'same.json', 'same.json'), /Curve differs/);
});
test('a constant axis can normalize independently; another axis must retain its nonconstant curve', () => {
  const a = fixture([{ x: 1, y: 0, curve: [0.3, 1, 0.7, 1, 0.2, 2, 0.8, 8] }, { time: 1, x: 1, y: 10 }], 'translate'), b = structuredClone(a);
  const key = (b.animations!.a!.bones as any).root.translate[0]; key.curve[1] += 0.000001;
  assert.equal(verifyRoundTrip(a, b, 'same.json', 'same.json').passed, true);
  key.curve[5] = 5; assert.throws(() => verifyRoundTrip(a, b, 'same.json', 'same.json'), /Curve differs/);
});
