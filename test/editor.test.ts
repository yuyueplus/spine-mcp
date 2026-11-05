import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, mkdir, readFile, unlink, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace, type Config } from '../src/config.js';
import { EditorProjects, editorCommand, type EditorCommand, type EditorProcess } from '../src/editor.js';
import { SpineService } from '../src/service.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-editor-'))), workspace = new Workspace(root);
  const executable = path.join(root, 'installed editor.exe'), project = path.join(root, '中文 project.spine');
  await writeFile(executable, 'fixture launcher'); await writeFile(project, 'native fixture');
  const config: Config = { targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: executable, cliTimeoutMs: 1000 };
  const commands: EditorCommand[] = [], processes: EditorProcess[] = [];
  const deps = { launch: async (command: EditorCommand) => { commands.push(command); return 12345; }, inventory: async () => ({ available: true, processes: structuredClone(processes) }) };
  const editor = new EditorProjects(workspace, config, deps);
  return { root, workspace, executable, project, config, commands, processes, deps, editor };
}

test('opening is detached, preserves the file, and never confuses spawn acceptance with a loaded project', async () => {
  const f = await fixture(), before = await readFile(f.project);
  const result = await f.editor.open(f.project, { waitMs: 0 });
  assert.equal(result.launchAccepted, true); assert.equal(result.state, 'submitted_unconfirmed');
  assert.equal(result.projectLoadedVerified, false); assert.equal(result.windowObserved, false);
  assert.equal(f.commands[0]!.options.detached, true); assert.equal(f.commands[0]!.options.shell, false); assert.equal(f.commands[0]!.options.stdio, 'ignore');
  assert.deepEqual(f.commands[0]!.args, ['--no-reuse-instance', f.project]);
  assert.deepEqual(await readFile(f.project), before);
  const reconnected = new EditorProjects(f.workspace, f.config, f.deps);
  assert.equal((await reconnected.get(result.id)).launcherPid, 12345);
});

test('idempotent retries across reconnects do not open a second window; conflicting revisions reject', async () => {
  const f = await fixture(), requestId = randomUUID();
  await f.editor.open(f.project, { requestId, waitMs: 0 });
  const reconnected = new EditorProjects(f.workspace, f.config, f.deps);
  assert.equal((await reconnected.open(f.project, { requestId, waitMs: 0 })).reusedRequest, true);
  assert.equal(f.commands.length, 1);
  await assert.rejects(reconnected.open(f.project, { requestId, reuseInstance: true, waitMs: 0 }), /already belongs/);
  await writeFile(f.project, 'changed');
  await assert.rejects(reconnected.open(f.project, { requestId, waitMs: 0 }), /file revision/);
  assert.equal(f.commands.length, 1);
});

test('existing windows and unrelated old processes are not accepted as evidence of this launch', async () => {
  const f = await fixture();
  f.processes.push({ pid: 200, parentPid: 1, executable: f.executable, startedAt: new Date().toISOString(), title: 'existing', hasWindow: true });
  const opened = await f.editor.open(f.project, { waitMs: 0 });
  assert.equal(opened.windowObserved, false);
  f.processes.push({ pid: 201, parentPid: 12345, executable: f.executable, startedAt: new Date().toISOString(), title: `Spine - ${path.basename(f.project, '.spine')}`, hasWindow: true });
  const observed = await f.editor.get(opened.id);
  assert.equal(observed.state, 'window_observed'); assert.deepEqual(observed.windows.map(item => item.pid), [201]);
  assert.equal(observed.windows[0]!.correlation, 'launched-process-family'); assert.equal(observed.projectLoadedVerified, false);
  assert.equal(observed.projectWindowTitleMatched, true);
});

test('failed launches are recorded, queryable, and never retried automatically', async () => {
  const f = await fixture(); let attempts = 0;
  const broken = new EditorProjects(f.workspace, f.config, { ...f.deps, launch: async () => { attempts++; throw new Error('fixture ENOENT'); } });
  const result = await broken.open(f.project, { waitMs: 0 });
  assert.equal(result.state, 'failed'); assert.equal(result.launchAccepted, false); assert.match(result.error!, /ENOENT/);
  await broken.open(f.project, { requestId: result.id, waitMs: 0 }); assert.equal(attempts, 1);
  assert.equal((await broken.get(result.id)).state, 'failed');
});

test('path/type/mode validation happens before any launcher execution', async () => {
  const f = await fixture();
  await assert.rejects(f.editor.open('../escape.spine', { waitMs: 0 }), /outside/);
  const json = path.join(f.root, 'skeleton.json'); await writeFile(json, '{}');
  await assert.rejects(f.editor.open(json, { waitMs: 0 }), /nonempty saved/);
  const empty = path.join(f.root, 'empty.spine'); await writeFile(empty, '');
  await assert.rejects(f.editor.open(empty, { waitMs: 0 }), /nonempty saved/);
  await assert.rejects(f.editor.open(f.project, { waitMs: 10001 }), /10000/);
  await assert.rejects(f.editor.get('../../other'), /Invalid editor-open/);
  assert.equal(f.commands.length, 0);
});

test('discovery resolves a current installed runtime and fails rather than silently using a different launcher', async () => {
  const f = await fixture(), runtime = path.join(f.root, 'runtime_1'); await mkdir(runtime);
  await writeFile(path.join(runtime, 'Run-Spine.bat'), '@exit /b 0');
  const config = { ...f.config, guiRuntimeDiscovery: { root: f.root, directoryPrefix: 'runtime_', entrypoint: 'Run-Spine.bat' } };
  const editor = new EditorProjects(f.workspace, config, f.deps);
  assert.equal(await editor.resolveExecutable(), await realpath(path.join(runtime, 'Run-Spine.bat')));
  await unlink(path.join(runtime, 'Run-Spine.bat')); await assert.rejects(editor.resolveExecutable(), /Configure guiExecutable/);
});

test('native arguments remain data, while batch expansion characters are rejected', () => {
  const direct = editorCommand('C:\\installed editor\\Spine.exe', 'C:\\work\\a & b.spine', true);
  assert.deepEqual(direct.args, ['--reuse-instance', 'C:\\work\\a & b.spine']); assert.equal(direct.options.shell, false);
  if (process.platform === 'win32') {
    assert.throws(() => editorCommand('C:\\runtime\\Run-Spine.bat', 'C:\\work\\bad%PATH%.spine', false), /metacharacters/);
    const batch = editorCommand('C:\\runtime\\Run-Spine.bat', 'C:\\work\\中文 project.spine', false);
    assert.equal(batch.options.detached, true); assert.equal(batch.options.windowsVerbatimArguments, true);
    assert.match(batch.args.at(-1)!, /"C:\\work\\中文 project.spine"/);
  }
});

test('status retains launch evidence when the project is changed or later removed', async () => {
  const f = await fixture(), result = await f.editor.open(f.project, { waitMs: 0 });
  await writeFile(f.project, 'later edit'); assert.equal((await f.editor.get(result.id)).projectFileUnchanged, false);
  await unlink(f.project); assert.equal((await f.editor.get(result.id)).projectFileUnchanged, false);
});

test('creation rejects existing outputs before running CLI or changing existing contents', async () => {
  const f = await fixture(), service = new SpineService(f.config), original = await readFile(f.project);
  await assert.rejects(service.createProject({ output: f.project, openInEditor: true }), /Output exists/);
  await assert.rejects(service.createProject({ output: '../escape.spine' }), /outside/);
  await assert.rejects(service.createProject({ output: 'wrong.json' }), /end in .spine/);
  assert.deepEqual(await readFile(f.project), original);
});

test('workspace junctions cannot route an open request outside its root', async () => {
  const f = await fixture(), outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-outside-')));
  await writeFile(path.join(outside, 'other.spine'), 'outside');
  await symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.editor.open('linked/other.spine', { waitMs: 0 }), /outside/);
  assert.equal(f.commands.length, 0);
});
