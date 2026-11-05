import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MixFrom, Skeleton, SkeletonJson, type Event } from '@esotericsoftware/spine-core';
import { setEvent, setEventTimeline, setDrawOrder, retimeAnimation, renameAnimation, removeTimeline } from '../src/animation-edits.js';
import { decodeDrawOrder, effectiveEvent } from '../src/animation-data.js';
import { parseDocument, setTimeline, loopCheck, readDocument, writeDocument, type SpineDocument } from '../src/document.js';
import { setColorTimeline, setAttachmentTimeline } from '../src/slot-edits.js';
import { boneDiagramLoader, sampleSkeleton } from '../src/runtime.js';
import { samplePose } from '../src/preview.js';
import { editProject, verifyRoundTrip } from '../src/project-workflow.js';
import { Workspace } from '../src/config.js';
import { editSchema } from '../src/edits.js';

function fixture(): SpineDocument {
  return { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 120 }], slots: [{ name: 'a', bone: 'arm', attachment: 'art' }, { name: 'b', bone: 'root' }, { name: 'c', bone: 'root' }], skins: [{ name: 'default', attachments: { a: { art: { width: 120, height: 24 } } } }], events: {}, animations: {}, customMetadata: { keep: true } };
}
function animated() {
  let data = setTimeline(fixture(), 'wave', 'arm', 'rotate', [{ time: 0, value: 0, curve: [0.2, 0, 0.8, 60] }, { time: 1, value: 60 }]);
  data = setColorTimeline(data, 'wave', 'a', [{ time: 0, color: 'ffffffff' }, { time: 1, color: 'ffffff00' }]);
  data = setEvent(data, 'step', { int: 1, float: 0.5, string: '脚步' });
  data = setEventTimeline(data, 'wave', [{ time: 0, name: 'step' }, { time: 0.5, name: 'step', int: 7 }, { time: 1, name: 'step' }]);
  return setDrawOrder(data, 'wave', [{ time: 0, order: null }, { time: 0.5, order: ['c', 'b', 'a'] }, { time: 1, order: null }]);
}

test('event definitions preserve unrelated fields, defaults, source data and safe names', () => {
  let data = setEvent(fixture(), 'step', { int: 1, string: 'old' });
  (data.events as any).step.editorMetadata = 'preserved';
  const snapshot = JSON.stringify(data), next = setEvent(data, 'step', { string: 'new', float: 2.5 });
  assert.deepEqual((next.events as any).step, { int: 1, string: 'new', float: 2.5, editorMetadata: 'preserved' });
  assert.equal(JSON.stringify(data), snapshot);
  assert.throws(() => setEvent(data, '__proto__', {}), /reserved/);
  assert.throws(() => setEvent(data, 'bad', { int: 2147483648 }), /32-bit/);
  assert.throws(() => setEvent(data, 'bad', { float: Infinity }), /finite/);
  assert.throws(() => setEvent(data, 'bad', { float: 1e100 }), /float32/);
  assert.ok(Object.hasOwn(setEvent(data, 'toString', {}).events as object, 'toString'));
});

test('official runtime emits simultaneous events with inherited and explicit payloads', () => {
  let data = setEvent(fixture(), 'step', { int: 1, float: 0.5, string: '脚步' });
  data = setEvent(data, 'impact', { int: 2 });
  data = setEventTimeline(data, 'wave', [{ time: 0, name: 'step' }, { time: 0.5, name: 'step', int: 7, string: '左脚' }, { time: 0.5, name: 'impact', float: 0.75 }]);
  const runtime = new SkeletonJson(boneDiagramLoader).readSkeletonData(data), skeleton = new Skeleton(runtime), events: Event[] = [];
  runtime.findAnimation('wave')!.apply(skeleton, -1, 1, false, events, 1, MixFrom.setup, false, false, false);
  assert.deepEqual(events.map(event => [event.data.name, event.intValue, event.floatValue, event.stringValue]), [['step', 1, 0.5, '脚步'], ['step', 7, 0.5, '左脚'], ['impact', 2, 0.75, '']]);
  assert.equal(effectiveEvent(data, { name: 'step', time: 0 }).string, '脚步');
});

test('validation rejects missing events, descending times and invalid event payload types', () => {
  const data = setEvent(fixture(), 'step', {});
  assert.throws(() => setEventTimeline(data, 'wave', [{ time: 0, name: 'missing' }]), /missing event/);
  assert.throws(() => setEventTimeline(data, 'wave', [{ time: 1, name: 'step' }, { time: 0, name: 'step' }]), /nondecreasing/);
  assert.throws(() => setEventTimeline(data, 'wave', [{ time: 0, name: 'step', int: 1.25 }]), /32-bit/);
  const malformed = structuredClone(data); (malformed.events as any).step.string = 12;
  assert.throws(() => parseDocument(malformed), /must be a string/);
});

test('every four-slot permutation agrees with the official runtime draw order', () => {
  const data = fixture(); data.slots!.push({ name: 'd', bone: 'root' });
  function permutations(items: string[]): string[][] { return items.length ? items.flatMap((item, index) => permutations(items.filter((_value, other) => index !== other)).map(rest => [item, ...rest])) : [[]]; }
  for (const order of permutations(['a', 'b', 'c', 'd'])) {
    const next = setDrawOrder(data, 'layers', [{ time: 0, order }, { time: 1, order: null }]);
    assert.deepEqual(decodeDrawOrder(next, (next.animations!.layers!.drawOrder as any)[0]), order);
    assert.deepEqual(sampleSkeleton(next, 'layers', 0.5).drawOrder.appliedPose.map(slot => slot.data.name), order);
    assert.deepEqual(sampleSkeleton(next, 'layers', 1).drawOrder.appliedPose.map(slot => slot.data.name), ['a', 'b', 'c', 'd']);
  }
});

test('draw order rejects incomplete permutations, malformed offsets and folder conflicts', () => {
  const data = fixture();
  assert.throws(() => setDrawOrder(data, 'layers', [{ time: 0, order: ['a', 'b'] }]), /every slot/);
  assert.throws(() => setDrawOrder(data, 'layers', [{ time: 0, order: ['a', 'a', 'c'] }]), /every slot/);
  assert.throws(() => decodeDrawOrder(data, { offsets: [{ slot: 'a', offset: 3 }] }), /outside/);
  assert.throws(() => decodeDrawOrder(data, { offsets: [{ slot: 'a', offset: 1 }, { slot: 'b', offset: 0 }] }), /same index/);
  assert.throws(() => decodeDrawOrder(data, { offsets: [{ slot: 'b', offset: 0 }, { slot: 'a', offset: 0 }] }), /setup order/);
  data.animations!.layers = { drawOrderFolder: [{ slots: ['a'], keys: [{ time: 0 }] }] };
  assert.throws(() => setDrawOrder(data, 'layers', [{ time: 0, order: null }]), /folder/);
});

test('retiming transforms Bezier time controls and preserves sampled pose, opacity and events', () => {
  const source = animated(), snapshot = JSON.stringify(source), next = retimeAnimation(source, 'wave', 2, 0.25);
  assert.deepEqual((next.animations!.wave!.bones as any).arm.rotate[0].curve, [0.65, 0, 1.85, 60]);
  assert.deepEqual((next.animations!.wave!.events as any[]).map(key => key.time), [0.25, 1.25, 2.25]);
  for (const time of [0, 0.2, 0.5, 0.8, 1]) {
    const before = samplePose(source, 'wave', time).find(bone => bone.name === 'arm')!, after = samplePose(next, 'wave', time * 2 + 0.25).find(bone => bone.name === 'arm')!;
    assert.ok(Math.abs(before.rotation - after.rotation) < 0.0001);
    assert.ok(Math.abs(before.endX - after.endX) < 0.0001);
    const a = sampleSkeleton(source, 'wave', time), b = sampleSkeleton(next, 'wave', time * 2 + 0.25);
    assert.ok(Math.abs(a.slots[0]!.appliedPose.color.a - b.slots[0]!.appliedPose.color.a) < 0.00001);
    assert.deepEqual(a.drawOrder.appliedPose.map(slot => slot.data.name), b.drawOrder.appliedPose.map(slot => slot.data.name));
  }
  assert.equal(JSON.stringify(source), snapshot);
});

test('retiming handles omitted zero times, 8/16 control arrays and stepped interpolation', () => {
  let data = setTimeline(fixture(), 'wave', 'arm', 'translate', [{ time: 0, x: 0, y: 0, curve: [0.2, 0, 0.8, 4, 0.2, 0, 0.8, 8] }, { time: 1, x: 4, y: 8 }]);
  data = setColorTimeline(data, 'wave', 'a', [{ time: 0, color: 'ffffffff', curve: Array.from({ length: 4 }, () => [0.2, 1, 0.8, 0]).flat() }, { time: 1, color: '00000000' }]);
  const first = (data.animations!.wave!.bones as any).arm.translate[0]; delete first.time;
  const next = retimeAnimation(data, 'wave', 0.5, 0.1);
  assert.equal((next.animations!.wave!.bones as any).arm.translate[0].time, 0.1);
  assert.deepEqual((next.animations!.wave!.bones as any).arm.translate[0].curve, [0.2, 0, 0.5, 4, 0.2, 0, 0.5, 8]);
  for (const time of [0.2, 0.5, 0.8]) {
    const a = sampleSkeleton(data, 'wave', time), b = sampleSkeleton(next, 'wave', time * 0.5 + 0.1);
    assert.ok(Math.abs(a.slots[0]!.appliedPose.color.a - b.slots[0]!.appliedPose.color.a) < 0.0001);
  }
  const stepped = setTimeline(fixture(), 'hold', 'arm', 'rotate', [{ time: 0, value: 0, curve: 'stepped' }, { time: 1, value: 60 }]);
  assert.equal((retimeAnimation(stepped, 'hold', 2, 0).animations!.hold!.bones as any).arm.rotate[0].curve, 'stepped');
});

test('retiming rejects unsupported tracks, negative or collapsed times, and numeric overflow', () => {
  for (const field of ['ik', 'attachments', 'drawOrderFolder', 'customTimeline']) {
    const source = animated(); source.animations!.wave![field] = [{ time: 0 }];
    assert.throws(() => retimeAnimation(source, 'wave', 2, 0), /Cannot safely retime|must be an object|missing .*constraint|Invalid draw-order folder/);
  }
  const data = animated(), snapshot = JSON.stringify(data);
  assert.throws(() => retimeAnimation(data, 'wave', 0, 0), /positive/);
  assert.throws(() => retimeAnimation(data, 'wave', 1, -0.1), /before zero/);
  assert.throws(() => retimeAnimation(data, 'wave', 1, 1e300), /float32/);
  assert.throws(() => retimeAnimation(data, 'wave', 1, 1e8), /collapse/);
  assert.throws(() => retimeAnimation(data, 'wave', 1e-50, 0), /collapse/);
  assert.throws(() => retimeAnimation(data, 'wave', Number.MAX_VALUE, Number.MAX_VALUE), /non-finite/);
  const eventsOnly = setEventTimeline(setEvent(fixture(), 'step', {}), 'events', [{ time: 0, name: 'step' }, { time: 1, name: 'step' }]);
  assert.throws(() => retimeAnimation(eventsOnly, 'events', 1, 1e16), /collapse/);
  assert.equal(JSON.stringify(data), snapshot);
});

test('renaming preserves other strings and updates only matching slider references', () => {
  const data = animated(); data.animations!.other = {}; data.constraints = [{ name: 'slider', type: 'slider', animation: 'wave' }, { name: 'other', type: 'slider', animation: 'other' }];
  const next = renameAnimation(data, 'wave', 'slow');
  assert.equal(Object.hasOwn(next.animations!, 'wave'), false); assert.ok(Object.hasOwn(next.animations!, 'slow'));
  assert.equal((next.constraints as any)[0].animation, 'slow'); assert.equal((next.constraints as any)[1].animation, 'other');
  assert.equal((data.constraints as any)[0].animation, 'wave');
  assert.throws(() => renameAnimation(data, 'wave', 'wave'), /already exists/);
  assert.throws(() => renameAnimation(data, 'missing', 'new'), /not found/);
  assert.throws(() => renameAnimation(data, 'wave', '__proto__'), /reserved/);
});

test('timeline removal is selective, prunes empty maps and keeps event definitions', () => {
  const source = animated(), snapshot = JSON.stringify(source);
  const withoutBone = removeTimeline(source, 'wave', { kind: 'bone', bone: 'arm', channel: 'rotate' });
  assert.equal(withoutBone.animations!.wave!.bones, undefined);
  assert.ok(withoutBone.animations!.wave!.slots); assert.ok(withoutBone.animations!.wave!.events);
  const withoutEvents = removeTimeline(withoutBone, 'wave', { kind: 'events' });
  assert.equal(withoutEvents.animations!.wave!.events, undefined); assert.ok((withoutEvents.events as any).step);
  const cleared = setDrawOrder(setEventTimeline(source, 'wave', []), 'wave', []);
  assert.equal(cleared.animations!.wave!.drawOrder, undefined); assert.equal(cleared.animations!.wave!.events, undefined);
  assert.throws(() => removeTimeline(source, 'wave', { kind: 'slot', slot: 'a', channel: 'alpha' }), /not found/);
  assert.equal(JSON.stringify(source), snapshot);
});

test('removing an alpha channel permits a clean RGBA replacement', () => {
  const data = fixture(); data.animations!.wave = { slots: { a: { alpha: [{ time: 0, value: 1 }, { time: 1, value: 0 }] } } };
  const cleaned = removeTimeline(data, 'wave', { kind: 'slot', slot: 'a', channel: 'alpha' });
  const next = setColorTimeline(cleaned, 'wave', 'a', [{ time: 0, color: 'ffffffff' }, { time: 1, color: 'ffffff00' }]);
  assert.deepEqual(Object.keys((next.animations!.wave!.slots as any).a), ['rgba']);
});

test('loop report identifies attachment, opacity and draw-order endpoint changes', () => {
  let data = animated(); data = setAttachmentTimeline(data, 'wave', 'a', [{ time: 0, name: 'art' }, { time: 1, name: null }]);
  data = setDrawOrder(data, 'wave', [{ time: 0, order: null }, { time: 1, order: ['c', 'b', 'a'] }]);
  const report = loopCheck(data, 'wave');
  assert.equal(report.endpointMismatches.length, 1); assert.equal(report.slotMismatches.length, 2); assert.equal(report.drawOrderMismatch, true);
  assert.throws(() => loopCheck(data, 'toString'), /not found/);
});

test('verification compares resolved draw order and effective event values, not serialization details', () => {
  let source = setEvent(fixture(), 'step', { int: 0, float: 0.5 });
  source = setEvent(source, 'impact', {});
  source = setEventTimeline(source, 'wave', [{ time: 0.5, name: 'step' }, { time: 0.5, name: 'impact' }]);
  source = setDrawOrder(source, 'wave', [{ time: 0, order: ['b', 'a', 'c'] }]);
  const actual = structuredClone(source);
  actual.animations!.wave!.drawOrder = [{ offsets: [{ slot: 'a', offset: 1 }] }];
  actual.animations!.wave!.events = [{ time: 0.5, name: 'impact', int: 0, float: 0, string: '' }, { time: 0.5, name: 'step', int: 0, float: 0.5, string: '' }];
  delete (actual.events as any).step.int;
  assert.equal(verifyRoundTrip(source, actual, 'a.json', 'a.json').passed, true);
});

test('verification rejects lost event payloads, incorrect timing, order and timeline removal', () => {
  const source = animated();
  for (const tamper of [
    (data: SpineDocument) => { (data.events as any).step.int = 4; },
    (data: SpineDocument) => { (data.animations!.wave!.events as any)[1].string = 'wrong'; },
    (data: SpineDocument) => { (data.animations!.wave!.events as any)[1].time = 0.6; },
    (data: SpineDocument) => { (data.animations!.wave!.drawOrder as any)[1] = { time: 0.5 }; },
    (data: SpineDocument) => { delete data.animations!.wave!.slots; },
  ]) {
    const actual = structuredClone(source); tamper(actual);
    assert.throws(() => verifyRoundTrip(source, actual, 'a.json', 'a.json'), /verification failed/);
  }
});

test('project workflow refuses to publish a changed event payload after CLI round-trip', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-events-'))), workspace = new Workspace(root);
  const source = await writeDocument(workspace, 'original.json', animated()), before = await readFile(source.path, 'utf8');
  const cli = {
    async importProject(input: string, output: string) { await writeFile(output, await readFile(input), { flag: 'wx' }); return { path: output, log: '', warning: '' }; },
    async exportData(input: string) {
      const data = await readDocument(input); (data.animations!.slow!.events as any)[1].int = 999;
      const exported = await writeDocument(workspace, 'tampered.json', data);
      return { files: [exported.path], outputDirectory: root, log: '', warning: undefined };
    },
  };
  const destination = path.join(root, 'result.spine');
  await assert.rejects(editProject(workspace, cli, source.path, destination, [editSchema.parse({ type: 'rename_animation', animation: 'wave', newName: 'slow' })]), /verification failed/);
  await assert.rejects(stat(destination), /ENOENT/); assert.equal(await readFile(source.path, 'utf8'), before);
});
