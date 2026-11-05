import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { inspectTimelines, copyTimelines, retimeKeyframes, type DetailedTimelineTarget as Target, type TimelineMapping } from '../src/timeline-tools.js';
import { parseDocument, setTimeline, type SpineDocument } from '../src/document.js';
import { setAttachment, setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { copyAttachment, linkMesh } from '../src/attachment-reuse.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { sampleSkeleton } from '../src/runtime.js';
import { setColorTimeline } from '../src/slot-edits.js';
import { setEventTimeline, setEvent, setDrawOrder } from '../src/animation-edits.js';
import { setConstraint, setConstraintTimeline } from '../src/constraint-edits.js';
import { constraintTypes, constraintTracks } from '../src/constraint-data.js';
import { applyEdits, editSchema } from '../src/edits.js';

const meshRef = { skin: 'base', slot: 'art', name: 'visual' }, copyRef = { skin: 'base', slot: 'target', name: 'copy' }, linkRef = { skin: 'base', slot: 'linked', name: 'link' };
const rotate: Target = { kind: 'bone', bone: 'z-arm', channel: 'rotate' }, tipRotate: Target = { kind: 'bone', bone: 'a-tip', channel: 'rotate' };
const deform = { kind: 'attachment' as const, ...meshRef, channel: 'deform' as const }, sequence = { ...deform, channel: 'sequence' as const };
const color: Target = { kind: 'slot', slot: 'art', channel: 'rgba' };
const mapping = (from: Target, to = from): TimelineMapping => ({ from, to });
function value(data: SpineDocument, ref = meshRef) { return attachmentEntries(data).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name)!.value; }
function frames(data: SpineDocument, name: string, path: string[]): any[] { let item: any = data.animations![name]; for (const key of path) item = item[key]; return item; }
function fixture(weighted = false): SpineDocument {
  let data = parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root', rotation: 9, shearY: 8 }, { name: 'z-arm', parent: 'root', x: 7, y: 3, rotation: 11, scaleX: 1.2, scaleY: 0.8 }, { name: 'a-tip', parent: 'root', x: 80, y: -20, rotation: -17, scaleX: -0.9, scaleY: 1.2 }], slots: [{ name: 'art', bone: 'z-arm', attachment: 'visual' }, { name: 'target', bone: 'z-arm' }, { name: 'linked', bone: 'z-arm' }], skins: [{ name: 'base', attachments: { art: { visual: { type: 'mesh', name: 'base/visual', path: 'arm', sequence: { count: 3 }, width: 120, height: 24, uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, -12, 0, 12, 120, 12, 120, -12], triangles: [0, 1, 2, 0, 2, 3], hull: 4 } } } }], animations: {}, customMetadata: { keep: true } });
  if (weighted) data = setWeights(data, meshRef.skin, meshRef.slot, meshRef.name, Array.from({ length: 4 }, () => [{ bone: 'z-arm', weight: 0.7 }, { bone: 'a-tip', weight: 0.3 }]));
  data = copyAttachment(data, meshRef, copyRef, { copyTimelines: false, setAsSetup: true });
  if (weighted) {
    const raw = value(data, copyRef).vertices as number[];
    for (let offset = 0; offset < raw.length; offset += 9) { const a = raw.slice(offset + 1, offset + 5), b = raw.slice(offset + 5, offset + 9); raw.splice(offset + 1, 8, ...b, ...a); }
  }
  data = linkMesh(data, meshRef, linkRef, { setAsSetup: true });
  data = setTimeline(data, 'main', 'z-arm', 'rotate', [{ time: 0, value: 0, curve: [0.2, 0, 0.8, 30] }, { time: 1, value: 30, curve: [1.2, 30, 1.8, 0] }, { time: 2, value: 0 }]);
  data = setTimeline(data, 'main', 'a-tip', 'rotate', [{ time: 0, value: 0 }, { time: 1, value: -20 }, { time: 2, value: 0 }]);
  data = setColorTimeline(data, 'main', 'art', [{ time: 0, color: 'ffffffff', curve: Array.from({ length: 4 }, () => [0.2, 1, 0.8, 0.5]).flat() }, { time: 1, color: '80808080' }, { time: 2, color: 'ffffffff' }]);
  data = setAttachmentTimeline(data, 'main', meshRef.skin, meshRef.slot, meshRef.name, 'deform', [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, offset: 3, vertices: [11, -3, 13] }, { time: 2 }]);
  data = setAttachmentTimeline(data, 'main', meshRef.skin, meshRef.slot, meshRef.name, 'sequence', [{ time: 0, mode: 'loop', delay: 0.25 }, { time: 2, mode: 'hold', index: 1 }]);
  data = setEvent(setEvent(data, 'step', { int: 1, string: '脚步' }), 'impact', { float: 0.5 });
  data = setEventTimeline(data, 'main', [{ time: 0.5, name: 'step', int: 7 }, { time: 0.5, name: 'impact' }, { time: 1.5, name: 'step' }]);
  return setDrawOrder(data, 'main', [{ time: 0, order: null }, { time: 1, order: ['target', 'linked', 'art'] }, { time: 2, order: null }]);
}
function geometry(data: SpineDocument, ref: typeof meshRef, time: number, animation = 'main') {
  const skeleton = sampleSkeleton(data, animation, time, ref.skin), slot = skeleton.slots.find(item => item.data.name === ref.slot)!, mesh = slot.appliedPose.attachment as MeshAttachment;
  const world = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2); return { world, frame: mesh.sequence.resolveIndex(slot.appliedPose) };
}
function close(a: number[], b: number[]) { assert.equal(a.length, b.length); assert.ok(a.every((value, index) => Math.abs(value - b[index]!) < 0.0002), JSON.stringify({ a, b })); }
function constraintsFixture() {
  let data = fixture(); data.animations!.pose = { bones: { root: { rotate: [{ time: 0 }, { time: 1, value: 1 }] } } };
  for (const type of constraintTypes) for (const suffix of ['a', 'b']) data.bones.push({ name: `${type}-${suffix}`, parent: 'root', length: 30 });
  data.bones.push({ name: 'control', parent: 'root', x: 50, y: 50 }); data.slots!.push({ name: 'path-slot', bone: 'root' });
  data = setAttachment(data, 'base', 'path-slot', 'path', { type: 'path', vertexCount: 6, vertices: [-10, 0, 0, 0, 33, 0, 66, 0, 100, 0, 110, 0], lengths: [100] }, false, true);
  for (const type of constraintTypes) for (const [name, suffix] of [['控制', 'a'], ['目标', 'b']]) {
    const common = { name, type, skin: true }, definition = type === 'ik' ? { ...common, bones: [`${type}-${suffix}`], target: 'control' }
      : type === 'transform' ? { ...common, bones: [`${type}-${suffix}`], source: 'control', properties: { x: { to: { x: {} } } } }
      : type === 'path' ? { ...common, bones: [`${type}-${suffix}`], slot: 'path-slot' } : type === 'physics' ? { ...common, bone: `${type}-${suffix}`, rotate: 1 } : { ...common, animation: 'pose' };
    data = setConstraint(data, definition);
  }
  for (const type of constraintTypes) {
    const channel = type === 'ik' || type === 'transform' ? 'parameters' : type === 'path' ? 'position' : type === 'physics' ? 'wind' : 'time';
    const keys = type === 'ik' ? [{ time: 0, mix: 1 }, { time: 1, mix: 0.5 }, { time: 2, mix: 1 }] : type === 'transform' ? [{ time: 0, mixX: 1 }, { time: 1, mixX: 0.5 }, { time: 2, mixX: 1 }] : [{ time: 0, value: 0 }, { time: 1, value: 1 }, { time: 2, value: 0 }];
    data = setConstraintTimeline(data, 'main', '控制', channel, keys, type);
  }
  return setConstraintTimeline(data, 'main', '', 'mix', [{ time: 0, value: 1 }, { time: 1, value: 0.5 }, { time: 2, value: 1 }], 'physics');
}

test('timeline inventory paginates stored channels and reports ignored inherited keys and unsupported data', () => {
  const source = setAttachmentTimeline(fixture(), 'main', linkRef.skin, linkRef.slot, linkRef.name, 'deform', [{ time: 0, vertices: [-9, -8] }]);
  source.animations!.main!.customTrack = { keep: true }; source.animations!.main!.drawOrderFolder = [{ slots: ['art'], keys: [{ time: 0 }] }]; const snapshot = structuredClone(source);
  const all = inspectTimelines(source, 'main'), page = inspectTimelines(source, 'main', 1, 2), linked = all.tracks.find(item => item.target.kind === 'attachment' && item.target.name === linkRef.name)!;
  assert.equal(page.tracks.length, 2); assert.equal(page.nextOffset, 3); assert.equal(linked.editable, false); assert.equal(linked.storedKeysIgnoredByInheritance, true); assert.deepEqual(linked.effectiveTarget, deform); assert.equal(all.unsupportedCount, 2);
  assert.ok(all.tracks.some(item => item.bezierSegments === 2)); assert.deepEqual(source, snapshot);
  assert.throws(() => inspectTimelines(source, 'missing'), /not found/); assert.throws(() => inspectTimelines(source, 'main', 100), /pages/); assert.throws(() => inspectTimelines(source, 'main', 0, 501), /pages/);
});
test('selective bone copy preserves local animation offsets, existing unrelated channels and source bytes', () => {
  const source = fixture(); source.animations!.target = { color: 'abcdef', bones: { 'a-tip': { scale: [{ time: 0, x: 1, y: 1 }] } }, custom: 'kept' }; const snapshot = structuredClone(source);
  const output = copyTimelines(source, 'main', 'target', [mapping(rotate, tipRotate)], { timeScale: 2, timeOffset: 0.25 });
  for (const time of [0, 0.2, 0.5, 1, 1.3, 2]) {
    const a = sampleSkeleton(source, 'main', time, 'base').bones[1]!, b = sampleSkeleton(output, 'target', time * 2 + 0.25, 'base').bones[2]!;
    close([a.appliedPose.rotation - 11], [b.appliedPose.rotation + 17]);
  }
  assert.equal(output.animations!.target!.custom, 'kept'); assert.ok(frames(output, 'target', ['bones', 'a-tip', 'scale'])); assert.deepEqual(source, snapshot);
});
test('same-animation channel swaps read a stable source snapshot and require explicit replacement', () => {
  const source = fixture(), output = copyTimelines(source, 'main', 'main', [mapping(rotate, tipRotate), mapping(tipRotate, rotate)], { replace: true });
  assert.deepEqual(frames(output, 'main', ['bones', 'a-tip', 'rotate']), frames(source, 'main', ['bones', 'z-arm', 'rotate']));
  assert.deepEqual(frames(output, 'main', ['bones', 'z-arm', 'rotate']), frames(source, 'main', ['bones', 'a-tip', 'rotate']));
  assert.throws(() => copyTimelines(source, 'main', 'main', [mapping(rotate)]), /replace=true/);
});
test('copy rejects duplicated destinations, incompatible channel kinds and reserved animation names', () => {
  const source = fixture(); assert.throws(() => copyTimelines(source, 'main', 'new', [mapping(rotate), mapping(rotate)]), /only once/);
  assert.throws(() => copyTimelines(source, 'main', 'new', [mapping(rotate, color)]), /same timeline kind/);
  assert.throws(() => copyTimelines(source, 'main', '__proto__', [mapping(rotate)]), /reserved/);
  assert.throws(() => copyTimelines(source, 'main', 'new', []), /1–100/);
  assert.throws(() => copyTimelines(source, 'main', 'new', [mapping({ kind: 'bone', bone: 'missing', channel: 'rotate' })]), /Missing bone/);
});
test('copy detects overlapping bone axes/color channels while allowing RGB plus alpha', () => {
  const source = fixture(); source.animations!.axes = { bones: { 'a-tip': { translatex: [{ time: 0, value: 1 }] } } };
  source.animations!.main!.bones = { ...(source.animations!.main!.bones as object), root: { translate: [{ time: 0, x: 1, y: 2 }], translatey: [{ time: 0, value: 2 }] } };
  assert.throws(() => copyTimelines(source, 'main', 'axes', [mapping({ kind: 'bone', bone: 'root', channel: 'translate' }, { kind: 'bone', bone: 'a-tip', channel: 'translate' })]), /overlaps translatex/);
  source.animations!.colors = { slots: { art: { alpha: [{ time: 0, value: 0.5 }] } } };
  assert.throws(() => copyTimelines(source, 'main', 'colors', [mapping(color)]), /overlaps alpha/);
  source.animations!.rgb = { slots: { art: { rgb: [{ time: 0, color: 'ff0000' }] } } };
  assert.ok(copyTimelines(source, 'rgb', 'colors', [mapping({ kind: 'slot', slot: 'art', channel: 'rgb' })]).animations!.colors!.slots);
});
for (const weighted of [false, true]) test(`${weighted ? 'reordered weighted' : 'unweighted'} deformation copy preserves actual shape and sequence`, () => {
  const source = fixture(weighted), output = copyTimelines(source, 'main', 'main', [mapping(deform, { ...deform, ...copyRef }), mapping(sequence, { ...sequence, ...copyRef })]);
  for (const time of [0, 0.2, 0.5, 0.8, 1, 1.5, 2]) {
    const a = geometry(source, meshRef, time), b = geometry(output, copyRef, time); close(a.world, b.world); assert.equal(a.frame, b.frame);
  }
  assert.deepEqual(value(output, copyRef), value(source, copyRef)); assert.deepEqual(output.animations!.main!.bones, source.animations!.main!.bones);
});
test('copy uses effective inherited deformation/sequence instead of ignored own keys', () => {
  const source = setAttachmentTimeline(fixture(), 'main', linkRef.skin, linkRef.slot, linkRef.name, 'deform', [{ time: 0, vertices: [-9, -8] }]);
  const output = copyTimelines(source, 'main', 'new', [mapping({ ...deform, ...linkRef }, { ...deform, ...copyRef }), mapping({ ...sequence, ...linkRef }, { ...sequence, ...copyRef })]);
  assert.deepEqual(frames(output, 'new', ['attachments', 'base', 'target', 'copy', 'deform']), frames(source, 'main', ['attachments', 'base', 'art', 'visual', 'deform']));
});
test('copying a complete weighted clip with time scaling preserves sampled pose, deform, sequence, tint and draw order', () => {
  const source = fixture(true), mappings = inspectTimelines(source, 'main').tracks.map(track => mapping(track.target)), output = copyTimelines(source, 'main', 'slow', mappings, { timeScale: 2, timeOffset: 0.25 });
  for (const time of [0, 0.2, 0.5, 0.8, 1, 1.5, 2]) {
    const a = geometry(source, meshRef, time), b = geometry(output, meshRef, time * 2 + 0.25, 'slow'); close(a.world, b.world); assert.equal(a.frame, b.frame);
    const x = sampleSkeleton(source, 'main', time, 'base'), y = sampleSkeleton(output, 'slow', time * 2 + 0.25, 'base');
    close([x.slots[0]!.appliedPose.color.a], [y.slots[0]!.appliedPose.color.a]); assert.deepEqual(x.drawOrder.appliedPose.map(slot => slot.data.name), y.drawOrder.appliedPose.map(slot => slot.data.name));
  }
});
test('deform copy rejects UV/topology, vertex counts and influence identity mismatches', () => {
  const run = (source: SpineDocument) => copyTimelines(source, 'main', 'new', [mapping(deform, { ...deform, ...copyRef })]);
  const uv = fixture(); (value(uv, copyRef).uvs as number[])[0] = 0.1; assert.throws(() => run(uv), /UV indices/);
  const topology = fixture(); value(topology, copyRef).triangles = [0, 1, 3, 1, 2, 3]; assert.throws(() => run(topology), /topology/);
  const weighted = fixture(true); (value(weighted, copyRef).vertices as number[])[1] = 0; assert.throws(() => run(weighted), /influence bones/);
  const count = fixture(); value(count, copyRef).uvs = [0, 0, 0, 1, 1, 1]; value(count, copyRef).vertices = [0, 0, 0, 1, 1, 1]; value(count, copyRef).triangles = [0, 1, 2]; value(count, copyRef).hull = 3; assert.throws(() => run(count), /vertex counts/);
});
test('sequence copy scales delays with time while range retiming retains playback delay values', () => {
  const source = fixture(), output = copyTimelines(source, 'main', 'new', [mapping(sequence)], { timeScale: 2, timeOffset: 0.25 });
  assert.equal(frames(output, 'new', ['attachments', 'base', 'art', 'visual', 'sequence'])[0]!.delay, 0.5);
  const retimed = retimeKeyframes(source, 'main', [sequence], 0, 2, 2, 0.25);
  assert.equal(frames(retimed, 'main', ['attachments', 'base', 'art', 'visual', 'sequence'])[0]!.delay, 0.25);
  assert.equal(geometry(source, meshRef, 0.25).frame, geometry(output, meshRef, 0.75, 'new').frame);
  assert.equal(geometry(source, meshRef, 0.25).frame, geometry(retimed, meshRef, 0.5).frame);
});
test('sequence count mismatch and writes to inheriting linked mesh channels are blocked', () => {
  const source = fixture(); value(source, copyRef).sequence = { count: 2 };
  assert.throws(() => copyTimelines(source, 'main', 'new', [mapping(sequence, { ...sequence, ...copyRef })]), /matching frame counts/);
  assert.throws(() => copyTimelines(source, 'main', 'new', [mapping(deform, { ...deform, ...linkRef })]), /inherits/);
  assert.throws(() => retimeKeyframes(source, 'main', [{ ...deform, ...linkRef }], 0, 1), /inherits/);
});
test('five same-name constraint types and global physics channels copy by explicit type', () => {
  const source = constraintsFixture(), mappings = constraintTracks(source, source.animations!.main!).map(track => mapping({ kind: 'constraint', constraint: track.name, constraintType: track.type as any, channel: track.channel }, { kind: 'constraint', constraint: track.name ? '目标' : '', constraintType: track.type as any, channel: track.channel }));
  const output = copyTimelines(source, 'main', 'new', mappings, { timeScale: 2, timeOffset: 0.25 }), tracks = constraintTracks(output, output.animations!.new!);
  assert.equal(tracks.length, 6); assert.equal(tracks.filter(track => track.name === '目标').length, 5); assert.equal(tracks.find(track => track.name === '')!.type, 'physics');
  for (const track of tracks) assert.deepEqual(track.frames.map(key => key.time), [0.25, 2.25, 4.25]);
});
test('range retiming preserves normalized Bezier easing on both adjacent intervals and untouched channels', () => {
  const source = fixture(), snapshot = structuredClone(source), output = retimeKeyframes(source, 'main', [rotate], 1, 1, 1, 0.5);
  assert.deepEqual(frames(output, 'main', ['bones', 'z-arm', 'rotate']).map(key => key.time), [0, 1.5, 2]);
  close(frames(output, 'main', ['bones', 'z-arm', 'rotate'])[0]!.curve, [0.3, 0, 1.2, 30]);
  for (const time of [0, 0.2, 0.5, 0.8, 1, 1.2, 1.5, 1.8, 2]) {
    const mapped = time <= 1 ? time * 1.5 : 1.5 + (time - 1) * 0.5;
    close([sampleSkeleton(source, 'main', time, 'base').bones[1]!.appliedPose.rotation], [sampleSkeleton(output, 'main', mapped, 'base').bones[1]!.appliedPose.rotation]);
  }
  assert.deepEqual(output.animations!.main!.slots, source.animations!.main!.slots); assert.deepEqual(frames(output, 'main', ['bones', 'a-tip', 'rotate']), frames(source, 'main', ['bones', 'a-tip', 'rotate'])); assert.deepEqual(source, snapshot);
});
for (const weighted of [false, true]) test(`range retiming preserves ${weighted ? 'weighted' : 'unweighted'} sparse deformation easing without changing bind data`, () => {
  const source = fixture(weighted); delete source.animations!.main!.bones;
  const output = retimeKeyframes(source, 'main', [deform], 1, 1, 1, 0.5);
  for (const time of [0, 0.2, 0.5, 0.8, 1, 1.2, 1.5, 1.8, 2]) close(geometry(source, meshRef, time).world, geometry(output, meshRef, time <= 1 ? time * 1.5 : 1.5 + (time - 1) * 0.5).world);
  assert.deepEqual(output.skins, source.skins); assert.deepEqual(frames(output, 'main', ['attachments', 'base', 'art', 'visual', 'sequence']), frames(source, 'main', ['attachments', 'base', 'art', 'visual', 'sequence']));
});
test('multi-axis and RGBA Bezier controls keep sampled local poses and tint after selective time scaling', () => {
  const source = setTimeline(fixture(), 'main', 'z-arm', 'translate', [{ time: 0, x: 0, y: 0, curve: [0.2, 0, 0.8, 8, 0.2, 0, 0.8, -4] }, { time: 1, x: 8, y: -4 }, { time: 2, x: 0, y: 0 }]);
  const output = retimeKeyframes(source, 'main', [{ kind: 'bone', bone: 'z-arm', channel: 'translate' }, color], 0, 2, 2, 0.25);
  for (const time of [0, 0.2, 0.5, 0.8, 1, 1.5, 2]) {
    const a = sampleSkeleton(source, 'main', time, 'base'), b = sampleSkeleton(output, 'main', time * 2 + 0.25, 'base');
    close([a.bones[1]!.appliedPose.x, a.bones[1]!.appliedPose.y, a.slots[0]!.appliedPose.color.a], [b.bones[1]!.appliedPose.x, b.bones[1]!.appliedPose.y, b.slots[0]!.appliedPose.color.a]);
  }
});
test('event simultaneity, discrete attachment keys and draw order retain values during range shifts', () => {
  const source = fixture(); source.animations!.main!.slots = { ...(source.animations!.main!.slots as object), art: { ...(source.animations!.main!.slots as any).art, attachment: [{ time: 0, name: 'visual' }, { time: 1 }, { time: 2, name: 'visual' }] } };
  const output = retimeKeyframes(source, 'main', [{ kind: 'events' }], 0.5, 0.5, 1, 0.25);
  assert.deepEqual((output.animations!.main!.events as any[]).map(key => key.time), [0.75, 0.75, 1.5]);
  const moved = retimeKeyframes(source, 'main', [{ kind: 'drawOrder' }, { kind: 'slot', slot: 'art', channel: 'attachment' }], 1, 1, 1, 0.25);
  assert.equal(sampleSkeleton(moved, 'main', 1.1, 'base').slots[0]!.appliedPose.attachment?.name, 'base/visual');
  assert.equal(sampleSkeleton(moved, 'main', 1.3, 'base').slots[0]!.appliedPose.attachment, null);
  assert.deepEqual(sampleSkeleton(moved, 'main', 1.3, 'base').drawOrder.appliedPose.map(slot => slot.data.name), ['target', 'linked', 'art']);
});
test('range editing constraint channels preserves typed values and global physics identity', () => {
  const source = constraintsFixture(), targets: Target[] = constraintTracks(source, source.animations!.main!).map(track => ({ kind: 'constraint', constraint: track.name, constraintType: track.type as any, channel: track.channel }));
  const output = retimeKeyframes(source, 'main', targets, 1, 1, 1, 0.5);
  for (const track of constraintTracks(output, output.animations!.main!)) assert.deepEqual(track.frames.map(key => key.time), [0, 1.5, 2]);
  assert.deepEqual(output.constraints, source.constraints);
});
test('range editing rejects crossings, float32 collapses, negative/overflow times and empty selections without mutations', () => {
  const source = fixture(), snapshot = structuredClone(source);
  for (const args of [[1, 1, 1, 1], [0, 2, 1e-20, 1], [0, 2, 1, -1], [0, 2, 1, 300], [0, 2, Number.MAX_VALUE, 0], [0, 2, 0, 0]]) assert.throws(() => retimeKeyframes(source, 'main', [rotate], ...args as [number, number, number, number]), /cross|collapse|0–300|positive|overflow/);
  assert.throws(() => retimeKeyframes(source, 'main', [rotate], 0.1, 0.2), /No keyframes/);
  assert.throws(() => retimeKeyframes(source, 'main', [rotate, rotate], 0, 2), /only once/); assert.throws(() => retimeKeyframes(source, 'main', [], 0, 2), /1–100/);
  assert.deepEqual(source, snapshot);
});
test('attachment-name and folder draw-order copying require explicit compatible destination data', () => {
  const source = fixture(); (source.animations!.main!.slots as any).art.attachment = [{ time: 0, name: 'visual' }];
  assert.throws(() => copyTimelines(source, 'main', 'new', [mapping({ kind: 'slot', slot: 'art', channel: 'attachment' }, { kind: 'slot', slot: 'target', channel: 'attachment' })]), /Missing timeline attachment/);
  source.animations!.folders = { drawOrderFolder: [{ slots: ['art'], keys: [{ time: 0 }] }] };
  assert.throws(() => copyTimelines(source, 'main', 'folders', [mapping({ kind: 'drawOrder' })]), /Flatten/);
});
test('timeline key-count and source byte budgets reject oversized copying and retiming', () => {
  const source = fixture(); source.animations!.main!.events = Array.from({ length: 100001 }, (_, index) => ({ time: index / 1000, name: 'step' }));
  assert.throws(() => copyTimelines(source, 'main', 'new', [mapping({ kind: 'events' })]), /100,000/); assert.throws(() => retimeKeyframes(source, 'main', [{ kind: 'events' }], 0, 100), /100,000/);
  source.animations!.main!.events = [{ time: 0, name: 'step', string: 'x'.repeat(17 * 1024 * 1024) }];
  assert.throws(() => copyTimelines(source, 'main', 'new', [mapping({ kind: 'events' })]), /16 MiB/);
});
test('deformation work budget is checked before expanding sparse keys', () => {
  const source = fixture(true), record = value(source), target = value(source, copyRef), vertices = Array.from({ length: 10000 }, () => [2, 1, 0, 0, 0.7, 2, 0, 0, 0.3]).flat();
  for (const item of [record, target]) { item.vertices = vertices; item.uvs = new Array(20000).fill(0); item.triangles = [0, 1, 2]; item.hull = 3; }
  (source.animations!.main!.attachments as any).base.art.visual.deform = Array.from({ length: 126 }, (_, index) => ({ time: index }));
  assert.throws(() => copyTimelines(source, 'main', 'new', [mapping(deform, { ...deform, ...copyRef })]), /5,000,000/);
});
test('ordered edit schema combines new channel copy and partial retiming with defaults', async () => {
  const source = fixture(), edits = [{ type: 'copy_timelines', fromAnimation: 'main', toAnimation: 'new', mappings: [mapping(rotate)] }, { type: 'retime_keyframes', animation: 'new', targets: [rotate], start: 1, end: 1, timeOffset: 0.5 }].map(raw => editSchema.parse(raw));
  const output = await applyEdits(source, edits); assert.deepEqual(frames(output, 'new', ['bones', 'z-arm', 'rotate']).map(key => key.time), [0, 1.5, 2]); assert.deepEqual(source.animations!.main, fixture().animations!.main);
  assert.throws(() => editSchema.parse({ type: 'copy_timelines', fromAnimation: 'main', toAnimation: 'new', mappings: [], merge: true }));
});
