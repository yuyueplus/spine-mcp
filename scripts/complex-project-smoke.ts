import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { connectSpine } from '../src/mcp-client.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { auditAssets, resourceRefs } from '../src/production-assets.js';
import { readDocument } from '../src/document.js';
import { constraintList } from '../src/constraint-data.js';
import { animationDuration } from '../src/advanced-animation.js';
import { VERSION } from '../src/version.js';

const config = await loadConfig(), directory = path.join(config.workspaceRoot, `complex-projects-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const images = path.join(directory, '角色 images'), audio = path.join(directory, '音效 audio'); await mkdir(images); await mkdir(audio);
await writeFile(path.join(images, 'part.png'), encodePng(8, 8, new Uint8Array(8 * 8 * 4).fill(255)));
const wav = Buffer.alloc(1644); wav.write('RIFF'); wav.writeUInt32LE(1636, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(1600, 40); for (let i = 0; i < 800; i++) wav.writeInt16LE(Math.round(Math.sin(i * 0.35) * 1000), 44 + i * 2);
const waveFile = path.join(audio, '脚步 step.wav'); await writeFile(waveFile, wav);
const source = path.join(directory, 'sound.json');
await writeFile(source, JSON.stringify({ skeleton: { spine: '4.3.23', images: './角色 images', audio: './音效 audio', fps: 30 }, bones: [{ name: 'root' }, { name: 'child', parent: 'root', x: 5 }], slots: [{ name: 'art', bone: 'child', attachment: 'part' }], skins: [{ name: 'default', attachments: { art: { part: { path: 'part', width: 8, height: 8 } } } }], events: { footstep: { audio: '脚步 step.wav', int: 7, float: 0.5, string: 'contact', volume: 0.75, balance: -0.2 } }, animations: { step: { bones: { child: { rotate: [{ value: 0 }, { time: 1, value: 20 }] } }, events: [{ time: 0.25, name: 'footstep' }, { time: 0.75, name: 'footstep', int: 9, volume: 0.5 }] } } }));
const sourceHash = await fileSha256(source), waveHash = await fileSha256(waveFile), { client, timeoutMs } = await connectSpine();
const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }, { timeout: timeoutMs }), t = r.content.find(c => c.type === 'text'); if (r.isError || t?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(r.content)}`); return JSON.parse(t.text); };
const report: Record<string, any> = { version: VERSION, directory, editorOpened: false, inputAutomation: false, audioActuallyPlayed: false, fixtureScope: 'Generated valid PCM event audio, official Cloud-pot interacting physics, official Stretchyman path/transform; no claim of arbitrary user-production coverage.' };
try {
  assert.equal((await call('spine_status', {})).serverVersion, VERSION);
  const built = await call('spine_build_project', { entries: [{ input: source, name: 'sound' }], output: path.join(directory, 'sound.spine') }), collected = await call('spine_deliver', { input: built.output, options: { formats: ['json', 'binary'], atlas: false } });
  const moved = path.join(directory, '独立目录 with spaces'); await cp(collected.directory, moved, { recursive: true, force: false, errorOnExist: true });
  const isolated = new SpineService({ ...config, workspaceRoot: moved }), movedNative = path.join(moved, 'runtime/project.spine'), inspected = await isolated.load(movedNative), isolatedAudit = await auditAssets(isolated.workspace, inspected.data, inspected.jsonPath, false);
  assert.equal(isolatedAudit.valid, true); const refs = await resourceRefs(isolated.workspace, inspected.data, inspected.jsonPath), audioRef = refs.refs.find(r => r.kind === 'audio'); assert.ok(audioRef); assert.equal(await fileSha256(audioRef.path), waveHash);
  for (const f of isolatedAudit.files) { const relative = path.relative(moved, f.path); assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative)); }
  assert.deepEqual((inspected.data.animations!.step!.events as any[]).map(e => [e.time, e.name]), [[0.25, 'footstep'], [0.75, 'footstep']]);
  report.audioPortability = { passed: true, package: collected.directory, moved, native: movedNative, resources: isolatedAudit.files.length, eventAudioSha256: waveHash, allResourcesInsideIsolatedWorkspace: true, noOriginalResourceFallback: true, eventTimingsAndPayloadVerifiedByNativeRoundTrip: true };
  const officialRoot = path.join(config.workspaceRoot, 'official-examples/examples'), cloud = path.join(officialRoot, 'cloud-pot/cloud-pot-pro.spine'), stretch = path.join(officialRoot, 'stretchyman/stretchyman-pro.spine'), originals = [{ path: source, sha256: sourceHash }, { path: waveFile, sha256: waveHash }, { path: cloud, sha256: await fileSha256(cloud) }, { path: stretch, sha256: await fileSha256(stretch) }];
  const cloudSource = await call('spine_inspect', { input: cloud }), stretchSource = await call('spine_inspect', { input: stretch }), cloudData = await readDocument(cloudSource.workingJson), stretchData = await readDocument(stretchSource.workingJson);
  const baselineQuality = await call('spine_check_publish_quality', { input: stretchSource.workingJson });
  assert.equal(baselineQuality.checksPassed, false); assert.ok(baselineQuality.reports.some((r: any) => r.findingCounts?.mesh_fold));
  report.untouchedOfficialQuality = { reportPath: baselineQuality.reportPath, checksPassed: false, findings: baselineQuality.reports.map((r: any) => ({ animation: r.animation, counts: r.findingCounts })), explicitPolicy: 'report', reason: 'This fixture checks preservation of all skeletons and resources. Untouched official Stretchyman sneak already has visible sampled folds. Report mode retains those findings; production default remains enforce. No natural-motion acceptance is granted.' };
  const physics = constraintList(cloudData).filter(c => c.type === 'physics'); assert.ok(physics.length > 1, 'Fixture must contain multiple real physics constraints.'); assert.ok(constraintList(stretchData).some(c => c.type === 'path' || c.type === 'transform'));
  const combined = await call('spine_build_project', { entries: [{ input: source, name: 'sound' }, { input: cloudSource.workingJson, name: 'cloud' }, { input: stretchSource.workingJson, name: 'stretch' }], output: path.join(directory, 'multiple-skeletons.spine') });
  const session = await call('spine_create_session', { input: combined.output, name: 'Audio plus physics plus path', skeletonName: 'sound', requestId: randomUUID(), quality: { mode: 'report' } }); assert.equal(session.versions[0].skeletons.length, 3);
  const edited = await call('spine_edit_session', { id: session.id, requestId: randomUUID(), expectedRevision: 0, output: path.join(directory, 'multiple-edited.spine'), edits: [{ type: 'set_bone', bone: 'root', transform: { x: 12 } }], note: 'Only sound skeleton changes' });
  assert.equal(edited.versions.at(-1).quality.mode, 'report'); assert.equal(edited.versions.at(-1).quality.checksPassed, false);
  const editQuality = await Promise.all(edited.versions.at(-1).quality.reports.map(async (p: string) => JSON.parse(await readFile(p, 'utf8')))), stretchQuality = editQuality.find(q => q.reports.some((r: any) => r.animation === 'sneak'));
  assert.ok(stretchQuality); assert.deepEqual(stretchQuality.reports.map((r: any) => ({ animation: r.animation, counts: r.findingCounts })), report.untouchedOfficialQuality.findings);
  const comparisons = [];
  for (const [name, data, input, enablePhysics] of [['cloud', cloudData, cloudSource.workingJson, true], ['stretch', stretchData, stretchSource.workingJson, false]] as const) {
    const after = await call('spine_inspect', { input: edited.output, skeletonName: name });
    const entry = Object.entries(data.animations ?? {}).find(([, a]) => animationDuration(a) > 0); assert.ok(entry); const [animation, a] = entry, end = Math.min(1, animationDuration(a)), comparison = await call('spine_compare_projects', { input, other: after.workingJson, animation, times: [0, end / 2, end], physics: enablePhysics, fps: 60, tolerance: 0.05, render: false }); assert.equal(comparison.withinTolerance, true); comparisons.push({ skeleton: name, physics: enablePhysics, animation, comparison: comparison.reportPath, maxError: comparison.maxSampledError });
  }
  const restored = await call('spine_restore_session', { id: session.id, requestId: randomUUID(), expectedRevision: 1, versionId: session.currentVersionId, output: path.join(directory, 'multiple-restored.spine'), note: 'Restore all skeletons and archived event audio' }); assert.equal(restored.versions.at(-1).skeletons.length, 3);
  assert.equal(restored.versions.at(-1).quality.mode, 'report'); assert.equal(restored.versions.at(-1).quality.checksPassed, false);
  const restoredSound = await call('spine_inspect', { input: restored.output, skeletonName: 'sound' }), soundData = await readDocument(restoredSound.workingJson), soundAssets = await auditAssets(new SpineService(config).workspace, soundData, restoredSound.workingJson, false); assert.equal(soundAssets.valid, true); const soundRefs = await resourceRefs(new SpineService(config).workspace, soundData, restoredSound.workingJson); assert.equal(await fileSha256(soundRefs.refs.find(r => r.kind === 'audio')!.path), waveHash);
  const restoredDiff = await call('spine_compare_session_versions', { id: session.id, fromVersionId: session.currentVersionId }); assert.equal(restoredDiff.dataDiff.total, 0); assert.equal(restoredDiff.resourceDiff.total, 0);
  for (const f of originals) assert.equal(await fileSha256(f.path), f.sha256);
  report.multiSkeleton = { passed: true, native: combined.output, edited: edited.output, restored: restored.output, skeletons: ['sound', 'cloud', 'stretch'], actualPhysicsConstraints: physics.length, unaffectedSkeletonComparisons: comparisons, restoredDiff, eventAudioBytesRestored: true, originalsUnchanged: true };
  report.passed = true;
} catch (error) { report.passed = false; report.error = (error as Error).message; process.exitCode = 1; }
finally { await client.close(); const reportPath = path.join(config.workspaceRoot, `complex-project-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, version: VERSION, reportPath, error: report.error })); }
