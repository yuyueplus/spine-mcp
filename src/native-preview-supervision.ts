import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpineService } from './service.js';
import { atomicJson } from './jobs.js';
import { processAlive, syncLease } from './sync-lock.js';
import { nativePreviewLeaseOwner, type NativePreviewRecovery, type NativePreviewStatus } from './native-preview.js';

export const nativePreviewRetryDelay = (failures: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
export const NATIVE_PREVIEW_MAX_FAILURES = 5;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Separate from the renderer, so a renderer process exit cannot kill its
 * recovery loop. Only our own hidden Node workers are started; Spine is never
 * launched, activated or terminated. A fresh request explicitly resets retries. */
export async function superviseNativePreview(service: SpineService, folder: string) {
  const manager = service.nativePreviews, id = path.basename(folder);
  if (path.resolve(await manager.folder(id)) !== path.resolve(folder)) throw new Error('Native preview supervisor directory does not match workspace.');
  const release = await syncLease(service.workspace, path.join(folder, 'supervisor.lock')); if (!release) return;
  let recovery: NativePreviewRecovery = { supervisorPid: process.pid, state: 'starting', updatedAt: new Date().toISOString(), restartCount: 0, consecutiveFailures: 0 };
  const save = async () => { recovery.updatedAt = new Date().toISOString(); await atomicJson(path.join(folder, 'supervisor.json'), recovery); };
  try {
    const previous = await manager.recovery(folder);
    if (previous) recovery = { ...previous, supervisorPid: process.pid };
    let stableSince = 0, firstWorker = !previous;
    for (;;) {
      const request = await manager.request(folder);
      if (request.stop || Date.parse(request.expiresAt) <= Date.now()) { recovery.state = request.stop ? 'stopped' : 'expired'; await save(); return; }
      if (request.recoveryEpoch !== recovery.epoch) {
        recovery.epoch = request.recoveryEpoch; recovery.consecutiveFailures = 0; delete recovery.nextRestartAt; delete recovery.lastError;
        if (recovery.state === 'exhausted') recovery.state = 'starting';
      }
      if (recovery.state === 'exhausted') return;
      const worker = await nativePreviewLeaseOwner(service.workspace, folder, 'worker');
      if (worker.held) {
        if (worker.pid && worker.pid !== recovery.workerPid) { recovery.workerPid = worker.pid; recovery.workerStartedAt = new Date().toISOString(); stableSince = Date.now(); }
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 20_000) recovery.consecutiveFailures = 0;
        recovery.state = 'watching'; await save(); await delay(500); continue;
      }
      // A just-spawned renderer may still be importing modules before it takes
      // its lease. Never start a duplicate while that child is alive.
      if (processAlive(recovery.workerPid)) { recovery.state = 'starting'; await save(); await delay(500); continue; }
      if (recovery.workerPid) {
        recovery.lastError = `Native preview renderer ${recovery.workerPid} exited. The last published image is retained.`;
        recovery.consecutiveFailures++; delete recovery.workerPid; stableSince = 0;
        recovery.nextRestartAt = new Date(Date.now() + nativePreviewRetryDelay(recovery.consecutiveFailures)).toISOString();
      }
      if (recovery.consecutiveFailures >= NATIVE_PREVIEW_MAX_FAILURES) {
        recovery.state = 'exhausted'; recovery.lastError = `${recovery.lastError ?? 'Renderer could not start.'} Automatic recovery stopped after ${NATIVE_PREVIEW_MAX_FAILURES} consecutive failures. Correct the cause and resume the same preview or submit a new edit.`;
        await save(); return;
      }
      if (recovery.nextRestartAt && Date.parse(recovery.nextRestartAt) > Date.now()) { recovery.state = 'waiting'; await save(); await delay(500); continue; }
      const status = JSON.parse(await readFile(path.join(folder, 'status.json'), 'utf8')) as NativePreviewStatus;
      if (!firstWorker || status.workerPid) recovery.restartCount++;
      firstWorker = false;
      const child = spawn(process.execPath, [fileURLToPath(new URL('./native-preview-worker.js', import.meta.url)), folder], {
        detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, SPINE_NATIVE_PREVIEW_CONFIG: JSON.stringify(service.config) },
      });
      try {
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        recovery.workerPid = child.pid; recovery.workerStartedAt = new Date().toISOString(); recovery.state = 'starting'; delete recovery.nextRestartAt;
      } catch (error) {
        recovery.lastError = `Renderer could not start: ${(error as Error).message}`; recovery.consecutiveFailures++;
        recovery.nextRestartAt = new Date(Date.now() + nativePreviewRetryDelay(recovery.consecutiveFailures)).toISOString(); recovery.state = 'waiting';
      }
      child.unref(); await save(); await delay(500);
    }
  } catch (error) { recovery.state = 'exhausted'; recovery.lastError = `Preview supervisor failed: ${(error as Error).message}`; await save(); }
  finally {
    await release();
    // A resume can race the last iteration of a stopped/exhausted supervisor.
    // Recheck AFTER releasing the lease so the new request cannot lose its kick.
    const latest = await manager.request(folder);
    if (!latest.stop && Date.parse(latest.expiresAt) > Date.now() && latest.recoveryEpoch !== recovery.epoch) await manager.kick(folder);
  }
}
