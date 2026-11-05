import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFile } from './file-replace.js';
import { fileURLToPath } from 'node:url';
import type { Config, Workspace } from './config.js';
import { jobSchema, type JobRequest } from './job-schema.js';
import type { Progress } from './progress.js';
import { processAlive, syncLease } from './sync-lock.js';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface JobStatus { id: string; operation: JobRequest['operation']; state: JobState; createdAt: string; updatedAt: string; progress?: Progress; error?: string; resultPath?: string; workerPid?: number; retryOf?: string; recoveryId?: string; recoveryOutput?: string }
export async function atomicJson(filename: string, value: unknown) {
  const temporary = path.join(path.dirname(filename), `.write-${randomUUID()}.json`);
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' }); await replaceFile(temporary, filename); }
  finally { await unlink(temporary).catch(() => undefined); }
}
export const exists = async (filename: string) => { try { await access(filename); return true; } catch { return false; } };
export class BackgroundJobs {
  constructor(readonly workspace: Workspace, readonly config: Config) {}
  async root() { const directory = await this.workspace.resolve('.queue', false); await mkdir(directory, { recursive: true }); return directory; }
  async folder(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid job id.');
    return this.workspace.resolve(path.join(await this.root(), id));
  }
  kick(root: string) {
    const worker = fileURLToPath(new URL('./job-worker.js', import.meta.url));
    const child = spawn(process.execPath, [worker, root], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, SPINE_JOB_CONFIG: JSON.stringify(this.config) } }); child.on('error', () => undefined); child.unref();
  }
  async submit(raw: JobRequest, origin: Pick<JobStatus, 'retryOf' | 'recoveryId' | 'recoveryOutput'> = {}) {
    const request = jobSchema.parse(raw), root = await this.root();
    if (request.operation === 'publish_and_open') request.args.requestId ??= randomUUID();
    const pending = (await this.list(1000)).jobs.filter(job => ['queued', 'running'].includes(job.state));
    if (pending.length >= 100) throw new Error('Background queue already has 100 pending jobs.');
    const id = randomUUID(), directory = path.join(root, id), now = new Date().toISOString(); await mkdir(directory);
    const serialized = JSON.stringify({ request });
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('Job request exceeds 8 MiB. Split it into smaller operations.');
    await writeFile(path.join(directory, 'request.json'), serialized, { flag: 'wx' });
    const status: JobStatus = { id, operation: request.operation, state: 'queued', createdAt: now, updatedAt: now, ...origin };
    await atomicJson(path.join(directory, 'status.json'), status); this.kick(root);
    return { ...status, directory, note: 'Runs in a hidden detached worker, even after this MCP connection closes. Query with spine_get_job; cancel cooperatively between work stages. Existing CLI steps may finish before cancellation is observed.' };
  }
  async get(id: string, includeResult = false) {
    const directory = await this.folder(id), status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')) as JobStatus;
    const cancelRequested = await exists(path.join(directory, 'cancel'));
    let result: unknown;
    if (includeResult && status.resultPath) {
      const filename = await this.workspace.resolve(status.resultPath), text = await readFile(filename, 'utf8');
      result = Buffer.byteLength(text) <= 1024 * 1024 ? JSON.parse(text) : { note: 'Result exceeds 1 MiB. Read resultPath locally.' };
    }
    const workerAlive = processAlive(status.workerPid), interrupted = status.state === 'running' && !workerAlive;
    return { ...status, cancelRequested, directory, workerAlive, interrupted, ...(interrupted ? { recoverySuggested: 'spine_recover_job', note: 'Stored running state belongs to a worker that is no longer alive. Explicit recovery can classify the interruption and submit one idempotent replacement.' } : {}), ...(includeResult ? { result } : {}) };
  }
  async list(limit = 50) {
    const root = await this.root(), jobs: JobStatus[] = [];
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f0-9-]{36}$/.test(item.name)) continue;
      try { jobs.push(JSON.parse(await readFile(path.join(root, item.name, 'status.json'), 'utf8')) as JobStatus); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { total: jobs.length, jobs: jobs.slice(0, limit) };
  }
  async cancel(id: string) {
    const status = await this.get(id);
    if (['succeeded', 'failed', 'cancelled'].includes(status.state)) return { ...status, cancellationAccepted: false, reason: 'Job is already finished.' };
    const directory = await this.folder(id);
    await writeFile(path.join(directory, 'cancel'), new Date().toISOString(), { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    this.kick(await this.root());
    return { id, cancellationAccepted: true, note: 'Cancellation requested. Worker checks before each stage and before publishing. A CLI call already running is allowed to finish; the open Spine editor process is never killed.' };
  }
  async resume() {
    const pending = (await this.list(1000)).jobs.filter(job => ['queued', 'running'].includes(job.state));
    if (pending.length) this.kick(await this.root());
    return { pending: pending.map(job => job.id), workerRequested: pending.length > 0, note: 'Queued jobs resume when no worker is alive. Interrupted running jobs are marked failed for inspection rather than repeated automatically. Does not duplicate a live worker.' };
  }
  async retry(id: string, newOutput?: string) {
    const previous = await this.get(id);
    if (!['failed', 'cancelled'].includes(previous.state)) throw new Error('Only failed or cancelled jobs can be retried.');
    const raw = JSON.parse(await readFile(path.join(await this.folder(id), 'request.json'), 'utf8')) as { request: JobRequest }, request = jobSchema.parse(raw.request);
    if (newOutput !== undefined) { if (!('output' in request.args)) throw new Error('This operation has no output destination.'); if (request.operation === 'publish_and_open' && request.args.output !== newOutput) request.args.requestId = randomUUID(); request.args.output = newOutput; }
    return this.submit(request, { retryOf: id });
  }
  async recover(id: string, recoveryId = id, newOutput?: string) {
    const directory = await this.folder(id); if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(recoveryId)) throw new Error('Invalid recovery ID.');
    const output = newOutput === undefined ? undefined : await this.workspace.resolve(newOutput, false);
    const release = await syncLease(this.workspace, path.join(directory, 'recovery.lock'));
    if (!release) return { id, recoveryId, action: 'recovery_in_progress', note: 'Repeat the same recovery ID to obtain the existing result; no duplicate replacement was submitted.' };
    let queueRelease: (() => Promise<void>) | null = null, kickAfterRelease = false;
    try {
      // The metadata is persisted with the queued status BEFORE any worker is
      // kicked. After a lost response or process exit, rediscover that exact
      // replacement instead of submitting another one.
      const existing = (await this.list(Number.MAX_SAFE_INTEGER)).jobs.find(job => job.retryOf === id && job.recoveryId === recoveryId);
      if (existing) {
        if (existing.recoveryOutput !== output) throw new Error('recoveryId belongs to another output. Use a fresh recoveryId for a different request.');
        if (existing.state === 'queued') { this.kick(await this.root()); }
        return { ...await this.get(existing.id, true), action: 'existing_recovery', sourceId: id, recoveryId, resultRevalidated: false };
      }
      let previous = await this.get(id, true);
      if (previous.state === 'succeeded') return { ...previous, action: 'already_completed', recoveryId, resultRevalidated: false, note: 'Historical completed result reused; this does not revalidate changed sources/resources or reopen an editor.' };
      if (previous.state === 'queued' || previous.state === 'running' && previous.workerAlive) {
        if (output !== undefined) throw new Error('A queued or live job cannot change its output. Let it finish or explicitly cancel it first.');
        if (previous.state === 'queued') this.kick(await this.root());
        return { ...previous, action: previous.state === 'queued' ? 'resumed_queue' : 'already_running', recoveryId };
      }
      if (previous.state === 'running') {
        queueRelease = await syncLease(this.workspace, path.join(await this.root(), 'worker.lock'));
        if (!queueRelease) return { ...previous, action: 'queue_busy', recoveryId, note: 'Queue ownership is active or being established. Retry with the same recovery ID; no running worker was disturbed.' };
        previous = await this.get(id, true);
        if (previous.state !== 'running' || previous.workerAlive) return { ...previous, action: 'state_changed', recoveryId };
        const status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')) as JobStatus;
        status.state = 'failed'; status.error = 'Previous worker exited; explicit recovery preserved its artifacts and classified the interruption.'; status.updatedAt = new Date().toISOString();
        await atomicJson(path.join(directory, 'status.json'), status);
      }
      const raw = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8')) as { request: JobRequest }, request = jobSchema.parse(raw.request);
      if (output !== undefined) {
        if (!('output' in request.args)) throw new Error('This operation has no output destination.');
        if (request.operation === 'publish_and_open' && await this.workspace.resolve(request.args.output, false) !== output) request.args.requestId = randomUUID();
        request.args.output = output;
      }
      if (request.operation !== 'publish_and_open' && 'output' in request.args && typeof request.args.output === 'string' && await exists(await this.workspace.resolve(request.args.output, false))) throw new Error('Output already exists. Choose newOutput; recovery never overwrites an uncertain output. Verified publication requests can recheck and reuse their own output.');
      const submitted = await this.submit(request, { retryOf: id, recoveryId, ...(output === undefined ? {} : { recoveryOutput: output }) }); kickAfterRelease = true;
      return { ...submitted, sourceId: id, action: 'retried', recoveryId, note: 'One replacement is bound to this recovery ID, including after reconnect/lost response. Publication keeps its request ID for the same output and independently verifies uncertain results. Other operations read the current saved inputs; no unsaved or historical input revision is restored.' };
    } finally { if (queueRelease) { await queueRelease(); kickAfterRelease = true; } await release(); if (kickAfterRelease) this.kick(await this.root()); }
  }
}
