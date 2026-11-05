import path from 'node:path';
import assert from 'node:assert/strict';
import { cp, copyFile, readFile, writeFile } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { encodePng } from '../src/raster.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

let connection = await connectSpine(), id: string | undefined; const invoked = new Set<string>();
const names = new Set(['spine_start_saved_sync', 'spine_get_saved_sync', 'spine_list_saved_sync', 'spine_stop_saved_sync', 'spine_resume_saved_sync']);
async function call(name: string, args: Record<string, unknown>) { if (names.has(name)) invoked.add(name); const response = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), block = response.content.find(item => item.type === 'text'); if (response.isError || block?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`); return JSON.parse(block.text); }
async function until(predicate: (status: any) => boolean, timeout = 90000) { const deadline = Date.now() + timeout; let status; do { status = await call('spine_get_saved_sync', { id }); if (predicate(status)) return status; assert.ok(status.state !== 'failed', JSON.stringify(status)); await new Promise(resolve => setTimeout(resolve, 300)); } while (Date.now() < deadline); throw new Error(`Synchronization timed out: ${JSON.stringify(status)}`); }
try {
  const status = await call('spine_status', { probeCli: true }); assert.equal(status.serverVersion, VERSION); assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT);
  const demo = await call('spine_create_demo', {}), base = await call('spine_build_project', { entries: [{ input: demo.path, name: 'saved' }], output: path.join(demo.directory, 'base.spine') }), baseHash = await fileSha256(base.output), watched = path.join(demo.directory, 'watched.spine'); await copyFile(base.output, watched);
  const started = await call('spine_start_saved_sync', { input: watched, options: { intervalMs: 250, stableMs: 500, durationSeconds: 180, maxRevisions: 3, verifyEverySeconds: 1 } }); id = started.id; await connection.client.close(); connection = await connectSpine();
  const initial = await until(status => status.revisions.length === 1); assert.equal(initial.revisions[0].sourceHash, baseHash); assert.equal(initial.editorMemoryRead, false);
  const repeated = await call('spine_start_saved_sync', { input: watched }); assert.equal(repeated.id, id); assert.equal(repeated.alreadyRunning, true);
  const edited = await call('spine_edit_project', { input: base.output, output: path.join(demo.directory, 'changed.spine'), edits: [{ type: 'set_bone', bone: 'root', transform: { x: 17 } }] }), editedHash = await fileSha256(edited.output); await copyFile(edited.output, watched);
  const changed = await until(status => status.revisions.length === 2); assert.equal(changed.revisions[1].sourceHash, editedHash); const image = path.join(demo.images, 'arm.png'); await writeFile(image, encodePng(120, 24, new Uint8Array(120 * 24 * 4).fill(180)));
  const final = await until(status => status.state === 'limit_reached'); assert.equal(final.revisions.length, 3); assert.equal(final.revisions[2].sourceHash, editedHash); assert.notEqual(final.revisions[2].fingerprint, final.revisions[1].fingerprint);
  for (const revision of final.revisions) { assert.equal((await call('spine_verify_archive', { input: revision.archive })).valid, true); assert.equal(await fileSha256(revision.original), revision.sourceHash); }
  const moved = path.join(demo.directory, 'synchronized archive relocated with spaces'); await cp(path.dirname(final.revisions[2].archive), moved, { recursive: true }); assert.equal((await call('spine_verify_archive', { input: path.join(moved, 'archive.json') })).valid, true);
  await call('spine_resume_saved_sync', { id, options: { maxRevisions: 4, durationSeconds: 30 } }); await until(status => status.phase === 'monitoring'); assert.equal((await call('spine_get_saved_sync', { id })).revisions.length, 3); assert.ok((await call('spine_list_saved_sync', { limit: 100 })).watches.some((watch: any) => watch.id === id)); await call('spine_stop_saved_sync', { id }); const stopped = await until(status => status.state === 'stopped');
  assert.equal(stopped.revisions.length, 3); assert.equal(await fileSha256(base.output), baseHash); assert.equal(await fileSha256(edited.output), editedHash); assert.equal(invoked.size, names.size);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, newToolsInvoked: [...invoked], nativeSource: watched, initialNativeHash: baseHash, changedNativeHash: editedHash, survivedClientDisconnect: true, detectsSavedNativeChanges: true, detectsImageOnlyChanges: true, sameSourceDeduplicated: true, archivedNativeBytesVerified: true, relocatedArchiveVerified: true, resumeDidNotDuplicateRevision: true, cooperativeStopVerified: true, baseAndEditedInputsUnchanged: true, onlyOwnedTestCopiesModified: true, unsavedEditorMemoryRead: false, status: stopped }, reportPath = path.join(projectRoot, `work/saved-sync-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, newToolsVerified: invoked.size, revisions: stopped.revisions.length, reportPath }, null, 2));
} finally { if (id) { try { await call('spine_stop_saved_sync', { id }); } catch {} } await connection.client.close(); }
