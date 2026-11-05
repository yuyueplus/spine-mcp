import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from '../src/document.js';
import { setAttachmentTimeline } from '../src/geometry-edits.js';
import { verifyGeometry } from '../src/geometry-verification.js';
import { isConvexPolygon, nativeCompatibility } from '../src/native-compatibility.js';

function fixture() { return parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], slots: [{ name: 'mask', bone: 'root', attachment: 'clip' }], skins: [{ name: 'default', attachments: { mask: { clip: { type: 'clipping', vertexCount: 4, vertices: [0, 0, 10, 0, 10, 10, 0, 10], convex: false } } } }], animations: { move: {} } }); }
const clip = (data: ReturnType<typeof fixture>) => (data.skins as any[])[0].attachments.mask.clip;
test('stable convex clipping permits equivalent importer flag normalization', () => {
  const data = fixture(), actual = structuredClone(data); clip(actual).convex = true;
  assert.deepEqual(verifyGeometry(data, actual, isDeepStrictEqual), []); assert.equal(nativeCompatibility(data).clippingImportRisks, 0);
});
test('animation deformation prevents assuming a convex setup stays convex', () => {
  const data = setAttachmentTimeline(fixture(), 'move', 'default', 'mask', 'clip', 'deform', [{ time: 0 }, { time: 1, offset: 4, vertices: [-8, -8] }]), actual = structuredClone(data); clip(actual).convex = true;
  assert.match(verifyGeometry(data, actual, isDeepStrictEqual).join(';'), /Clipping convexity/);
  const report = nativeCompatibility(data); assert.equal(report.clippingImportRisks, 1); assert.equal(report.clipping[0]!.animatedDeformation, true);
});
test('concave clipping reports native import risk and rejects changed convexity', () => {
  const data = fixture(); clip(data).vertices = [0, 0, 10, 0, 2, 2, 0, 10]; const actual = structuredClone(data); clip(actual).convex = true;
  assert.equal(nativeCompatibility(data).clippingImportRisks, 1); assert.match(verifyGeometry(data, actual, isDeepStrictEqual).join(';'), /Clipping convexity/);
});
test('inverse clipping is already convex independently of the stored convex flag', () => {
  const data = fixture(); clip(data).vertices = [0, 0, 10, 0, 2, 2, 0, 10]; clip(data).inverse = true; const actual = structuredClone(data); clip(actual).convex = true;
  assert.equal(nativeCompatibility(data).clippingImportRisks, 0); assert.deepEqual(verifyGeometry(data, actual, isDeepStrictEqual), []);
});
test('convexity inspection rejects star winding, backtracking and repeated polygon walks', () => {
  const points = Array.from({ length: 5 }, (_, i) => [Math.cos(i * Math.PI * 2 / 5), Math.sin(i * Math.PI * 2 / 5)]);
  assert.equal(isConvexPolygon([0, 0, 5, 0, 10, 0, 10, 10, 0, 10]), true);
  assert.equal(isConvexPolygon([0, 0, 10, 0, 5, 0, 10, 10, 0, 10]), false);
  assert.equal(isConvexPolygon([0, 2, 4, 1, 3].flatMap(i => points[i]!)), false);
  assert.equal(isConvexPolygon([0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 10, 0, 10, 10, 0, 10]), false);
  assert.equal(isConvexPolygon([0, 0, 10, 0, 10, 0, 0, 10]), false);
});
