import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig, projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';

const config = await loadConfig(), directory = path.join(config.workspaceRoot, `character-pipeline-${randomUUID().slice(0, 8)} with spaces`); await mkdir(directory);
const configFile = path.join(config.workspaceRoot, `character-pipeline-config-${randomUUID()}.json`); await writeFile(configFile, JSON.stringify({ ...config, workspaceRoot: directory }));
const client = new Client({ name: 'character-pipeline-smoke', version: VERSION }), transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'dist/src/index.js')], env: { SPINE_MCP_CONFIG: configFile }, stderr: 'pipe' });
const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }, { timeout: 300000 }), t = r.content.find(c => c.type === 'text'); if (r.isError || t?.type !== 'text') throw Error(name + ': ' + JSON.stringify(r.content)); return JSON.parse(t.text); };
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
let preview: string | undefined;
const report: Record<string, any> = { version: VERSION, directory, nativeEditorOpened: false, inputAutomation: false, realUserArtModified: false };
const promoteArgs = (candidate: any, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), candidate: candidate.candidate, expectedSha256: candidate.candidateSha256, confirmation: 'use_reviewed_candidate', note: 'Explicit synthetic regression selection, not a real user visual acceptance.', ...extra });
try {
  await client.connect(transport); assert.equal((await client.listTools()).tools.length, TOOL_COUNT); assert.equal((await call('spine_status', {})).serverVersion, VERSION);
  const png = async (name: string, pixel: (x: number, y: number) => number[]) => { const file = path.join(directory, name), bytes = new Uint8Array(256); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bytes.set(pixel(x, y), (y * 8 + x) * 4); await writeFile(file, encodePng(8, 8, bytes)); return file; };
  const original = await png('原图 source.png', () => [255, 255, 255, 255]), base = await png('待补图 layer.png', (x, y) => [255, 255, 255, x === 4 && y === 4 ? 0 : 255]), mask = await png('补绘 mask.png', (x, y) => [0, 0, 0, x === 4 && y === 4 ? 255 : 0]), replacement = await png('替换 image.png', () => [80, 170, 240, 255]);
  const hArgs = { requestId: randomUUID(), original, layers: [{ name: 'body', image: base, x: 0, y: 0, pivot: { x: 4, y: 7 }, repaintMask: mask }] }, h = await call('spine_prepare_layer_handoff', hArgs), audited = { handoff: h.handoff, expectedSha256: h.handoffSha256 };
  assert.equal((await call('spine_prepare_layer_handoff', hArgs)).reused, true); assert.equal((await call('spine_audit_layer_handoff', audited)).checksPassed, false);
  const full = { ...audited, replacements: [{ layer: 'body', image: original }] }; assert.equal((await call('spine_audit_layer_handoff', full)).checksPassed, true);
  const emptyProject = path.join(directory, 'empty-before-layer-import.spine'); await call('spine_create_project', { output: emptyProject, skeletonName: 'Empty-for-layer-import', openInEditor: false });
  const imported = await call('spine_import_layer_handoff', { ...full, requestId: randomUUID(), input: emptyProject }); assert.equal(imported.checksPassed, true);
  const importedNative = await call('spine_promote_character_candidate', promoteArgs(imported)); assert.equal(importedNative.publication.structuralAndNativeRoundTrip, 'passed'); report.layerHandoff = { handoff: h.handoff, candidate: imported.candidate, native: importedNative.output, failedMaskBlocked: true, canvasAndPivotRetained: true, importedIntoExistingRootOnlyNative: true };
  const source = path.join(directory, 'source.json'), data = { skeleton: { spine: '4.3.23', images: '.', fps: 60 }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', x: 2 }], slots: [{ name: 'art', bone: 'arm', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { path: '原图 source', width: 8, height: 8 } } } }], animations: { wave: { bones: { arm: { rotate: [{ value: 0 }, { time: 0.5, value: 60 }, { time: 1, value: 0 }] } } }, idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 2 }] } } } } }; await writeFile(source, JSON.stringify(data)); const sourceHash = await fileSha256(source), imageHash = await fileSha256(original);
  const session = await call('spine_create_session', { input: source, name: 'Character pipeline regression' }), p = await call('spine_start_native_preview', { input: source, requestId: randomUUID(), options: { animation: 'wave', time: 0.5, width: 128, height: 160, durationSeconds: 240 } }); preview = p.id;
  let bound = await call('spine_bind_session_preview', { id: session.id, expectedRevision: 0, requestId: randomUUID(), previewId: preview });
  let publication = await call('spine_wait_native_preview', { id: preview, options: { generation: bound.preview.generation, waitMs: 30000 } }); assert.equal(publication.outcome, 'published');
  const replacePlan = await call('spine_plan_image_replacement', { input: source, slot: 'art', attachment: 'art', image: replacement }); assert.equal(replacePlan.checksPassed, true);
  const replaceArgs = { requestId: randomUUID(), plan: replacePlan.plan, expectedSha256: replacePlan.planSha256 }, candidate = await call('spine_apply_image_replacement', replaceArgs); assert.equal((await call('spine_get_character_candidate', { candidate: candidate.candidate, expectedSha256: candidate.candidateSha256 })).sourceChanged, false);
  const candidateData = await read(candidate.json); assert.deepEqual(candidateData.animations, data.animations); assert.deepEqual(candidateData.bones, data.bones);
  const promotedArgs = promoteArgs(candidate, { session: { id: session.id, expectedRevision: bound.revision } }), promoted = await call('spine_promote_character_candidate', promotedArgs); assert.equal(promoted.publication.structuralAndNativeRoundTrip, 'passed');
  publication = await call('spine_wait_native_preview', { id: preview, options: { generation: promoted.session.preview.generation, waitMs: 30000 } }); assert.equal(publication.outcome, 'published'); assert.equal((await call('spine_promote_character_candidate', promotedArgs)).reused, true);
  report.imageReplacement = { plan: replacePlan.plan, candidate: candidate.candidate, native: promoted.output, sourceBonesAndAnimationsPreserved: true, exactPromotionRetryReused: true, automaticPreviewGeneration: promoted.session.preview.generation, publication: publication.outcome };
  const repairArgs = { requestId: randomUUID(), input: promoted.output, animation: 'wave', newName: 'wave_limited', rotations: [{ bone: 'arm', min: 0, max: 20 }], comparison: { width: 96, height: 128, fps: 8, video: true } }, repair = await call('spine_create_animation_repair', repairArgs);
  assert.equal(repair.checksPassed, true); assert.ok(repair.details.before[0].findingCounts.joint_limit > 0); assert.equal(repair.details.after[0].checksPassed, true); assert.ok(repair.details.comparison.video); assert.equal(repair.details.comparison.fixedSharedCamera, true); assert.equal((await call('spine_create_animation_repair', repairArgs)).reused, true);
  const repairedNative = await call('spine_promote_character_candidate', promoteArgs(repair, { session: { id: session.id, expectedRevision: promoted.session.revision } })); assert.equal(repairedNative.publication.structuralAndNativeRoundTrip, 'passed');
  publication = await call('spine_wait_native_preview', { id: preview, options: { generation: repairedNative.session.preview.generation, waitMs: 30000 } }); assert.equal(publication.outcome, 'published');
  report.animationRepair = { candidate: repair.candidate, native: repairedNative.output, video: repair.details.comparison.video, poster: repair.details.comparison.poster, player: repair.details.comparison.player, numericBeforeFindings: repair.details.before[0].findingCounts, numericAfterPassed: repair.details.after[0].checksPassed, candidateVisualAcceptance: repair.visualAcceptance, nativeRoundTrip: 'passed', exactRetryReused: true, previewPublication: publication.outcome };
  const final = await call('spine_get_session', { id: session.id }); assert.equal(final.versions.length, 3); assert.equal(final.inSync, true); assert.equal(await fileSha256(source), sourceHash); assert.equal(await fileSha256(original), imageHash);
  report.session = { id: final.id, revision: final.revision, retainedVersions: final.versions.length, inSync: final.inSync }; report.originalSourceAndPngUnchanged = true; report.passed = true;
} finally {
  if (preview) { await call('spine_stop_native_preview', { id: preview }); report.testPreviewStopped = true; }
  await client.close(); await writeFile(path.join(projectRoot, `work/character-pipeline-report-${VERSION}.json`), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
