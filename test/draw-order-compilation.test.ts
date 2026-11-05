import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFolderDrawOrder } from '../src/draw-order-compilation.js';
import { setDrawOrder, setFolderDrawOrder } from '../src/animation-edits.js';
import { sampleSkeleton } from '../src/runtime.js';
import { verifyRoundTrip } from '../src/project-workflow.js';
import type { SpineDocument } from '../src/document.js';

function fixture(): SpineDocument { return { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], slots: ['a', 'b', 'c', 'd'].map(name => ({ name, bone: 'root' })), animations: {} }; }
const draw = (data: SpineDocument, time: number) => sampleSkeleton(data, 'layers', time).drawOrder.appliedPose.map(slot => slot.data.name);
const permutations = (names: string[]): string[][] => names.length ? names.flatMap((name, index) => permutations(names.filter((_name, other) => index !== other)).map(tail => [name, ...tail])) : [[]];
test('folder compilation preserves runtime permutations across every global four-slot order', () => {
  for (const order of permutations(['a', 'b', 'c', 'd'])) {
    let source = setDrawOrder(fixture(), 'layers', [{ time: 0.1, order }, { time: 0.8, order: null }]);
    source = setFolderDrawOrder(source, 'layers', [{ slots: ['a', 'c'], keyframes: [{ time: 0.3, order: ['c', 'a'] }, { time: 1, order: null }] }, { slots: ['b', 'd'], keyframes: [{ time: 0.5, order: ['d', 'b'] }] }]);
    const snapshot = JSON.stringify(source), compiled = compileFolderDrawOrder(source);
    for (const time of [0, 0.2, 0.3, 0.5, 0.8, 1]) assert.deepEqual(draw(compiled, time), draw(source, time));
    assert.equal(compiled.animations!.layers!.drawOrderFolder, undefined); assert.equal(JSON.stringify(source), snapshot);
  }
});
test('compilation preserves nested raw folder application order', () => {
  let source = setFolderDrawOrder(fixture(), 'layers', [{ slots: ['a', 'b', 'c'], keyframes: [{ time: 0.2, order: ['c', 'b', 'a'] }] }]);
  const nested = setFolderDrawOrder(fixture(), 'layers', [{ slots: ['b', 'c'], keyframes: [{ time: 0.5, order: ['c', 'b'] }] }]);
  (source.animations!.layers!.drawOrderFolder as any[]).push(...nested.animations!.layers!.drawOrderFolder as any[]);
  const compiled = compileFolderDrawOrder(source);
  for (const time of [0, 0.2, 0.5, 1]) assert.deepEqual(draw(compiled, time), draw(source, time));
});
test('round-trip accepts equivalent compiled groups and rejects silently dropped keys', () => {
  const source = setFolderDrawOrder(fixture(), 'layers', [{ slots: ['a', 'c'], keyframes: [{ time: 0.2, order: ['c', 'a'] }, { time: 1, order: null }] }]);
  const compiled = compileFolderDrawOrder(source), result = verifyRoundTrip(source, compiled, 'a.json', 'a.json');
  assert.equal(result.passed, true); assert.equal(result.folderDrawOrderNormalization!.editorFolderStructurePreserved, false);
  const lost = structuredClone(compiled); delete lost.animations!.layers!.drawOrder;
  assert.throws(() => verifyRoundTrip(source, lost, 'a.json', 'a.json'), /Draw-order keyframe count differs/);
});
test('constant folder keys retain duration and animations without folders remain intact', () => {
  const source = setFolderDrawOrder(fixture(), 'layers', [{ slots: ['a'], keyframes: [{ time: 2, order: null }] }]);
  source.animations!.other = { bones: { root: { rotate: [{ time: 0 }, { time: 1, value: 10 }] } } };
  const compiled = compileFolderDrawOrder(source);
  assert.deepEqual(compiled.animations!.other, source.animations!.other);
  assert.equal((compiled.animations!.layers!.drawOrder as any[]).at(-1).time, 2);
});
