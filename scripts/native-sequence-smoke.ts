import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const { client, timeoutMs } = await connectSpine(); let id: string | undefined;
async function call(name: string, args: Record<string, unknown>) { const r = await client.callTool({ name, arguments: args }, { timeout: timeoutMs }), b = r.content.find(c => c.type === 'text'); if (r.isError || b?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(r.content)}`); return JSON.parse(b.text); }
async function until(predicate: (s: any) => boolean) { let s; for (const deadline = Date.now() + 45000; Date.now() < deadline;) { s = await call('spine_get_native_preview', { id }); if (predicate(s)) return s; if (s.lastError) throw new Error(s.lastError); await new Promise(r => setTimeout(r, 100)); } throw new Error(JSON.stringify(s)); }
const ready = (s: any) => s.generation === s.pendingGeneration && s.sequence?.state === 'ready' && !s.lastError;
try {
  assert.equal((await client.listTools()).tools.length, TOOL_COUNT);
  const demo = await call('spine_create_demo', {}), animated = await call('spine_apply_edits', { input: demo.path, output: path.join(demo.directory, 'sequence-source.json'), edits: [{ type: 'add_animation', name: 'wave' }, { type: 'set_timeline', animation: 'wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.6666667, value: 90 }] }] });
  const sourceHash = await fileSha256(animated.path), started = await call('spine_start_native_sequence_preview', { input: animated.path, options: { animation: 'wave', width: 160, height: 160, durationSeconds: 240 }, sequence: { nativeFps: 12 } }); id = started.id;
  const first = await until(s => ready(s) && s.workerAlive && s.supervisorAlive), projectHash = await fileSha256(first.project);
  assert.equal(first.sequence.layout.frameCount, 8); assert.equal(first.mode, 'native-image-sequence');
  const inspected = await call('spine_inspect', { input: first.project }), data = JSON.parse(await readFile(inspected.workingJson, 'utf8')), attachment = data.skins[0].attachments.preview.preview;
  assert.equal(attachment.sequence.count, 8); assert.equal(attachment.sequence.start ?? 0, 0); assert.equal(attachment.sequence.digits, 4);
  const nativeKeys = data.animations['MCP-playback'].attachments.default.preview.preview.sequence; assert.equal(nativeKeys[0].mode, 'loop'); assert.ok(Math.abs(nativeKeys[0].delay - 1 / 12) < 1e-6);
  const assets = await call('spine_audit_assets', { input: inspected.workingJson, scanUnused: false }); assert.equal(assets.valid, true); assert.equal(assets.missing.length, 0);
  const sampled = await call('spine_render_artwork', { input: inspected.workingJson, animation: 'MCP-playback', times: [0, 0.25, 0.5] });
  assert.equal(new Set(sampled.frames.map((f: any) => f.slots[0].image)).size, 3);
  const events: string[] = [], watcher = watch(path.join(first.directory, 'images'), (_e, name) => events.push(String(name))); await new Promise(r => setTimeout(r, 2600)); watcher.close(); assert.deepEqual(events, []);
  const edit = await call('spine_set_bone', { input: animated.path, output: path.join(demo.directory, 'sequence-edit.json'), bone: 'root', transform: { x: 14 } });
  const changed = await until(s => ready(s) && s.input === edit.path); assert.notEqual(changed.sequence.cacheKey, first.sequence.cacheKey); assert.equal(await fileSha256(first.project), projectHash);
  await unlink(path.join(first.directory, 'images/frame-0003.png')); await until(s => ready(s) && s.textureRevision > changed.textureRevision);
  await call('spine_stop_native_preview', { id }); await until(s => s.state === 'stopped' && !s.workerAlive && !s.supervisorAlive);
  await call('spine_resume_native_preview', { id }); const resumed = await until(ready); assert.equal(resumed.sequence.cacheReused, true); assert.equal(resumed.project, first.project);
  assert.equal(await fileSha256(first.project), projectHash); assert.equal(await fileSha256(animated.path), sourceHash);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, newToolsInvoked: ['spine_start_native_sequence_preview'], nativeSequenceMetadataReadbackVerified: true, nativeAnimationTimelineReadbackVerified: true, nativeResourceReferencesVerified: true, sampledNativeSequenceChangesFrames: true, noPerFrameImageWrites: true, ordinaryEditsUpdateSameSequence: true, missingFrameRestored: true, sameProjectResumeAndCacheReuse: true, sourceAndNativeProjectUnchanged: true, nativeDisplayVerified: false, nativeClockControl: false, project: first.project };
  const reportPath = path.join(projectRoot, `work/native-sequence-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, reportPath, project: first.project }, null, 2));
} finally { if (id) { try { await call('spine_stop_native_preview', { id }); } catch {} } await client.close(); }
