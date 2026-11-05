import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MeshAttachment, SkeletonBinary } from '@esotericsoftware/spine-core';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/file-hash.js';
import { readDocument, type SpineDocument } from '../src/document.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { boneDiagramLoader, sampleSkeleton } from '../src/runtime.js';
import { encodePng } from '../src/raster.js';
import type { AttachmentRef } from '../src/attachment-reuse.js';

const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); return JSON.parse(block.text);
}
function sample(data: SpineDocument, ref: AttachmentRef, time: number) {
  const skeleton = sampleSkeleton(data, 'mesh-motion', time, ref.skin), slot = skeleton.slots.find(item => item.data.name === ref.slot)!, mesh = slot.appliedPose.attachment as MeshAttachment;
  assert.ok(mesh instanceof MeshAttachment); const world = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2);
  return { world, uv: Array.from(mesh.regionUVs), triangles: mesh.triangles, frame: mesh.sequence.resolveIndex(slot.appliedPose) };
}
function interpolate(uv: number[], triangles: ArrayLike<number>, world: number[], u: number, v: number) {
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const a = triangles[offset]!, b = triangles[offset + 1]!, c = triangles[offset + 2]!, ax = uv[a * 2]!, ay = uv[a * 2 + 1]!, bx = uv[b * 2]!, by = uv[b * 2 + 1]!, cx = uv[c * 2]!, cy = uv[c * 2 + 1]!;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy), wa = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / det, wb = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / det, wc = 1 - wa - wb;
    if (Math.min(wa, wb, wc) >= -1e-7) return [0, 1].map(axis => world[a * 2 + axis]! * wa + world[b * 2 + axis]! * wb + world[c * 2 + axis]! * wc);
  }
  throw new Error(`UV outside source surface: ${u},${v}`);
}
async function compareSurface(before: string, after: string, ref: AttachmentRef) {
  const a = await readDocument(before), b = await readDocument(after); let maxError = 0, samples = 0;
  for (const time of [0, 0.13, 0.25, 0.5, 0.8, 1]) {
    const x = sample(a, ref, time), y = sample(b, ref, time); assert.equal(x.frame, y.frame);
    const positions = [...Array.from({ length: y.uv.length / 2 }, (_, index) => [y.uv[index * 2]!, y.uv[index * 2 + 1]!] as [number, number]), ...[[0.1, 0.2], [0.2, 0.9], [0.5, 0.5], [0.9, 0.8]] as [number, number][]];
    for (const [u, v] of positions) {
      const expected = interpolate(x.uv, x.triangles, x.world, u, v), actual = interpolate(y.uv, y.triangles, y.world, u, v); samples++;
      maxError = Math.max(maxError, ...expected.map((value, index) => Math.abs(value - actual[index]!)));
    }
  }
  assert.ok(maxError < 0.0002, `${JSON.stringify(ref)}: ${maxError}`); return { maxError, samples };
}
try {
  assert.equal((await client.listTools()).tools.length, TOOL_COUNT); assert.equal(client.getServerVersion()?.version, VERSION);
  const status = await call('spine_status', {}); assert.equal(status.capabilities.weightedMeshSubdivisionWithDeform, true);
  const demo = await call('spine_create_demo', {}), output = (name: string) => path.join(demo.directory, name), hashes = new Map<string, string>();
  for (const filename of [demo.path, path.join(demo.images, 'arm.png')]) hashes.set(filename, await fileSha256(filename));
  for (let frame = 1; frame <= 3; frame++) {
    const pixels = new Uint8Array(120 * 24 * 4);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 120; x++) pixels.set(x < 2 || x >= 118 || y < 2 || y >= 22 ? [35, 61, 57, 255] : [[65, 211, 157, 255], [245, 177, 67, 255], [109, 160, 245, 255]][frame - 1]!, (y * 120 + x) * 4);
    const filename = path.join(demo.images, `cycle${frame}.png`); await writeFile(filename, encodePng(120, 24, pixels), { flag: 'wx' }); hashes.set(filename, await fileSha256(filename));
  }
  const ref = { skin: 'day', slot: 'arm-slot', name: 'arm' }, inherited = { skin: 'day', slot: 'linked-slot', name: 'inherited' }, own = { skin: 'day', slot: 'own-slot', name: 'own' }, night = { skin: 'night', slot: 'night-slot', name: 'night-linked' };
  const plain = { skin: 'day', slot: 'plain-slot', name: 'plain' }, plainLink = { skin: 'day', slot: 'plain-linked', name: 'plain-linked' };
  const prepared = await call('spine_apply_edits', { input: demo.path, output: output('prepared.json'), edits: [
    { type: 'set_bone', bone: 'root', transform: { rotation: 12, shearY: 9 } },
    { type: 'set_bone', bone: 'arm', transform: { rotation: 11, scaleX: 1.2, scaleY: 0.8 } },
    { type: 'add_bone', name: 'tip', parent: 'root', transform: { x: 80, y: -20, rotation: -17, scaleX: -0.9, scaleY: 1.2, shearX: 9, length: 35 } },
    ...['linked-slot', 'night-slot', 'plain-linked'].map(name => ({ type: 'add_slot', name, bone: 'root' })),
    ...['own-slot', 'plain-slot'].map(name => ({ type: 'add_slot', name, bone: 'arm' })),
    { type: 'set_attachment', skin: 'default', slot: 'plain-slot', name: 'plain', setAsSetup: true, attachment: { path: 'arm', width: 120, height: 24, x: 60, y: 40 } },
    { type: 'add_skin', name: 'night', copyFrom: 'default', baseSkin: 'day' },
    { type: 'mesh_from_region', ...ref, columns: 2, rows: 1 },
    { type: 'mesh_from_region', ...plain, columns: 1, rows: 1 },
    { type: 'set_weights', ...ref, weights: Array.from({ length: 6 }, (_, index) => [{ bone: 'tip', weight: 0.1 + index * 0.15 }, { bone: 'arm', weight: 0.9 - index * 0.15 }]) },
    { type: 'set_attachment_animation', animation: 'mesh-motion', ...ref, channel: 'deform', keyframes: [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 0.5, offset: 3, vertices: [11, -3, 13, 2, -8] }, { time: 1 }] },
    { type: 'set_attachment_animation', animation: 'mesh-motion', ...plain, channel: 'deform', keyframes: [{ time: 0 }, { time: 1, offset: 1, vertices: [2, 3, 4, 5, 6] }] },
    { type: 'set_timeline', animation: 'mesh-motion', bone: 'tip', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 45 }] },
    { type: 'set_timeline', animation: 'mesh-motion', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 20 }] },
  ] });
  const record = attachmentEntries(await readDocument(prepared.path)).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name)!.value;
  const linked = await call('spine_apply_edits', { input: prepared.path, output: output('linked.json'), edits: [
    { type: 'set_attachment', ...ref, replace: true, attachment: { ...record, path: 'cycle', sequence: { count: 3 } } },
    { type: 'set_attachment_animation', animation: 'mesh-motion', ...ref, channel: 'sequence', keyframes: [{ time: 0, mode: 'loop', delay: 0.25 }] },
    { type: 'link_mesh', from: ref, to: inherited, setAsSetup: true },
    { type: 'link_mesh', from: ref, to: own, inheritTimelines: false, copyTimelines: true, setAsSetup: true },
    { type: 'link_mesh', from: ref, to: night, setAsSetup: true },
    { type: 'link_mesh', from: plain, to: plainLink, setAsSetup: true },
    { type: 'set_attachment_animation', animation: 'mesh-motion', ...own, channel: 'deform', keyframes: [{ time: 0 }, { time: 1, offset: 3, vertices: [-8, 5, 3] }] },
  ] }); hashes.set(linked.path, await fileSha256(linked.path));
  const info = await call('spine_inspect_mesh', { input: linked.path, ...inherited, offset: 1, limit: 2, triangleOffset: 1, triangleLimit: 2 });
  assert.equal(info.vertexCount, 6); assert.equal(info.triangleCount, 4); assert.equal(info.refinable, true); assert.deepEqual(info.source, ref); assert.equal(info.nextOffset, 3); assert.equal(info.relatedDeformTracks, 2);
  const weighted = await call('spine_transform_mesh', { input: linked.path, output: output('weighted-transform.json'), ...ref, transform: { x: 5, y: -3, rotation: 12, scaleX: 1.1, scaleY: 0.9, pivotX: 40 }, vertices: [2, 3, 4] });
  const transformed = await call('spine_transform_mesh', { input: weighted.path, output: output('transformed.json'), ...plain, transform: { x: 7, y: 3, rotation: -10, scaleX: -0.85, scaleY: 1.2, pivotX: 60, pivotY: 40 } }); hashes.set(transformed.path, await fileSha256(transformed.path));
  const before = await call('spine_inspect_mesh', { input: linked.path, ...ref }), after = await call('spine_inspect_mesh', { input: transformed.path, ...ref });
  for (const index of [0, 1, 5]) assert.deepEqual(after.vertices[index].world, before.vertices[index].world);
  assert.notDeepEqual(after.vertices[2].world, before.vertices[2].world);
  const refined = await call('spine_refine_mesh', { input: transformed.path, output: output('refined-weighted.json'), ...ref, iterations: 2 });
  const result = await call('spine_refine_mesh', { input: refined.path, output: output('refined.json'), ...plain }); hashes.set(result.path, await fileSha256(result.path));
  const surfaces: Record<string, { maxError: number; samples: number }> = {};
  for (const selected of [ref, inherited, own, night, plain, plainLink]) surfaces[`${selected.skin}/${selected.name}`] = await compareSurface(transformed.path, result.path, selected);
  const finalInfo = await call('spine_inspect_mesh', { input: result.path, ...ref }); assert.equal(finalInfo.vertexCount, 45); assert.equal(finalInfo.triangleCount, 64); assert.equal(finalInfo.hullVertices, 24); assert.equal(finalInfo.refinable, true);
  const blockedPath = output('blocked-linked-edit.json'), blocked = await client.callTool({ name: 'spine_transform_mesh', arguments: { input: result.path, output: blockedPath, ...inherited, transform: { x: 1 } } });
  assert.equal(blocked.isError, true); await assert.rejects(stat(blockedPath), /ENOENT/);
  console.log('Registered mesh tools passed selected transforms, weighted/unweighted surface, linked deformation and sequence checks. Checking native import...');
  const project = await call('spine_edit_project', { input: result.path, output: output('网格细分与局部编辑.spine'), skeletonName: 'mesh-editing', edits: [{ type: 'set_bone', bone: 'tip', transform: { length: 40 } }] }); assert.equal(project.verification.passed, true); hashes.set(project.output, await fileSha256(project.output));
  for (const selected of [ref, inherited, own, night, plain, plainLink]) surfaces[`native/${selected.skin}/${selected.name}`] = await compareSurface(result.path, project.exportedJson, selected);
  const nativeInfo = await call('spine_inspect_mesh', { input: project.output, ...ref }); assert.equal(nativeInfo.refinable, true); assert.equal(nativeInfo.vertexCount, 45);
  const binary = await call('spine_export', { input: project.output, format: 'binary' }), binaryFile = binary.files.find((file: string) => file.endsWith('.skel'));
  const runtime = new SkeletonBinary(boneDiagramLoader).readSkeletonData(await readFile(binaryFile)), native = runtime.findSkin('day')!.getAttachment(runtime.slots.findIndex(slot => slot.name === ref.slot), ref.name) as MeshAttachment;
  assert.equal(native.worldVerticesLength, 90); assert.equal(native.triangles.length, 192); assert.equal(native.hullLength, 48); assert.ok(native.edges && native.edges.length > 0); assert.ok(native.edges.every(index => index % 2 === 0 && index < 90));
  const edited = await call('spine_edit_project', { input: project.output, output: output('原生工程继续细分.spine'), edits: [{ type: 'refine_mesh', ...plain }, { type: 'transform_mesh', ...ref, transform: { x: 3, y: -2 }, vertices: [1] }] }); assert.equal(edited.verification.passed, true);
  surfaces.nativeProjectRefinement = await compareSurface(project.exportedJson, edited.exportedJson, plain);
  const preview = await call('spine_render_artwork', { input: edited.output, animation: 'mesh-motion', skin: 'day', times: [0, 0.25, 0.5, 0.75, 1] });
  const multi = await call('spine_build_project', { entries: [{ input: project.exportedJson, name: 'mesh' }, { input: demo.path, name: 'untouched' }], output: output('mesh-multi.spine') }); assert.equal(multi.checks.length, 2);
  const multiEdited = await call('spine_edit_multi_project', { input: multi.output, output: output('mesh-multi-edited.spine'), changes: [{ name: 'mesh', edits: [{ type: 'refine_mesh', ...plain }] }] }); assert.equal(multiEdited.checks.length, 2);
  const job = await call('spine_start_job', { operation: 'edit_project', args: { input: project.output, output: output('后台网格编辑.spine'), edits: [{ type: 'transform_mesh', ...ref, transform: { y: 1 }, vertices: [0] }, { type: 'refine_mesh', ...plain }] } });
  console.log('Native project/binary geometry and multi-skeleton edits passed. Closing MCP to check detached mesh editing...');
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
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, inspector: finalInfo, surfaces, sampledTimes: [0, 0.13, 0.25, 0.5, 0.8, 1], selectedAndUnselectedVerticesVerified: true, blockedLinkedEditPublishesNoFile: true, binaryTopologyAndCoordinateEdgesVerified: true, sourceAndImageBytesUnchanged: true, hashes: Object.fromEntries(hashes), project, edited, binaryFile, preview, multi, multiEdited, job: completed, workerSurvivedMcpDisconnect: true, limits: ['Source mesh edits affect every link and subdivision changes vertex indices.', 'Transforms use setup slot-local coordinates; animated world motion is not baked.', 'Uniform four-way triangle subdivision requires a single complete hull and at most 16 influences per midpoint; crossing triangles are not detected.'] };
  const reportPath = path.join(projectRoot, 'work/mesh-report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, project: edited.output, preview: preview.path, maxSurfaceError: Math.max(...Object.values(surfaces).map(item => item.maxError)), surfaceSamples: Object.values(surfaces).reduce((sum, item) => sum + item.samples, 0), workerSurvivedMcpDisconnect: true }, null, 2));
} finally { await client.close(); }
