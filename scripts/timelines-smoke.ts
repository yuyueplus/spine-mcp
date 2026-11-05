import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MeshAttachment, SkeletonBinary, SliderData } from '@esotericsoftware/spine-core';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/file-hash.js';
import { readDocument, type SpineDocument } from '../src/document.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { constraintTypes } from '../src/constraint-data.js';
import { boneDiagramLoader, sampleSkeleton } from '../src/runtime.js';
import { encodePng } from '../src/raster.js';
import type { DetailedTimelineTarget as Target, TimelineMapping } from '../src/timeline-tools.js';

const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); return JSON.parse(block.text);
}
function sample(data: SpineDocument, animation: string, time: number, slotName: string) {
  const skeleton = sampleSkeleton(data, animation, time, 'day'), slot = skeleton.slots.find(item => item.data.name === slotName)!, mesh = slot.appliedPose.attachment as MeshAttachment;
  assert.ok(mesh instanceof MeshAttachment); const world = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2);
  return { world, frame: mesh.sequence.resolveIndex(slot.appliedPose), color: [slot.appliedPose.color.r, slot.appliedPose.color.g, slot.appliedPose.color.b, slot.appliedPose.color.a], order: skeleton.drawOrder.appliedPose.map(slot => slot.data.name) };
}
async function compare(before: string, from: string, after: string, to: string, fromSlot: string, toSlot: string, timeMap: (time: number) => number, checkSequence = true, checkOrder = true, times = [0, 0.13, 0.25, 0.5, 0.8, 1, 1.3, 1.5, 1.8, 2]) {
  const a = await readDocument(before), b = await readDocument(after); let maxError = 0;
  for (const time of times) {
    const x = sample(a, from, time, fromSlot), y = sample(b, to, timeMap(time), toSlot);
    assert.equal(x.world.length, y.world.length); if (checkSequence) assert.equal(x.frame, y.frame); if (checkOrder) assert.deepEqual(x.order, y.order);
    maxError = Math.max(maxError, ...[...x.world, ...x.color].map((value, index) => Math.abs(value - [...y.world, ...y.color][index]!)));
  }
  assert.ok(maxError < 0.0002, `${from}/${fromSlot} -> ${to}/${toSlot}: ${maxError}`); return maxError;
}
try {
  assert.equal((await client.listTools()).tools.length, TOOL_COUNT); assert.equal(client.getServerVersion()?.version, VERSION);
  const status = await call('spine_status', {}); assert.equal(status.capabilities.selectiveTimelineCopyAndMapping, true);
  const demo = await call('spine_create_demo', {}), output = (name: string) => path.join(demo.directory, name), hashes = new Map<string, string>();
  for (const filename of [demo.path, path.join(demo.images, 'arm.png')]) hashes.set(filename, await fileSha256(filename));
  for (let frame = 1; frame <= 3; frame++) {
    const pixels = new Uint8Array(120 * 24 * 4);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 120; x++) pixels.set(x < 2 || x >= 118 || y < 2 || y >= 22 ? [35, 61, 57, 255] : [[65, 211, 157, 255], [245, 177, 67, 255], [109, 160, 245, 255]][frame - 1]!, (y * 120 + x) * 4);
    const filename = path.join(demo.images, `cycle${frame}.png`); await writeFile(filename, encodePng(120, 24, pixels), { flag: 'wx' }); hashes.set(filename, await fileSha256(filename));
  }
  const source = { skin: 'day', slot: 'arm-slot', name: 'arm' }, target = { skin: 'day', slot: 'copy-slot', name: 'copy' }, linked = { skin: 'day', slot: 'linked-slot', name: 'inherited' };
  const edits: Record<string, unknown>[] = [
    { type: 'set_bone', bone: 'root', transform: { rotation: 12, shearY: 9 } },
    { type: 'set_bone', bone: 'arm', transform: { rotation: 11, scaleX: 1.2, scaleY: 0.8 } },
    { type: 'add_bone', name: 'tip', parent: 'root', transform: { x: 80, y: -20, rotation: -17, scaleX: -0.9, scaleY: 1.2, length: 35 } },
    ...constraintTypes.flatMap(type => ['a', 'b'].map(suffix => ({ type: 'add_bone', name: `${type}-${suffix}`, parent: 'root', transform: { x: -30, length: 30 } }))),
    { type: 'add_bone', name: 'control', parent: 'root', transform: { x: 50, y: 50 } },
    ...['copy-slot', 'linked-slot', 'path-slot'].map(name => ({ type: 'add_slot', name, bone: name === 'path-slot' ? 'root' : 'arm' })),
    { type: 'add_skin', name: 'night', copyFrom: 'default', baseSkin: 'day' },
    { type: 'set_attachment', ...source, replace: true, attachment: { type: 'mesh', path: 'cycle', sequence: { count: 3 }, width: 120, height: 24, uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, -12, 0, 12, 120, 12, 120, -12], triangles: [0, 1, 2, 0, 2, 3], hull: 4 } },
    { type: 'set_weights', ...source, weights: Array.from({ length: 4 }, (_, index) => [{ bone: 'arm', weight: 0.8 - index * 0.15 }, { bone: 'tip', weight: 0.2 + index * 0.15 }]) },
    { type: 'copy_attachment', from: source, to: target, copyTimelines: false, setAsSetup: true },
    { type: 'link_mesh', from: source, to: linked, setAsSetup: true },
    { type: 'set_attachment', skin: 'day', slot: 'path-slot', name: 'curve', attachment: { type: 'path', vertexCount: 6, vertices: [-10, 0, 0, 0, 33, 0, 66, 0, 100, 0, 110, 0], lengths: [100] }, setAsSetup: true },
    { type: 'set_timeline', animation: 'z-pose', bone: 'slider-a', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 5 }] },
  ];
  for (const type of constraintTypes) for (const [name, suffix] of [['控制', 'a'], ['目标', 'b']]) {
    const common = { name, type, skin: false }, definition = type === 'ik' ? { ...common, bones: [`${type}-${suffix}`], target: 'control' }
      : type === 'transform' ? { ...common, bones: [`${type}-${suffix}`], source: 'control', properties: Object.fromEntries(['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'].map(property => [property, { to: { [property]: {} } }])) }
      : type === 'path' ? { ...common, bones: [`${type}-${suffix}`], slot: 'path-slot' } : type === 'physics' ? { ...common, bone: `${type}-${suffix}`, rotate: 1 } : { ...common, animation: 'z-pose' };
    edits.push({ type: 'set_constraint', definition });
  }
  edits.push(
    { type: 'set_timeline', animation: 'a-action', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0, curve: [0.2, 0, 0.8, 30] }, { time: 1, value: 30, curve: [1.2, 30, 1.8, 0] }, { time: 2, value: 0 }] },
    { type: 'set_timeline', animation: 'a-action', bone: 'tip', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: -20 }, { time: 2, value: 0 }] },
    { type: 'set_color_timeline', animation: 'a-action', slot: 'arm-slot', keyframes: [{ time: 0, color: 'ffffffff', curve: Array.from({ length: 4 }, () => [0.2, 1, 0.8, 0.5]).flat() }, { time: 1, color: '80808080' }, { time: 2, color: 'ffffffff' }] },
    { type: 'set_attachment_animation', animation: 'a-action', ...source, channel: 'deform', keyframes: [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, offset: 3, vertices: [11, -3, 13, 2, -8] }, { time: 2 }] },
    { type: 'set_attachment_animation', animation: 'a-action', ...source, channel: 'sequence', keyframes: [{ time: 0, mode: 'loop', delay: 0.25 }, { time: 2, mode: 'hold', index: 1 }] },
    { type: 'set_event', name: 'step', defaults: { int: 1, string: '脚步' } }, { type: 'set_event', name: 'impact', defaults: { float: 0.5 } },
    { type: 'set_event_timeline', animation: 'a-action', keyframes: [{ time: 0.5, name: 'step', int: 7 }, { time: 0.5, name: 'impact' }, { time: 1.5, name: 'step' }] },
    { type: 'set_draw_order', animation: 'a-action', keyframes: [{ time: 0, order: null }, { time: 1, order: ['copy-slot', 'linked-slot', 'arm-slot', 'path-slot'] }, { time: 2, order: null }] },
  );
  for (const type of constraintTypes) {
    const channel = type === 'ik' || type === 'transform' ? 'parameters' : type === 'path' ? 'position' : type === 'physics' ? 'wind' : 'time';
    const fields = ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'];
    const keyframes = type === 'ik' ? [{ time: 0, mix: 1, softness: 0, curve: [0.2, 1, 0.8, 0.5, 0.2, 0, 0.8, 2] }, { time: 1, mix: 0.5, softness: 2 }, { time: 2, mix: 1, softness: 0 }]
      : type === 'transform' ? [{ time: 0, ...Object.fromEntries(fields.map(field => [field, 1])), curve: Array.from({ length: 6 }, () => [0.2, 1, 0.8, 0.5]).flat() }, { time: 1, ...Object.fromEntries(fields.map(field => [field, 0.5])) }, { time: 2, ...Object.fromEntries(fields.map(field => [field, 1])) }]
      : [{ time: 0, value: 0, curve: [0.2, 0, 0.8, type === 'physics' ? 15 : 1] }, { time: 1, value: type === 'physics' ? 15 : 1 }, { time: 2, value: 0 }];
    edits.push({ type: 'set_constraint_timeline', animation: 'a-action', constraint: '控制', constraintType: type, channel, keyframes });
  }
  edits.push({ type: 'set_constraint_timeline', animation: 'a-action', constraint: '', constraintType: 'physics', channel: 'mix', keyframes: [{ time: 0, value: 1 }, { time: 1, value: 0.5 }, { time: 2, value: 1 }] });
  const prepared = await call('spine_apply_edits', { input: demo.path, output: output('prepared.json'), edits });
  const data = await readDocument(prepared.path), targetValue = attachmentEntries(data).find(item => item.skin === target.skin && item.slot === target.slot && item.name === target.name)!.value, raw = targetValue.vertices as number[];
  for (let offset = 0; offset < raw.length; offset += 9) { const a = raw.slice(offset + 1, offset + 5), b = raw.slice(offset + 5, offset + 9); raw.splice(offset + 1, 8, ...b, ...a); }
  const unsorted = output('unsorted.json'); await writeFile(unsorted, JSON.stringify(data, null, 2), { flag: 'wx' }); hashes.set(unsorted, await fileSha256(unsorted));
  const inventory = await call('spine_inspect_timelines', { input: unsorted, animation: 'a-action' }), page = await call('spine_inspect_timelines', { input: unsorted, animation: 'a-action', offset: 1, limit: 2 });
  assert.equal(inventory.total, 13); assert.equal(page.tracks.length, 2); assert.equal(page.nextOffset, 3);
  const mappings: TimelineMapping[] = inventory.tracks.map((item: { target: Target }) => ({ from: item.target, to: item.target.kind === 'constraint' && item.target.constraint ? { ...item.target, constraint: '目标' } : item.target }));
  mappings.push({ from: { kind: 'attachment', ...linked, channel: 'deform' }, to: { kind: 'attachment', ...target, channel: 'deform' } }, { from: { kind: 'attachment', ...linked, channel: 'sequence' }, to: { kind: 'attachment', ...target, channel: 'sequence' } }, { from: { kind: 'slot', slot: 'arm-slot', channel: 'rgba' }, to: { kind: 'slot', slot: 'copy-slot', channel: 'rgba' } });
  const copied = await call('spine_copy_timelines', { input: unsorted, output: output('copied.json'), fromAnimation: 'a-action', toAnimation: 'b-reused', mappings, timeScale: 2, timeOffset: 0.25 }); hashes.set(copied.path, await fileSha256(copied.path));
  const errors: Record<string, number> = { scaledOriginal: await compare(unsorted, 'a-action', copied.path, 'b-reused', 'arm-slot', 'arm-slot', time => time * 2 + 0.25), remappedWeightedCopy: await compare(unsorted, 'a-action', copied.path, 'b-reused', 'arm-slot', 'copy-slot', time => time * 2 + 0.25) };
  const targets = mappings.map(item => item.to), retimed = await call('spine_retime_keyframes', { input: copied.path, output: output('retimed.json'), animation: 'b-reused', targets, start: 2.25, end: 2.25, timeOffset: 0.5 });
  const rangeMap = (time: number) => time <= 1 ? 0.25 + time * 2.5 : 2.75 + (time - 1) * 1.5;
  errors.partialOriginal = await compare(unsorted, 'a-action', retimed.path, 'b-reused', 'arm-slot', 'arm-slot', rangeMap, false);
  errors.partialWeightedCopy = await compare(unsorted, 'a-action', retimed.path, 'b-reused', 'arm-slot', 'copy-slot', rangeMap, false);
  const events = await call('spine_retime_keyframes', { input: retimed.path, output: output('events.json'), animation: 'b-reused', targets: [{ kind: 'events' }], start: 1.25, end: 1.25, timeOffset: 0.25 });
  assert.deepEqual(((await readDocument(events.path)).animations!['b-reused'] as any).events.map((key: any) => key.time), [1.5, 1.5, 3.25]);
  const invalidPath = output('blocked.json'), invalid = await client.callTool({ name: 'spine_copy_timelines', arguments: { input: events.path, output: invalidPath, fromAnimation: 'a-action', toAnimation: 'b-reused', mappings: [mappings[0]] } });
  assert.equal(invalid.isError, true); await assert.rejects(stat(invalidPath), /ENOENT/);
  const blockedRange = output('crossing.json'), crossing = await client.callTool({ name: 'spine_retime_keyframes', arguments: { input: events.path, output: blockedRange, animation: 'b-reused', targets: [{ kind: 'bone', bone: 'arm', channel: 'rotate' }], start: 2.75, end: 2.75, timeOffset: 2 } });
  assert.equal(crossing.isError, true); await assert.rejects(stat(blockedRange), /ENOENT/);
  console.log('Registered timeline tools passed weighted remapping, effective links, Bezier boundary retiming and simultaneous events. Checking native projects...');
  const all = (await call('spine_inspect_timelines', { input: events.path, animation: 'b-reused' })).tracks.map((item: { target: Target }) => ({ from: item.target, to: item.target }));
  const project = await call('spine_edit_project', { input: events.path, output: output('时间轴选择性复用.spine'), skeletonName: 'timeline-editing', edits: [{ type: 'copy_timelines', fromAnimation: 'b-reused', toAnimation: 'd-native-copy', mappings: all }] }); assert.equal(project.verification.passed, true); hashes.set(project.output, await fileSha256(project.output));
  errors.nativeGeometryAndTint = await compare(events.path, 'b-reused', project.exportedJson, 'd-native-copy', 'copy-slot', 'copy-slot', time => time, true, true, [0.25, 0.5, 1.25, 2, 2.75, 3.25, 4.25]);
  const native = await call('spine_edit_project', { input: project.output, output: output('原生工程局部调时.spine'), edits: [{ type: 'retime_keyframes', animation: 'd-native-copy', targets: [{ kind: 'bone', bone: 'arm', channel: 'rotate' }], start: 2.75, end: 2.75, timeOffset: 0.25 }] }); assert.equal(native.verification.passed, true);
  const binary = await call('spine_export', { input: native.output, format: 'binary' }), binaryFile = binary.files.find((file: string) => file.endsWith('.skel')), runtime = new SkeletonBinary(boneDiagramLoader).readSkeletonData(await readFile(binaryFile));
  assert.equal(runtime.constraints.length, 10); assert.ok(runtime.constraints.filter(item => item instanceof SliderData).every(item => (item as SliderData).animation.name === 'z-pose'));
  const preview = await call('spine_render_artwork', { input: native.output, animation: 'd-native-copy', skin: 'day', times: [0.25, 1.25, 2.5, 3.25, 4.25] });
  const multi = await call('spine_build_project', { entries: [{ input: native.exportedJson, name: 'timelines' }, { input: demo.path, name: 'untouched' }], output: output('timelines-multi.spine') }); assert.equal(multi.checks.length, 2);
  const multiEdited = await call('spine_edit_multi_project', { input: multi.output, output: output('timelines-multi-edited.spine'), changes: [{ name: 'timelines', edits: [{ type: 'copy_timelines', fromAnimation: 'd-native-copy', toAnimation: 'e-multi-copy', mappings: [{ from: { kind: 'bone', bone: 'arm', channel: 'rotate' }, to: { kind: 'bone', bone: 'tip', channel: 'rotate' } }] }] }] }); assert.equal(multiEdited.checks.length, 2);
  const job = await call('spine_start_job', { operation: 'edit_project', args: { input: native.output, output: output('后台时间轴编辑.spine'), edits: [{ type: 'copy_timelines', fromAnimation: 'd-native-copy', toAnimation: 'f-detached', mappings: all }, { type: 'retime_keyframes', animation: 'f-detached', targets: [{ kind: 'bone', bone: 'arm', channel: 'rotate' }], start: 3, end: 3, timeOffset: 0.25 }] } });
  console.log('Native project/binary Slider bindings and multi-skeleton timeline editing passed. Closing MCP to check detached execution...');
  await client.close(); const reopened = await connectSpine(); let completed: any;
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await reopened.client.callTool({ name: 'spine_get_job', arguments: { id: job.id, includeResult: true } });
      const block = response.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); completed = JSON.parse(block.text);
      if (['succeeded', 'failed', 'cancelled'].includes(completed.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(completed.state, 'succeeded', JSON.stringify(completed)); assert.equal(completed.result.verification.passed, true);
  } finally { await reopened.client.close(); }
  for (const [filename, hash] of hashes) assert.equal(await fileSha256(filename), hash, `Changed source: ${filename}`);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, sourceInventory: inventory, copiedChannels: mappings.length, sampledTimes: [0, 0.13, 0.25, 0.5, 0.8, 1, 1.3, 1.5, 1.8, 2], errors, weightedInfluenceRemappingVerified: true, effectiveInheritedTimelineReadVerified: true, adjacentBezierIntervalsVerified: true, simultaneousEventsVerified: true, sameNameConstraintTypesAndGlobalPhysicsVerified: true, binarySliderBindingsVerified: true, existingTargetAndCrossingErrorsPublishNoFile: true, sourceAndImageBytesUnchanged: true, hashes: Object.fromEntries(hashes), project, native, binaryFile, preview, multi, multiEdited, job: completed, workerSurvivedMcpDisconnect: true, limits: ['Copies use local values within one skeleton, with explicit replacement and compatible deform indices; no world-space retargeting or clip merging.', 'Range retiming keeps key order and normalized interval easing. No keys are synthesized at range boundaries; sequence delays stay unchanged.', 'Flatten folder draw order before selective editing; stored keys on inheriting linked meshes are not writable.'] };
  const reportPath = path.join(projectRoot, 'work/timelines-report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, project: native.output, preview: preview.path, errors, workerSurvivedMcpDisconnect: true }, null, 2));
} finally { await client.close(); }
