import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { atomicJson } from '../src/jobs.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const config = await loadConfig(), directory = path.join(config.workspaceRoot, `preview-requests-${randomUUID().slice(0, 8)}`); await mkdir(directory);
let connection = await connectSpine({ local: process.argv.includes('--local') });
const reportPath = path.join(directory, 'report.json'), report: Record<string, any> = { version: VERSION, passed: false, directory, editorOpened: false, inputAutomationUsed: false };
const ids: string[] = [];
const call = async (name: string, args: Record<string, unknown>) => { const r = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), t = r.content.find(c => c.type === 'text'); assert.ok(!r.isError && t?.type === 'text', `${name}: ${JSON.stringify(r.content)}`); return JSON.parse(t.text); };
const reject = async (name: string, args: Record<string, unknown>, pattern: RegExp) => { const r = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }); assert.equal(r.isError, true); assert.match(JSON.stringify(r.content), pattern); };
const wait = async (id: string, generation: number, sourceSha256: string) => { const result = await call('spine_wait_native_preview', { id, options: { generation, sourceSha256, waitMs: 20000 } }); assert.equal(result.outcome, 'published', JSON.stringify(result)); return result; };
const reconnect = async () => { await connection.client.close(); connection = await connectSpine({ local: process.argv.includes('--local') }); };
try {
  assert.equal((await call('spine_status', {})).serverVersion, VERSION); assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT);
  const demo = await call('spine_create_demo', {}), originalSha = await fileSha256(demo.path);
  const animated = await call('spine_apply_edits', { input: demo.path, output: path.join(demo.directory, 'request-wave.json'), edits: [{ type: 'add_animation', name: 'wave' }, { type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 100 }] }] });
  const sourceSha = await fileSha256(animated.path), id = randomUUID(); ids.push(id);
  const args = { requestId: id, input: animated.path, options: { animation: 'wave', width: 128, height: 128, durationSeconds: 180, viewport: { minX: -50, maxX: 180, minY: -30, maxY: 170 } }, sequence: { nativeFps: 4 } };
  const concurrent = await Promise.all([call('spine_start_native_sequence_preview', args), call('spine_start_native_sequence_preview', args)]);
  assert.ok(concurrent.every(r => r.id === id)); assert.ok(concurrent.some(r => r.creationReused));
  report.concurrentCreation = concurrent.map(r => ({ id: r.id, creationReused: r.creationReused, creationPending: r.creationPending }));
  report.initial = await wait(id, 1, sourceSha); const native = await call('spine_get_native_preview', { id }), projectHash = await fileSha256(native.project), imageTime = (await stat(native.image)).mtimeMs;
  await reconnect();
  const replay = await call('spine_start_native_sequence_preview', args); assert.equal(replay.creationReused, true); assert.equal(replay.pendingGeneration, 1); assert.equal((await stat(native.image)).mtimeMs, imageTime);
  const mutation = { id, requestId: randomUUID(), expectedGeneration: 1, changes: { viewport: { minX: -80, maxX: 210, minY: -50, maxY: 200 } } };
  const updates = await Promise.all([call('spine_update_native_preview', mutation), call('spine_update_native_preview', mutation)]);
  assert.ok(updates.every(r => r.requestReceipt.generation === 2)); assert.equal(updates.filter(r => r.requestReceipt.reused).length, 1); report.update = await wait(id, 2, sourceSha);
  const later = await call('spine_update_native_preview', { id, requestId: randomUUID(), expectedGeneration: 2, changes: { skin: null } }); assert.equal(later.requestReceipt.generation, 3); await wait(id, 3, sourceSha);
  await reconnect();
  const requestFile = path.join(native.directory, 'request.json'), before = await readFile(requestFile, 'utf8');
  const oldUpdate = await call('spine_update_native_preview', mutation); assert.equal(oldUpdate.requestReceipt.generation, 2); assert.equal(oldUpdate.requestReceipt.reused, true); assert.equal(oldUpdate.pendingGeneration, 3); assert.equal(await readFile(requestFile, 'utf8'), before);
  assert.equal((await call('spine_wait_native_preview', { id, options: { generation: 2, waitMs: 0 } })).outcome, 'superseded');
  await reject('spine_update_native_preview', { ...mutation, changes: { refit: true } }, /different preview mutation/);
  for (const name of ['spine_update_native_preview', 'spine_resume_native_preview', 'spine_stop_native_preview']) await reject(name, { id, requestId: randomUUID(), expectedGeneration: 1 }, /generation conflict/);
  assert.equal(await readFile(requestFile, 'utf8'), before);
  const stopArgs = { id, requestId: randomUUID(), expectedGeneration: 3 }; await call('spine_stop_native_preview', stopArgs);
  const resumeArgs = { id, requestId: randomUUID(), expectedGeneration: 3, options: { durationSeconds: 180 } }, resumed = await call('spine_resume_native_preview', resumeArgs); assert.equal(resumed.requestReceipt.generation, 4); await wait(id, 4, sourceSha);
  const activeRequest = await readFile(requestFile, 'utf8'), oldStop = await call('spine_stop_native_preview', stopArgs); assert.equal(oldStop.requestReceipt.reused, true); assert.equal(oldStop.stopRequested, false);
  await reconnect(); const oldResume = await call('spine_resume_native_preview', resumeArgs); assert.equal(oldResume.requestReceipt.reused, true); assert.equal(oldResume.expiresAt, resumed.expiresAt); assert.equal(await readFile(requestFile, 'utf8'), activeRequest);
  report.mutations = { duplicateUpdateAppliedOnce: true, oldUpdatePreservedGeneration: 2, staleMutationsRejected: true, oldStopDidNotStopNewResume: true, resumeExpiryUnchangedOnReplay: true, reconnectVerified: true };

  // Real native import completes in an owned child, then that child exits
  // before saving the result. The same ID must reuse that exact .spine file.
  const interruptedId = randomUUID(); ids.push(interruptedId); const staticOptions = { width: 128, height: 128, durationSeconds: 180 }, payload = path.join(directory, 'interruption-input.json');
  await atomicJson(payload, { config, input: demo.path, options: staticOptions, id: interruptedId });
  const script = `import {readFile} from 'node:fs/promises'; import {SpineService} from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)}; const p=JSON.parse(await readFile(process.argv[1],'utf8')),s=new SpineService(p.config),run=s.cli.importProject.bind(s.cli);s.nativePreviews.kick=async()=>{};s.cli.importProject=async(...args)=>{await run(...args);process.exit(75)};await s.nativePreviews.start(p.input,p.options,undefined,p.id);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, payload], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); assert.equal(code, 75, stderr);
  const interrupted = await call('spine_get_native_preview', { id: interruptedId }); assert.equal(interrupted.creation.phase, 'importing'); assert.equal(interrupted.creation.ownerAlive, false); assert.equal(interrupted.resumable, false);
  const interruptedHash = await fileSha256(interrupted.project), interruptedTime = (await stat(interrupted.project)).mtimeMs;
  await reject('spine_resume_native_preview', { id: interruptedId }, /Retry the original start call/);
  const recovered = await call('spine_start_native_preview', { requestId: interruptedId, input: demo.path, options: staticOptions }); assert.equal(recovered.creationReused, true); assert.equal(recovered.creation.phase, 'ready'); assert.equal(recovered.creation.attempts, 2);
  await wait(interruptedId, 1, originalSha); assert.equal(await fileSha256(interrupted.project), interruptedHash); assert.equal((await stat(interrupted.project)).mtimeMs, interruptedTime);
  const cached = await call('spine_start_native_preview', { requestId: interruptedId, input: demo.path, options: staticOptions }); assert.equal(cached.creationReused, true); assert.equal(cached.id, interruptedId);
  await reject('spine_start_native_preview', { requestId: interruptedId, input: demo.path, options: { ...staticOptions, width: 160 } }, /different preview/);
  report.creationRecovery = { childExitCode: code, sameId: recovered.id, attempts: recovered.creation.attempts, nativeFileByteAndTimestampUnchanged: true, independentlyVerified: true };
  assert.equal(await fileSha256(native.project), projectHash); assert.equal(await fileSha256(demo.path), originalSha); assert.equal(await fileSha256(animated.path), sourceSha);
  report.originalsAndNativeProjectUnchanged = true; report.passed = true; report.completedAt = new Date().toISOString(); await atomicJson(reportPath, report);
  await atomicJson(path.join(config.workspaceRoot, `preview-requests-report-${VERSION}.json`), { version: VERSION, passed: true, reportPath });
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, sameSessionAfterReconnect: true, conditionalMutationsVerified: true, realCreationInterruptionRecovered: true, editorOpened: false }, null, 2));
} catch (error) { report.error = (error as Error).message; await atomicJson(reportPath, report); throw error; }
finally {
  for (const id of ids) { await call('spine_stop_native_preview', { id }).catch(() => undefined); const deadline = Date.now() + 10000; while (Date.now() < deadline) { const s = await call('spine_get_native_preview', { id }).catch(() => null); if (!s || !s.workerAlive && !s.supervisorAlive) break; await new Promise(resolve => setTimeout(resolve, 100)); } }
  await connection.client.close();
}
