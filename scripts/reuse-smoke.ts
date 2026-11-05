import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MeshAttachment, RegionAttachment, SkeletonBinary, VertexAttachment } from '@esotericsoftware/spine-core';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/file-hash.js';
import { readDocument } from '../src/document.js';
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
async function sample(filename: string, ref: AttachmentRef, time: number) {
  const data = await readDocument(filename), skeleton = sampleSkeleton(data, 'reuse', time, ref.skin), slot = skeleton.slots.find(item => item.data.name === ref.slot)!;
  const attachment = skeleton.data.findSkin(ref.skin)!.getAttachment(slot.data.index, ref.name); assert.equal(slot.appliedPose.attachment, attachment);
  assert.ok(attachment instanceof RegionAttachment || attachment instanceof VertexAttachment);
  const values = new Array<number>(attachment instanceof RegionAttachment ? 8 : attachment.worldVerticesLength);
  if (attachment instanceof RegionAttachment) attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), values, 0, 2);
  else attachment.computeWorldVertices(skeleton, slot, 0, values.length, values, 0, 2);
  const frame = attachment instanceof MeshAttachment || attachment instanceof RegionAttachment ? attachment.sequence.resolveIndex(slot.appliedPose) : null;
  return { values, frame };
}
async function compare(left: string, a: AttachmentRef, right: string, b: AttachmentRef) {
  let maxError = 0;
  for (const time of [0, 0.13, 0.25, 0.5, 0.8, 1]) {
    const x = await sample(left, a, time), y = await sample(right, b, time); assert.equal(x.frame, y.frame); assert.equal(x.values.length, y.values.length);
    maxError = Math.max(maxError, ...x.values.map((value, index) => Math.abs(value - y.values[index]!)));
  }
  assert.ok(maxError < 0.0001, `${JSON.stringify(a)} -> ${JSON.stringify(b)} error=${maxError}`); return maxError;
}
try {
  assert.equal((await client.listTools()).tools.length, TOOL_COUNT); assert.equal(client.getServerVersion()?.version, VERSION);
  const status = await call('spine_status', {}); assert.equal(status.capabilities.linkedMeshCreationAndIndependence, true);
  const demo = await call('spine_create_demo', {}), output = (name: string) => path.join(demo.directory, name);
  const hashes = new Map<string, string>();
  for (const filename of [demo.path, path.join(demo.images, 'arm.png')]) hashes.set(filename, await fileSha256(filename));
  for (let frame = 1; frame <= 3; frame++) {
    const pixels = new Uint8Array(120 * 24 * 4);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 120; x++) {
      const edge = x < 2 || x >= 118 || y < 2 || y >= 22;
      pixels.set(edge ? [35, 61, 57, 255] : [[65, 211, 157, 255], [245, 177, 67, 255], [109, 160, 245, 255]][frame - 1]!, (y * 120 + x) * 4);
    }
    const filename = path.join(demo.images, `cycle${frame}.png`); await writeFile(filename, encodePng(120, 24, pixels), { flag: 'wx' }); hashes.set(filename, await fileSha256(filename));
  }
  const prepared = await call('spine_apply_edits', { input: demo.path, output: output('prepared.json'), edits: [
    { type: 'set_bone', bone: 'root', transform: { rotation: 12, shearY: 9 } },
    { type: 'set_bone', bone: 'arm', transform: { rotation: 11, scaleX: 1.2, scaleY: 0.8 } },
    { type: 'add_bone', name: 'tip', parent: 'arm', transform: { x: 95, y: 8, length: 30 } },
    { type: 'add_bone', name: 'target-bone', parent: 'root', transform: { x: -40, y: 70, rotation: -27, scaleX: -1.1, scaleY: 1.25, shearX: 9 } },
    ...['linked-slot', 'copy-slot', 'region-copy', 'plain-copy', 'night-copy', 'night-link', 'job-slot'].map(name => ({ type: 'add_slot', name, bone: 'target-bone' })),
    ...['free-slot', 'region-source', 'plain-source'].map(name => ({ type: 'add_slot', name, bone: 'arm' })),
    { type: 'set_attachment', skin: 'default', slot: 'region-source', name: 'cycle', setAsSetup: true, attachment: { path: 'cycle', width: 120, height: 24, x: 60, y: 30, rotation: 17, scaleX: -0.9, sequence: { count: 3 } } },
    { type: 'add_skin', name: 'night', copyFrom: 'default', baseSkin: 'day' },
    { type: 'mesh_from_region', skin: 'day', slot: 'arm-slot', name: 'arm', columns: 1, rows: 1 },
    { type: 'set_weights', skin: 'day', slot: 'arm-slot', name: 'arm', weights: Array.from({ length: 4 }, () => [{ bone: 'tip', weight: 0.3 }, { bone: 'arm', weight: 0.7 }]) },
    { type: 'set_attachment', skin: 'day', slot: 'plain-source', name: 'plain', setAsSetup: true, attachment: { type: 'mesh', path: 'arm', width: 120, height: 24, uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, -50, 0, -26, 120, -26, 120, -50], triangles: [0, 1, 2, 0, 2, 3], hull: 4 } },
    { type: 'set_timeline', animation: 'reuse', bone: 'tip', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 35 }] },
    { type: 'set_attachment_animation', animation: 'reuse', skin: 'day', slot: 'arm-slot', name: 'arm', channel: 'deform', keyframes: [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, offset: 3, vertices: [11, -3, 13] }] },
    { type: 'set_attachment_animation', animation: 'reuse', skin: 'day', slot: 'plain-source', name: 'plain', channel: 'deform', keyframes: [{ time: 0, curve: [0.2, 0, 0.8, 1] }, { time: 1, offset: 3, vertices: [11, -3, 13] }] },
    { type: 'set_attachment_animation', animation: 'reuse', skin: 'day', slot: 'region-source', name: 'cycle', channel: 'sequence', keyframes: [{ time: 0, mode: 'loop', delay: 0.25 }] },
  ] });
  const from = { skin: 'day', slot: 'arm-slot', name: 'arm' }, plain = { skin: 'day', slot: 'plain-source', name: 'plain' }, cycle = { skin: 'day', slot: 'region-source', name: 'cycle' };
  const record = attachmentEntries(await readDocument(prepared.path)).find(item => item.skin === 'day' && item.slot === 'arm-slot' && item.name === 'arm')!.value;
  const sequenced = await call('spine_apply_edits', { input: prepared.path, output: output('sequenced.json'), edits: [
    { type: 'set_attachment', ...from, replace: true, attachment: { ...record, path: 'cycle', sequence: { count: 3 } } },
    { type: 'set_attachment_animation', animation: 'reuse', ...from, channel: 'sequence', keyframes: [{ time: 0, mode: 'loop', delay: 0.25 }] },
  ] }); hashes.set(sequenced.path, await fileSha256(sequenced.path));
  const copiedPlain = { skin: 'day', slot: 'plain-copy', name: 'plain-copy' }, copiedCycle = { skin: 'day', slot: 'region-copy', name: 'cycle-copy' };
  const copied = await call('spine_copy_attachment', { input: sequenced.path, output: output('copied.json'), from: plain, to: copiedPlain, setAsSetup: true });
  const regions = await call('spine_copy_attachment', { input: copied.path, output: output('regions.json'), from: cycle, to: copiedCycle, setAsSetup: true });
  const linkedRef = { skin: 'day', slot: 'linked-slot', name: 'inherited' }, freeRef = { skin: 'day', slot: 'free-slot', name: 'independent' };
  const linked = await call('spine_link_mesh', { input: regions.path, output: output('linked.json'), from, to: linkedRef, preserveWorld: true, setAsSetup: true });
  const independent = await call('spine_link_mesh', { input: linked.path, output: output('independent.json'), from, to: freeRef, inheritTimelines: false, copyTimelines: true, setAsSetup: true });
  const unlinked = await call('spine_unlink_mesh', { input: independent.path, output: output('unlinked.json'), ...freeRef });
  const nightCopy = { skin: 'night', slot: 'night-copy', name: 'night-copy' }, nightLink = { skin: 'night', slot: 'night-link', name: 'night-link' };
  const reused = await call('spine_apply_edits', { input: unlinked.path, output: output('reused.json'), edits: [
    { type: 'copy_attachment', from: linkedRef, to: nightCopy, setAsSetup: true },
    { type: 'link_mesh', from, to: nightLink, preserveWorld: true, setAsSetup: true },
  ] }); hashes.set(reused.path, await fileSha256(reused.path));
  const errors: Record<string, number> = {
    unweightedDeformCopy: await compare(sequenced.path, plain, reused.path, copiedPlain),
    regionSequenceConversion: await compare(sequenced.path, cycle, reused.path, copiedCycle),
    weightedLinkedInheritance: await compare(sequenced.path, from, reused.path, linkedRef),
    independentlyUnlinked: await compare(independent.path, freeRef, reused.path, freeRef),
    crossSkinCopy: await compare(sequenced.path, from, reused.path, nightCopy),
    crossSkinLinkedInheritance: await compare(sequenced.path, from, reused.path, nightLink),
  };
  const blockedPath = output('blocked-world-link.json'), blocked = await client.callTool({ name: 'spine_link_mesh', arguments: { input: reused.path, output: blockedPath, from: plain, to: { skin: 'day', slot: 'copy-slot', name: 'invalid' }, preserveWorld: true } });
  assert.equal(blocked.isError, true); await assert.rejects(stat(blockedPath), /ENOENT/);
  console.log('Registered copy/link/unlink tools passed world geometry, sparse deformation and sequence checks. Checking native Spine projects...');
  const project = await call('spine_edit_project', { input: reused.path, output: output('附件复制与链接.spine'), skeletonName: 'attachment-reuse', edits: [{ type: 'set_bone', bone: 'tip', transform: { length: 35 } }] }); assert.equal(project.verification.passed, true);
  const projectHash = await fileSha256(project.output); hashes.set(project.output, projectHash);
  const binary = await call('spine_export', { input: project.output, format: 'binary' }), binaryFile = binary.files.find((file: string) => file.endsWith('.skel'));
  const runtime = new SkeletonBinary(boneDiagramLoader).readSkeletonData(await readFile(binaryFile));
  const nativeAttachment = (ref: AttachmentRef) => runtime.findSkin(ref.skin)!.getAttachment(runtime.slots.findIndex(slot => slot.name === ref.slot), ref.name) as MeshAttachment;
  assert.ok(nativeAttachment(linkedRef).getSourceMesh()); assert.ok(nativeAttachment(nightLink).getSourceMesh());
  assert.equal(nativeAttachment(freeRef).getSourceMesh(), null); assert.equal(nativeAttachment(nightCopy).getSourceMesh(), null); assert.equal(nativeAttachment(copiedCycle).sequence.regions.length, 3);
  const edited = await call('spine_edit_project', { input: project.output, output: output('链接独立化并保留动画.spine'), edits: [{ type: 'unlink_mesh', ...linkedRef }] }); assert.equal(edited.verification.passed, true);
  errors.nativeInheritedUnlink = await compare(project.exportedJson, linkedRef, edited.exportedJson, linkedRef);
  errors.nativeRegionSequence = await compare(reused.path, copiedCycle, edited.exportedJson, copiedCycle);
  errors.nativeWeightedCopy = await compare(reused.path, nightCopy, edited.exportedJson, nightCopy);
  const preview = await call('spine_render_artwork', { input: edited.output, animation: 'reuse', skin: 'day', times: [0, 0.25, 0.5, 0.75, 1] });
  const multi = await call('spine_build_project', { entries: [{ input: edited.exportedJson, name: 'reuse' }, { input: demo.path, name: 'untouched' }], output: output('reuse-multi.spine') }); assert.equal(multi.checks.length, 2);
  const job = await call('spine_start_job', { operation: 'edit_project', args: { input: project.output, output: output('后台附件复用.spine'), edits: [
    { type: 'copy_attachment', from: cycle, to: { skin: 'day', slot: 'job-slot', name: 'job-copy' }, setAsSetup: true },
    { type: 'unlink_mesh', ...linkedRef },
    { type: 'link_mesh', from, to: { skin: 'day', slot: 'copy-slot', name: 'job-link' }, inheritTimelines: false, copyTimelines: true, setAsSetup: true },
  ] } });
  console.log('Native/binary export and multi-skeleton reuse passed. Closing MCP to check detached copy/link/unlink...');
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
  for (const [filename, hash] of hashes) assert.equal(await fileSha256(filename), hash, `Changed source: ${filename}`);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, errors, checkedSamplesPerComparison: 6, blockedWorldLinkPublishesNoFile: true, binaryLinkedAndIndependentMeshesVerified: true, binaryRegionSequenceConvertedToMesh: true, sourceAndImageBytesUnchanged: true, hashes: Object.fromEntries(hashes), project, edited, binaryFile, preview, multi, job: completed, workerSurvivedMcpDisconnect: true, limits: ['World preservation uses the setup pose; it does not bake the source bone animation onto another target bone.', 'World-preserving region copies may become four-vertex meshes. Shared links cannot change their geometry independently.'] };
  const reportPath = path.join(projectRoot, 'work/reuse-report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, project: edited.output, preview: preview.path, errors, workerSurvivedMcpDisconnect: true }, null, 2));
} finally { await client.close(); }
