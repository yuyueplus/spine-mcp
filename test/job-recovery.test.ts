import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-recovery-'))), service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  const input = path.join(root, 'input.json'); await writeFile(input, JSON.stringify({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }] })); service.jobs.kick = () => undefined;
  const submit = () => service.jobs.submit({ operation: 'batch', args: { inputs: [input], action: 'validate', format: 'json', stopOnError: false } });
  const state = async (id: string, changes: object) => { const filename = path.join(await service.jobs.folder(id), 'status.json'), value = JSON.parse(await readFile(filename, 'utf8')); await writeFile(filename, JSON.stringify({ ...value, ...changes })); };
  return { root, input, jobs: service.jobs, submit, state };
}
test('recovery reuses queued and live work without duplicating jobs', async () => {
  const f = await fixture(), job = await f.submit(); assert.equal((await f.jobs.recover(job.id)).action, 'resumed_queue'); assert.equal((await f.jobs.list()).total, 1);
  await f.state(job.id, { state: 'running', workerPid: process.pid }); assert.equal((await f.jobs.recover(job.id)).action, 'already_running'); assert.equal((await f.jobs.list()).total, 1);
});
test('a recovery ID persists at most one replacement even after a lost response or fast failure', async () => {
  const f = await fixture(), job = await f.submit(); await f.state(job.id, { state: 'failed', error: 'fixture failure' });
  const first = await f.jobs.recover(job.id), again = await f.jobs.recover(job.id); assert.equal(first.action, 'retried'); assert.equal(again.action, 'existing_recovery'); assert.equal(again.id, first.id); assert.equal((await f.jobs.list()).total, 2);
  await f.state(first.id, { state: 'failed' }); assert.equal((await f.jobs.recover(job.id)).id, first.id); assert.equal((await f.jobs.list()).total, 2);
  assert.notEqual((await f.jobs.recover(job.id, randomUUID())).id, first.id); assert.equal((await f.jobs.list()).total, 3);
});
test('dead-worker recovery classifies interruption and preserves partial artifacts', async () => {
  const f = await fixture(), job = await f.submit(); await f.state(job.id, { state: 'running', workerPid: Number.MAX_SAFE_INTEGER });
  const artifact = path.join(await f.jobs.folder(job.id), 'partial.txt'); await writeFile(artifact, 'do not remove');
  assert.equal((await f.jobs.get(job.id)).interrupted, true); assert.equal((await f.jobs.recover(job.id)).action, 'retried');
  assert.equal((await f.jobs.get(job.id)).state, 'failed'); assert.equal(await readFile(artifact, 'utf8'), 'do not remove');
});
test('concurrent recoveries and an active queue owner do not launch duplicate or competing work', async () => {
  const f = await fixture(), job = await f.submit(); await f.state(job.id, { state: 'failed' });
  const result = await Promise.all([f.jobs.recover(job.id), f.jobs.recover(job.id)]); assert.ok(result.some(r => r.action === 'retried')); assert.equal((await f.jobs.list()).total, 2);
  const other = await f.submit(); await f.state(other.id, { state: 'running', workerPid: Number.MAX_SAFE_INTEGER });
  const lock = path.join(await f.jobs.root(), 'worker.lock'); await mkdir(lock); await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live-queue-owner' }));
  assert.equal((await f.jobs.recover(other.id)).action, 'queue_busy'); assert.equal((await f.jobs.get(other.id)).state, 'running'); assert.equal((await f.jobs.list()).total, 3);
});
test('generic uncertain outputs require a new destination and recovery IDs bind it', async () => {
  const f = await fixture(), output = path.join(f.root, 'existing.spine'), nextOutput = path.join(f.root, 'new.spine');
  const job = await f.jobs.submit({ operation: 'edit_project', args: { input: f.input, output, edits: [{ type: 'set_bone', bone: 'root', transform: { x: 1 } }] } }); await f.state(job.id, { state: 'failed' }); await writeFile(output, 'retained artifact');
  await assert.rejects(f.jobs.recover(job.id), /Output already exists/); const recoveryId = randomUUID(), next = await f.jobs.recover(job.id, recoveryId, nextOutput); assert.equal(next.action, 'retried');
  await assert.rejects(f.jobs.recover(job.id, recoveryId, path.join(f.root, 'different.spine')), /another output/); assert.equal(await readFile(output, 'utf8'), 'retained artifact');
});
test('publication recovery preserves a same-output request ID and renews it for a new destination', async () => {
  const f = await fixture(), job = await f.jobs.submit({ operation: 'publish_and_open', args: { input: f.input, output: path.join(f.root, 'p.spine'), openInEditor: false, edits: [], reuseInstance: false, waitMs: 0 } }); await f.state(job.id, { state: 'failed' });
  const request = async (id: string) => JSON.parse(await readFile(path.join(await f.jobs.folder(id), 'request.json'), 'utf8')).request;
  const original = await request(job.id), same = await f.jobs.recover(job.id), changed = await f.jobs.recover(job.id, randomUUID(), path.join(f.root, 'q.spine'));
  assert.equal((await request(same.id)).args.requestId, original.args.requestId); assert.notEqual((await request(changed.id)).args.requestId, original.args.requestId);
});
test('completed results are historical and are never re-executed or reopened', async () => {
  const f = await fixture(), job = await f.submit(), filename = path.join(await f.jobs.folder(job.id), 'result.json'); await writeFile(filename, JSON.stringify({ passed: true })); await f.state(job.id, { state: 'succeeded', resultPath: filename });
  const result = await f.jobs.recover(job.id); assert.equal(result.action, 'already_completed'); assert.equal('resultRevalidated' in result && result.resultRevalidated, false); assert.equal((await f.jobs.list()).total, 1);
});
