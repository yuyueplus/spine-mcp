import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { connectSpine } from '../src/mcp-client.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/file-hash.js';
import { atomicJson } from '../src/jobs.js';
import { encodePng } from '../src/raster.js';

const config = await loadConfig(), connection = await connectSpine({ local: process.argv.includes('--local') }), directory = path.join(config.workspaceRoot, `native-publication-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const reportPath = path.join(directory, 'report.json'), report: Record<string, any> = { version: VERSION, passed: false, directory, editorOpened: false, inputAutomationUsed: false };
let id: string | undefined;
const call = async (name: string, args: Record<string, unknown>) => { const r = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), t = r.content.find(c => c.type === 'text'); assert.ok(!r.isError && t?.type === 'text', `${name}: ${JSON.stringify(r.content)}`); return JSON.parse(t.text); };
const wait = async (generation?: number, sourceSha256?: string) => {
  for (let n = 0; n < 4; n++) { const receipt = await call('spine_wait_native_preview', { id, options: { generation, sourceSha256, waitMs: 15000 } }); if (receipt.outcome === 'published') return receipt; assert.equal(receipt.outcome, 'timeout', JSON.stringify(receipt)); }
  throw new Error('Publication wait timed out.');
};
const stopped = async () => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { const s = await call('spine_get_native_preview', { id }); if (s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive) return s; await new Promise(r => setTimeout(r, 150)); } throw new Error('Owned test preview did not stop.'); };
try {
  assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT); assert.equal((await call('spine_status', {})).serverVersion, VERSION);
  const demo = await call('spine_create_demo', {}), originalHash = await fileSha256(demo.path);
  const animated = await call('spine_apply_edits', { input: demo.path, output: path.join(demo.directory, 'publication-wave.json'), edits: [{ type: 'add_animation', name: 'wave' }, { type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }] }] });
  const sourceHash = await fileSha256(animated.path);
  const started = await call('spine_start_native_sequence_preview', { input: animated.path, options: { animation: 'wave', width: 128, height: 128, durationSeconds: 180, viewport: { minX: -50, maxX: 180, minY: -30, maxY: 170 } }, sequence: { nativeFps: 4 } }); id = started.id;
  report.initial = await wait(started.pendingGeneration, sourceHash); assert.equal(report.initial.imageSetVerified, true); assert.equal(report.initial.editorDisplayAcknowledged, false);
  const projectHash = await fileSha256(started.project);
  const edited = await call('spine_apply_edits', { input: animated.path, output: path.join(demo.directory, 'publication-edited.json'), edits: [{ type: 'set_bone', bone: 'root', transform: { x: 30 } }] }), generation = edited.nativePreview.sessions.find((s: any) => s.id === id).generation;
  report.edit = await wait(generation, await fileSha256(edited.path)); assert.equal(report.edit.input, edited.path);
  report.superseded = await call('spine_wait_native_preview', { id, options: { generation: started.pendingGeneration, waitMs: 0 } }); assert.equal(report.superseded.outcome, 'superseded');
  report.wrongSource = await call('spine_wait_native_preview', { id, options: { sourceSha256: '0'.repeat(64), waitMs: 0 } }); assert.equal(report.wrongSource.outcome, 'source_changed');
  const native = await call('spine_inspect', { input: started.project }), nativeJson = JSON.parse(await readFile(native.workingJson, 'utf8')); assert.equal(nativeJson.skins[0].attachments.preview.preview.sequence.count, 4);
  await call('spine_stop_native_preview', { id }); await stopped();
  const previous = JSON.parse(await readFile(path.join(started.directory, 'status.json'), 'utf8'));
  const crashCache = path.join(started.directory, `sequence-${randomUUID()}`); await mkdir(crashCache);
  const names = ['frame-0000.png', 'frame-0001.png', 'frame-0002.png', 'frame-0003.png', 'preview.png'], images = [], before = [];
  for (const [index, name] of names.entries()) {
    const source = path.join(crashCache, name); await writeFile(source, encodePng(2, 2, new Uint8Array(16).fill(90 + index)));
    images.push({ name, source, sha256: await fileSha256(source) }); before.push(await fileSha256(path.join(started.directory, 'images', name)));
  }
  const payload = path.join(directory, 'interruption-input.json'); await atomicJson(payload, { root: config.workspaceRoot, folder: started.directory, previous, images });
  const script = `import {readFile} from 'node:fs/promises'; import {Workspace} from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}; import {publishSequenceImages} from ${JSON.stringify(new URL('../src/sequence-publication.js', import.meta.url).href)}; import {replaceFile} from ${JSON.stringify(new URL('../src/file-replace.js', import.meta.url).href)}; const p=JSON.parse(await readFile(process.argv[1],'utf8')); await publishSequenceImages(new Workspace(p.root),p.folder,p.previous,p.previous,p.images,{...p.previous,generation:p.previous.generation+1},async()=>{},async(a,b)=>{await replaceFile(a,b);process.exit(74)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, payload], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); assert.equal(code, 74, stderr);
  assert.notEqual(await fileSha256(path.join(started.directory, 'images', names[0]!)), before[0]);
  const resumed = await call('spine_resume_native_preview', { id }); report.recovered = await wait(resumed.pendingGeneration, await fileSha256(edited.path));
  const recovered = await call('spine_get_native_preview', { id }); assert.equal(recovered.publicationRecovery.state, 'rolled_back'); assert.equal(recovered.publicationPending, false);
  assert.deepEqual(await Promise.all(names.map(name => fileSha256(path.join(started.directory, 'images', name)))), before);
  assert.equal(await fileSha256(started.project), projectHash); assert.equal(await fileSha256(demo.path), originalHash); assert.equal(await fileSha256(animated.path), sourceHash);
  report.interruption = { childExitCode: code, rollback: recovered.publicationRecovery, allFiveImagesRestored: true, nativeProjectUnchanged: true, originalSourcesUnchanged: true };
  report.passed = true; report.completedAt = new Date().toISOString(); await atomicJson(reportPath, report);
  await atomicJson(path.join(config.workspaceRoot, `native-publication-report-${VERSION}.json`), { passed: true, version: VERSION, reportPath });
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, waitVerified: true, actualWorkerCrashRecoveryVerified: true, editorOpened: false }, null, 2));
} catch (error) { report.error = (error as Error).message; await atomicJson(reportPath, report); throw error; }
finally { if (id) { await call('spine_stop_native_preview', { id }).catch(() => undefined); await stopped().catch(() => undefined); } await connection.client.close(); }
