import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, cp, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { animationDuration } from '../src/advanced-animation.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

// An explicit local example is copied in full. User-owned files are read only.
let input = process.env.SPINE_AUDIT_USER_PROJECT;
if (!input) { const pointer = JSON.parse(await readFile(path.join(projectRoot, 'work/current-spineboy-session.json'), 'utf8')); input = JSON.parse(await readFile(pointer.reportPath, 'utf8')).source; }
if (!input || !path.isAbsolute(input) || !input.toLowerCase().endsWith('.spine')) throw new Error('Set SPINE_AUDIT_USER_PROJECT to a saved absolute .spine path.');
const source = input, sourceDirectory = path.dirname(source), sourceFiles: { path: string; hash: string }[] = [];
const snapshot = async (folder: string): Promise<void> => { for (const entry of await readdir(folder, { withFileTypes: true })) { const filename = path.join(folder, entry.name); if (entry.isSymbolicLink()) throw new Error('User-project audit requires regular local resource files.'); if (entry.isDirectory()) await snapshot(filename); else sourceFiles.push({ path: filename, hash: await fileSha256(filename) }); } }; await snapshot(sourceDirectory);
const directory = path.join(projectRoot, 'work', `user-acceptance-${randomUUID().slice(0, 8)}`); await mkdir(directory); const copied = path.join(directory, 'source-copy'); await cp(sourceDirectory, copied, { recursive: true, errorOnExist: true, force: false }); const project = path.join(copied, path.basename(source));
const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>) { const response = await client.callTool({ name, arguments: args }, { timeout: timeoutMs }), block = response.content.find(item => item.type === 'text'); if (response.isError || block?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`); return JSON.parse(block.text); }
try {
  const status = await call('spine_status', {}); assert.equal(status.serverVersion, VERSION); assert.equal((await client.listTools()).tools.length, TOOL_COUNT);
  const inspected = await call('spine_inspect', { input: project }), data = JSON.parse(await readFile(inspected.workingJson, 'utf8'));
  assert.equal((await call('spine_validate', { input: inspected.workingJson })).valid, true); const audit = await call('spine_audit_assets', { input: inspected.workingJson, scanUnused: true }); assert.equal(audit.valid, true);
  const rebuilt = await call('spine_build_project', { entries: [{ input: inspected.workingJson, name: 'selected-example' }], output: path.join(directory, 'rebuilt.spine') }), roundTrip = await call('spine_inspect', { input: rebuilt.output });
  const animations = [];
  for (const [name, animation] of Object.entries(data.animations ?? {})) {
    const duration = animationDuration(animation as Record<string, unknown>), times = [...new Set([0, duration / 4, duration / 2, 3 * duration / 4, duration])];
    const inventory = await call('spine_inspect_timelines', { input: inspected.workingJson, animation: name });
    const comparison = await call('spine_compare_projects', { input: inspected.workingJson, other: roundTrip.workingJson, animation: name, times, tolerance: 0.05, render: false }); assert.equal(comparison.withinTolerance, true);
    const artwork = await call('spine_render_artwork', { input: inspected.workingJson, animation: name, times: [0, duration / 2, duration] }); assert.equal(artwork.frames.length, 3); assert.ok((await stat(artwork.path)).size > 0);
    animations.push({ name, duration, inventory, nativeSampledComparison: comparison.reportPath, maxError: comparison.maxSampledError, artwork: artwork.path });
  }
  assert.equal(animations.length, Object.keys(data.animations).length);
  const run = animations.find(animation => animation.name === 'run'); assert.ok(run);
  const media = await call('spine_export_media', { input: inspected.workingJson, options: { animation: 'run', end: run.duration, fps: 30, width: 128, height: 128, formats: ['apng', 'gif', 'mp4', 'spritesheet'] } });
  // Use the actual exported duration, without the manual frame-alignment workaround.
  assert.equal(media.frameCount, 20); assert.equal(media.outputs.length, 4); assert.ok(Math.abs(media.encodedDuration - 20 / 30) < 1e-12);
  const mediaManifest = JSON.parse(await readFile(media.manifestPath, 'utf8')); assert.equal(mediaManifest.endpointOmitted, true);
  const included = await call('spine_export_media', { input: inspected.workingJson, options: { animation: 'run', end: run.duration, fps: 30, width: 64, height: 64, formats: ['apng'], omitEndFrame: false } }); assert.equal(included.frameCount, 21);
  const partial = await call('spine_export_media', { input: inspected.workingJson, options: { animation: 'run', start: 0, end: 0.05, fps: 30, width: 64, height: 64, formats: ['apng'] } }); assert.equal(partial.frameCount, 2);
  for (const file of sourceFiles) assert.equal(await fileSha256(file.path), file.hash, `User file changed: ${file.path}`);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, fixtureKind: 'user-selected-official-example', userProductionProjectValidated: false, source, sourceFiles, directory, originalFilesUnchanged: true, boneCount: data.bones.length, slotCount: data.slots.length, resources: audit.counts, nativeRebuilt: rebuilt.output, animations, allAnimationsNativeCompared: true, allAnimationsArtworkRendered: true, roundedNativeMediaDurationVerified: true, explicitEndFrameVerified: true, fractionalIntervalVerified: true, media }, reportPath = path.join(projectRoot, `work/user-project-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, version: VERSION, animations: animations.length, originalFilesUnchanged: true, rawRunDuration: run.duration, encodedRunFrames: media.frameCount, directory, reportPath }, null, 2));
} finally { await client.close(); }
