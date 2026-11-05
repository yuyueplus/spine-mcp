import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaSampleTimes } from '../src/media-sampling.js';

test('native rounded run duration produces 20 distinct CFR samples without a terminal hold', () => {
  for (const end of [20 / 30, 0.6666667, 0.66666665]) {
    const times = mediaSampleTimes(0, end, 30);
    assert.equal(times.length, 20);
    for (let i = 0; i < times.length; i++) assert.equal(times[i], i / 30);
    assert.ok(times.at(-1)! < end);
  }
});
test('explicit endpoint inclusion coalesces native rounding noise and retains requested end', () => {
  const times = mediaSampleTimes(0, 0.6666667, 30, false);
  assert.equal(times.length, 21); assert.equal(times.at(-1), 0.6666667);
  assert.ok(times.every((value, index) => !index || value - times[index - 1]! > 0.03));
});
test('fractional frame interval does not introduce an extra endpoint hold', () => {
  assert.deepEqual(mediaSampleTimes(2, 2.05, 30), [2, 2 + 1 / 30]);
  assert.deepEqual(mediaSampleTimes(2, 2.05, 30, false), [2, 2 + 1 / 30, 2.05]);
});
test('full 300-frame budget is available and 301 encoded samples reject', () => {
  assert.equal(mediaSampleTimes(0, 10, 30).length, 300);
  assert.throws(() => mediaSampleTimes(0, 10, 30, false), /300 encoded/);
  assert.throws(() => mediaSampleTimes(0, 10.01, 30), /300 encoded/);
});
test('zero-duration and sub-frame previews retain their initial pose', () => {
  assert.deepEqual(mediaSampleTimes(3, 3, 30), [3]);
  assert.deepEqual(mediaSampleTimes(3, 3.00000002, 30), [3]);
});
test('media sampling rejects invalid ranges and frame rates', () => {
  for (const args of [[-1, 1, 30], [1, 0, 30], [0, 301, 30], [0, 1, 0], [0, 1, 1.5], [0, NaN, 30]] as const) assert.throws(() => mediaSampleTimes(args[0], args[1], args[2]));
});
