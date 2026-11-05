import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { Config, Workspace } from './config.js';
import { readDocument, rebaseResources, type SpineDocument } from './document.js';
import { safeName } from './document.js';
import { validateResourcePaths } from './resource-paths.js';
import { checkpoint, type WorkControl } from './progress.js';
import { animationOrderFromJson, serializeImportJson, verifySliderBindings } from './import-order.js';
import { constraintList } from './constraint-data.js';
import { compileFolderDrawOrder } from './draw-order-compilation.js';
import { canonicalizeWeights } from './weight-order.js';
import { SkeletonBinary, TextureAtlas } from '@esotericsoftware/spine-core';
import { attachmentEntries } from './attachment-data.js';
import { readbackGeometry } from './binary-geometry.js';
import { boneDiagramLoader } from './runtime.js';
import { fileSha256 } from './file-hash.js';
import { nativeImportAudioRoot } from './import-audio.js';
import { resolveLauncher } from './launcher-discovery.js';
import { importTiming } from './import-timing.js';

export interface ProcessResult { exitCode: number; stdout: string; stderr: string }
const redact = (text: string) => text.split(/\r?\n/)
  .filter(line => !/^\[[A-Za-z0-9_-]*Agent\]|^Press any key|^Process exited\.|^Starting Spine Pro/.test(line))
  .map(line => /licensed to:|activation code:|license key:/i.test(line) ? '[license information omitted]' : line).join('\n');

export async function runProcess(executable: string, args: string[], timeoutMs: number, options: { windowsVerbatimArguments?: boolean; cwd?: string } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd ?? path.dirname(executable), shell: false, windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, exitCode = -1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ exitCode, stdout: redact(stdout.trim()), stderr: redact(stderr.trim()) });
    };
    const terminate = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.unref();
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { terminate(); finish(new Error(`Spine CLI timed out after ${timeoutMs} ms. Only the process started by this call was terminated.`)); }, timeoutMs);
    const collect = (kind: 'stdout' | 'stderr', chunk: string) => {
      if (kind === 'stdout') stdout += chunk; else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 512 * 1024) { terminate(); finish(new Error('CLI output exceeded 512 KiB.')); }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => finish(error));
    child.on('close', code => finish(undefined, code ?? -1));
  });
}

export class SpineCli {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly config: Config, readonly workspace: Workspace, private readonly processRunner = runProcess) {}

  async resolveExecutable(): Promise<string | null> {
    return (await resolveLauncher(this.config, 'cli')).executable;
  }

  async probe() {
    try {
      const result = await this.run(['--help'], Math.min(this.config.cliTimeoutMs, 10_000));
      const output = `${result.stdout}\n${result.stderr}`;
      const editorVersion = output.match(/^Spine\s+(\d+\.\d+\.\d+)\b/m)?.[1];
      const available = result.exitCode === 0 && (!editorVersion || editorVersion === this.config.targetVersion) && (/--export|--input/.test(output) || editorVersion === this.config.targetVersion);
      return { available, executable: result.entrypoint, editorVersion, ...result, reason: available ? undefined : 'The entrypoint did not return standard CLI help or the expected editor version.' };
    } catch (error) { return { available: false, executable: await this.resolveExecutable(), reason: (error as Error).message }; }
  }

  private async run(args: string[], timeout = this.config.cliTimeoutMs) {
    const task = this.tail.then(async () => {
      // Resolve inside the serialized operation, not before it waits in line.
      // A temporary entrypoint can disappear while another job is running.
      let executable = await this.resolveExecutable();
      if (!executable) throw new Error('Spine CLI unavailable: configure a working standard installed launcher, or start the installed editor to recreate its runtime. JSON tools remain available. No launcher or activation files were changed.');
      const invoke = (exe: string) => {
        if (/\.(?:bat|cmd)$/i.test(exe)) {
          if (process.platform !== 'win32') throw new Error('Batch entrypoints require Windows.');
          if ([exe, ...args].some(arg => /[\r\n"&|<>^%!]/.test(arg))) throw new Error('Batch CLI paths and names cannot contain quotes, newlines, or CMD metacharacters. Use a simple local filename.');
          const command = `"${[exe, ...args].map(arg => `"${arg}"`).join(' ')}"`;
          return this.processRunner(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', command], timeout, { windowsVerbatimArguments: true, cwd: path.dirname(exe) }).then(result => ({ ...result, entrypoint: exe }));
        }
        return this.processRunner(exe, args, timeout).then(result => ({ ...result, entrypoint: exe }));
      };
      try { return await invoke(executable); }
      catch (error) {
        // Retry only a synchronous missing-executable failure, before any
        // process started. Nonzero exits and timeouts are never replayed.
        if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
        const renewed = await this.resolveExecutable();
        if (!renewed || renewed === executable) throw error;
        executable = renewed; return invoke(executable);
      }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async checked(args: string[]) {
    const result = await this.run(args);
    if (result.exitCode !== 0) throw new Error(`Spine CLI failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    const reportedVersion = result.stdout.match(/^Spine\s+(\d+\.\d+\.\d+)\b/m)?.[1];
    if (reportedVersion && reportedVersion !== this.config.targetVersion) throw new Error(`CLI loaded Spine ${reportedVersion}; this adapter targets ${this.config.targetVersion}.`);
    if (/^ERROR\b|^Error[: ]|Exception(?: in thread|:)/m.test(`${result.stdout}\n${result.stderr}`)) throw new Error(`Spine CLI reported an error: ${result.stderr || result.stdout}`);
    return result;
  }

  private async job() {
    const root = await this.workspace.resolve('.jobs', false);
    await mkdir(root, { recursive: true });
    return mkdtemp(path.join(root, 'job-'));
  }

  async projectInfo(input: string) {
    const filename = await this.workspace.resolve(input);
    const result = await this.checked(['-i', filename]);
    if (!/Project info:|Skeleton:/.test(result.stdout)) throw new Error('CLI did not produce project information.');
    return result;
  }

  async exportData(input: string, format: 'json' | 'binary' = 'json') {
    const filename = await this.workspace.resolve(input);
    if (!['.spine', '.json', '.skel'].includes(path.extname(filename).toLowerCase())) throw new Error('Input must be .spine, .json, or .skel.');
    const originalHash = format === 'json' ? await fileSha256(filename) : undefined;
    const job = await this.job();
    const output = path.join(job, 'export');
    await mkdir(output);
    const settingsPath = path.join(job, 'export-settings.json');
    const settings = { class: format, extension: format === 'json' ? '.json' : '.skel', ...(format === 'json' ? { format: 'JSON', prettyPrint: true } : {}), nonessential: true, cleanUp: false, exportAll: true };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), { flag: 'wx' });
    const result = await this.checked(['-i', filename, '-o', output, '-e', settingsPath]);
    const files = (await readdir(output)).map(name => path.join(output, name));
    if (!files.some(file => file.endsWith(format === 'json' ? '.json' : '.skel'))) throw new Error('CLI reported success but did not produce skeleton data.');
    const skeletons: { name: string; path: string; animationOrder: string[] }[] = [];
    const documents = format === 'json' ? await Promise.all(files.filter(f => f.endsWith('.json')).map(async file => ({ file, data: await readDocument(file) }))) : [];
    const needsPrecision = (data: SpineDocument) => attachmentEntries(data).some(item => Array.isArray(item.value.vertices)) || Object.values(data.animations ?? {}).some(animation => Object.keys(animation.bones as object ?? {}).length);
    const binaryExport = documents.some(({ data }) => needsPrecision(data)) ? await this.exportData(filename, 'binary') : undefined;
    const geometryReadback: { skeleton: string; attachments: number; deformTracks: number; boneTracks: number; binary: string }[] = [];
    for (const document of documents) {
      const { file } = document; let { data } = document;
      skeletons.push({ name: path.basename(file, '.json'), path: file, animationOrder: animationOrderFromJson(await readFile(file, 'utf8')) });
      if (binaryExport && needsPrecision(data)) {
        const binaryPath = binaryExport.files.find(item => path.basename(item, '.skel') === path.basename(file, '.json'));
        if (!binaryPath || (await stat(binaryPath)).size > 32 * 1024 * 1024) throw new Error('Matching binary geometry export missing or larger than 32 MiB.');
        const precise = readbackGeometry(data, new SkeletonBinary(boneDiagramLoader).readSkeletonData(await readFile(binaryPath)));
        data = precise.data; geometryReadback.push({ skeleton: path.basename(file, '.json'), attachments: precise.attachments, deformTracks: precise.deformTracks, boneTracks: precise.boneTracks, binary: binaryPath });
      }
      // Spine exports image/audio metadata relative to the input project, not
      // the export directory. Make each generated JSON self-consistent.
      // A root equal to the project directory is serialized as null/empty.
      // Resolve that root BEFORE moving the JSON into the export job folder.
      for (const field of ['images', 'audio']) if (data.skeleton[field] === null || data.skeleton[field] === '') data.skeleton[field] = '.';
      const normalized = rebaseResources(data, path.dirname(filename), path.dirname(file));
      await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    }
    if (binaryExport && await fileSha256(filename) !== originalHash) throw new Error('Input changed between JSON and binary exports. Retry after saving; no consistent geometry snapshot was returned.');
    return { files, outputDirectory: output, log: result.stdout, warning: result.stderr || undefined, ...(format === 'json' ? { skeletons, geometryReadback } : {}) };
  }

  private async prepareImport(filename: string, inputData: SpineDocument, projectDirectory: string) {
    const prepared = path.join(await this.job(), 'import.json'), timing = importTiming(inputData), compiled = compileFolderDrawOrder(timing.data), absolute = rebaseResources(canonicalizeWeights(compiled), path.dirname(filename));
    const audio = nativeImportAudioRoot(inputData, path.dirname(filename), projectDirectory);
    if (audio !== undefined) absolute.skeleton.audio = audio;
    for (const item of attachmentEntries(absolute)) if (item.value.type === 'clipping' && item.value.convex === undefined) item.value.convex = false;
    await writeFile(prepared, serializeImportJson(absolute), { flag: 'wx' });
    let animationOrder: string[] | undefined;
    if (constraintList(inputData).some(item => item.type === 'slider')) {
      // This editor binds sliders before sorting imported animations. Obtain
      // its exact order, then serialize the ORIGINAL values in that order.
      const canonical = await this.exportData(prepared);
      if (canonical.skeletons?.length !== 1) throw new Error('Expected one canonical skeleton while preparing Slider import.');
      animationOrder = canonical.skeletons[0]!.animationOrder;
      await writeFile(prepared, serializeImportJson(absolute, animationOrder));
    }
    return { path: prepared, animationOrder, folderDrawOrderCompiled: compiled !== timing.data, timing: timing.report };
  }

  async importProject(input: string, output: string, skeletonName?: string, control?: WorkControl) {
    const filename = await this.workspace.resolve(input);
    if (path.extname(filename).toLowerCase() !== '.json') throw new Error('Import expects a Spine JSON file.');
    const inputData = await readDocument(filename);
    await validateResourcePaths(this.workspace, inputData, filename);
    const destination = await this.workspace.resolve(output, false);
    if (path.extname(destination).toLowerCase() !== '.spine') throw new Error('Output must end in .spine.');
    try { await stat(destination); throw new Error('Output exists; choose a new project name.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(path.dirname(destination), { recursive: true });
    // Keep staging beside the destination so relative images/audio paths survive
    // publishing the project under its final filename.
    const staging = path.join(path.dirname(destination), `.mcp-import-${randomUUID()}.spine`);
    try {
      await checkpoint(control, { phase: 'prepare-import', completed: 0, total: 4 });
      const prepared = await this.prepareImport(filename, inputData, path.dirname(destination));
      await checkpoint(control, { phase: 'import-skeleton', completed: 1, total: 4 });
      const result = await this.checked(['-i', prepared.path, '-o', staging, '-r', ...(skeletonName ? [skeletonName] : [])]);
      if (!(await stat(staging)).size) throw new Error('CLI did not produce a project.');
      const info = await this.projectInfo(staging);
      if (!new RegExp(`Spine version:\\s*${this.config.targetVersion.replaceAll('.', '\\.')}(?:\\s|$)`).test(info.stdout)) throw new Error('The generated project version could not be verified.');
      let sliderVerification: ReturnType<typeof verifySliderBindings> | undefined;
      await checkpoint(control, { phase: 'verify-import', completed: 2, total: 4 });
      if (prepared.animationOrder) {
        const exported = await this.exportData(staging), json = exported.files.filter(file => file.endsWith('.json'));
        if (json.length !== 1) throw new Error('Expected exactly one skeleton while verifying Slider import.');
        sliderVerification = verifySliderBindings(inputData, await readDocument(json[0]!));
      }
      await checkpoint(control, { phase: 'publish-import', completed: 3, total: 4 });
      await copyFile(staging, destination, constants.COPYFILE_EXCL);
      return { path: destination, log: result.stdout, folderDrawOrderCompiled: prepared.folderDrawOrderCompiled, ...(sliderVerification ? { sliderVerification, canonicalAnimationOrder: prepared.animationOrder } : {}), warning: 'JSON round-trips may omit editor-only information. Folder draw-order groups are compiled to equivalent global keys on import. The original project was not replaced.' };
    } finally { await unlink(staging).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }

  async importSkeletons(entries: { input: string; name: string }[], output: string, control?: WorkControl) {
    if (!entries.length || entries.length > 50 || new Set(entries.map(item => item.name)).size !== entries.length) throw new Error('Provide 1–50 skeletons with unique names.');
    const destination = await this.workspace.resolve(output, false);
    if (path.extname(destination).toLowerCase() !== '.spine') throw new Error('Output must end in .spine.');
    try { await stat(destination); throw new Error('Output exists; choose a new project name.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const prepared: { input: string; name: string; sliderData?: SpineDocument }[] = [];
    for (const entry of entries) {
      await checkpoint(control, { phase: 'prepare-import', completed: prepared.length, total: entries.length, detail: entry.name });
      safeName(entry.name);
      const input = await this.workspace.resolve(entry.input), data = await readDocument(input);
      await validateResourcePaths(this.workspace, data, input);
      const canonical = await this.prepareImport(input, data, path.dirname(destination));
      prepared.push({ input: canonical.path, name: entry.name, ...(canonical.animationOrder ? { sliderData: data } : {}) });
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const staging = path.join(path.dirname(destination), `.mcp-multi-${randomUUID()}.spine`);
    try {
      for (let index = 0; index < prepared.length; index++) {
        await checkpoint(control, { phase: 'import', completed: index, total: prepared.length, detail: prepared[index]!.name });
        // Only this fresh, owned staging file is ever extended by a later import.
        await this.checked(['-i', prepared[index]!.input, '-o', staging, '-r', prepared[index]!.name]);
      }
      if (!(await stat(staging)).size) throw new Error('CLI did not produce a multi-skeleton project.');
      await this.projectInfo(staging);
      if (prepared.some(entry => entry.sliderData)) {
        const exported = await this.exportData(staging);
        for (const entry of prepared) if (entry.sliderData) {
          const actual = exported.files.find(file => path.basename(file, '.json') === entry.name);
          if (!actual) throw new Error(`Imported skeleton missing while verifying Slider references: ${entry.name}`);
          verifySliderBindings(entry.sliderData, await readDocument(actual));
        }
      }
      await checkpoint(control, { phase: 'import', completed: prepared.length, total: prepared.length });
      await copyFile(staging, destination, constants.COPYFILE_EXCL);
      return { path: destination, skeletons: entries.map(entry => entry.name) };
    } finally { await unlink(staging).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }

  async packAtlas(images: string, name: string, settings?: Record<string, unknown>, project?: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('Atlas name must contain only letters, digits, _ and -.');
    const source = await this.workspace.resolve(images);
    if (!(await stat(source)).isDirectory()) throw new Error('images must be a directory.');
    const rejectLinks = async (folder: string): Promise<void> => {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error('Image directories cannot contain symbolic links or junctions.');
        if (item.isDirectory()) await rejectLinks(path.join(folder, item.name));
      }
    };
    await rejectLinks(source);
    const job = await this.job(), staged = path.join(job, 'images'), ignoredPackFiles: string[] = [], snapshots: { path: string; sha256: string }[] = []; let bytes = 0;
    const collect = async (folder: string, target: string): Promise<void> => {
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const filename = await this.workspace.resolve(path.join(folder, entry.name));
        if (entry.isSymbolicLink()) throw new Error('Image directories cannot contain links.');
        if (entry.isDirectory()) { await collect(filename, path.join(target, entry.name)); continue; }
        if (entry.name.toLowerCase() === 'pack.json') { ignoredPackFiles.push(filename); continue; }
        if (!/\.(png|jpg|jpeg)$/i.test(entry.name)) continue;
        bytes += (await stat(filename)).size; if (bytes > 1024 ** 3 || snapshots.length >= 20000) throw new Error('Atlas inputs exceed 1 GiB or 20,000 images.');
        const sha256 = await fileSha256(filename), destination = path.join(target, entry.name); await copyFile(filename, destination, constants.COPYFILE_EXCL); if (await fileSha256(destination) !== sha256) throw new Error('Atlas image changed while copying.'); snapshots.push({ path: filename, sha256 });
      }
    }; await collect(source, staged);
    if (!snapshots.length) throw new Error('No supported PNG/JPEG images were found.');
    const output = path.join(job, 'atlas');
    await mkdir(output);
    const pack = path.join(job, 'pack-settings.json'); await writeFile(pack, JSON.stringify(settings ?? {}), { flag: 'wx' });
    const context = project ? await this.workspace.resolve(project) : undefined;
    const result = await this.checked(['-i', staged, ...(context ? ['-j', context] : []), '-o', output, '-n', name, '-p', pack]);
    if (!(await readdir(output)).some(file => file.endsWith('.atlas'))) throw new Error('CLI did not produce an atlas.');
    for (const file of snapshots) if (await fileSha256(file.path) !== file.sha256) throw new Error('Atlas source image changed during packing.');
    return { files: (await readdir(output)).map(file => path.join(output, file)), log: result.stdout, ignoredPackFiles, sourceImages: snapshots.length, note: 'Images are copied into an owned staging tree. Input-folder pack.json files are ignored; use spine_pack_atlas_configured for validated settings.' };
  }

  async unpackAtlas(input: string, project?: string) {
    const atlas = await this.workspace.resolve(input);
    if (path.extname(atlas).toLowerCase() !== '.atlas') throw new Error('Unpack expects a local .atlas file.');
    const text = await readFile(atlas, 'utf8');
    if (text.length > 8 * 1024 * 1024) throw new Error('Atlas exceeds 8 MiB.');
    // Every page header follows a blank line and precedes a size field.
    const pages = [...text.matchAll(/(?:^|\r?\n\s*\r?\n)([^\r\n]+)\r?\n(?:size:|\s*size:)/g)].map(match => match[1]!.trim());
    if (!pages.length) throw new Error('Atlas page headers could not be validated.');
    for (const page of pages) { if (path.isAbsolute(page) || page.includes('..') || /[\\/]/.test(page)) throw new Error('Atlas pages must be plain filenames beside the atlas.'); await this.workspace.resolve(path.join(path.dirname(atlas), page)); }
    const output = path.join(await this.job(), 'unpacked'); await mkdir(output);
    const parsed = new TextureAtlas(text); if (!parsed.regions.length || parsed.regions.length > 100000) throw new Error('Atlas has no regions or exceeds 100,000 regions.');
    for (const region of parsed.regions) {
      const filename = path.resolve(output, `${region.name}.png`), relative = path.relative(output, filename);
      if (!region.name || /[\x00-\x1f]/.test(region.name) || path.isAbsolute(region.name) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Atlas region name escapes the new output directory.');
    }
    const context = project ? await this.workspace.resolve(project) : undefined;
    const result = await this.checked(['-i', path.dirname(atlas), '-o', output, ...(context ? ['-j', context] : []), '-c', atlas]);
    const files: string[] = []; const walk = async (folder: string): Promise<void> => { for (const entry of await readdir(folder, { withFileTypes: true })) { if (entry.isSymbolicLink()) throw new Error('Unpacked output contains a link.'); const filename = await this.workspace.resolve(path.join(folder, entry.name)); if (entry.isDirectory()) await walk(filename); else files.push(filename); } }; await walk(output);
    if (!files.length) throw new Error('CLI did not produce unpacked files.'); return { directory: output, files, log: result.stdout };
  }
}
