import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpineService } from '../src/service.js';
import { EditorProjects } from '../src/editor.js';
import { publishAndOpen, getPublication } from '../src/publication.js';
import { parseDocument, writeDocument } from '../src/document.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';

async function fixture(withImage = false) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-publication-'))), exe = path.join(root, 'editor.exe'); await writeFile(exe, 'fixture');
  const service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: exe, cliTimeoutMs: 1000 });
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root' }], ...(withImage ? { slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { path: 'image', width: 1, height: 1 } } } }] } : {}) });
  if (withImage) await writeFile(path.join(root, 'image.png'), 'fixture image bytes');
  const source = await writeDocument(service.workspace, 'input.json', data); let builds = 0, launches = 0;
  service.cli.probe = (async () => ({ available: true })) as any;
  service.buildProject = (async (_entries: unknown, output: string) => { builds++; await writeFile(output, 'verified native fixture', { flag: 'wx' }); return { output, checks: [{ verification: { passed: true } }] }; }) as any;
  Object.defineProperty(service, 'editorProjects', { value: new EditorProjects(service.workspace, service.config, { launch: async () => { launches++; return 42; }, inventory: async () => ({ available: true, processes: [] }) }) });
  return { root, service, source: source.path, output: path.join(root, 'new.spine'), builds: () => builds, launches: () => launches };
}
test('one-shot publication is revision-bound and idempotent across reconnection', async () => {
  const f = await fixture(), requestId = randomUUID(), before = await fileSha256(f.source), args = { requestId, input: f.source, output: f.output, waitMs: 0 };
  const first = await publishAndOpen(f.service, args), second = await publishAndOpen(f.service, args);
  assert.equal(first.phase, 'complete'); assert.equal(second.phase, 'complete'); assert.equal(f.builds(), 1); assert.equal(f.launches(), 1); assert.equal(await fileSha256(f.source), before); assert.equal((await getPublication(f.service, requestId)).projectUnchanged, true);
  await writeFile(f.source, '{}'); await assert.rejects(publishAndOpen(f.service, args), /another source revision/); assert.equal(f.launches(), 1);
});
test('a resource change invalidates a previously verified publication before another open', async () => {
  const f = await fixture(true), args = { requestId: randomUUID(), input: f.source, output: f.output, waitMs: 0 };
  await publishAndOpen(f.service, args); await writeFile(path.join(f.root, 'image.png'), 'changed image'); await assert.rejects(publishAndOpen(f.service, args), /Resource changed/); assert.equal(f.builds(), 1); assert.equal(f.launches(), 1);
});
test('missing CLI and existing outputs fail before publishing or launching', async () => {
  const f = await fixture(); f.service.cli.probe = (async () => ({ available: false, reason: 'missing' })) as any;
  await assert.rejects(publishAndOpen(f.service, { input: f.source, output: f.output }), /preflight failed/); await assert.rejects(stat(f.output), /ENOENT/); assert.equal(f.launches(), 0);
  await writeFile(f.output, 'existing'); await assert.rejects(publishAndOpen(f.service, { input: f.source, output: f.output }), /Output exists/); assert.equal(await readFile(f.output, 'utf8'), 'existing');
});
test('a verified native result survives editor launch failure', async () => {
  const f = await fixture(); Object.defineProperty(f.service, 'editorProjects', { value: new EditorProjects(f.service.workspace, f.service.config, { launch: async () => { throw new Error('fixture launch failure'); }, inventory: async () => ({ available: true, processes: [] }) }) });
  const result = await publishAndOpen(f.service, { input: f.source, output: f.output, waitMs: 0 }); assert.equal(result.phase, 'published_open_failed'); assert.ok((await stat(f.output)).size); assert.equal(result.structuralAndNativeRoundTrip, 'passed');
});
test('interruption after verification resumes opening without rebuilding', async () => {
  const f = await fixture(), args = { requestId: randomUUID(), input: f.source, output: f.output, waitMs: 0 };
  await assert.rejects(publishAndOpen(f.service, args, { checkpoint: async p => { if (p.phase === 'publication-open') throw new Error('interrupted'); } }), /interrupted/);
  assert.equal(f.builds(), 1); assert.equal(f.launches(), 0); await publishAndOpen(f.service, args); assert.equal(f.builds(), 1); assert.equal(f.launches(), 1);
  await writeFile(f.output, 'changed native'); await assert.rejects(publishAndOpen(f.service, args), /Published output changed/); assert.equal(f.launches(), 1);
});
test('uncertain native output is independently verified before recovery and mismatches reject', async () => {
  for (const mismatch of [false, true]) {
    const f = await fixture(), args = { requestId: randomUUID(), input: f.source, output: f.output, waitMs: 0 };
    const build = f.service.buildProject.bind(f.service);
    f.service.buildProject = (async (...values: Parameters<typeof build>) => { await build(...values); throw new Error('interrupted after native output'); }) as any;
    await assert.rejects(publishAndOpen(f.service, args), /interrupted after native output/);
    const readback = mismatch ? (await writeDocument(f.service.workspace, 'mismatch.json', parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root', x: 100 }] }))).path : f.source;
    f.service.cli.exportData = (async () => ({ files: [readback] })) as any;
    if (mismatch) { await assert.rejects(publishAndOpen(f.service, args), /root|transform|mismatch/i); assert.equal(f.launches(), 0); }
    else { const result = await publishAndOpen(f.service, args); assert.equal(result.build.recovered, true); assert.equal(f.launches(), 1); }
    assert.equal(f.builds(), 1);
  }
});
test('newly attached images are guarded before editor handoff', async () => {
  const f = await fixture(true), image = path.join(f.root, 'new-image.png'); await writeFile(image, encodePng(2, 2, new Uint8Array(16).fill(255)));
  f.service.editProject = (async (_input: string, output: string) => { await writeFile(output, 'native fixture'); await writeFile(image, encodePng(2, 2, new Uint8Array(16).fill(100))); return { output }; }) as any;
  await assert.rejects(publishAndOpen(f.service, { input: f.source, output: f.output, edits: [{ type: 'attach_image', skin: 'default', slot: 'art', name: 'new-image', image, setAsSetup: true }] }), /Resource changed/);
  assert.equal(f.launches(), 0);
});
test('publication records reject resource paths escaping the workspace', async () => {
  const f = await fixture(), requestId = randomUUID(), result = await publishAndOpen(f.service, { requestId, input: f.source, output: f.output, openInEditor: false });
  const record = JSON.parse(await readFile(result.statusPath, 'utf8')); record.files = [{ path: path.join(path.dirname(f.root), 'outside.png'), sha256: '0'.repeat(64) }]; await writeFile(result.statusPath, JSON.stringify(record));
  await assert.rejects(getPublication(f.service, requestId), /outside the configured workspace/); assert.equal(f.launches(), 0);
});
test('a last-stage resource edit prevents opening but retains the verified project', async () => {
  const f = await fixture(true), requestId = randomUUID();
  await assert.rejects(publishAndOpen(f.service, { requestId, input: f.source, output: f.output, waitMs: 0 }, { checkpoint: async p => { if (p.phase === 'publication-open') await writeFile(path.join(f.root, 'image.png'), 'user saved a new image'); } }), /Resource changed/);
  assert.equal(f.builds(), 1); assert.equal(f.launches(), 0); assert.ok((await stat(f.output)).size);
  const status = await getPublication(f.service, requestId); assert.equal(status.projectUnchanged, true); assert.equal(status.phase, 'published_attention_required'); assert.equal(status.failedStage, 'published');
});
