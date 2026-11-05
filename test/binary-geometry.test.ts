import test from 'node:test';
import assert from 'node:assert/strict';
import { VertexAttachment } from '@esotericsoftware/spine-core';
import { readbackGeometry } from '../src/binary-geometry.js';
import { attachmentEntries, attachmentTracks, vertexLayout } from '../src/attachment-data.js';
import { setAttachment, setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { parseDocument, type SpineDocument, type JsonObject } from '../src/document.js';
import { sampleSkeleton } from '../src/runtime.js';
import { canonicalizeWeights } from '../src/weight-order.js';

function fixture(weighted = false) {
  let data = setAttachment({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'z', parent: 'root' }, { name: 'a', parent: 'root', x: 40, y: 17, rotation: 15 }], slots: [{ name: 'art', bone: 'z' }, { name: 'box', bone: 'z' }, { name: 'link', bone: 'root' }], skins: [{ name: 'default', attachments: {} }], animations: {} }, 'default', 'art', 'mesh', { type: 'mesh', uvs: [0, 0, 1, 0, 0, 1], vertices: [0.123456, 0.234567, 20.123456, 0.345678, 0.456789, 20.56789], triangles: [0, 1, 2] }, false, true);
  data = setAttachment(data, 'default', 'box', 'bounds', { type: 'boundingbox', vertexCount: 3, vertices: [-2.12345, 1.2345, 8.3456, 2.4567, 3.789, 7.1234] }, false, true);
  if (weighted) data = setWeights(data, 'default', 'art', 'mesh', Array.from({ length: 3 }, () => [{ bone: 'z', weight: 0.7123456 }, { bone: 'a', weight: 0.2876544 }]));
  data = setAttachmentTimeline(data, 'bend', 'default', 'art', 'mesh', 'deform', [{ time: 0 }, { time: 1, offset: 1, vertices: [0.123456, 0.234567] }]);
  data = setAttachment(data, 'default', 'link', 'copy', { type: 'mesh', path: 'art', source: 'mesh', slot: 'art', timelines: false }, false, true);
  return setAttachmentTimeline(data, 'bend', 'default', 'link', 'copy', 'deform', [{ time: 0 }, { time: 1, offset: 2, vertices: [0.345678, 0.456789] }]);
}
function roundJson(source: SpineDocument) {
  const data = structuredClone(source);
  for (const item of attachmentEntries(data)) if (Array.isArray(item.value.vertices)) {
    const values = item.value.vertices as number[], weighted = vertexLayout(data, item.value).weighted;
    if (!weighted) item.value.vertices = values.map(value => Math.round(value * 100) / 100);
    else {
      let cursor = 0;
      while (cursor < values.length) { const count = values[cursor++]!; for (let index = 0; index < count; index++, cursor += 4) { values[cursor + 1] = Math.round(values[cursor + 1]! * 100) / 100; values[cursor + 2] = Math.round(values[cursor + 2]! * 100) / 100; values[cursor + 3] = Math.round(values[cursor + 3]! * 1e6) / 1e6; } }
    }
  }
  for (const animation of Object.values(data.animations ?? {})) for (const track of attachmentTracks(data, animation)) if (track.channel === 'deform') for (const key of track.frames) if (Array.isArray(key.vertices)) key.vertices = key.vertices.map((value: number) => Math.round(value * 100) / 100);
  return data;
}
function positions(data: SpineDocument, time: number) {
  const skeleton = sampleSkeleton(data, 'bend', time);
  return skeleton.slots.flatMap(slot => { const attachment = slot.appliedPose.attachment; if (!(attachment instanceof VertexAttachment)) return []; const values = new Array<number>(attachment.worldVerticesLength); attachment.computeWorldVertices(skeleton, slot, 0, values.length, values, 0, 2); return values; });
}
test('binary readback restores unweighted mesh, polygon and independent linked deformations', () => {
  const original = fixture(), rounded = roundJson(original), snapshot = structuredClone(rounded), binary = sampleSkeleton(original, undefined, 0).data;
  const result = readbackGeometry(rounded, binary); assert.equal(result.attachments, 2); assert.equal(result.deformTracks, 2); assert.deepEqual(rounded, snapshot);
  for (const time of [0, 0.4, 1]) { const a = positions(original, time), b = positions(result.data, time); assert.ok(a.every((value, index) => Math.abs(value - b[index]!) < 0.00001)); }
});
test('binary readback matches weighted bones by name and transposes deform coordinates to JSON influence order', () => {
  const original = fixture(true), rounded = roundJson(canonicalizeWeights(original, true)), result = readbackGeometry(rounded, sampleSkeleton(original, undefined, 0).data);
  assert.equal((attachmentEntries(result.data)[0]!.value.vertices as number[])[1], 2);
  for (const time of [0, 0.25, 0.75, 1]) { const a = positions(original, time), b = positions(result.data, time); assert.ok(a.every((value, index) => Math.abs(value - b[index]!) < 0.00001)); }
});
test('binary readback rejects differences outside the known JSON rounding quantum', () => {
  const original = fixture(), rounded = roundJson(original); (attachmentEntries(rounded)[0]!.value.vertices as number[])[0]! += 0.01;
  assert.throws(() => readbackGeometry(rounded, sampleSkeleton(original, undefined, 0).data), /geometry mismatch/);
});
test('binary readback rejects mismatched versions, attachment identity and influence bones', () => {
  const original = fixture(true), rounded = roundJson(original), binary = sampleSkeleton(original, undefined, 0).data;
  (attachmentEntries(rounded)[0]!.value.vertices as number[])[1] = 0;
  assert.throws(() => readbackGeometry(rounded, binary), /influence bone/);
  const missing = sampleSkeleton(original, undefined, 0).data; missing.skins = [];
  assert.throws(() => readbackGeometry(roundJson(original), missing), /attachment missing/);
  binary.version = '4.3.22'; assert.throws(() => readbackGeometry(roundJson(original), binary), /versions differ/);
});

test('binary readback restores small values in all numeric bone channels without changing curves', () => {
  const channels: Record<string, JsonObject[]> = {};
  for (const channel of ['rotate', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary']) {
    const fallback = channel.startsWith('scale') ? 1 : 0, fields = ['translate', 'scale', 'shear'].includes(channel) ? ['x', 'y'] : ['value'];
    channels[channel] = [0, 1].map((time, index) => ({ time, ...Object.fromEntries(fields.map((field, component) => [field, fallback + 0.0042 - index * 0.0001 + component * 0.0002])), ...(index ? {} : { curve: 'stepped' }) }));
  }
  const original = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], animations: { tiny: { bones: { root: channels } } } }), rounded = structuredClone(original), snapshot = JSON.stringify(original);
  for (const [channel, keys] of Object.entries((rounded.animations!.tiny!.bones as any).root) as [string, JsonObject[]][]) for (const key of keys) for (const field of ['x', 'y', 'value']) if (field in key) delete key[field];
  const result = readbackGeometry(rounded, sampleSkeleton(original, undefined, 0).data); assert.equal(result.boneTracks, 10);
  for (const [channel, keys] of Object.entries(channels)) for (const [index, key] of keys.entries()) { const received = (result.data.animations!.tiny!.bones as any).root[channel][index]; for (const field of ['x', 'y', 'value']) if (field in key) assert.ok(Math.abs(Number(received[field]) - Number(key[field])) < 1e-6); assert.equal(received.curve, key.curve); }
  assert.equal(JSON.stringify(original), snapshot);
  const wrong = structuredClone(rounded); ((wrong.animations!.tiny!.bones as any).root.translate[0] as JsonObject).x = 0.1; assert.throws(() => readbackGeometry(wrong, sampleSkeleton(original, undefined, 0).data), /geometry mismatch/);
});

test('bone precision readback rejects frame, time and timeline mismatches', () => {
  const original = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], animations: { motion: { bones: { root: { translate: [{ time: 0 }, { time: 1, x: 2 }] } } } } }), binary = sampleSkeleton(original, undefined, 0).data;
  const missing = structuredClone(original); ((missing.animations!.motion!.bones as any).root.translate as JsonObject[]).pop(); assert.throws(() => readbackGeometry(missing, binary), /bone frame count/);
  const shifted = structuredClone(original); (shifted.animations!.motion!.bones as any).root.translate[1].time = 1.01; assert.throws(() => readbackGeometry(shifted, binary), /geometry mismatch/);
  binary.findAnimation('motion')!.timelines.length = 0; assert.throws(() => readbackGeometry(original, binary), /bone timeline missing/);
});
test('binary readback rejects lost deform frames rather than silently substituting different animations', () => {
  const original = fixture(), rounded = roundJson(original), binary = sampleSkeleton(original, undefined, 0).data;
  binary.animations[0]!.timelines = [];
  assert.throws(() => readbackGeometry(rounded, binary), /timeline missing/);
});
