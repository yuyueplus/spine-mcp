import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineCli, type ProcessResult } from '../src/cli.js';
import { Workspace, type Config } from '../src/config.js';
import { resolveLauncher } from '../src/launcher-discovery.js';
import { EditorProjects } from '../src/editor.js';
import { importTiming } from '../src/import-timing.js';
import { parseDocument, readDocument } from '../src/document.js';
import { auditAssets } from '../src/production-assets.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-discovery-'))), directory = path.join(root, 'runtime_1'); await mkdir(directory);
  const exe = path.join(directory, 'entry.exe'); await writeFile(exe, 'fixture');
  const config: Config = { targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliRuntimeDiscovery: { root, directoryPrefix: 'runtime_', entrypoint: 'entry.exe' }, guiRuntimeDiscovery: { root, directoryPrefix: 'runtime_', entrypoint: 'entry.exe' }, cliTimeoutMs: 1000 };
  return { root, exe, config, workspace: new Workspace(root) };
}
const help: ProcessResult = { exitCode: 0, stdout: 'Spine 4.3.23\n--input --export', stderr: '' };
test('queued CLI operations resolve the current entrypoint when executed', async () => {
  const f = await fixture(); let finish!: () => void, entered!: () => void, calls: string[] = [];
  const active = new Promise<void>(r => entered = r), blocked = new Promise<void>(r => finish = r);
  const cli = new SpineCli(f.config, f.workspace, async exe => { calls.push(exe); if (calls.length === 1) { entered(); await blocked; } return help; });
  const first = cli.probe(); await active; const second = cli.probe();
  const newer = path.join(f.root, 'runtime_2'); await mkdir(newer); const secondExe = path.join(newer, 'entry.exe'); await writeFile(secondExe, 'fixture'); await unlink(f.exe); finish();
  await first; const result = await second; assert.deepEqual(calls, [f.exe, secondExe]); assert.equal(result.executable, secondExe);
});
test('missing executable at spawn retries only a newly discovered trusted candidate', async () => {
  const f = await fixture(); let calls = 0;
  const cli = new SpineCli(f.config, f.workspace, async () => { calls++; if (calls === 1) { await unlink(f.exe); const p = path.join(f.root, 'runtime_2'); await mkdir(p); await writeFile(path.join(p, 'entry.exe'), 'fixture'); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } return help; });
  assert.equal((await cli.probe()).available, true); assert.equal(calls, 2);
});
test('nonzero exits are not replayed and mismatched editor versions fail preflight', async () => {
  const f = await fixture(); let calls = 0;
  const cli = new SpineCli(f.config, f.workspace, async () => { calls++; return { ...help, exitCode: 2 }; });
  assert.equal((await cli.probe()).available, false); assert.equal(calls, 1);
  const wrong = new SpineCli(f.config, f.workspace, async () => ({ ...help, stdout: 'Spine 4.2.1\n--input --export' })); assert.equal((await wrong.probe()).available, false);
});
test('pinned missing launchers do not silently switch to another application', async () => {
  const f = await fixture(); const result = await resolveLauncher({ ...f.config, cliExecutable: path.join(f.root, 'missing.exe') }, 'cli'); assert.equal(result.mode, 'pinned'); assert.equal(result.executable, null); assert.ok(result.errors.length);
});
test('GUI discovery is renewed after slow inventory and before any child starts', async () => {
  const f = await fixture(), project = path.join(f.root, 'p.spine'); await writeFile(project, 'fixture'); let inventoried = false, launched = '';
  const newer = path.join(f.root, 'runtime_2'), editor = new EditorProjects(f.workspace, f.config, { inventory: async () => { if (!inventoried) { inventoried = true; await unlink(f.exe); await mkdir(newer); await writeFile(path.join(newer, 'entry.exe'), 'fixture'); } return { available: true, processes: [] }; }, launch: async command => { launched = command.executable; return 42; } });
  const result = await editor.open(project, { waitMs: 0 }); assert.equal(result.launchAccepted, true); assert.equal(launched, path.join(newer, 'entry.exe'));
});
test('import FPS alignment preserves key times and source data', () => {
  const source = parseDocument({ skeleton: { spine: '4.3.23', fps: 30 }, bones: [{ name: 'root' }], animations: { a: { bones: { root: { rotate: [{ time: 0 }, { time: 1 / 60, value: 1 }] } } } } }), before = JSON.stringify(source), result = importTiming(source);
  assert.equal(result.report.importFps, 60); assert.equal(result.report.boneKeysOnEditorGrid, true); assert.equal(JSON.stringify(source), before); assert.deepEqual(result.data.animations, source.animations);
});
test('native null image roots stay beside their source project after JSON export', async () => {
  const f = await fixture(), project = path.join(f.root, 'project.spine'); await writeFile(project, 'native fixture'); await writeFile(path.join(f.root, 'art.png'), 'image fixture');
  const cli = new SpineCli(f.config, f.workspace, async (_exe, args) => {
    const output = args[args.indexOf('-o') + 1]!;
    await writeFile(path.join(output, 'root.json'), JSON.stringify({ skeleton: { spine: '4.3.23', images: null }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { width: 1, height: 1 } } } }] })); return help;
  });
  const exported = await cli.exportData(project), filename = exported.files[0]!, data = await readDocument(filename);
  assert.equal(path.resolve(path.dirname(filename), String(data.skeleton.images)), f.root); assert.equal((await auditAssets(f.workspace, data, filename, false)).valid, true);
});
