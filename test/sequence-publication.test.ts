import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { Workspace } from '../src/config.js';
import { publishSequenceImages, recoverSequencePublication } from '../src/sequence-publication.js';
import type { NativePreviewStatus } from '../src/native-preview.js';
import { atomicJson, exists } from '../src/jobs.js';
import { fileSha256 } from '../src/file-hash.js';
import { replaceFile } from '../src/file-replace.js';
import { encodePng } from '../src/raster.js';
import { SpineService } from '../src/service.js';
import { runNativePreview, nativePreviewOptions } from '../src/native-preview.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-publication-'))), workspace = new Workspace(root), id = randomUUID(), folder = path.join(root, '.native-previews', id), cache = path.join(folder, `sequence-${randomUUID()}`);
  await mkdir(path.join(folder, 'images'), { recursive: true }); await mkdir(cache);
  const status: NativePreviewStatus = { id, state: 'watching', project: path.join(folder, 'MCP-sequence.spine'), image: path.join(folder, 'images', 'preview.png'), input: path.join(root, 'source.json'), generation: 1, textureRevision: 1, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  await writeFile(status.project, 'unchanged native project');
  const names = ['frame-0000.png', 'frame-0001.png', 'preview.png'], old: string[] = [], images = [];
  for (const [i, name] of names.entries()) {
    const target = path.join(folder, 'images', name), source = path.join(cache, name);
    await writeFile(target, encodePng(2, 2, new Uint8Array(16).fill(20 + i)));
    await writeFile(source, encodePng(2, 2, new Uint8Array(16).fill(150 + i)));
    old.push(await fileSha256(target)); images.push({ name, source, sha256: await fileSha256(source) });
  }
  const next = { ...status, generation: 2, textureRevision: 2 };
  await atomicJson(path.join(folder, 'status.json'), status);
  const hashes = () => Promise.all(names.map(name => fileSha256(path.join(folder, 'images', name))));
  return { root, workspace, folder, status, next, names, old, images, hashes };
}
async function crashAfterFirstWrite(f: Awaited<ReturnType<typeof fixture>>) {
  const input = path.join(f.root, 'crash-input.json'); await atomicJson(input, { root: f.root, folder: f.folder, status: f.status, next: f.next, images: f.images });
  const script = `import {readFile} from 'node:fs/promises'; import {Workspace} from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}; import {publishSequenceImages} from ${JSON.stringify(new URL('../src/sequence-publication.js', import.meta.url).href)}; import {replaceFile} from ${JSON.stringify(new URL('../src/file-replace.js', import.meta.url).href)}; const f=JSON.parse(await readFile(process.argv[1],'utf8')); await publishSequenceImages(new Workspace(f.root),f.folder,f.status,f.status,f.images,f.next,async()=>{},async(a,b)=>{await replaceFile(a,b);process.exit(73)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, input], { windowsHide: true, stdio: 'pipe' }); let output = ''; child.stderr.on('data', data => { output += String(data); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); assert.equal(exit, 73, output);
}

test('partial image replacement failure restores the entire old set and committed status', async () => {
  const f = await fixture(); let writes = 0;
  await assert.rejects(publishSequenceImages(f.workspace, f.folder, f.status, structuredClone(f.status), f.images, f.next, async () => undefined, async (source, target) => {
    if (path.basename(path.dirname(source)) === 'after' && ++writes === 2) throw new Error('injected locked target');
    await replaceFile(source, target);
  }), /locked target/);
  assert.deepEqual(await f.hashes(), f.old); assert.equal(f.status.generation, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.folder, 'status.json'), 'utf8')).generation, 1);
  assert.equal(await exists(path.join(f.folder, 'sequence-publication.json')), false);
  assert.equal((await readdir(f.folder)).filter(name => name.startsWith('publication-')).length, 0);
});

test('a fresh process recovers a real interruption after the first watched image replacement', async () => {
  const f = await fixture(), projectHash = await fileSha256(f.status.project);
  await crashAfterFirstWrite(f); assert.notDeepEqual(await f.hashes(), f.old);
  const recoveredStatus = JSON.parse(await readFile(path.join(f.folder, 'status.json'), 'utf8'));
  const recovered = await recoverSequencePublication(new Workspace(f.root), f.folder, recoveredStatus);
  assert.equal(recovered?.state, 'rolled_back'); assert.deepEqual(await f.hashes(), f.old);
  assert.equal(recoveredStatus.generation, 1); assert.equal(await fileSha256(f.status.project), projectHash);
  assert.equal(await exists(path.join(f.folder, 'sequence-publication.json')), false);
});

test('worker restores an interrupted set before trying to load an unavailable new source', { timeout: 12000 }, async () => {
  const f = await fixture(); await crashAfterFirstWrite(f);
  const service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: f.root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 }); service.nativePreviews.kick = async () => undefined;
  await atomicJson(path.join(f.folder, 'request.json'), { id: f.status.id, input: f.status.input, sources: [f.status.input], generation: 2, options: nativePreviewOptions.parse({ width: 128, height: 128 }), expiresAt: f.status.expiresAt });
  const worker = runNativePreview(service, f.folder);
  try {
    const deadline = Date.now() + 5000; let observed = false;
    while (Date.now() < deadline) { const status = await service.nativePreviews.get(f.status.id); if (status.publicationRecovery?.state === 'rolled_back' && status.lastError) { observed = true; break; } await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.ok(observed); assert.deepEqual(await f.hashes(), f.old);
  } finally { await service.nativePreviews.stop(f.status.id); await worker; }
});

test('recovery refuses conflicting external bytes before restoring any image', async () => {
  const f = await fixture(); await crashAfterFirstWrite(f);
  const target = path.join(f.folder, 'images', 'frame-0001.png'); await writeFile(target, 'external edit'); const before = await f.hashes();
  await assert.rejects(recoverSequencePublication(f.workspace, f.folder, f.status), /changed externally/);
  assert.deepEqual(await f.hashes(), before); assert.equal(await exists(path.join(f.folder, 'sequence-publication.json')), true);
  await writeFile(target, encodePng(2, 2, new Uint8Array(16).fill(21)));
  await recoverSequencePublication(f.workspace, f.folder, f.status); assert.deepEqual(await f.hashes(), f.old);
});

test('a failed rollback keeps its journal and backups for a later successful recovery', async () => {
  const f = await fixture(); let writes = 0;
  await assert.rejects(publishSequenceImages(f.workspace, f.folder, f.status, structuredClone(f.status), f.images, f.next, async () => undefined, async (source, target) => {
    if (path.basename(source).startsWith('restore-')) throw new Error('injected rollback lock');
    if (++writes === 2) throw new Error('injected publication lock'); await replaceFile(source, target);
  }), /recovery requires attention.*rollback lock/);
  assert.equal(await exists(path.join(f.folder, 'sequence-publication.json')), true);
  await recoverSequencePublication(f.workspace, f.folder, f.status); assert.deepEqual(await f.hashes(), f.old);
});

test('source revision failure after all writes rolls back and removes newly created targets', async () => {
  const f = await fixture(), missing = path.join(f.folder, 'images', 'frame-0000.png'); await unlink(missing); let checks = 0;
  await assert.rejects(publishSequenceImages(f.workspace, f.folder, f.status, structuredClone(f.status), f.images, f.next, async () => { if (++checks === 2) throw new Error('source changed'); }), /source changed/);
  assert.equal(await exists(missing), false);
  assert.equal(await fileSha256(path.join(f.folder, 'images', f.names[1]!)), f.old[1]); assert.equal(await fileSha256(f.status.image), f.old[2]);
});

test('committed status survives interruption before journal cleanup, while untrusted paths reject', async () => {
  const f = await fixture(); await crashAfterFirstWrite(f);
  const journalFile = path.join(f.folder, 'sequence-publication.json'), journal = JSON.parse(await readFile(journalFile, 'utf8'));
  for (const image of f.images) await writeFile(path.join(f.folder, 'images', image.name), await readFile(image.source));
  const publication = { id: journal.id, generation: 2, frameCount: 2, changedImages: 3, publishedAt: new Date().toISOString() };
  await atomicJson(path.join(f.folder, 'status.json'), { ...f.next, sequencePublication: publication });
  const recovered = await recoverSequencePublication(f.workspace, f.folder, f.status);
  assert.equal(recovered?.state, 'committed'); assert.deepEqual(await f.hashes(), f.images.map(image => image.sha256)); assert.equal(f.status.generation, 2);
  journal.entries[0].name = '../outside.png'; await atomicJson(journalFile, journal);
  await assert.rejects(recoverSequencePublication(f.workspace, f.folder, f.status), /Invalid sequence publication journal/);
});

test('successful publication verifies all cached bytes and leaves no image-write staging files', async () => {
  const f = await fixture(), previous = structuredClone(f.status);
  const receipt = await publishSequenceImages(f.workspace, f.folder, f.status, previous, f.images, f.next, async () => undefined);
  assert.equal(receipt.frameCount, 2); assert.equal(receipt.changedImages, 3); assert.equal(f.status.sequencePublication?.id, receipt.id);
  assert.deepEqual(await f.hashes(), f.images.map(image => image.sha256)); assert.deepEqual((await readdir(path.join(f.folder, 'images'))).sort(), f.names.toSorted());
  const next = { ...f.status, generation: 3 };
  const reused = await publishSequenceImages(f.workspace, f.folder, f.status, structuredClone(f.status), f.images, next, async () => undefined); assert.equal(reused.changedImages, 0);
});
