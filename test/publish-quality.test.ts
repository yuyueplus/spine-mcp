import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument } from '../src/document.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { auditAnimation } from '../src/animation-audit.js';
import { checkPublishQuality, assertPublishQuality } from '../src/publish-quality.js';
import { publishAndOpen, getPublication } from '../src/publication.js';
import { deliver } from '../src/production-workflows.js';

async function fixture(fold = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-publish-quality-'))), service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  const image = path.join(root, 'art.png'); await writeFile(image, encodePng(4, 4, new Uint8Array(64).fill(255)));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root' }, { name: 'corner', parent: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }, { name: 'cover', bone: 'root', attachment: 'cover' }], skins: [{ name: 'default', attachments: { art: { art: { type: 'mesh', path: 'art', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, vertices: [1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, -1, 1, 1, 1, 0, -1, 1] } }, cover: { cover: { path: 'art', width: 0.3, height: 0.3, x: 1, y: -2 / 3 } } } }], animations: { fold: { bones: { corner: { translate: [{ x: 0 }, { time: 1, x: fold ? 2 : 0 }] }, root: { rotate: [{ value: 0 }, { time: 1, value: 10 }] } } } } });
  const input = (await writeDocument(service.workspace, 'source.json', data)).path;
  return { root, service, input, image };
}

test('automatic gate catches an exposed fold missed by centroid-only checks and retains evidence', async () => {
  const f = await fixture(), sourceHash = await fileSha256(f.input), imageHash = await fileSha256(f.image);
  const centroid = await auditAnimation(f.service, { input: f.input, options: { animation: 'fold', fps: 1, meshVisibility: 'centroid', preview: 'none' } }); assert.equal(centroid.checksPassed, true);
  const quality = await checkPublishQuality(f.service, f.input, { fps: 1, visibilityPixelSize: 0.05 });
  assert.equal(quality.checksPassed, false); assert.equal(quality.publishingAllowed, false); assert.ok(quality.reports[0]!.findingCounts!.mesh_fold); assert.equal(quality.visualAcceptance, 'pending'); assert.equal(quality.editorDisplayAcknowledged, false);
  assert.throws(() => assertPublishQuality(quality), /quality gate failed/); assert.equal(JSON.parse(await readFile(quality.reportPath, 'utf8')).sourceSha256, sourceHash);
  assert.equal(await fileSha256(f.input), sourceHash); assert.equal(await fileSha256(f.image), imageHash);
});

test('pixel budget exhaustion is a failed check with no invented completed samples', async () => {
  const f = await fixture(), quality = await checkPublishQuality(f.service, f.input, { fps: 1, visibilityPixelSize: 0.01, maxVisibilityPixels: 1 });
  assert.equal(quality.checksPassed, false); assert.equal(quality.publishingAllowed, false); assert.equal(quality.sampledPoses, 0); assert.equal(quality.budgetedSamples, 2); assert.match(quality.reports[0]!.error!, /budget/i);
});

test('sample budgets include off-grid contact boundaries and per-animation FPS inherits the policy', async () => {
  const f = await fixture(false), rule = { animation: 'fold', contacts: [{ bone: 'root', start: 0.2, end: 0.8, tolerance: 0.01 }] };
  const blocked = await checkPublishQuality(f.service, f.input, { fps: 1, maxSamples: 2, rules: [rule] }); assert.equal(blocked.checksPassed, false); assert.match(blocked.errors.join(), /contact boundaries/); assert.equal(blocked.sampledPoses, 0);
  const pass = await checkPublishQuality(f.service, f.input, { fps: 2, maxSamples: 5, rules: [rule] }); assert.equal(pass.checksPassed, true); assert.equal(pass.sampledPoses, 5); assert.equal(pass.budgetedSamples, 5);
});

test('explicit joint/contact rules block motion without a mesh fold and invalid selections reject', async () => {
  const f = await fixture(false), report = await checkPublishQuality(f.service, f.input, { fps: 2, rules: [{ animation: 'fold', joints: [{ bone: 'root', min: -1, max: 1 }] }] });
  assert.equal(report.checksPassed, false); assert.ok(report.reports[0]!.findingCounts!.joint_limit); assert.equal(report.reports[0]!.findingCounts!.mesh_fold, undefined);
  for (const policy of [{ animations: ['missing'] }, { rules: [{ animation: 'other' }] }, { rules: [{ animation: 'fold' }, { animation: 'fold' }] }]) assert.equal((await checkPublishQuality(f.service, f.input, policy)).checksPassed, false);
});

test('enforce mode blocks the session commit while retaining the independent failed candidate', async () => {
  const f = await fixture(), s = await f.service.projectSessions.create({ input: f.input, name: 'Blocked', quality: { fps: 1 } }), hash = await fileSha256(f.input);
  await assert.rejects(f.service.projectSessions.edit({ id: s.id, requestId: randomUUID(), expectedRevision: 0, output: 'blocked.json', edits: [{ type: 'set_bone', bone: 'root', transform: { x: 1 } }] }), /quality gate failed/);
  const after = await f.service.projectSessions.get(s.id); assert.equal(after.revision, 0); assert.equal(after.versions.length, 1); assert.equal(after.currentInput, f.input); assert.ok((await stat(path.join(f.root, 'blocked.json'))).size); assert.equal(await fileSha256(f.input), hash);
});

test('explicit report mode records a failed session quality check without claiming visual approval', async () => {
  const f = await fixture(), s = await f.service.projectSessions.create({ input: f.input, name: 'Report only', quality: { mode: 'report', fps: 1 } });
  const after = await f.service.projectSessions.edit({ id: s.id, requestId: randomUUID(), expectedRevision: 0, output: 'reported.json', edits: [{ type: 'set_bone', bone: 'root', transform: { x: 1 } }] });
  assert.equal(after.revision, 1); assert.equal(after.versions.at(-1)!.quality!.checksPassed, false); assert.equal(after.versions.at(-1)!.quality!.mode, 'report'); assert.equal(after.visualAcceptance, 'pending');
});

test('publication and delivery block failed quality before native builds or editor handoff', async () => {
  const f = await fixture(), requestId = randomUUID(); let nativeCalls = 0;
  f.service.cli.probe = (async () => { nativeCalls++; throw new Error('must not reach native CLI'); }) as any;
  f.service.buildProject = (async () => { nativeCalls++; throw new Error('must not build'); }) as any;
  await assert.rejects(publishAndOpen(f.service, { requestId, input: f.input, output: path.join(f.root, 'blocked.spine'), openInEditor: false, quality: { fps: 1 } }), /quality gate failed/);
  const record = await getPublication(f.service, requestId); assert.equal(record.phase, 'failed'); assert.equal(record.quality!.checksPassed, false); assert.equal(record.projectUnchanged, false);
  await assert.rejects(deliver(f.service, f.input, { quality: { fps: 1 } }), /quality gate failed/); assert.equal(nativeCalls, 0); await assert.rejects(stat(path.join(f.root, 'blocked.spine')), /ENOENT/);
});

test('delivery rejects a new source or PNG revision after a successful gate before any native build', async () => {
  for (const changeImage of [false, true]) {
    const f = await fixture(false), load = f.service.load.bind(f.service); let loads = 0, builds = 0;
    f.service.load = (async (...args: Parameters<typeof load>) => {
      if (++loads === 3) {
        if (changeImage) await writeFile(f.image, encodePng(4, 4, new Uint8Array(64).fill(128)));
        else { const data = JSON.parse(await readFile(f.input, 'utf8')); data.bones[0].x = 99; await writeFile(f.input, JSON.stringify(data)); }
      }
      return load(...args);
    }) as typeof load;
    f.service.buildProject = (async () => { builds++; throw new Error('must not build'); }) as any;
    await assert.rejects(deliver(f.service, f.input, { quality: { fps: 1 } }), /changed after publication quality/); assert.equal(builds, 0);
  }
});
