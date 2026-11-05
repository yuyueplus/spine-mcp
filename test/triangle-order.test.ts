import test from 'node:test';
import assert from 'node:assert/strict';
import { setAttachment } from '../src/geometry-edits.js';
import { sourceMesh } from '../src/attachment-data.js';
import { verifyRoundTrip } from '../src/project-workflow.js';

function fixture() {
  return setAttachment({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root' }], skins: [{ name: 'default', attachments: {} }] }, 'default', 'art', 'mesh', { type: 'mesh', uvs: [0, 0, 1, 0, 1, 1, 0, 1], vertices: [0, 0, 20, 0, 20, 20, 0, 20], triangles: [0, 1, 2, 0, 2, 3] });
}
test('verification accepts reordered/cyclically rotated faces and reports the visual-order limitation', () => {
  const source = fixture(), actual = structuredClone(source); sourceMesh(actual, 'default', 'art', 'mesh').triangles = [2, 3, 0, 1, 2, 0];
  const result = verifyRoundTrip(source, actual, 'a.json', 'a.json');
  assert.equal(result.passed, true); assert.equal(result.triangleOrderNormalization!.selfOverlapOrderPreserved, false);
  assert.deepEqual(result.triangleOrderNormalization!.attachments, [{ skin: 'default', slot: 'art', name: 'mesh' }]);
});
test('verification still rejects reversed winding, changed diagonals, duplicate and missing faces', () => {
  const source = fixture();
  for (const triangles of [[0, 2, 1, 0, 2, 3], [0, 1, 3, 1, 2, 3], [0, 1, 2, 0, 1, 2], [0, 1, 2]]) {
    const actual = structuredClone(source); sourceMesh(actual, 'default', 'art', 'mesh').triangles = triangles;
    assert.throws(() => verifyRoundTrip(source, actual, 'a.json', 'a.json'), /triangles differs/);
  }
});
