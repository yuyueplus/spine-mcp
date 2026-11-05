import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument } from '../src/document.js';
import { recordVisualReview, getAcceptance } from '../src/acceptance.js';
import { runRegressionSuite } from '../src/regression-suite.js';
import { fileSha256 } from '../src/file-hash.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-acceptance-'))), service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  await writeFile(path.join(root, 'art.png'), 'fixture image');
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { path: 'art', width: 1, height: 1 } } } }], animations: { a: { bones: { root: { translate: [{ x: 0 }, { time: 1, x: 1 }] } } } } });
  return { service, input: (await writeDocument(service.workspace, 'input.json', data)).path };
}
test('visual acceptance remains pending until explicit review and invalidates on source/resource changes', async () => {
  const f = await fixture(); assert.equal((await getAcceptance(f.service, f.input)).visualAcceptance, 'pending');
  await recordVisualReview(f.service, { input: f.input, decision: 'accepted', note: 'User confirms visual review.' }); assert.equal((await getAcceptance(f.service, f.input)).visualAcceptance, 'accepted');
  await writeFile(path.join(f.service.workspace.root, 'art.png'), 'different pixels'); const changed = await getAcceptance(f.service, f.input); assert.equal(changed.visualAcceptance, 'pending'); assert.equal(changed.previousReviewOutdated, true);
  await recordVisualReview(f.service, { input: f.input, decision: 'rejected', note: 'User reports unnatural knee.' }); assert.equal((await getAcceptance(f.service, f.input)).visualAcceptance, 'rejected');
});
test('regression distinguishes structural success, unrequested native checks and pending human acceptance', async () => {
  const f = await fixture(), hash = await fileSha256(f.input), report = await runRegressionSuite(f.service, { cases: [{ name: 'known fixture', input: f.input, expectedSha256: hash }] });
  assert.equal(report.checksPassed, true); assert.equal(report.visualAcceptance, 'pending'); assert.equal(report.editorOpened, false); assert.deepEqual(report.cases[0]!.nativeRoundTrip, { requested: false }); assert.equal(await fileSha256(f.input), hash);
  const bad = await runRegressionSuite(f.service, { stopOnError: true, cases: [{ name: 'changed', input: f.input, expectedSha256: '0'.repeat(64) }, { name: 'skipped', input: f.input }] }); assert.equal(bad.checksPassed, false); assert.equal(bad.skipped, 1); assert.match(bad.cases[0]!.error!, /Pinned fixture hash changed/);
});

test('regression pins complete resource revisions and distinguishes rejected visuals', async () => {
  const f = await fixture(), image = path.join(f.service.workspace.root, 'art.png'), pinned = { name: 'image fixture', input: f.input, expectedResourceHashes: [{ path: image, sha256: await fileSha256(image) }] };
  await recordVisualReview(f.service, { input: f.input, decision: 'rejected', note: 'User rejects foot sliding.' });
  const rejected = await runRegressionSuite(f.service, { cases: [pinned] });
  assert.equal(rejected.checksPassed, true); assert.equal(rejected.visualAcceptance, 'reported_rejected'); assert.equal(rejected.releaseReady, false);
  await writeFile(image, 'changed image'); const changed = await runRegressionSuite(f.service, { cases: [pinned] });
  assert.equal(changed.checksPassed, false); assert.match(changed.cases[0]!.error!, /Pinned resource/);
});

test('scoped visual acceptance never promotes one accepted animation to a whole-project pass', async () => {
  const f = await fixture(), data = JSON.parse(await readFile(f.input, 'utf8')); data.animations.b = structuredClone(data.animations.a); await writeFile(f.input, JSON.stringify(data));
  await recordVisualReview(f.service, { input: f.input, animations: ['a'], decision: 'accepted', note: 'User watched only a.' });
  const partial = await getAcceptance(f.service, f.input); assert.equal(partial.visualAcceptance, 'partial'); assert.deepEqual(partial.animationAcceptance.map(a => a.visualAcceptance), ['accepted', 'pending']);
  assert.equal((await getAcceptance(f.service, f.input, undefined, ['a'])).visualAcceptance, 'accepted'); assert.equal((await getAcceptance(f.service, f.input, undefined, ['b'])).visualAcceptance, 'pending');
  const regression = await runRegressionSuite(f.service, { cases: [{ name: 'partial review', input: f.input }] }); assert.equal(regression.releaseReady, false);
  await recordVisualReview(f.service, { input: f.input, animations: ['b'], decision: 'rejected', note: 'User rejects b.' }); assert.equal((await getAcceptance(f.service, f.input)).visualAcceptance, 'rejected');
  await recordVisualReview(f.service, { input: f.input, animations: ['b'], decision: 'accepted', note: 'User accepts corrected review.' }); assert.equal((await getAcceptance(f.service, f.input)).visualAcceptance, 'accepted');
  await writeFile(path.join(f.service.workspace.root, 'art.png'), 'changed'); assert.equal((await getAcceptance(f.service, f.input)).visualAcceptance, 'pending');
});

test('scoped reviews validate names, reject duplicates and allow explicit project-wide review', async () => {
  const f = await fixture();
  await assert.rejects(recordVisualReview(f.service, { input: f.input, animations: ['missing'], decision: 'accepted', note: 'invalid' }), /not found/);
  await assert.rejects(recordVisualReview(f.service, { input: f.input, animations: ['a', 'a'], decision: 'accepted', note: 'invalid' }), /unique/);
  await assert.rejects(getAcceptance(f.service, f.input, undefined, []), /Too small/);
  await recordVisualReview(f.service, { input: f.input, animations: ['a'], decision: 'rejected', note: 'Earlier scoped rejection.' });
  await recordVisualReview(f.service, { input: f.input, decision: 'accepted', note: 'Explicit full project review.' }); assert.equal((await getAcceptance(f.service, f.input)).visualAcceptance, 'accepted');
});
