import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BoundingBoxAttachment, ClippingAttachment, MeshAttachment, SkeletonBinary, VertexAttachment } from '@esotericsoftware/spine-core';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/project-workflow.js';
import { readDocument } from '../src/document.js';
import { boneDiagramLoader, sampleSkeleton } from '../src/runtime.js';
import { encodePng } from '../src/raster.js';

const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); return JSON.parse(block.text);
}
async function geometry(filename: string, slotName: string, name: string) {
  const skeleton = sampleSkeleton(await readDocument(filename), undefined, 0, 'day'), slot = skeleton.slots.find(slot => slot.data.name === slotName)!, attachment = skeleton.data.findSkin('day')!.getAttachment(slot.data.index, name) as VertexAttachment;
  const values = new Array<number>(attachment.worldVerticesLength); attachment.computeWorldVertices(skeleton, slot, 0, values.length, values, 0, 2); return values;
}
try {
  assert.equal((await client.listTools()).tools.length, TOOL_COUNT); assert.equal(client.getServerVersion()?.version, VERSION);
  const status = await call('spine_status', {}); assert.equal(status.capabilities.pngAlphaConvexHullInspection, true);
  const demo = await call('spine_create_demo', {}), sourceHash = await fileSha256(demo.path), originalImage = path.join(demo.images, 'arm.png'), originalImageHash = await fileSha256(originalImage), image = path.join(demo.images, 'alpha-shape.png');
  const rgba = new Uint8Array(128 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
    const ellipse = ((x - 58) / 46) ** 2 + ((y - 34) / 23) ** 2 <= 1;
    const hole = Math.hypot(x - 58, y - 34) < 8, notch = x < 40 && y < 27, island = Math.hypot(x - 116, y - 12) < 4;
    rgba.set([65, 211, 157, ((ellipse && !hole && !notch) || island) ? 255 : 0], (y * 128 + x) * 4);
  }
  await writeFile(image, encodePng(128, 64, rgba), { flag: 'wx' }); const imageHash = await fileSha256(image), output = (name: string) => path.join(demo.directory, name);
  const prepared = await call('spine_apply_edits', { input: demo.path, output: output('prepared.json'), edits: [
    { type: 'set_bone', bone: 'root', transform: { rotation: 12, shearY: 9 } },
    { type: 'add_bone', name: 'tip', parent: 'arm', transform: { x: 95, length: 35 } },
    { type: 'add_bone', name: 'bounds-bone', parent: 'root', transform: { x: -40, y: 20, rotation: 33, scaleX: -1.1, scaleY: 1.2 } },
    { type: 'add_slot', name: 'mask-slot', bone: 'arm' },
    { type: 'add_slot', name: 'bounds-slot', bone: 'bounds-bone' },
    { type: 'set_slot_order', order: ['mask-slot', 'arm-slot', 'bounds-slot'] },
    { type: 'attach_image', skin: 'default', slot: 'arm-slot', name: 'alpha', image, transform: { x: 64, y: 4, rotation: 13, scaleX: -0.9, scaleY: 1.1 }, setAsSetup: true },
    { type: 'add_skin', name: 'night', copyFrom: 'default', baseSkin: 'day' },
    { type: 'set_timeline', animation: 'alpha-motion', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 35 }, { time: 1, value: 0 }] },
  ] }); const preparedHash = await fileSha256(prepared.path);
  const traceArgs = { input: prepared.path, skin: 'day', slot: 'arm-slot', name: 'alpha' };
  const trace = await call('spine_trace_region', traceArgs), limited = await call('spine_trace_region', { ...traceArgs, maxVertices: 8 });
  assert.equal(trace.width, 128); assert.equal(trace.height, 64); assert.ok(trace.alphaFraction > 0 && trace.alphaFraction < 1); assert.ok(limited.vertexCount <= 8); assert.equal(limited.approximated, true);
  const nightTrace = await call('spine_trace_region', { ...traceArgs, skin: 'night' }); assert.deepEqual(nightTrace.worldVertices, trace.worldVertices);
  const bbox = await call('spine_polygon_from_region', { ...traceArgs, output: output('bounds.json'), kind: 'boundingbox', targetSlot: 'bounds-slot', targetName: 'alpha-bounds' });
  const boundsWorld = await geometry(bbox.path, 'bounds-slot', 'alpha-bounds'), boundsMaxError = Math.max(...boundsWorld.map((value, index) => Math.abs(value - trace.worldVertices[index]))); assert.ok(boundsMaxError < 0.0001);
  const invalidPath = output('bad-clip.json'), invalid = await client.callTool({ name: 'spine_polygon_from_region', arguments: { ...traceArgs, output: invalidPath, kind: 'clipping', targetSlot: 'bounds-slot', targetName: 'invalid' } });
  assert.equal(invalid.isError, true); await assert.rejects(stat(invalidPath), /ENOENT/);
  const clipped = await call('spine_polygon_from_region', { ...traceArgs, input: bbox.path, output: output('polygons.json'), kind: 'clipping', targetSlot: 'mask-slot', targetName: 'alpha-clip', endSlot: 'arm-slot' });
  const mesh = await call('spine_mesh_from_alpha', { ...traceArgs, input: clipped.path, output: output('alpha-mesh.json') });
  const unweightedVertices = await geometry(mesh.path, 'arm-slot', 'alpha'), boundaryMaxError = Math.max(...trace.worldVertices.map((value: number, index: number) => Math.abs(value - unweightedVertices[index]!))); assert.ok(boundaryMaxError < 0.0001);
  console.log('Registered alpha tracing, mesh, bounding box, clipping and named-skin setup geometry passed. Checking native import...');
  const unweightedProject = await call('spine_edit_project', { input: mesh.path, output: output('透明轮廓网格与碰撞框.spine'), skeletonName: 'alpha-rig', edits: [{ type: 'set_bone', bone: 'tip', transform: { length: 40 } }] }); assert.equal(unweightedProject.verification.passed, true);
  const weighted = await call('spine_auto_weights', { input: mesh.path, output: output('alpha-weighted.json'), skin: 'day', slot: 'arm-slot', name: 'alpha', bones: ['tip', 'arm'], influences: 2 });
  const weightedVertices = await geometry(weighted.path, 'arm-slot', 'alpha'), bindingMaxError = Math.max(...weightedVertices.map((value, index) => Math.abs(value - unweightedVertices[index]!))); assert.ok(bindingMaxError < 0.0001);
  const project = await call('spine_edit_project', { input: weighted.path, output: output('透明轮廓自动绑定.spine'), skeletonName: 'alpha-rig', edits: [{ type: 'smooth_weights', skin: 'day', slot: 'arm-slot', name: 'alpha', strength: 0.25, iterations: 2, maxInfluences: 2 }] }); assert.equal(project.verification.passed, true);
  const preview = await call('spine_render_artwork', { input: project.output, animation: 'alpha-motion', skin: 'day', times: [0, 0.25, 0.5, 0.75, 1] });
  const binary = await call('spine_export', { input: project.output, format: 'binary' }), runtime = new SkeletonBinary(boneDiagramLoader).readSkeletonData(await readFile(binary.files.find((file: string) => file.endsWith('.skel'))));
  const skin = runtime.findSkin('day')!, armIndex = runtime.slots.findIndex(slot => slot.name === 'arm-slot'), boundsIndex = runtime.slots.findIndex(slot => slot.name === 'bounds-slot'), clipIndex = runtime.slots.findIndex(slot => slot.name === 'mask-slot');
  assert.ok(skin.getAttachment(armIndex, 'alpha') instanceof MeshAttachment); assert.ok(skin.getAttachment(boundsIndex, 'alpha-bounds') instanceof BoundingBoxAttachment); assert.ok(skin.getAttachment(clipIndex, 'alpha-clip') instanceof ClippingAttachment);
  const multi = await call('spine_build_project', { entries: [{ input: weighted.path, name: 'alpha' }, { input: demo.path, name: 'untouched' }], output: output('alpha-multi.spine') }); assert.equal(multi.checks.length, 2);
  const job = await call('spine_start_job', { operation: 'edit_project', args: { input: prepared.path, output: output('后台透明轮廓.spine'), skeletonName: 'background-alpha', edits: [
    { type: 'polygon_from_region', skin: 'day', slot: 'arm-slot', name: 'alpha', kind: 'boundingbox', targetSlot: 'bounds-slot', targetName: 'job-bounds' },
    { type: 'polygon_from_region', skin: 'day', slot: 'arm-slot', name: 'alpha', kind: 'clipping', targetSlot: 'mask-slot', targetName: 'job-clip', endSlot: 'arm-slot' },
    { type: 'mesh_from_alpha', skin: 'day', slot: 'arm-slot', name: 'alpha', maxVertices: 16 },
    { type: 'auto_weights', skin: 'day', slot: 'arm-slot', name: 'alpha', bones: ['tip', 'arm'], influences: 2 },
  ] } });
  console.log('Native/binary export and multi-skeleton import passed. Closing MCP to check detached alpha generation...');
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
  assert.equal(await fileSha256(demo.path), sourceHash); assert.equal(await fileSha256(prepared.path), preparedHash); assert.equal(await fileSha256(image), imageHash); assert.equal(await fileSha256(originalImage), originalImageHash);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, source: demo.path, sourceHash, prepared: prepared.path, preparedHash, image, imageHash, originalImage, originalImageHash, sourceAndImageBytesUnchanged: true, trace, limited, namedSkinTraceVerified: true, boundsMaxError, boundaryMaxError, bindingMaxError, invalidClippingBlockedBeforePublication: true, binaryMeshAndPolygonTypesVerified: true, unweightedProject, project, preview, multi, job: completed, workerSurvivedMcpDisconnect: true, limits: ['Convex geometry covers holes and separated islands; PNG transparency remains unchanged.', 'Alpha threshold may exclude faint pixels. Polygon setup matching follows its selected target bone during animation.'] };
  const reportPath = path.join(projectRoot, 'work/alpha-report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, project: project.output, preview: preview.path, alphaPixels: trace.alphaPixels, hullVertices: trace.vertexCount, workerSurvivedMcpDisconnect: true }, null, 2));
} finally { await client.close(); }
