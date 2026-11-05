import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/file-hash.js';
import { readDocument, type SpineDocument } from '../src/document.js';
import { encodePng } from '../src/raster.js';
import { SkeletonBinary } from '@esotericsoftware/spine-core';
import { boneDiagramLoader } from '../src/runtime.js';

let connection = await connectSpine();
async function call(name: string, args: Record<string, unknown>, error = false): Promise<any> { const result = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }); if (error) { assert.equal(result.isError, true); return result; } assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`); const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); return JSON.parse(block.text); }
const invoked = new Set<string>();
async function invoke(name: string, args: Record<string, unknown>) { invoked.add(name); return call(name, args); }
try {
  assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT);
  const demo = await call('spine_create_demo', {}), directory = demo.directory as string, sourceHash = await fileSha256(demo.path), image = path.join(demo.images, 'arm.png'), imageHash = await fileSha256(image);
  const output = (name: string) => path.join(directory, `${name}.json`), ref = { skin: 'day', slot: 'arm-slot', name: 'arm' }, target = { kind: 'bone', bone: 'arm', channel: 'rotate' };
  let current = (await call('spine_apply_edits', { input: demo.path, output: output('prepared'), edits: [{ type: 'add_skin', name: 'day', copyFrom: 'default', baseSkin: 'base' }, { type: 'mesh_from_region', ...ref }, { type: 'add_animation', name: 'wave' }, { type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0, curve: [0.2, 0, 0.8, 30] }, { time: 1, value: 30 }, { time: 2, value: 0 }] }] })).path;
  const audit = await invoke('spine_audit_assets', { input: current }); assert.equal(audit.valid, true);
  const preflight = await invoke('spine_preflight_edits', { input: current, edits: [{ type: 'set_bone', bone: 'arm', transform: { x: 4 } }] }); assert.ok(preflight.changes > 0); assert.equal(preflight.publishesProject, false);
  current = (await invoke('spine_edit_keyframes', { input: current, output: output('keys'), animation: 'wave', target, action: 'upsert', collision: 'overwrite', keyframes: [{ time: 1, value: 35 }] })).path;
  current = (await invoke('spine_edit_curves', { input: current, output: output('curves'), animation: 'wave', target, times: [0], curve: [0.2, 0, 0.8, 35] })).path;
  const beforeSplit = current;
  current = (await invoke('spine_insert_boundary_keys', { input: current, output: output('boundary'), animation: 'wave', targets: [target], times: [0.3, 0.7] })).path;
  const comparison = await invoke('spine_compare_projects', { input: beforeSplit, other: current, animation: 'wave', skin: 'day', times: [0, 0.13, 0.3, 0.7, 0.83, 1, 2], tolerance: 0.001, render: true }); assert.equal(comparison.withinTolerance, true);
  current = (await invoke('spine_paste_keyframes', { input: current, output: output('pasted'), fromAnimation: 'wave', toAnimation: 'pasted', mappings: [{ from: target, to: target }], start: 0.3, end: 0.7, destination: 0, boundaries: true })).path;
  current = (await invoke('spine_key_pose', { input: current, output: output('pose'), animation: 'pose', sourceAnimation: 'wave', time: 0.5, destination: 0, bones: ['arm'], skin: 'day' })).path;
  const crossSource = current;
  current = (await invoke('spine_transfer_animation', { input: current, output: output('transferred'), source: crossSource, animation: 'pasted', newName: 'transferred' })).path;
  current = (await invoke('spine_transfer_rig', { input: current, output: output('branch'), source: demo.path, root: 'arm', parent: 'root', prefix: 'copy-' })).path;
  current = (await invoke('spine_merge_skins', { input: current, output: output('skins'), skins: ['base', 'day'], newName: 'combined', collision: 'first' })).path;
  const loop = await invoke('spine_check_visual_loop', { input: current, animation: 'wave', skin: 'day' }); assert.equal(loop.poseContinuous, true);
  current = (await invoke('spine_edit_mesh_vertices', { input: current, output: output('vertices'), ...ref, changes: [{ index: 4, x: 65, u: 0.52 }] })).path;
  current = (await invoke('spine_refine_selected_triangles', { input: current, output: output('local-refine'), ...ref, triangles: [0, 1] })).path;
  const topology = await invoke('spine_check_mesh_intersections', { input: current, ...ref }); assert.equal(topology.intersections.length, 0);
  current = (await invoke('spine_transfer_weights', { input: current, output: output('weights'), from: ref, to: ref, boneMap: { arm: 'arm' } })).path;
  current = (await call('spine_apply_edits', { input: current, output: output('dense'), edits: [{ type: 'set_timeline', animation: 'dense', bone: 'arm', channel: 'rotate', keyframes: Array.from({ length: 31 }, (_, i) => ({ time: i / 30, value: i })) }, { type: 'add_bone', name: 'control', parent: 'root', transform: { x: 60, y: 30 } }, { type: 'set_constraint', definition: { name: 'aim', type: 'ik', bones: ['arm'], target: 'control' } }] })).path;
  current = (await invoke('spine_simplify_animation', { input: current, output: output('simplified'), animation: 'dense', newName: 'simple', skin: 'day', fps: 30, tolerance: 0.001 })).path;
  current = (await invoke('spine_selective_bake', { input: current, output: output('baked'), animation: 'wave', newName: 'baked', constraints: ['ik/aim'], skin: 'day', fps: 20 })).path;
  current = (await invoke('spine_relink_assets', { input: current, output: output('relinked'), images: demo.images })).path;
  const native = await call('spine_edit_project', { input: current, output: path.join(directory, 'production.spine'), edits: [{ type: 'set_bone', bone: 'control', transform: { y: 31 } }] }); assert.equal(native.verification.passed, true);
  const collected = await invoke('spine_collect_assets', { input: current }), delivered = await invoke('spine_deliver', { input: current, options: { atlasPreset: 'portable' } });
  const moved = path.join(directory, '交付副本 with spaces'); await cp(delivered.directory, moved, { recursive: true }); const verified = await invoke('spine_verify_package', { input: path.join(moved, 'delivery.json') }); assert.equal(verified.valid, true);
  const movedNative = await call('spine_inspect', { input: path.join(moved, 'runtime/project.spine') }), movedNativeData = await readDocument(movedNative.workingJson);
  for (const kind of ['images', 'audio']) {
    const resolved = path.resolve(path.dirname(movedNative.workingJson), String(movedNativeData.skeleton[kind] ?? '.')), relative = path.relative(moved, resolved);
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Relocated native ${kind} root escaped the delivery: ${resolved}`);
  }
  await writeFile(path.join(demo.images, 'pack.json'), JSON.stringify({ output: '../must-not-be-used', atlasExtension: '../must-not-be-used' }), { flag: 'wx' });
  const packed = await invoke('spine_pack_atlas_configured', { imagesDirectory: demo.images, name: 'configured', settings: { maxWidth: 512, maxHeight: 512 }, project: native.output }); assert.equal(packed.ignoredPackFiles.length, 1);
  const unpacked = await invoke('spine_unpack_atlas', { input: packed.files.find((file: string) => file.endsWith('.atlas')), project: native.output }); assert.ok(unpacked.files.length);
  // Retopology and exact alpha islands/holes are validated on independent rigs.
  const raw = await readDocument(current), oldMesh = (raw.skins as any[]).find(skin => skin.name === 'day').attachments['arm-slot'].arm;
  await invoke('spine_replace_mesh_topology', { input: current, output: output('retopology'), ...ref, mesh: { vertices: [0, -12, 120, -12, 60, 12], uvs: [0, 1, 1, 1, 0.5, 0], triangles: [0, 2, 1], hull: 3 }, deformPolicy: 'clear' });
  const alphaDemo = await call('spine_create_demo', {}), raster = new Uint8Array(12 * 12 * 4); for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) if (x < 9 && y < 9 && !(x >= 3 && x < 6 && y >= 3 && y < 6) || x >= 10 && y >= 10) raster.set([30, 180, 110, 255], (y * 12 + x) * 4); await writeFile(path.join(alphaDemo.images, 'shape.png'), encodePng(12, 12, raster));
  const region = await call('spine_attach_image', { input: alphaDemo.path, output: path.join(alphaDemo.directory, 'shape.json'), skin: 'default', slot: 'arm-slot', name: 'shape', image: path.join(alphaDemo.images, 'shape.png'), setAsSetup: true });
  const trace = await invoke('spine_trace_contours', { input: region.path, skin: 'default', slot: 'arm-slot', name: 'shape' }); assert.equal(trace.components.length, 2); assert.equal(trace.holes, 1);
  const contours = await invoke('spine_mesh_from_contours', { input: region.path, output: path.join(alphaDemo.directory, 'contours.json'), skin: 'default', slot: 'arm-slot', name: 'shape' });
  const contourNative = await call('spine_build_project', { entries: [{ input: contours.path, name: 'contours' }], output: path.join(alphaDemo.directory, 'contours.spine') });
  const sequenceDemo = await call('spine_create_demo', {}); for (const index of [1, 2]) await cp(path.join(sequenceDemo.images, 'arm.png'), path.join(sequenceDemo.images, `sequence${index}.png`));
  const sequence = await call('spine_apply_edits', { input: sequenceDemo.path, output: path.join(sequenceDemo.directory, 'sequence.json'), edits: [{ type: 'set_attachment', skin: 'default', slot: 'arm-slot', name: 'sequence', attachment: { path: 'sequence', width: 120, height: 24, x: 60, sequence: { count: 2 } }, setAsSetup: true }, { type: 'set_attachment_animation', animation: 'sequence', skin: 'default', slot: 'arm-slot', name: 'sequence', channel: 'sequence', keyframes: [{ time: 0, mode: 'loop', delay: 0.1 }, { time: 1, mode: 'hold', index: 0 }] }] });
  const runtimeOnly = await call('spine_deliver', { input: sequence.path, options: { formats: ['json', 'binary'], atlasPreset: 'compact', includeProject: false } }); assert.equal(runtimeOnly.project, null); assert.equal((await call('spine_verify_package', { input: runtimeOnly.deliveryManifest })).valid, true);
  const runtimeBinary = new SkeletonBinary(boneDiagramLoader).readSkeletonData(await readFile(path.join(runtimeOnly.runtimeDirectory, 'skeleton.skel'))); assert.equal(path.resolve(runtimeOnly.runtimeDirectory, runtimeBinary.imagesPath!), path.join(runtimeOnly.directory, 'images'));
  const pipeline = { id: `production-${path.basename(directory)}`, steps: [{ id: 'edit', operation: 'edit_json', input: current, edits: [{ type: 'set_bone', bone: 'control', transform: { x: 61 } }] }, { id: 'audit', operation: 'audit_assets', inputFrom: 'edit' }] };
  const first = await invoke('spine_run_pipeline', pipeline), resumed = await invoke('spine_run_pipeline', pipeline); assert.equal(resumed.reusedSteps, 2);
  const queued = await call('spine_start_job', { operation: 'pipeline', args: { id: `detached-${path.basename(directory)}`, steps: pipeline.steps } }); await connection.client.close();
  connection = await connectSpine(); let completed: any;
  for (let attempt = 0; attempt < 60; attempt++) { completed = await call('spine_get_job', { id: queued.id, includeResult: true }); if (!['queued', 'running'].includes(completed.state)) break; await new Promise(resolve => setTimeout(resolve, 500)); } assert.equal(completed.state, 'succeeded');
  const failedJob = await call('spine_start_job', { operation: 'pipeline', args: { id: `retry-${path.basename(directory)}`, steps: [{ id: 'missing', operation: 'audit_assets', input: output('not-yet') }] } });
  let failed: any; for (let attempt = 0; attempt < 30; attempt++) { failed = await call('spine_get_job', { id: failedJob.id }); if (failed.state === 'failed') break; await new Promise(resolve => setTimeout(resolve, 300)); } assert.equal(failed.state, 'failed'); await cp(current, output('not-yet'));
  const retry = await invoke('spine_retry_job', { id: failedJob.id }); let retried: any; for (let attempt = 0; attempt < 30; attempt++) { retried = await call('spine_get_job', { id: retry.id }); if (retried.state === 'succeeded' || retried.state === 'failed') break; await new Promise(resolve => setTimeout(resolve, 300)); } assert.equal(retried.state, 'succeeded');
  assert.equal(await fileSha256(demo.path), sourceHash); assert.equal(await fileSha256(image), imageHash); assert.equal(invoked.size, 29);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, newToolsInvoked: [...invoked], sourceAndImageUnchanged: true, boundaryComparison: comparison, native, collected, delivered, relocatedPackage: verified, relocatedNativeResourceRootsContained: true, unpacked, untrustedFolderPackSettingsIgnored: true, runtimeOnlySequenceDelivery: runtimeOnly, binaryResourcePathsPortable: true, contourNative, contours: { components: trace.components.length, holes: trace.holes, pixels: trace.pixels, area: trace.area }, pipelineStageReuse: resumed.reusedSteps, workerSurvivedDisconnect: completed.state === 'succeeded', retryRecovered: retried.state === 'succeeded' };
  const reportPath = path.join(projectRoot, 'work/production-report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, newToolsInvoked: invoked.size, reportPath, native: native.output, delivery: delivered.directory }, null, 2));
} finally { await connection.client.close(); }

