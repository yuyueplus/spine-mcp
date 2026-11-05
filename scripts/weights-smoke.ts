import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MeshAttachment, SkeletonBinary, SliderData } from '@esotericsoftware/spine-core';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/project-workflow.js';
import { readDocument } from '../src/document.js';
import { boneDiagramLoader, sampleSkeleton } from '../src/runtime.js';
import { constraintTypes } from '../src/constraint-data.js';
import { canonicalizeWeights } from '../src/weight-order.js';

const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); return JSON.parse(block.text);
}
async function geometry(filename: string) {
  const skeleton = sampleSkeleton(await readDocument(filename), undefined, 0), slot = skeleton.slots.find(slot => slot.data.name === 'arm-slot')!, mesh = slot.appliedPose.attachment as MeshAttachment;
  const values = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, values.length, values, 0, 2); return values;
}
try {
  assert.equal((await client.listTools()).tools.length, TOOL_COUNT); assert.equal(client.getServerVersion()?.version, VERSION);
  const status = await call('spine_status', {}); assert.equal(status.capabilities.typedConstraintIdentity, true);
  const demo = await call('spine_create_demo', {}), sourceHash = await fileSha256(demo.path), image = path.join(demo.images, 'arm.png'), imageHash = await fileSha256(image);
  const output = (name: string) => path.join(demo.directory, name), shared = '控制';
  const edits: Record<string, unknown>[] = [];
  for (const [name, x, y, length] of [['tip', 120, 0, 60], ['control', 60, 70, 20], ['ik-bone', -20, -30, 80], ['transform-bone', 0, 0, 30], ['physics-bone', -40, 30, 60], ['path-bone', 0, 0, 30], ['slider-bone', 0, -50, 40]] as const) edits.push({ type: 'add_bone', name, parent: 'root', transform: { x, y, length } });
  edits.push(
    { type: 'set_timeline', animation: 'z-pose', bone: 'slider-bone', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 60 }] },
    { type: 'set_timeline', animation: 'a-motion', bone: 'tip', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 45 }, { time: 1, value: 0 }] },
    { type: 'add_slot', name: 'path-slot', bone: 'root' },
    { type: 'set_attachment', skin: 'default', slot: 'path-slot', name: 'curve', attachment: { type: 'path', vertexCount: 6, vertices: [-10, -35, 0, -35, 33, -35, 66, -35, 100, -35, 110, -35], lengths: [100] }, setAsSetup: true },
    { type: 'set_constraint', definition: { type: 'ik', name: shared, bones: ['ik-bone'], target: 'control', skin: true } },
    { type: 'set_constraint', definition: { type: 'transform', name: shared, bones: ['transform-bone'], source: 'control', properties: { x: { to: { x: {} } } }, skin: true } },
    { type: 'set_constraint', definition: { type: 'path', name: shared, bones: ['path-bone'], slot: 'path-slot', skin: true } },
    { type: 'set_constraint', definition: { type: 'physics', name: shared, bone: 'physics-bone', rotate: 1, wind: 15, skin: true } },
    { type: 'set_constraint', definition: { type: 'slider', name: shared, animation: 'z-pose', time: 0.25, skin: true } },
    { type: 'add_skin', name: 'active' },
    { type: 'set_skin_members', skin: 'active', bones: ['ik-bone', 'transform-bone', 'path-bone', 'physics-bone', 'slider-bone'], constraints: constraintTypes.map(type => ({ name: shared, type })) },
  );
  for (const [constraintType, channel, keyframes] of [
    ['ik', 'parameters', [{ time: 0, mix: 1 }, { time: 1, mix: 0.7 }]],
    ['transform', 'parameters', [{ time: 0, mixX: 0.5 }, { time: 1, mixX: 1 }]],
    ['path', 'position', [{ time: 0, value: 0.2 }, { time: 1, value: 0.8 }]],
    ['physics', 'wind', [{ time: 0, value: 15 }, { time: 1, value: 20 }]],
    ['slider', 'time', [{ time: 0, value: 0 }, { time: 1, value: 1 }]],
  ] as const) edits.push({ type: 'set_constraint_timeline', animation: 'a-motion', constraint: shared, constraintType, channel, keyframes });
  const prepared = await call('spine_apply_edits', { input: demo.path, output: output('typed.json'), edits });
  const ambiguousPath = output('ambiguous.json'), ambiguous = await client.callTool({ name: 'spine_set_constraint_timeline', arguments: { input: prepared.path, output: ambiguousPath, animation: 'a-motion', constraint: shared, keyframes: [{ time: 0 }] } });
  assert.equal(ambiguous.isError, true); await assert.rejects(stat(ambiguousPath), /ENOENT/);
  const mesh = await call('spine_mesh_from_region', { input: prepared.path, output: output('mesh.json'), skin: 'default', slot: 'arm-slot', name: 'arm', columns: 4, rows: 2 });
  const meshJson = await readDocument(mesh.path), uvs = (meshJson.skins as any)[0].attachments['arm-slot'].arm.uvs as number[];
  const weighted = await call('spine_set_weights', { input: mesh.path, output: output('weights.json'), skin: 'default', slot: 'arm-slot', name: 'arm', weights: Array.from({ length: 15 }, (_, vertex) => [{ bone: 'tip', weight: 0.05 + uvs[vertex * 2]! * 0.8 }, { bone: 'arm', weight: 0.94 - uvs[vertex * 2]! * 0.8 }, { bone: 'root', weight: 0.01 }]) });
  const info = await call('spine_inspect_weights', { input: weighted.path, skin: 'default', slot: 'arm-slot', name: 'arm', limit: 5 });
  assert.equal(info.vertexCount, 15); assert.equal(info.nextOffset, 5); assert.equal(info.maxInfluences, 3);
  assert.deepEqual(info.vertices[0].influences.map((item: any) => item.bone), ['root', 'arm', 'tip']);
  const deformed = await call('spine_apply_edits', { input: weighted.path, output: output('deformed.json'), edits: [
    { type: 'add_slot', name: 'linked-slot', bone: 'root' },
    { type: 'set_attachment', skin: 'default', slot: 'linked-slot', name: 'copy', attachment: { type: 'mesh', path: 'arm', source: 'arm', slot: 'arm-slot', timelines: false } },
    { type: 'set_attachment_animation', animation: 'a-motion', skin: 'default', slot: 'arm-slot', name: 'arm', channel: 'deform', keyframes: [{ time: 0 }, { time: 0.5, offset: 3, vertices: [0, 2, 0, 4, 0, 6] }, { time: 1 }] },
    { type: 'set_attachment_animation', animation: 'a-motion', skin: 'default', slot: 'linked-slot', name: 'copy', channel: 'deform', keyframes: [{ time: 0 }, { time: 1, offset: 1, vertices: [1, 2, 3] }] },
  ] });
  const blockedPath = output('blocked-clean.json'), blocked = await client.callTool({ name: 'spine_clean_weights', arguments: { input: deformed.path, output: blockedPath, skin: 'default', slot: 'arm-slot', name: 'arm' } });
  assert.equal(blocked.isError, true); await assert.rejects(stat(blockedPath), /ENOENT/);
  const unsortedPath = output('unsorted-deform.json'); await writeFile(unsortedPath, JSON.stringify(canonicalizeWeights(await readDocument(deformed.path), true), null, 2), { flag: 'wx' });
  console.log('Registered weight tools and five same-name constraints passed. Checking native weighted deformation import...');
  const orderProject = await call('spine_edit_project', { input: unsortedPath, output: output('权重顺序与变形.spine'), skeletonName: 'weights', edits: [{ type: 'set_bone', bone: 'tip', transform: { length: 70 } }] });
  assert.equal(orderProject.verification.passed, true);
  const cleaned = await call('spine_clean_weights', { input: deformed.path, output: output('cleaned.json'), skin: 'default', slot: 'arm-slot', name: 'arm', maxInfluences: 2, minWeight: 0.02, clearDeform: true });
  assert.equal((await call('spine_inspect_weights', { input: cleaned.path, skin: 'default', slot: 'arm-slot', name: 'arm' })).maxInfluences, 2);
  const smoothed = await call('spine_smooth_weights', { input: cleaned.path, output: output('smoothed.json'), skin: 'default', slot: 'arm-slot', name: 'arm', strength: 0.4, iterations: 3, maxInfluences: 2 });
  const before = await geometry(weighted.path), after = await geometry(smoothed.path), setupMaxError = Math.max(...after.map((value, index) => Math.abs(value - before[index]!)));
  assert.ok(setupMaxError < 0.0001); const preview = await call('spine_render_artwork', { input: smoothed.path, animation: 'a-motion', skin: 'active', times: [0, 0.25, 0.5, 0.75, 1] });
  const project = await call('spine_edit_project', { input: smoothed.path, output: output('同名约束与权重平滑.spine'), skeletonName: 'weights', edits: [{ type: 'set_bone', bone: 'tip', transform: { length: 70 } }] });
  assert.equal(project.verification.passed, true);
  const projectPreview = await call('spine_render_artwork', { input: project.output, animation: 'a-motion', skin: 'active', times: [0, 0.25, 0.5, 0.75, 1] });
  const binary = await call('spine_export', { input: project.output, format: 'binary' }), runtime = new SkeletonBinary(boneDiagramLoader).readSkeletonData(await readFile(binary.files.find((file: string) => file.endsWith('.skel'))));
  assert.equal(runtime.constraints.filter(item => item.name === shared).length, 5);
  assert.equal((runtime.constraints.find(item => item instanceof SliderData) as SliderData).animation.name, 'z-pose');
  const typedProject = await call('spine_edit_project', { input: project.output, output: output('按类型修改约束.spine'), edits: [
    { type: 'rename', target: { kind: 'constraint', name: shared, constraintType: 'ik' }, newName: '瞄准' },
    { type: 'delete', target: { kind: 'constraint', name: shared, constraintType: 'physics' }, cascade: true },
  ] }); assert.equal(typedProject.verification.passed, true);
  const multi = await call('spine_build_project', { entries: [{ input: smoothed.path, name: 'weights' }, { input: demo.path, name: 'untouched' }], output: output('multi.spine') });
  assert.equal(multi.checks.length, 2);
  const job = await call('spine_start_job', { operation: 'edit_project', args: { input: project.output, output: output('后台清理权重.spine'), edits: [{ type: 'clean_weights', skin: 'default', slot: 'arm-slot', name: 'arm', maxInfluences: 1 }] } });
  console.log('Native projects, binary Slider binding and multi-skeleton import passed. Checking detached weight job...');
  await client.close(); const reopened = await connectSpine(); let completed: any;
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await reopened.client.callTool({ name: 'spine_get_job', arguments: { id: job.id, includeResult: true } });
      const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); completed = JSON.parse(block.text);
      if (['succeeded', 'failed', 'cancelled'].includes(completed.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(completed.state, 'succeeded', JSON.stringify(completed)); assert.equal(completed.result.verification.passed, true);
  } finally { await reopened.client.close(); }
  assert.equal(await fileSha256(demo.path), sourceHash); assert.equal(await fileSha256(image), imageHash);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, source: demo.path, sourceHash, image, imageHash, sourceUnchanged: true, imageUnchanged: true, paginatedWeightsVerified: true, typedConstraintsVerified: 5, ambiguousSelectionBlockedBeforePublication: true, sourceAndLinkedDeformGuardVerified: true, unsortedWeightedDeformsVerified: true, setupMaxError, cleanupAndSmoothingVerified: true, binarySliderBindingVerified: true, orderProject, project, typedProject, multi, detachedJob: completed, workerSurvivedMcpDisconnect: true, preview, projectPreview };
  const reportPath = path.join(projectRoot, 'work/weights-report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, output: project.output, preview: preview.path, setupMaxError, workerSurvivedMcpDisconnect: true }, null, 2));
} finally { await client.close(); }
