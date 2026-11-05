import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import type { Config, Workspace } from './config.js';
import type { SpineService } from './service.js';
import { atomicJson, exists } from './jobs.js';
import { syncOptionsSchema, syncRequestSchema, syncResumeOptionsSchema, type SyncRequest } from './sync-schema.js';
import { processAlive, syncLease } from './sync-lock.js';
import { readDocument } from './document.js';
import { resourceRefs } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { archiveProject, verifyArchive } from './original-archive.js';

export type SyncState = 'starting' | 'watching' | 'capturing' | 'stopped' | 'expired' | 'limit_reached' | 'failed' | 'interrupted';
export interface SyncRevision { index: number; createdAt: string; fingerprint: string; sourceHash: string; archive: string; original: string; bytes: number }
export interface SyncStatus { id: string; input: string; state: SyncState; phase: string; createdAt: string; updatedAt: string; expiresAt: string; options: SyncRequest['options']; revisions: SyncRevision[]; outputBytes: number; workerPid?: number; lastFingerprint?: string; lastError?: string; consecutiveErrors?: number; lastObservationAt?: string; orphanedArchives?: string[] }
const live = new Set<SyncState>(['starting', 'watching', 'capturing']);
const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export class SavedProjectSync {
  constructor(readonly workspace: Workspace, readonly config: Config) {}
  async root() { const root = await this.workspace.resolve('.sync', false); await mkdir(root, { recursive: true }); return root; }
  async folder(id: string) { if (!validId(id)) throw new Error('Invalid synchronization id.'); return this.workspace.resolve(path.join(await this.root(), id)); }
  kick(directory: string) { const child = spawn(process.execPath, [fileURLToPath(new URL('./sync-worker.js', import.meta.url)), directory], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, SPINE_SYNC_CONFIG: JSON.stringify(this.config) } }); child.on('error', () => undefined); child.unref(); }
  async get(id: string) {
    const directory = await this.folder(id), status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')) as SyncStatus;
    if (live.has(status.state) && !processAlive(status.workerPid) && Date.now() - Date.parse(status.updatedAt) > 5000) { status.state = 'interrupted'; status.phase = 'worker-exited'; }
    return { ...status, stopRequested: await exists(path.join(directory, 'stop')), directory, savedFilesOnly: true, editorMemoryRead: false };
  }
  async list(limit = 50) {
    const watches = []; for (const item of await readdir(await this.root(), { withFileTypes: true })) if (item.isDirectory() && validId(item.name)) { try { watches.push(await this.get(item.name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    watches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return { total: watches.length, watches: watches.slice(0, limit) };
  }
  async start(input: string, rawOptions: unknown = {}) {
    const options = syncOptionsSchema.parse(rawOptions), filename = await realpath(await this.workspace.resolve(input));
    const info = await stat(filename); if (!['.json', '.spine'].includes(path.extname(filename).toLowerCase()) || !info.isFile()) throw new Error('Saved synchronization requires a local .json or .spine file.'); if (info.size > 1024 ** 3) throw new Error('Saved synchronization source exceeds 1 GiB.');
    const root = await this.root(), release = await syncLease(this.workspace, path.join(root, 'control.lock')); if (!release) throw new Error('Synchronization settings are busy. Retry shortly.');
    try {
      const current = (await this.list(1000)).watches.filter(item => live.has(item.state));
      const duplicate = current.find(item => samePath(item.input, filename)); if (duplicate) return { ...duplicate, alreadyRunning: true };
      if (current.length >= 8) throw new Error('At most eight saved-project synchronizations may run at once.');
      const id = randomUUID(), directory = path.join(root, id), now = new Date(); await mkdir(directory);
      const request: SyncRequest = { schemaVersion: 1, input: filename, options }, status: SyncStatus = { id, input: filename, state: 'starting', phase: 'worker-start', createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + options.durationSeconds * 1000).toISOString(), options, revisions: [], outputBytes: 0 };
      await atomicJson(path.join(directory, 'request.json'), request); await atomicJson(path.join(directory, 'status.json'), status); this.kick(directory);
      return { ...await this.get(id), alreadyRunning: false, note: 'Hidden worker observes saved project/resource changes and publishes independent byte-exact archives after a quiet period. Original files are never written. Stops at expiry or revision/storage limits. No editor memory access or keyboard/mouse input.' };
    } finally { await release(); }
  }
  async stop(id: string) { const status = await this.get(id); if (!live.has(status.state)) return { ...status, stopAccepted: false }; await writeFile(path.join(status.directory, 'stop'), new Date().toISOString(), { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); return { id, stopAccepted: true, note: 'Cooperative stop requested. An in-progress CLI export may finish; the editor is never stopped. Existing archives remain.' }; }
  async resume(id: string, rawOptions: unknown = {}) {
    const patch = syncResumeOptionsSchema.parse(rawOptions), root = await this.root(), release = await syncLease(this.workspace, path.join(root, 'control.lock')); if (!release) throw new Error('Synchronization settings are busy. Retry shortly.');
    try {
      const status = await this.get(id); if (live.has(status.state)) throw new Error('Synchronization is already active.');
      const all = (await this.list(1000)).watches.filter(item => live.has(item.state)); if (all.length >= 8 || all.some(item => samePath(item.input, status.input))) throw new Error('Another synchronization is active for this source or the worker limit is reached.');
      const request = syncRequestSchema.parse(JSON.parse(await readFile(path.join(status.directory, 'request.json'), 'utf8'))); request.options = syncOptionsSchema.parse({ ...request.options, ...patch });
      if (request.options.maxRevisions <= status.revisions.length || request.options.maxOutputMiB * 1024 ** 2 <= status.outputBytes) throw new Error('Increase maxRevisions/maxOutputMiB before resuming a synchronization at its limit.');
      await this.workspace.resolve(request.input); const updated: SyncStatus = { ...status, state: 'starting', phase: 'worker-resume', options: request.options, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + request.options.durationSeconds * 1000).toISOString(), consecutiveErrors: 0 }; delete updated.workerPid; delete updated.lastError;
      await unlink(path.join(status.directory, 'stop')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); await atomicJson(path.join(status.directory, 'request.json'), request); await atomicJson(path.join(status.directory, 'status.json'), updated); this.kick(status.directory); return this.get(id);
    } finally { await release(); }
  }
}

export interface SyncObservationCache { sourceHash?: string; resourcePaths: string[] }
export async function savedFileStamp(workspace: Workspace, input: string, paths: string[]) {
  const files = []; for (const file of [input, ...paths]) { try { const info = await stat(await workspace.resolve(file)); files.push([file, info.size, info.mtimeMs, info.ctimeMs]); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files.push([file, 'missing']); } }
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
export async function observeSavedProject(service: SpineService, input: string, cache: SyncObservationCache) {
  const source = await service.workspace.resolve(input); if ((await stat(source)).size > 1024 ** 3) throw new Error('Saved synchronization source exceeds 1 GiB.'); const sourceHash = await fileSha256(source);
  if (sourceHash !== cache.sourceHash) {
    const files = path.extname(source).toLowerCase() === '.json' ? [source] : (await service.cli.exportData(source)).files.filter(file => file.endsWith('.json'));
    if (!files.length) throw new Error('Saved project has no exported skeleton JSON.');
    const paths = new Set<string>(); for (const file of files) { const { refs } = await resourceRefs(service.workspace, await readDocument(file), file); for (const ref of refs) paths.add(ref.path); }
    if (paths.size > 10000) throw new Error('Saved synchronization exceeds 10,000 resource files.');
    cache.resourcePaths = [...paths].sort(); cache.sourceHash = sourceHash;
  }
  const resources: { path: string; sha256: string; bytes: number }[] = []; let bytes = (await stat(source)).size;
  for (const filename of cache.resourcePaths) { const file = await service.workspace.resolve(filename), info = await stat(file); if (!info.isFile()) throw new Error('A saved project resource is not a file.'); bytes += info.size; if (bytes > 1024 ** 3) throw new Error('Saved synchronization input exceeds 1 GiB.'); resources.push({ path: file, bytes: info.size, sha256: await fileSha256(file) }); }
  if (await fileSha256(source) !== sourceHash) throw new Error('Source changed during synchronization observation.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ sourceHash, resources: resources.map(file => [file.path, file.sha256]) })).digest('hex');
  return { fingerprint, sourceHash, resources, bytes };
}

export async function recoverSyncRevisions(service: SpineService, directory: string, status: SyncStatus) {
  const folder = await service.workspace.resolve(path.join(directory, 'commits'), false); await mkdir(folder, { recursive: true });
  const files = (await readdir(folder)).filter(file => /^revision-\d{4}-[a-f0-9]{64}\.json$/.test(file)).sort(); if (files.length > 100) throw new Error('Synchronization commit count exceeds 100.');
  const recovered: SyncRevision[] = [];
  for (const file of files) {
    const revision = JSON.parse(await readFile(await service.workspace.resolve(path.join(folder, file)), 'utf8')) as SyncRevision;
    if (revision.index !== recovered.length + 1 || !/^[a-f0-9]{64}$/.test(revision.fingerprint) || file !== `revision-${String(revision.index).padStart(4, '0')}-${revision.fingerprint}.json`) throw new Error('Synchronization commit index/fingerprint is invalid.');
    const manifestFile = await service.workspace.resolve(revision.archive), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (!samePath(manifest.source, status.input) || manifest.sourceHash !== revision.sourceHash || !samePath(path.join(path.dirname(manifestFile), manifest.original), revision.original) || revision.bytes !== manifest.files.reduce((sum: number, entry: { bytes: number }) => sum + entry.bytes, 0) || !(await verifyArchive(service, manifestFile)).valid) throw new Error('Synchronization committed archive verification failed.');
    recovered.push(revision);
  }
  if (status.revisions.length > recovered.length || status.revisions.some((revision, index) => JSON.stringify(revision) !== JSON.stringify(recovered[index]))) throw new Error('Synchronization history differs from its commit records.');
  const missing = recovered.slice(status.revisions.length); if (missing.length) { status.outputBytes += missing.reduce((sum, revision) => sum + revision.bytes, 0); status.revisions = recovered; status.lastFingerprint = recovered.at(-1)!.fingerprint; }
}

export async function runSavedSync(service: SpineService, directory: string) {
  const manager = service.savedSync, id = path.basename(directory); if (path.resolve(await manager.folder(id)) !== path.resolve(directory)) throw new Error('Worker directory does not match synchronization workspace.');
  const release = await syncLease(service.workspace, path.join(directory, 'worker.lock')); if (!release) return;
  const request = syncRequestSchema.parse(JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'))), status = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8')) as SyncStatus, cache: SyncObservationCache = { resourcePaths: [] };
  const save = async () => { status.updatedAt = new Date().toISOString(); await atomicJson(path.join(directory, 'status.json'), status); };
  let terminal: SyncState = 'stopped', pendingStamp = '', processedStamp = '', quietSince = Date.now(), nextVerify = 0, nextAttempt = 0;
  status.workerPid = process.pid; status.state = 'watching'; status.phase = 'waiting-stable';
  try {
    status.phase = 'recovering-commits'; await save(); await recoverSyncRevisions(service, directory, status); status.phase = 'waiting-stable'; await save();
    for (;;) {
      if (await exists(path.join(directory, 'stop'))) { terminal = 'stopped'; break; }
      if (Date.now() >= Date.parse(status.expiresAt)) { terminal = 'expired'; break; }
      if (status.revisions.length >= request.options.maxRevisions || status.outputBytes >= request.options.maxOutputMiB * 1024 ** 2) { terminal = 'limit_reached'; break; }
      let captured: { manifest: string; bytes: number; accounted: boolean } | undefined;
      const retainUncommitted = () => { if (!captured || captured.accounted) return; status.outputBytes += captured.bytes; (status.orphanedArchives ??= []).push(captured.manifest); captured.accounted = true; };
      try {
        const now = Date.now(), stamp = await savedFileStamp(service.workspace, request.input, cache.resourcePaths);
        if (stamp !== pendingStamp) { pendingStamp = stamp; quietSince = now; nextAttempt = 0; status.phase = 'waiting-stable'; }
        if (now - quietSince >= request.options.stableMs && now >= nextAttempt && (stamp !== processedStamp || now >= nextVerify)) {
          const oldPaths = JSON.stringify(cache.resourcePaths), observed = await observeSavedProject(service, request.input, cache); status.lastObservationAt = new Date().toISOString();
          if (JSON.stringify(cache.resourcePaths) !== oldPaths) { pendingStamp = await savedFileStamp(service.workspace, request.input, cache.resourcePaths); quietSince = Date.now(); status.phase = 'waiting-resource-stability'; }
          else {
            processedStamp = stamp; nextVerify = Date.now() + request.options.verifyEverySeconds * 1000;
            if (!status.lastFingerprint && !request.options.includeInitial) { status.lastFingerprint = observed.fingerprint; status.phase = 'monitoring'; }
            else if (observed.fingerprint !== status.lastFingerprint) {
              if (status.outputBytes + observed.bytes > request.options.maxOutputMiB * 1024 ** 2) { terminal = 'limit_reached'; break; }
              status.state = 'capturing'; status.phase = 'archiving'; await save();
              const archive = await archiveProject(service, request.input), manifest = JSON.parse(await readFile(archive.manifestPath, 'utf8')), outputBytes = manifest.files.reduce((sum: number, file: { bytes: number }) => sum + file.bytes, 0);
              captured = { manifest: archive.manifestPath, bytes: outputBytes, accounted: false };
              const after = await observeSavedProject(service, request.input, cache);
              if (await exists(path.join(directory, 'stop')) || Date.now() >= Date.parse(status.expiresAt) || after.fingerprint !== observed.fingerprint || manifest.sourceHash !== observed.sourceHash) { retainUncommitted(); if ((status.orphanedArchives?.length ?? 0) > 20) { terminal = 'failed'; status.lastError = 'Too many discarded synchronization captures. Inspect retained archives before resuming.'; break; } processedStamp = ''; quietSince = Date.now(); }
              else {
                const revision: SyncRevision = { index: status.revisions.length + 1, createdAt: new Date().toISOString(), fingerprint: observed.fingerprint, sourceHash: observed.sourceHash, archive: archive.manifestPath, original: archive.original, bytes: outputBytes }, commit = path.join(directory, 'commits', `revision-${String(revision.index).padStart(4, '0')}-${revision.fingerprint}.json`);
                if (await exists(commit)) throw new Error('Synchronization revision already committed. Resume to recover its status.'); await atomicJson(commit, revision);
                status.outputBytes += outputBytes; captured.accounted = true; status.revisions.push(revision); status.lastFingerprint = observed.fingerprint;
              }
            }
            status.phase = 'monitoring'; status.consecutiveErrors = 0; delete status.lastError;
          }
        }
        status.state = 'watching';
      } catch (error) {
        retainUncommitted();
        status.state = 'watching'; status.phase = 'waiting-retry'; status.lastError = (error as Error).message; status.consecutiveErrors = (status.consecutiveErrors ?? 0) + 1; processedStamp = '';
        nextAttempt = Date.now() + Math.min(30000, request.options.intervalMs * 2 ** Math.min(status.consecutiveErrors, 6));
        if (status.consecutiveErrors >= 20) { terminal = 'failed'; break; }
      }
      await save(); await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(request.options.intervalMs, Date.parse(status.expiresAt) - Date.now()))));
    }
  } catch (error) { terminal = 'failed'; status.lastError = (error as Error).message; }
  finally { await release(); status.state = terminal; status.phase = terminal; await save(); }
}
