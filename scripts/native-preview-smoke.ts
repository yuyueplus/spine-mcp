import path from 'node:path';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

let connection = await connectSpine(), id: string | undefined;
const invoked = new Set<string>(), previewTools = new Set(['spine_start_native_preview', 'spine_get_native_preview', 'spine_list_native_previews', 'spine_update_native_preview', 'spine_stop_native_preview', 'spine_resume_native_preview']);
async function call(name: string, args: Record<string, unknown>) {
  if (previewTools.has(name)) invoked.add(name);
  const response = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), block = response.content.find(item => item.type === 'text');
  if (response.isError || block?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`);
  return JSON.parse(block.text);
}
async function until(predicate: (status: any) => boolean, timeout = 90000) {
  const deadline = Date.now() + timeout; let status;
  do { status = await call('spine_get_native_preview', { id }); if (predicate(status)) return status; assert.notEqual(status.state, 'failed', JSON.stringify(status)); await new Promise(resolve => setTimeout(resolve, 200)); } while (Date.now() < deadline);
  throw new Error(`Native preview timed out: ${JSON.stringify(status)}`);
}
try {
  assert.equal((await call('spine_status', {})).serverVersion, VERSION); assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT);
  const demo = await call('spine_create_demo', {}), sourceHash = await fileSha256(demo.path), base = await call('spine_build_project', { entries: [{ input: demo.path, name: 'preview-rig' }], output: path.join(demo.directory, 'base with spaces.spine') }), baseHash = await fileSha256(base.output);
  const started = await call('spine_start_native_preview', { input: base.output, options: { width: 256, height: 256, skeletonName: 'preview-rig', durationSeconds: 240 } }); id = started.id;
  assert.equal(started.mode, 'native-image-watch'); assert.equal(started.editorDisplayAcknowledged, false); assert.equal(started.editorProjectReloaded, false);
  const projectHash = await fileSha256(started.project), initial = await until(s => s.state === 'watching' && !!s.workerPid); await copyFile(initial.image, path.join(started.directory, 'initial-proof.png'));
  await connection.client.close(); connection = await connectSpine(); assert.equal((await call('spine_get_native_preview', { id })).workerPid, initial.workerPid);
  const inspected = await call('spine_inspect', { input: base.output }), edit = await call('spine_set_bone', { input: inspected.workingJson, output: path.join(demo.directory, 'edited.json'), bone: 'root', transform: { x: 9 } });
  assert.equal(edit.nativePreview.sessions[0].id, id); const changed = await until(s => s.generation >= 2 && s.input === edit.path); assert.notEqual(changed.textureSha256, initial.textureSha256);
  const jsonEditLatencyMs = Date.now() - Date.parse(changed.publishedAt);
  const animation = await call('spine_add_animation', { input: edit.path, output: path.join(demo.directory, 'animated.json'), name: 'wave' });
  const keyed = await call('spine_set_timeline', { input: animation.path, output: path.join(demo.directory, 'keyed.json'), animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 75 }] });
  await call('spine_update_native_preview', { id, changes: { animation: 'wave', time: 0.4, fps: 30 } });
  const animated = await until(s => s.input === keyed.path && s.generation === s.pendingGeneration); assert.notEqual(animated.textureSha256, changed.textureSha256);
  await call('spine_update_native_preview', { id, changes: { refit: true } });
  const refitted = await until(s => s.generation === s.pendingGeneration); assert.equal(refitted.options.time, 0.4); assert.equal(refitted.options.fps, 30);
  await call('spine_update_native_preview', { id, changes: { animation: 'does-not-exist' } }); const bad = await until(s => !!s.lastError); assert.match(bad.lastError, /Animation not found/); assert.equal(await fileSha256(started.image), refitted.textureSha256);
  await call('spine_update_native_preview', { id, changes: { animation: 'wave' } }); await until(s => !s.lastError && s.generation === s.pendingGeneration);
  const job = await call('spine_start_job', { operation: 'edit_project', args: { input: keyed.path, output: path.join(demo.directory, 'native changed.spine'), skeletonName: 'preview-rig', edits: [{ type: 'set_bone', bone: 'root', transform: { y: 20 } }] } });
  let native: any;
  for (const deadline = Date.now() + 90000; Date.now() < deadline;) { native = await call('spine_get_job', { id: job.id, includeResult: true }); if (native.state === 'succeeded') break; assert.ok(!['failed', 'cancelled'].includes(native.state), JSON.stringify(native)); await new Promise(resolve => setTimeout(resolve, 300)); }
  assert.equal(native.state, 'succeeded'); const afterJob = await until(s => s.input === native.result.output && s.generation === s.pendingGeneration); assert.notEqual(afterJob.textureSha256, refitted.textureSha256);
  await writeFile(path.join(demo.images, 'arm.png'), encodePng(120, 24, new Uint8Array(120 * 24 * 4).fill(190)));
  const texture = await until(s => s.textureRevision > afterJob.textureRevision); assert.notEqual(texture.textureSha256, afterJob.textureSha256);
  const previewData = await call('spine_inspect', { input: started.project }), assets = await call('spine_audit_assets', { input: previewData.workingJson, scanUnused: false });
  assert.equal(assets.valid, true); assert.ok(assets.files.some((file: any) => path.resolve(file.path) === path.resolve(started.image)));
  assert.equal(await fileSha256(started.project), projectHash); assert.equal(await fileSha256(demo.path), sourceHash); assert.equal(await fileSha256(base.output), baseHash);
  assert.ok((await call('spine_list_native_previews', {})).previews.some((p: any) => p.id === id)); await call('spine_stop_native_preview', { id }); const stopped = await until(s => s.state === 'stopped');
  await call('spine_set_bone', { input: keyed.path, output: path.join(demo.directory, 'after-stop.json'), bone: 'root', transform: { x: 50 } }); assert.equal(await fileSha256(started.image), stopped.textureSha256);
  await call('spine_resume_native_preview', { id, options: { durationSeconds: 120 } });
  const resumed = await until(s => s.generation === s.pendingGeneration && s.generation > stopped.generation && s.state === 'watching');
  assert.equal(resumed.project, started.project); assert.equal(resumed.image, started.image); assert.equal(resumed.textureSha256, stopped.textureSha256);
  assert.equal(await fileSha256(started.project), projectHash); await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped');
  assert.equal(invoked.size, previewTools.size);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, newToolsInvoked: [...invoked], dedicatedProject: started.project, nativeAssetReferencesVerified: true, sourceInputsUnchanged: true, previewProjectUnchangedAfterCreation: true, survivedMcpDisconnect: true, followsExportedJsonAlias: true, directJsonEditsRefreshTexture: true, animationPoseSelectionVerified: true, partialUpdatesPreserveOtherOptions: true, renderFailureRetainsLastImage: true, renderingRecoversAfterCorrection: true, detachedNativeEditJobRefreshesTexture: true, imageOnlyChangesRefreshTexture: true, cooperativeStopVerified: true, initialRenderMs: initial.renderMs, jsonEditRenderMs: changed.renderMs, statusReadAfterPublicationMs: jsonEditLatencyMs, mode: 'sampled-static-artwork-in-dedicated-native-project', editorDisplayAcknowledged: false, nativeEditorVisualVerification: 'Requires opening the generated preview project in Spine once. No native UI observation/control API is available in this session.', status: stopped };
  const reportPath = path.join(projectRoot, `work/native-preview-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, reportPath, newToolsVerified: invoked.size, project: started.project, editorDisplayAcknowledged: false }, null, 2));
} finally { if (id) { try { await call('spine_stop_native_preview', { id }); } catch {} } await connection.client.close(); }
