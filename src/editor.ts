import { spawn, execFile, type SpawnOptions } from 'node:child_process';
import { mkdir, open, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Config, Workspace } from './config.js';
import { resolveLauncher } from './launcher-discovery.js';
import { fileSha256 } from './file-hash.js';
import { replaceFile } from './file-replace.js';
import { editorOpenOptions } from './editor-project.js';
import type { z } from 'zod/v4';

type OpenOptions = z.input<typeof editorOpenOptions>;
export interface EditorProcess { pid: number; parentPid: number; executable: string; startedAt: string; hasWindow: boolean; title: string }
interface Inventory { available: boolean; processes: EditorProcess[]; reason?: string }
export interface EditorCommand { executable: string; args: string[]; options: SpawnOptions }
interface OpenRequest {
  id: string; project: string; projectSha256: string; executable: string; reuseInstance: boolean;
  requestedAt: string; launchAccepted: boolean; launcherPid?: number; error?: string; baselinePids: number[];
}
interface EditorDependencies {
  launch: (command: EditorCommand) => Promise<number>;
  inventory: (executable: string, pid?: number) => Promise<Inventory>;
}

/** Never run this through the batch CLI timeout/kill path. The editor owns
 * its lifetime and must survive MCP disconnects. Tool arguments stay data. */
export function editorCommand(executable: string, project: string, reuseInstance: boolean): EditorCommand {
  const args = [reuseInstance ? '--reuse-instance' : '--no-reuse-instance', project];
  const options: SpawnOptions = { cwd: path.dirname(executable), shell: false, detached: true, windowsHide: true, stdio: 'ignore' };
  if (/\.(?:bat|cmd)$/i.test(executable)) {
    if (process.platform !== 'win32') throw new Error('Batch editor launchers require Windows.');
    if ([executable, ...args].some(value => /[\r\n"&|<>^%!]/.test(value))) throw new Error('Batch editor paths cannot contain quotes, newlines, or CMD metacharacters. Use a simple local filename.');
    return { executable: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', `"${[executable, ...args].map(value => `"${value}"`).join(' ')}"`], options: { ...options, windowsVerbatimArguments: true } };
  }
  return { executable, args, options };
}

async function launch(command: EditorCommand): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, command.options);
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid!); });
  });
}

const execFileAsync = promisify(execFile);
async function inventory(executable: string, pid?: number): Promise<Inventory> {
  if (process.platform !== 'win32') return { available: false, processes: [], reason: 'Window observation is implemented for Windows only.' };
  // Read-only metadata only. Do not read command lines, send window messages,
  // activate windows, dismiss prompts, or expose unrelated process information.
  const command = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$taskGui = $env:SPINE_EDITOR_OBSERVE_EXE
$taskDir = [IO.Path]::GetDirectoryName($taskGui) + [IO.Path]::DirectorySeparatorChar
$taskRoot = [int]$env:SPINE_EDITOR_OBSERVE_PID
$taskAll = @(Get-CimInstance Win32_Process)
$taskIds = [Collections.Generic.HashSet[int]]::new()
if ($taskRoot -gt 0) { [void]$taskIds.Add($taskRoot) }
do {
  $taskAdded = $false
  foreach ($taskItem in $taskAll) { if ($taskIds.Contains([int]$taskItem.ParentProcessId) -and $taskIds.Add([int]$taskItem.ProcessId)) { $taskAdded = $true } }
} while ($taskAdded)
$taskResult = @($taskAll | Where-Object {
  $taskIds.Contains([int]$_.ProcessId) -or ($_.ExecutablePath -and ($_.ExecutablePath -eq $taskGui -or $_.ExecutablePath.StartsWith($taskDir, [StringComparison]::OrdinalIgnoreCase)))
} | ForEach-Object {
  $taskProc = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; executable=[string]$_.ExecutablePath; startedAt=$_.CreationDate.ToUniversalTime().ToString('o'); hasWindow=($taskProc.MainWindowHandle -ne 0 -and $null -ne $taskProc); title=[string]$taskProc.MainWindowTitle }
})
ConvertTo-Json -InputObject $taskResult -Depth 4 -Compress
`;
  try {
    const result = await execFileAsync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024, encoding: 'utf8', env: { ...process.env, SPINE_EDITOR_OBSERVE_EXE: executable, SPINE_EDITOR_OBSERVE_PID: String(pid ?? 0) } });
    return { available: true, processes: JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) };
  } catch { return { available: false, processes: [], reason: 'Process/window observation was unavailable; launch acceptance does not prove project load.' }; }
}

export class EditorProjects {
  private readonly deps: EditorDependencies;
  constructor(readonly workspace: Workspace, readonly config: Config, deps: Partial<EditorDependencies> = {}) { this.deps = { launch, inventory, ...deps }; }

  async observe() {
    try { const executable=await this.resolveExecutable();return {executable,...await this.deps.inventory(executable)}; }
    catch(e){return {available:false,processes:[] as EditorProcess[],reason:(e as Error).message};}
  }

  async resolveExecutable(): Promise<string> {
    const resolved = await resolveLauncher(this.config, 'gui');
    if (!resolved.executable) throw new Error('Configure guiExecutable or guiRuntimeDiscovery for the installed Spine editor. ' + resolved.errors.join(' '));
    return resolved.executable;
  }

  private async filename(id: string) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid editor-open request ID.');
    return this.workspace.resolve(path.join('.editor-opens', `${id}.json`), false);
  }
  private async save(request: OpenRequest) {
    const filename = await this.filename(request.id), staging = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(staging, JSON.stringify(request, null, 2), { flag: 'wx' }); await replaceFile(staging, filename); }
    finally { await unlink(staging).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  private async read(id: string): Promise<OpenRequest> {
    const filename = await this.workspace.resolve(await this.filename(id));
    if ((await stat(filename)).size > 64 * 1024) throw new Error('Editor-open record is too large.');
    const request = JSON.parse(await readFile(filename, 'utf8')) as OpenRequest;
    if (request.id !== id || typeof request.project !== 'string' || typeof request.executable !== 'string' || !Array.isArray(request.baselinePids)) throw new Error('Invalid editor-open record.');
    await this.workspace.resolve(request.project, false); return request;
  }

  async open(input: string, raw: OpenOptions = {}) {
    const options = editorOpenOptions.parse(raw), project = await this.workspace.resolve(input);
    if(options.nativeBridge)throw new Error('Use SpineService.openProject for nativeBridge=true.');
    if (path.extname(project).toLowerCase() !== '.spine' || !(await stat(project)).isFile() || !(await stat(project)).size) throw new Error('Open requires a nonempty saved .spine project inside workspaceRoot.');
    const id = options.requestId ?? randomUUID(), filename = await this.filename(id), projectSha256 = await fileSha256(project);
    const existing = await this.read(id).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return null; });
    if (existing) {
      if (existing.project !== project || existing.projectSha256 !== projectSha256 || existing.reuseInstance !== options.reuseInstance) throw new Error('requestId already belongs to another project, file revision, or instance mode.');
      return { ...await this.get(id, options.waitMs), reusedRequest: true };
    }
    const executable = await this.resolveExecutable(), command = editorCommand(executable, project, options.reuseInstance);
    const before = await this.deps.inventory(executable), request: OpenRequest = { id, project, projectSha256, executable, reuseInstance: options.reuseInstance, requestedAt: new Date().toISOString(), launchAccepted: false, baselinePids: before.processes.map(item => item.pid) };
    await mkdir(path.dirname(filename), { recursive: true });
    // Reserve before spawning. Retrying an uncertain request must not create
    // another editor. A failed request requires an explicitly NEW request ID.
    let reservation;
    try { reservation = await open(filename, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error('This requestId is already being submitted. Query spine_get_editor_open_status with the same ID.');
    }
    try { await reservation.writeFile(JSON.stringify(request, null, 2)); } finally { await reservation.close(); }
    try {
      // Inventory collection may take time. Re-resolve before spawning a trusted
      // runtime, while it is still certain that this request has no child.
      const current = await this.resolveExecutable();
      if (current !== request.executable) { request.executable = current; request.baselinePids = (await this.deps.inventory(current)).processes.map(p => p.pid); await this.save(request); }
      try { request.launcherPid = await this.deps.launch(editorCommand(request.executable, project, options.reuseInstance)); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
        const renewed = await this.resolveExecutable(); if (renewed === request.executable) throw error;
        request.executable = renewed; await this.save(request); request.launcherPid = await this.deps.launch(editorCommand(renewed, project, options.reuseInstance));
      }
      request.launchAccepted = true;
    }
    catch (error) { request.error = `Editor launcher could not start: ${(error as Error).message}`; }
    await this.save(request);
    return { ...await this.get(id, options.waitMs), reusedRequest: false };
  }

  async get(id: string, waitMs = 0) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw new Error('waitMs must be between 0 and 10000.');
    const request = await this.read(id), deadline = Date.now() + waitMs;
    let observation: Inventory, windows: (EditorProcess & { correlation: string })[];
    do {
      observation = await this.deps.inventory(request.executable, request.launcherPid);
      const descendants = new Set(request.launcherPid ? [request.launcherPid] : []);
      for (let pass = 0; pass <= observation.processes.length; pass++) {
        let added = false;
        for (const item of observation.processes) if (descendants.has(item.parentPid) && !descendants.has(item.pid)) { descendants.add(item.pid); added = true; }
        if (!added) break;
      }
      windows = observation.processes.filter(item => item.hasWindow && !request.baselinePids.includes(item.pid) && Date.parse(item.startedAt) >= Date.parse(request.requestedAt) - 2000).map(item => ({ ...item, correlation: descendants.has(item.pid) ? 'launched-process-family' : 'new-window-in-launcher-directory' }));
      if (windows.length || request.error || !request.launchAccepted || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
    let unchanged = false;
    try { unchanged = await fileSha256(request.project) === request.projectSha256; } catch {}
    return {
      id, project: request.project, projectSha256: request.projectSha256, projectFileUnchanged: unchanged,
      state: request.error ? 'failed' : windows!.length ? 'window_observed' : request.launchAccepted ? 'submitted_unconfirmed' : 'submission_unconfirmed',
      requestedAt: request.requestedAt, executable: request.executable, reuseInstance: request.reuseInstance,
      launchAccepted: request.launchAccepted, launcherPid: request.launcherPid, error: request.error,
      launcherProcessObserved: observation!.processes.some(item => item.pid === request.launcherPid),
      observationAvailable: observation!.available, observationReason: observation!.reason,
      windowObserved: Boolean(windows!.length), windows: windows!,
      projectWindowTitleMatched: windows!.some(item => item.title === `Spine - ${path.basename(request.project, path.extname(request.project))}`),
      projectLoadedVerified: false,
      editorUnsavedStateAvailable: false, focusPreservedGuaranteed: false, settingsModified: false,
      note: 'Window/process evidence is not a receipt of the loaded project or its visual contents. Spine may activate a window or show an import/save/startup prompt. No mouse, keyboard, prompt dismissal, settings edit, hot reload, or process termination is performed. The editor survives MCP disconnects.',
    };
  }
}
