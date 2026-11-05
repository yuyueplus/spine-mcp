import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { connectSpine } from '../src/mcp-client.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const config = await loadConfig(), directory = path.join(config.workspaceRoot, `session-smoke-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const fixture = path.join(directory, 'source.json'), image = path.join(directory, 'part.png');
await writeFile(image, encodePng(16, 32, new Uint8Array(16 * 32 * 4).fill(255)));
await writeFile(fixture, JSON.stringify({ skeleton: { spine: '4.3.23', images: '.', fps: 30 }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { path: 'part', width: 16, height: 32 } } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 10 }] } } } } }));
const sourceHash = await fileSha256(fixture), imageHash = await fileSha256(image), connection = await connectSpine(); let previewId: string | undefined;
let { client } = connection;
const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), t = r.content.find(c => c.type === 'text'); if (r.isError || t?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(r.content)}`); return JSON.parse(t.text); };
const report: Record<string, unknown> = { version: VERSION, directory, editorOpened: false, inputAutomation: false };
try {
  assert.equal((await call('spine_status', {})).serverVersion, VERSION); assert.equal((await client.listTools()).tools.length, TOOL_COUNT);
  const createArgs = { input: fixture, name: 'Persistent production context', requestId: randomUUID() }, created = await call('spine_create_session', createArgs); report.created = created;
  assert.equal((await call('spine_create_session', createArgs)).reused, true);
  assert.ok((await call('spine_list_sessions', { limit: 100 })).sessions.some((s: any) => s.id === created.id));
  const initial = await call('spine_start_native_preview', { input: fixture, requestId: randomUUID(), options: { animation: 'idle', time: 0.4, width: 128, height: 128, durationSeconds: 300, viewport: { minX: -40, maxX: 40, minY: -40, maxY: 40 } } }); previewId = initial.id;
  const bound = await call('spine_bind_session_preview', { id: created.id, requestId: randomUUID(), expectedRevision: 0, previewId }); assert.equal(bound.requestReceipt.preview.state, 'requested');
  const published = await call('spine_wait_native_preview', { id: previewId, options: { generation: bound.requestReceipt.preview.generation, waitMs: 30000 } }); assert.equal(published.outcome, 'published');
  const beforeImage = await fileSha256(initial.image), args = { id: created.id, requestId: randomUUID(), expectedRevision: 1, output: path.join(directory, 'edited.json'), edits: [{ type: 'set_bone', bone: 'root', transform: { rotation: 70 } }], note: 'Visible rotation' }, edited = await call('spine_edit_session', args);
  const update = await call('spine_wait_native_preview', { id: previewId, options: { generation: edited.requestReceipt.preview.generation, waitMs: 30000 } }); assert.equal(update.outcome, 'published'); assert.notEqual(await fileSha256(initial.image), beforeImage); report.boundPreview = { beforeImage, afterImage: await fileSha256(initial.image), publication: update, editorDisplayAcknowledged: false };
  await client.close(); ({ client } = await connectSpine()); const reconnected = await call('spine_get_session', { id: created.id }); assert.equal(reconnected.currentInput, edited.output); assert.equal(reconnected.inSync, true);
  const native = await call('spine_build_project', { entries: [{ input: edited.output, name: 'session-skeleton' }], output: path.join(directory, 'branch.spine') });
  const checkpoint = await call('spine_checkpoint_session', { id: created.id, requestId: randomUUID(), expectedRevision: 2, input: native.output, note: 'Adopt native working branch' });
  const nativeEdited = await call('spine_edit_session', { id: created.id, requestId: randomUUID(), expectedRevision: 3, output: path.join(directory, 'native-edited.spine'), edits: [{ type: 'set_bone', bone: 'root', transform: { x: 10 } }] }); assert.equal(nativeEdited.revision, 4);
  const diff = await call('spine_compare_session_versions', { id: created.id, fromVersionId: created.currentVersionId }); assert.ok(diff.dataDiff.total > 0); report.diff = diff;
  const restoreArgs = { id: created.id, requestId: randomUUID(), expectedRevision: 4, versionId: created.currentVersionId, output: path.join(directory, 'restored.json'), note: 'Restore original with archived artwork' }, restored = await call('spine_restore_session', restoreArgs);
  const restoredPublication = await call('spine_wait_native_preview', { id: previewId, options: { generation: restored.requestReceipt.preview.generation, waitMs: 30000 } }); assert.equal(restoredPublication.outcome, 'published');
  const clean = await call('spine_compare_session_versions', { id: created.id, fromVersionId: created.currentVersionId }); assert.equal(clean.dataDiff.total, 0); assert.equal(clean.resourceDiff.total, 0);
  const oldReceipt = await call('spine_edit_session', args); assert.equal(oldReceipt.requestReceipt.reused, true); assert.equal(oldReceipt.currentVersionId, restored.currentVersionId); assert.equal((await call('spine_restore_session', restoreArgs)).requestReceipt.reused, true);
  assert.equal(await fileSha256(fixture), sourceHash); assert.equal(await fileSha256(image), imageHash); report.history = { reconnectVerified: true, nativeBranch: checkpoint.currentInput, nativeEdited: nativeEdited.output, restored: restored.output, versions: restored.versions.length, restoredDataAndResourceDiff: clean, oldReceiptDidNotRewind: true, originalsUnchanged: true };
  report.passed = true;
} catch (error) { report.passed = false; report.error = (error as Error).message; process.exitCode = 1; }
finally {
  if (previewId) { try { await call('spine_stop_native_preview', { id: previewId }); } catch (error) { report.previewCleanupError = (error as Error).message; } }
  await client.close(); await writeFile(path.join(config.workspaceRoot, `session-report-${VERSION}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, version: VERSION, report: path.join(config.workspaceRoot, `session-report-${VERSION}.json`), error: report.error }));
}
