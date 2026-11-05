import path from 'node:path';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { loadConfig, projectRoot } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { connectSpine } from '../src/mcp-client.js';
import { parseDocument, writeDocument, readDocument } from '../src/document.js';
import { setAttachmentTimeline, setWeights } from '../src/geometry-edits.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { sampleSkeleton } from '../src/runtime.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const service = new SpineService(await loadConfig()), { client, timeoutMs } = await connectSpine(), invoked = new Set<string>();
async function call(name: string, args: Record<string, unknown>) { invoked.add(name); const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs }); const block = result.content.find(item => item.type === 'text'); if (!block || block.type !== 'text') throw new Error(`Missing text: ${name}`); const value = JSON.parse(block.text); if (result.isError) throw new Error(`${name}: ${block.text}`); return value; }
try {
  const status = await call('spine_status', { probeCli: true }); assert.equal(status.serverVersion, VERSION); assert.equal((await client.listTools()).tools.length, TOOL_COUNT);
  const demo = await call('spine_create_demo', {}), image = path.join(demo.images, 'arm.png'), originalDemoHash = await fileSha256(demo.path), imageHash = await fileSha256(image), from = { skin: 'default', slot: 'art', name: 'mesh' }, to = { skin: 'default', slot: 'target', name: 'target' };
  let data = parseDocument({ skeleton: { spine: '4.3.23', images: demo.images, fps: 30 }, bones: [{ name: 'root', x: 5, y: 7, rotation: 20, scaleX: 1.3, scaleY: 0.8 }, { name: 'a', parent: 'root' }, { name: 'b', parent: 'root', x: 12 }, { name: 'c', parent: 'root', y: 12 }], slots: [{ name: 'art', bone: 'root', attachment: 'mesh' }, { name: 'target', bone: 'root', attachment: 'target' }, { name: 'linked', bone: 'root', attachment: 'copy' }], skins: [{ name: 'default', attachments: { art: { mesh: { type: 'mesh', path: 'arm', width: 120, height: 24, vertices: [0, 0, 12, 0, 0, 12], uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3 } }, target: { target: { type: 'mesh', path: 'arm', width: 120, height: 24, vertices: [3, 3, 6, 0, 0, 6], uvs: [0.25, 0.25, 0.5, 0, 0, 0.5], triangles: [0, 1, 2], hull: 3 } }, linked: { copy: { type: 'linkedmesh', path: 'arm', source: 'mesh', slot: 'art', timelines: false } } } }], animations: { move: { bones: { a: { rotate: [{ time: 0 }, { time: 1, value: 100 }] }, b: { translate: [{ time: 0 }, { time: 1, x: 6, y: 2 }] }, c: { scale: [{ time: 0 }, { time: 1, x: 1.5, y: 0.8 }] } } } } });
  data = setWeights(data, from.skin, from.slot, from.name, [[{ bone: 'a', weight: 0.75 }, { bone: 'c', weight: 0.25 }], [{ bone: 'a', weight: 0.2 }, { bone: 'b', weight: 0.8 }], [{ bone: 'c', weight: 1 }]]);
  data = setWeights(data, to.skin, to.slot, to.name, Array.from({ length: 3 }, () => [{ bone: 'root', weight: 0.2 }, { bone: 'b', weight: 0.8 }]));
  data = setAttachmentTimeline(data, 'move', 'default', 'art', 'mesh', 'deform', [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, offset: 1, vertices: [2, 4, 6, 8, -1, 3, -2, 1] }]);
  data = setAttachmentTimeline(data, 'move', 'default', 'linked', 'copy', 'deform', [{ time: 0 }, { time: 1, offset: 2, vertices: [3, 1, 2, 4, 5, 6] }]);
  const source = await writeDocument(service.workspace, path.join(demo.directory, 'surface-source.json'), data), sourceHash = await fileSha256(source.path), topology = { vertices: [0, 0, 12, 0, 0, 12, 4, 4], uvs: [0, 0, 1, 0, 0, 1, 1 / 3, 1 / 3], triangles: [0, 1, 3, 1, 2, 3, 2, 0, 3], hull: 3 };
  const transferred = await call('spine_transfer_weights', { input: source.path, output: path.join(demo.directory, 'surface-weights.json'), from, to, method: 'surface', maxDistance: 0.001, lockedBones: ['root'] });
  const weights = await call('spine_inspect_weights', { input: transferred.path, ...to }); assert.ok(Math.abs(weights.vertices[0].influences.find((item: any) => item.bone === 'root').weight - 0.2) < 1e-8);
  const migrated = await call('spine_replace_mesh_topology', { input: transferred.path, output: path.join(demo.directory, 'surface-migrated.json'), ...from, mesh: topology, deformPolicy: 'interpolate' });
  const compatibility = await call('spine_check_native_compatibility', { input: migrated.path }); assert.equal(compatibility.clippingImportRisks, 0);
  const preflight = await call('spine_preflight_edits', { input: source.path, edits: [{ type: 'replace_mesh_topology', ...from, mesh: topology, deformPolicy: 'interpolate' }] }); assert.equal(preflight.nativeCompatibility.clippingImportRisks, 0);
  const built = await call('spine_build_project', { entries: [{ input: migrated.path, name: 'surface' }], output: path.join(demo.directory, 'surface.spine') });
  const native = await service.load(built.output), before = await readDocument(source.path), times = [0, 0.1, 0.3, 0.7, 1]; let maxSurfaceError = 0;
  for (const time of times) for (const ref of [from, { skin: 'default', slot: 'linked', name: 'copy' }]) {
    const geometry = (document: typeof data) => { const skeleton = sampleSkeleton(document, 'move', time, ref.skin), slot = skeleton.slots.find(slot => slot.data.name === ref.slot)!, attachment = skeleton.data.findSkin(ref.skin)!.getAttachment(slot.data.index, ref.name); assert.ok(attachment instanceof MeshAttachment); const world = new Array<number>(attachment.worldVerticesLength); attachment.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2); return world; };
    const old = geometry(before), after = geometry(native.data), expected = [...old, ...[0, 1].map(axis => (old[axis]! + old[2 + axis]! + old[4 + axis]!) / 3)];
    expected.forEach((value, index) => { maxSurfaceError = Math.max(maxSurfaceError, Math.abs(value - after[index]!)); });
  }
  assert.ok(maxSurfaceError < 0.001, String(maxSurfaceError));
  const nativeHash = await fileSha256(built.output), edited = await call('spine_edit_project', { input: built.output, output: path.join(demo.directory, 'surface-edited.spine'), edits: [{ type: 'transfer_weights', from, to, method: 'surface', maxDistance: 0.001, minWeight: 0.00001, lockedBones: ['root'] }] }); assert.equal(edited.verification.passed, true); assert.equal(await fileSha256(built.output), nativeHash);
  const queued = await call('spine_start_job', { operation: 'edit_project', args: { input: source.path, output: path.join(demo.directory, 'surface-background.spine'), edits: [{ type: 'replace_mesh_topology', ...from, mesh: topology, deformPolicy: 'interpolate' }] } });
  let job: any; for (let attempt = 0; attempt < 100; attempt++) { job = await call('spine_get_job', { id: queued.id, includeResult: true }); if (!['queued', 'running'].includes(job.state)) break; await new Promise(resolve => setTimeout(resolve, 500)); } assert.equal(job.state, 'succeeded', JSON.stringify(job));
  const clipping = structuredClone(before); clipping.slots!.unshift({ name: 'clip-slot', bone: 'root', attachment: 'clip' }); (clipping.skins as any[])[0].attachments['clip-slot'] = { clip: { type: 'clipping', convex: false, vertexCount: 4, vertices: [0, 0, 12, 0, 2, 2, 0, 12], end: 'linked' } };
  const clippingJson = await writeDocument(service.workspace, path.join(demo.directory, 'concave.json'), clipping), clippingHash = await fileSha256(clippingJson.path), warning = await call('spine_check_native_compatibility', { input: clippingJson.path }); assert.equal(warning.clippingImportRisks, 1);
  const rejectedOutput = path.join(demo.directory, 'concave-must-not-publish.spine'), rejected = await client.callTool({ name: 'spine_build_project', arguments: { entries: [{ input: clippingJson.path, name: 'clip' }], output: rejectedOutput } }, { timeout: timeoutMs }); assert.equal(rejected.isError, true); await assert.rejects(access(rejectedOutput)); assert.equal(await fileSha256(clippingJson.path), clippingHash);
  assert.equal(await fileSha256(source.path), sourceHash); assert.equal(await fileSha256(demo.path), originalDemoHash); assert.equal(await fileSha256(image), imageHash);
  let binaryProbe: unknown = null; try { binaryProbe = JSON.parse(await readFile(path.join(projectRoot, 'work/clipping-binary-probe.log'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, invoked: [...invoked], source: source.path, transferred: transferred.path, migrated: migrated.path, native: built.output, nativeEditing: edited.output, nativeReadbackVerified: true, maxSurfaceError, sampledTimes: times, independentLinkedDeformationVerified: true, originalSourcesAndImageUnchanged: true, backgroundJob: queued.id, backgroundJobState: job.state, compatibilityWarning: warning, unsafeNativePublicationRejected: true, concaveNativeImportFixed: false, binaryProbe };
  const reportPath = path.join(projectRoot, `work/surface-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, maxSurfaceError, backgroundJobState: job.state, native: built.output, reportPath }, null, 2));
} finally { await client.close(); }
