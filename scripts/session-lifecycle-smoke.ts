import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { connectSpine } from '../src/mcp-client.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const config = await loadConfig(), directory = path.join(config.workspaceRoot, `session-lifecycle-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const input = path.join(directory, 'source.json'), image = path.join(directory, 'art.png');
await writeFile(image, encodePng(8, 16, new Uint8Array(8 * 16 * 4).fill(255)));
const data = { skeleton: { spine: '4.3.23', images: '.', fps: 30 }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { path: 'art', width: 8, height: 16 } } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 10 }] } } } } };
await writeFile(input, JSON.stringify(data)); const original = { input: await fileSha256(input), image: await fileSha256(image) };
const connection = await connectSpine(); let { client } = connection; let previewId: string | undefined;
const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), t = r.content.find(c => c.type === 'text'); if (r.isError || t?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(r.content)}`); return JSON.parse(t.text); };
const identity = (id: string, expectedRevision: number) => ({ id, expectedRevision, requestId: randomUUID() });
const report: Record<string, any> = { version: VERSION, directory, editorOpened: false, inputAutomation: false, visualAcceptance: 'pending', editorDisplayAcknowledged: false };
try {
  assert.equal((await call('spine_status', {})).serverVersion, VERSION); assert.equal((await client.listTools()).tools.length, TOOL_COUNT);
  const rules = { fps: 2, rules: [{ animation: 'idle', joints: [{ bone: 'root', min: -15, max: 15 }] }] }, quality = await call('spine_check_publish_quality', { input, quality: rules }); assert.equal(quality.checksPassed, true); report.precheck = quality.reportPath;
  const failed = await call('spine_check_publish_quality', { input, quality: { fps: 2, rules: [{ animation: 'idle', joints: [{ bone: 'root', min: -1, max: 1 }] }] } }); assert.equal(failed.publishingAllowed, false); report.blockedCheck = failed.reportPath;
  await assert.rejects(call('spine_publish_and_open', { input, output: path.join(directory, 'must-not-publish.spine'), openInEditor: false, quality: { ...rules, maxSamples: 1 } }), /quality gate failed/);
  await assert.rejects(call('spine_deliver', { input, options: { quality: { ...rules, maxSamples: 1 } } }), /quality gate failed/);
  const create = { input, name: 'Before rename', requestId: randomUUID(), maxVersions: 2, quality: rules, previewLease: { durationSeconds: 30, renewBeforeSeconds: 1 } }, session = await call('spine_create_session', create);
  const rename = { ...identity(session.id, 0), name: 'Renamed across reconnect', maxVersions: 4 }, configured = await call('spine_configure_session', rename); assert.equal(configured.requestReceipt.preview.state, 'not_required');
  await client.close(); ({ client } = await connectSpine()); assert.equal((await call('spine_create_session', create)).reused, true); assert.equal((await call('spine_configure_session', rename)).requestReceipt.reused, true);
  const preview = await call('spine_start_native_preview', { input, requestId: randomUUID(), options: { animation: 'idle', time: 0.4, width: 128, height: 128, durationSeconds: 5, viewport: { minX: -20, maxX: 20, minY: -20, maxY: 20 } } }); previewId = preview.id;
  const projectHash = await fileSha256(preview.project), bound = await call('spine_bind_session_preview', { ...identity(session.id, 1), previewId });
  if (bound.requestReceipt.preview.state === 'requested') assert.equal((await call('spine_wait_native_preview', { id: previewId, options: { generation: bound.requestReceipt.preview.generation, waitMs: 30000 } })).outcome, 'published');
  const before = await call('spine_get_native_preview', { id: previewId }), waitMs = Math.max(0, Date.parse(before.expiresAt) - Date.now() + 1000); assert.ok(waitMs < 7000); if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  const touchArgs = identity(session.id, 2), touched = await call('spine_touch_session', touchArgs); assert.equal(touched.preview.id, previewId); assert.ok(touched.lastRenewalAt); assert.equal(touched.requestReceipt.preview.state, 'requested');
  const published = await call('spine_wait_native_preview', { id: previewId, options: { generation: touched.requestReceipt.preview.generation, waitMs: 30000 } }); assert.equal(published.outcome, 'published'); assert.equal(await fileSha256(preview.project), projectHash);
  const afterRenewal = await call('spine_get_native_preview', { id: previewId }); await call('spine_touch_session', touchArgs); assert.equal((await call('spine_get_native_preview', { id: previewId })).pendingGeneration, afterRenewal.pendingGeneration);
  const edited = await call('spine_edit_session', { ...identity(session.id, 3), output: path.join(directory, 'edited.json'), edits: [{ type: 'set_bone', bone: 'root', transform: { x: 6 } }] }); assert.equal(edited.versions.at(-1).quality.checksPassed, true); assert.equal((await call('spine_wait_native_preview', { id: previewId, options: { generation: edited.requestReceipt.preview.generation, waitMs: 30000 } })).outcome, 'published');
  const stopped = await call('spine_stop_native_preview', { id: previewId });
  // Explicit stop advances the preview outside the session; acknowledge that generation by rebinding.
  const rebound = await call('spine_bind_session_preview', { ...identity(session.id, 4), previewId }); assert.equal(rebound.requestReceipt.preview.state, 'failed');
  const stoppedTouch = await call('spine_touch_session', identity(session.id, 5)); assert.equal(stoppedTouch.requestReceipt.preview.state, 'failed'); assert.equal((await call('spine_get_native_preview', { id: previewId })).pendingGeneration, stopped.pendingGeneration); assert.equal((await call('spine_get_native_preview', { id: previewId })).stopRequested, true);
  const storage = await call('spine_get_session_storage', { id: session.id }); assert.equal(storage.versions, 2); assert.equal(storage.versionLimit, 4); assert.equal(storage.archivesDeleted, false); report.storage = storage;
  const archived = await call('spine_set_session_archived', { ...identity(session.id, 6), archived: true }); assert.equal(archived.preview, null); assert.equal((await call('spine_list_sessions', { limit: 100 })).sessions.some((s: any) => s.id === session.id), false); assert.ok((await call('spine_list_sessions', { includeArchived: true, limit: 100 })).sessions.some((s: any) => s.id === session.id));
  await assert.rejects(call('spine_touch_session', identity(session.id, 7)), /archived/);
  const unarchived = await call('spine_set_session_archived', { ...identity(session.id, 7), archived: false }); assert.equal(unarchived.preview, null); assert.equal(unarchived.versions.length, 2); await call('spine_set_session_archived', { ...identity(session.id, 8), archived: true });
  assert.equal(await fileSha256(input), original.input); assert.equal(await fileSha256(image), original.image);
  Object.assign(report, { passed: true, sessionId: session.id, renewal: { samePreviewId: previewId, beforeGeneration: before.pendingGeneration, afterGeneration: afterRenewal.pendingGeneration, projectBytesUnchanged: true, replayDidNotRenewAgain: true, publication: published }, manualStopRespected: true, metadataDidNotRequestImages: true, creationIdentitySurvivesRename: true, archiveHistoryRetained: true, qualityBlockedNativePublicationAndDelivery: true, originalsUnchanged: true });
} catch (error) { report.passed = false; report.error = (error as Error).message; process.exitCode = 1; }
finally { if (previewId) try { await call('spine_stop_native_preview', { id: previewId }); } catch (error) { report.cleanupError = (error as Error).message; } await client.close(); const filename = path.join(config.workspaceRoot, `session-lifecycle-report-${VERSION}.json`); await writeFile(filename, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, version: VERSION, reportPath: filename, error: report.error })); }
