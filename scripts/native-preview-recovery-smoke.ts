import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const execFileAsync = promisify(execFile), sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let connection = await connectSpine(), id: string | undefined, folder = '';
async function call(name: string, args: Record<string, unknown>) {
  const response = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs });
  const block = response.content.find(item => item.type === 'text');
  if (response.isError || block?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`);
  return JSON.parse(block.text);
}
async function until(predicate: (status: any) => boolean, ms = 30000) {
  const deadline = Date.now() + ms; let current;
  do { current = await call('spine_get_native_preview', { id }); if (predicate(current)) return current; await sleep(150); } while (Date.now() < deadline);
  throw new Error(`Native preview recovery timed out: ${JSON.stringify(current)}`);
}
const ready = (s: any) => s.state === 'watching' && s.workerAlive && s.supervisorAlive && s.generation === s.pendingGeneration && s.recovery?.current;
async function interruptOwnedProcess(kind: 'worker' | 'supervisor', pid: number) {
  assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  const owner = JSON.parse(await readFile(path.join(folder, `${kind}.lock/owner.json`), 'utf8'));
  assert.equal(owner.pid, pid);
  if (process.platform === 'win32') {
    const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$spineTestProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$env:SPINE_PREVIEW_TEST_PID)
if (-not $spineTestProcess -or $spineTestProcess.ExecutablePath -ne $env:SPINE_PREVIEW_TEST_NODE -or -not $spineTestProcess.CommandLine.Contains($env:SPINE_PREVIEW_TEST_FOLDER) -or -not $spineTestProcess.CommandLine.Contains($env:SPINE_PREVIEW_TEST_SCRIPT)) { throw 'Refusing to interrupt a process that is not this isolated Node preview worker.' }
Write-Output 'owned-node-preview-confirmed'
`], { windowsHide: true, timeout: 15000, env: { ...process.env, SPINE_PREVIEW_TEST_PID: String(pid), SPINE_PREVIEW_TEST_NODE: process.execPath, SPINE_PREVIEW_TEST_FOLDER: folder, SPINE_PREVIEW_TEST_SCRIPT: kind === 'worker' ? 'native-preview-worker.js' : 'native-preview-supervisor.js' } });
    assert.match(result.stdout, /owned-node-preview-confirmed/);
  }
  process.kill(pid, 'SIGKILL');
}

try {
  const status = await call('spine_status', { probeCli: false }); assert.equal(status.serverVersion, VERSION);
  assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT);
  assert.equal(status.editor.nativeTexturePreviewResume, true); assert.equal(status.editor.nativeTexturePreviewSupervision, true);
  const demo = await call('spine_create_demo', {}), sourceHash = await fileSha256(demo.path);
  const initial = await call('spine_start_native_preview', { input: demo.path, options: { width: 160, height: 160, durationSeconds: 300 } });
  id = initial.id; folder = initial.directory;
  const projectHash = await fileSha256(initial.project), first = await until(ready), started = Date.now();
  await interruptOwnedProcess('worker', first.workerPid);
  const a = await call('spine_set_bone', { input: demo.path, output: path.join(demo.directory, 'crash-a.json'), bone: 'root', transform: { x: 15 } });
  const b = await call('spine_set_bone', { input: a.path, output: path.join(demo.directory, 'crash-b.json'), bone: 'root', transform: { x: 35 } });
  assert.equal(b.nativePreview.sessions[0].id, id);
  const recovered = await until(s => ready(s) && s.input === b.path && s.workerPid !== first.workerPid && s.recovery.restartCount >= 1);
  assert.notEqual(recovered.textureSha256, first.textureSha256);
  const rendererRecoveryMs = Date.now() - started;
  await call('spine_resume_native_preview', { id, options: { durationSeconds: 300 } });
  let current = await until(s => ready(s) && s.recovery.consecutiveFailures === 0), failures = 0;
  // Kill only the explicitly verified renderer from this new isolated fixture.
  // No taskkill /T and no Spine executable is touched.
  for (let n = 1; n <= 5; n++) {
    const pid = current.workerPid; await interruptOwnedProcess('worker', pid);
    if (n < 5) current = await until(s => ready(s) && s.workerPid !== pid && s.recovery.consecutiveFailures === n);
    else current = await until(s => s.state === 'failed' && s.recovery?.state === 'exhausted' && s.recovery.consecutiveFailures === 5);
    failures = n;
  }
  assert.equal(await fileSha256(initial.image), recovered.textureSha256);
  const exhausted = current;
  await call('spine_resume_native_preview', { id, options: { durationSeconds: 300 } });
  current = await until(s => ready(s) && s.recovery.consecutiveFailures === 0 && s.generation > exhausted.generation);
  assert.equal(current.project, initial.project); assert.equal(current.image, initial.image);
  assert.equal(current.textureSha256, recovered.textureSha256);

  // The supervisor itself is restored when a fresh MCP process starts. An
  // already-running renderer is adopted, so reconnection does not duplicate it.
  const oldSupervisor = current.recovery.supervisorPid, oldWorker = current.workerPid;
  await interruptOwnedProcess('supervisor', oldSupervisor);
  await connection.client.close(); connection = await connectSpine();
  const reconnected = await until(s => ready(s) && s.recovery.supervisorPid !== oldSupervisor);
  assert.equal(reconnected.workerPid, oldWorker);

  for (let n = 0; n < 3; n++) {
    await call('spine_stop_native_preview', { id });
    // Resume immediately to exercise the old supervisor/renderer shutdown race.
    const resumed = await call('spine_resume_native_preview', { id, options: { durationSeconds: 300 } });
    current = await until(s => ready(s) && s.generation >= resumed.pendingGeneration);
    assert.equal(current.project, initial.project);
  }
  await call('spine_resume_native_preview', { id, options: { durationSeconds: 5 } });
  const expired = await until(s => s.state === 'expired' && !s.workerAlive, 20000);
  const expiredImage = await fileSha256(initial.image);
  await call('spine_resume_native_preview', { id, options: { durationSeconds: 300 } });
  const afterExpiry = await until(s => ready(s) && s.generation > expired.generation);
  assert.equal(afterExpiry.textureSha256, expiredImage); assert.equal(afterExpiry.project, initial.project);

  const goodImage = await fileSha256(initial.image);
  await call('spine_update_native_preview', { id, changes: { animation: 'missing-animation' } });
  const bad = await until(s => s.consecutiveRenderErrors >= 2 && Boolean(s.lastErrorAt));
  assert.equal(await fileSha256(initial.image), goodImage);
  const correctedAt = Date.now();
  await call('spine_update_native_preview', { id, changes: { animation: null } });
  const corrected = await until(s => ready(s) && !s.lastError);
  assert.equal(corrected.consecutiveRenderErrors, 0); assert.equal(corrected.textureSha256, goodImage);
  const correctedRequestMs = Date.now() - correctedAt;
  await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive);
  await sleep(1200); const stopped = await call('spine_get_native_preview', { id });
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.workerAlive, false); assert.equal(stopped.supervisorAlive, false);
  assert.equal(await fileSha256(initial.project), projectHash); assert.equal(await fileSha256(demo.path), sourceHash);
  const report = {
    passed: true, version: VERSION, tools: TOOL_COUNT, id, project: initial.project, directory: folder,
    rendererCrashAutomaticallyRecovered: true, pendingEditsPreservedDuringCrash: true, latestBranchRendered: true,
    boundedCrashRecoveryVerified: true, consecutiveFailuresBeforeExhaustion: failures, explicitResumeResetsCrashBudget: true,
    supervisorRestoredOnMcpReconnect: true, reconnectAdoptedExistingRenderer: true, immediateStopResumeRaceVerified: true,
    expiredSessionResumedInSameProject: true, errorKeepsLastGoodImage: true, newRequestInterruptsErrorBackoff: true,
    stoppedSessionNotResurrected: true, projectAndSourceUnchanged: true, rendererRecoveryMs, correctedRequestMs,
    observedRenderErrors: bad.consecutiveRenderErrors, final: stopped, nativeEditorDisplayReceipt: false,
    inputAutomationUsed: false, interruptedProcesses: 'Only owned Node preview renderer/supervisor processes from this isolated fixture; executable, command line and lock ownership checked.',
  };
  const reportPath = path.join(projectRoot, `work/native-preview-recovery-report-${VERSION}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, reportPath, rendererRecoveryMs, correctedRequestMs, sameProject: true }, null, 2));
} finally {
  if (id) { try { await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive, 15000); } catch {} }
  await connection.client.close();
}
