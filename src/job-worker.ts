import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace, type Config } from './config.js';
import { BackgroundJobs, atomicJson, exists, type JobStatus } from './jobs.js';
import { jobSchema } from './job-schema.js';
import { SpineService } from './service.js';
import type { WorkControl } from './progress.js';
import { runPipeline, deliver } from './production-workflows.js';
import { publishAndOpen } from './publication.js';
import { auditAnimation } from './animation-audit.js';
import { runRegressionSuite } from './regression-suite.js';
import { runCharacterTask } from './character-task.js';
import { importPsd } from './psd-import.js';

const root = path.resolve(process.argv[2] ?? '');
const config = JSON.parse(process.env.SPINE_JOB_CONFIG ?? '{}') as Config;
const workerWorkspace = new Workspace(config.workspaceRoot);
if (path.resolve(await workerWorkspace.resolve('.queue')) !== root) throw new Error('Worker configuration does not match queue root.');
if (path.basename(root) !== '.queue') throw new Error('Worker requires a workspace .queue directory.');
const lock = path.join(root, 'worker.lock'), ownerFile = path.join(lock, 'owner.json'), token = randomUUID();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function acquire(): Promise<boolean> {
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
      if (Number.isInteger(owner.pid) && alive(owner.pid)) return false;
      await rename(lock, path.join(root, `retired-lock-${randomUUID()}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { if (Date.now() - (await stat(lock)).mtimeMs > 10000) { await rename(lock, path.join(root, `retired-lock-${randomUUID()}`)); return acquire(); } } catch { return false; }
      }
      // A new owner may still be writing its marker. Leave it alone.
      if (['ENOENT', 'EEXIST', 'EPERM', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) return false;
      throw error;
    }
    return acquire();
  }
  await writeFile(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' }); return true;
}
async function statuses() {
  const jobs: { directory: string; status: JobStatus }[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) if (item.isDirectory() && /^[a-f0-9-]{36}$/.test(item.name)) {
    const directory = path.join(root, item.name);
    try { jobs.push({ directory, status: JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')) as JobStatus }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return jobs.sort((a, b) => a.status.createdAt.localeCompare(b.status.createdAt));
}
async function run() {
  if (!await acquire()) return;
  try {
    const initial = await statuses();
    for (const item of initial.filter(item => item.status.state === 'running')) {
      item.status.state = 'failed'; item.status.error = 'Previous background worker exited unexpectedly. Inspect its artifacts before submitting again.'; item.status.updatedAt = new Date().toISOString(); await atomicJson(path.join(item.directory, 'status.json'), item.status);
    }
    for (;;) {
      const item = (await statuses()).find(item => item.status.state === 'queued'); if (!item) break;
      const { directory, status } = item, filename = path.join(directory, 'status.json');
      const save = async () => { status.updatedAt = new Date().toISOString(); await atomicJson(filename, status); };
      try {
        const raw = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8')) as { request: unknown }, request = jobSchema.parse(raw.request);
        const workspace = workerWorkspace;
        if (path.resolve(await workspace.resolve('.queue')) !== root) throw new Error('Job config does not match worker workspace.');
        const service = new SpineService(config);
        const control: WorkControl = { checkpoint: async progress => {
          if (await exists(path.join(directory, 'cancel'))) throw new Error('MCP_JOB_CANCELLED');
          status.progress = progress; await save();
        } };
        status.state = 'running'; status.workerPid = process.pid; await save();
        await control.checkpoint!({ phase: 'start', completed: 0, total: 1 });
        let result: unknown;
        switch (request.operation) {
          case 'import_psd': result = await importPsd(service, request.args, control); break;
          case 'character_task': result = await runCharacterTask(service, request.args, control, status.id); break;
          case 'publish_and_open': result = await publishAndOpen(service, request.args, control); break;
          case 'audit_animation': result = await auditAnimation(service, request.args, control); break;
          case 'regression_suite': result = await runRegressionSuite(service, request.args, control); break;
          case 'pipeline': result = await runPipeline(service, request.args, control); break;
          case 'deliver': result = await deliver(service, request.args.input, request.args.options, request.args.skeletonName, control); break;
          case 'edit_project': result = await service.editProject(request.args.input, request.args.output, request.args.edits, request.args.skeletonName, control); break;
          case 'build_project': result = await service.buildProject(request.args.entries, request.args.output, control); break;
          case 'edit_multi_project': result = await service.editMultiProject(request.args.input, request.args.output, request.args.changes, control); break;
          case 'export_frames': result = await service.exportFrames(request.args.input, request.args.options, request.args.skeletonName, control); break;
          case 'export_media': result = await service.exportMedia(request.args.input, request.args.options, request.args.skeletonName, control); break;
          case 'batch': result = await service.batch(request.args, control); break;
        }
        status.resultPath = path.join(directory, 'result.json'); await atomicJson(status.resultPath, result); status.state = 'succeeded'; await save();
      } catch (error) {
        status.state = (error as Error).message === 'MCP_JOB_CANCELLED' ? 'cancelled' : 'failed'; status.error = status.state === 'failed' ? (error as Error).message : undefined; await save();
      }
    }
  } finally {
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
    if (owner.token === token) { await unlink(ownerFile); await rename(lock, path.join(root, `retired-lock-${token}`)); }
  }
  // A submit may have raced the last empty scan while the lock still existed.
  if ((await statuses()).some(item => item.status.state === 'queued')) {
    new BackgroundJobs(workerWorkspace, config).kick(root);
  }
}
await run();
