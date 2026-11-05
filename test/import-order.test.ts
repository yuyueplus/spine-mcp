import test from 'node:test';
import assert from 'node:assert/strict';
import { animationOrderFromJson, serializeImportJson, verifySliderBindings } from '../src/import-order.js';
import type { SpineDocument } from '../src/document.js';

const source = (): SpineDocument => ({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], constraints: [{ type: 'slider', name: 'driver', animation: 'z-target' }], animations: { 'z-target': { bones: {} }, 'a-first': {} }, metadata: { nested: [{ animations: { misleading: {} } }], text: 'a } ] \\" b' } });
test('import serialization reorders original animations without changing identities or payloads', () => {
  const data = source(), before = JSON.stringify(data), text = serializeImportJson(data, ['a-first', 'z-target']);
  assert.deepEqual(animationOrderFromJson(text), ['a-first', 'z-target']);
  assert.deepEqual(JSON.parse(text), data); assert.equal(JSON.stringify(data), before);
});
test('canonical order retains numeric, escaped and Unicode animation names', () => {
  const data = source(); data.constraints = []; data.animations = { '2': {}, '10': {}, '中文/动作': { events: [] }, 'a"\\b': {} };
  const names = ['中文/动作', '10', '2', 'a"\\b'], text = serializeImportJson(data, names);
  assert.deepEqual(animationOrderFromJson(text), names);
  assert.deepEqual(JSON.parse(text), data);
});
test('import order rejects changed/duplicate identities and ambiguous JSON', () => {
  assert.throws(() => serializeImportJson(source(), ['a-first', 'missing']), /identities/);
  assert.throws(() => serializeImportJson(source(), ['a-first', 'a-first']), /identities/);
  assert.throws(() => animationOrderFromJson('{"animations":{},"animations":{}}'), /Ambiguous/);
  assert.throws(() => animationOrderFromJson('{"animations":{"a":{},"a":{}}}'), /Duplicate/);
  assert.deepEqual(animationOrderFromJson('{"bones":[]}'), []);
});
test('Slider binding verification refuses a shifted reference before publication', () => {
  const expected = source(), actual = structuredClone(expected);
  assert.equal(verifySliderBindings(expected, actual).checked, 1);
  (actual.constraints as any[])[0].animation = 'a-first';
  assert.throws(() => verifySliderBindings(expected, actual), /expected z-target, received a-first/);
});
