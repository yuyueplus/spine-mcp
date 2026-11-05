import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig, projectRoot } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { parseDocument, type SpineDocument } from '../src/document.js';
import { fileSha256 } from '../src/file-hash.js';
import { sampleSkeleton } from '../src/runtime.js';
import { animationDuration } from '../src/advanced-animation.js';
import { documentSkins } from '../src/slot-data.js';
import { constraintList } from '../src/constraint-data.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const directory = path.join(projectRoot, 'work', `entrypoints-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const config = { ...await loadConfig(), workspaceRoot: directory }, configPath = path.join(directory, 'config.json'); await writeFile(configPath, JSON.stringify(config, null, 2));
const client = new Client({ name: 'spine-entrypoint-audit', version: VERSION }), transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'dist/src/index.js')], env: { ...process.env as Record<string, string>, SPINE_MCP_CONFIG: configPath }, stderr: 'pipe' }); transport.stderr?.on('data', () => undefined); await client.connect(transport);
const verified: string[] = [], rejectedInputs: string[] = [];
async function call(name: string, args: Record<string, unknown>) { const result = await client.callTool({ name, arguments: args }, { timeout: 300000 }), block = result.content.find(item => item.type === 'text'); if (result.isError || block?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(result.content)}`); return JSON.parse(block.text); }
async function reject(name: string, args: Record<string, unknown>) { let rejected = false; try { const result = await client.callTool({ name, arguments: args }); rejected = result.isError === true; } catch { rejected = true; } assert.equal(rejected, true, `${name} must reject invalid input`); rejectedInputs.push(name); }
const read = async (filename: string) => parseDocument(JSON.parse(await readFile(filename, 'utf8')));
try {
  const status = await call('spine_status', {}), tools = (await client.listTools()).tools; assert.equal(status.serverVersion, VERSION); assert.equal(tools.length, TOOL_COUNT);
  const demo = await call('spine_create_demo', {}), originalHash = await fileSha256(demo.path); let current = demo.path, ordinal = 0;
  const edit = async (name: string, args: Record<string, unknown>, verify: (after: SpineDocument, before: SpineDocument) => void) => {
    const before = await read(current), hash = await fileSha256(current), output = path.join(directory, `${String(++ordinal).padStart(2, '0')}-${name}.json`), result = await call(name, { input: current, output, ...args }), after = await read(result.path);
    verify(after, before); assert.equal(await fileSha256(current), hash); assert.equal((await call('spine_validate', { input: result.path })).valid, true); verified.push(name); current = result.path; return after;
  };
  await edit('spine_set_bone', { bone: 'root', transform: { x: 10, y: 12 } }, after => { assert.equal(after.bones.find(bone => bone.name === 'root')?.x, 10); assert.equal(after.bones.find(bone => bone.name === 'root')?.y, 12); });
  await edit('spine_add_bone', { name: 'hand', parent: 'arm', transform: { x: 100, length: 15 } }, after => assert.equal(after.bones.find(b => b.name === 'hand')?.x, 100));
  await edit('spine_reparent_bone', { bone: 'hand', parent: 'root', preserveWorld: true }, (after, before) => { const a = sampleSkeleton(after, undefined, 0).findBone('hand')!.appliedPose, b = sampleSkeleton(before, undefined, 0).findBone('hand')!.appliedPose; assert.equal(after.bones.find(bone => bone.name === 'hand')?.parent, 'root'); assert.ok(Math.hypot(a.worldX - b.worldX, a.worldY - b.worldY) < 1e-6); });
  await edit('spine_rename_object', { target: { kind: 'bone', name: 'hand' }, newName: 'renamed-hand' }, after => assert.ok(after.bones.some(b => b.name === 'renamed-hand')));
  await edit('spine_delete_object', { target: { kind: 'bone', name: 'renamed-hand' } }, after => assert.ok(!after.bones.some(b => b.name === 'renamed-hand')));
  await edit('spine_add_animation', { name: 'qa' }, after => assert.ok(Object.hasOwn(after.animations!, 'qa')));
  await edit('spine_set_timeline', { animation: 'qa', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 45 }] }, after => assert.equal((after.animations!.qa as any).bones.arm.rotate[1].value, 45));
  await edit('spine_add_slot', { name: 'accessory', bone: 'arm' }, after => assert.equal(after.slots!.at(-1)?.name, 'accessory'));
  const slotOrder = (await read(current)).slots!.map(slot => slot.name).reverse();
  await edit('spine_set_slot_order', { order: slotOrder }, after => assert.deepEqual(after.slots!.map(slot => slot.name), slotOrder));
  await reject('spine_add_skin', { input: current, output: path.join(directory, 'ambiguous-default-skin.json'), name: 'night', copyFrom: 'default' });
  await edit('spine_add_skin', { name: 'night', copyFrom: 'default', baseSkin: 'base' }, after => { const night = (documentSkins(after).find(skin => skin.name === 'night')!.attachments as any)['arm-slot'].arm, base = (documentSkins(after).find(skin => skin.name === 'base')!.attachments as any)['arm-slot'].arm; for (const field of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'width', 'height']) assert.deepEqual(night[field], base[field]); assert.equal(night.path, 'arm'); });
  await edit('spine_set_constraint', { definition: { name: 'qa-aim', type: 'ik', bones: ['arm'], target: 'root', mix: 0, skin: true } }, after => assert.ok(constraintList(after).some(c => c.name === 'qa-aim' && c.type === 'ik')));
  await edit('spine_set_skin_members', { skin: 'night', bones: ['arm'], constraints: [{ name: 'qa-aim', type: 'ik' }] }, after => { const skin = documentSkins(after).find(s => s.name === 'night')!; assert.deepEqual(skin.bones, ['arm']); assert.deepEqual(skin.ik, ['qa-aim']); });
  await edit('spine_set_constraint_timeline', { animation: 'qa', constraint: 'qa-aim', constraintType: 'ik', channel: 'parameters', keyframes: [{ time: 0, mix: 0 }, { time: 1, mix: 0.5 }] }, after => assert.equal((after.animations!.qa as any).ik['qa-aim'][1].mix, 0.5));
  await edit('spine_set_attachment', { skin: 'night', slot: 'accessory', name: 'badge', attachment: { type: 'region', path: 'arm', width: 120, height: 24, x: 20, y: 10 }, setAsSetup: true }, after => { assert.equal(after.slots!.find(s => s.name === 'accessory')?.attachment, 'badge'); assert.equal((documentSkins(after).find(s => s.name === 'night')!.attachments as any).accessory.badge.x, 20); });
  await edit('spine_set_attachment_timeline', { animation: 'qa', slot: 'arm-slot', keyframes: [{ time: 0, name: 'arm' }, { time: 0.5, name: null }, { time: 1, name: 'arm' }] }, after => { assert.equal((after.animations!.qa as any).slots['arm-slot'].attachment[1].name ?? null, null); assert.equal(sampleSkeleton(after, 'qa', 0.5, 'night').findSlot('arm-slot')!.appliedPose.attachment, null); });
  await edit('spine_set_color_timeline', { animation: 'qa', slot: 'accessory', keyframes: [{ time: 0, color: 'ffffffff' }, { time: 1, color: 'ff000080' }] }, after => assert.equal((after.animations!.qa as any).slots.accessory.rgba[1].color, 'ff000080'));
  await edit('spine_set_event', { name: 'ping', defaults: { int: 7, string: 'qa' } }, after => assert.equal((after.events as any).ping.int, 7));
  await edit('spine_set_event_timeline', { animation: 'qa', keyframes: [{ time: 0.5, name: 'ping', int: 11 }] }, after => assert.equal((after.animations!.qa as any).events[0].int, 11));
  await edit('spine_set_draw_order', { animation: 'qa', keyframes: [{ time: 0, order: [...slotOrder].reverse() }, { time: 1, order: null }] }, after => assert.deepEqual(sampleSkeleton(after, 'qa', 0, 'night').drawOrder.appliedPose.map(slot => slot.data.name), [...slotOrder].reverse()));
  await edit('spine_set_attachment', { skin: 'night', slot: 'arm-slot', name: 'qa-mesh', attachment: { type: 'mesh', path: 'arm', width: 120, height: 24, uvs: [0, 0, 1, 0, 0, 1], vertices: [0, 0, 120, 0, 0, 24], triangles: [0, 1, 2], hull: 3 } }, after => assert.equal((documentSkins(after).find(s => s.name === 'night')!.attachments as any)['arm-slot']['qa-mesh'].triangles.length, 3));
  await edit('spine_set_attachment_animation', { animation: 'qa', skin: 'night', slot: 'arm-slot', name: 'qa-mesh', channel: 'deform', keyframes: [{ time: 0 }, { time: 1, vertices: [2, 0, 2, 0, 2, 0] }] }, after => assert.equal((after.animations!.qa as any).attachments.night['arm-slot']['qa-mesh'].deform[1].vertices[0], 2));
  await edit('spine_add_animation', { name: 'qa-copy', copyFrom: 'qa' }, after => assert.deepEqual(after.animations!['qa-copy'], after.animations!.qa));
  await edit('spine_rename_animation', { animation: 'qa-copy', newName: 'renamed-copy' }, after => { assert.ok(!Object.hasOwn(after.animations!, 'qa-copy')); assert.deepEqual(after.animations!['renamed-copy'], after.animations!.qa); });
  await edit('spine_crop_animation', { animation: 'qa', newName: 'cropped', start: 0.2, end: 0.8, fps: 30 }, (after, before) => { assert.ok(Math.abs(animationDuration(after.animations!.cropped!) - 0.6) < 1e-6); assert.deepEqual(after.animations!.qa, before.animations!.qa); });
  await edit('spine_mirror_animation', { animation: 'qa', newName: 'mirrored', axis: 'x' }, after => assert.equal((after.animations!.mirrored as any).bones.arm.rotate[1].value, -45));
  await edit('spine_merge_animations', { animations: ['qa', 'renamed-copy'], newName: 'doubled', fps: 30 }, after => assert.equal(animationDuration(after.animations!.doubled!), 2));
  await edit('spine_remove_timeline', { animation: 'doubled', target: { kind: 'bone', bone: 'arm', channel: 'rotate' } }, after => assert.equal((after.animations!.doubled as any).bones?.arm?.rotate, undefined));
  await reject('spine_add_bone', { input: current, output: path.join(directory, 'invalid-bone.json'), name: 'root', parent: 'arm' });
  await reject('spine_reparent_bone', { input: current, output: path.join(directory, 'invalid-cycle.json'), bone: 'root', parent: 'arm' });
  await reject('spine_set_event_timeline', { input: current, output: path.join(directory, 'invalid-event.json'), animation: 'qa', keyframes: [{ time: 0, name: 'missing' }] });
  await reject('spine_set_bone', { input: current, output: current, bone: 'arm', transform: { x: 7 } });
  const built = await call('spine_build_project', { entries: [{ input: current, name: 'entrypoint-qa' }], output: path.join(directory, 'entrypoint-qa.spine') }); assert.equal(built.checks.length, 1); assert.ok((await stat(built.output)).size > 0);
  const frames = await call('spine_export_frames', { input: current, options: { animation: 'qa', skin: 'night', kind: 'bones', start: 0, end: 0.1, fps: 10 } }); assert.equal(frames.frameCount, 2); assert.ok((await stat(frames.player)).size > 0); verified.push('spine_export_frames');
  const fixture = new SpineService(config); fixture.jobs.kick = () => undefined;
  const cancelled = await fixture.jobs.submit({ operation: 'export_frames', args: { input: current, options: { animation: 'qa', skin: 'night', kind: 'bones', start: 0, end: 0.1, fps: 10, physics: false } } }); assert.equal((await call('spine_cancel_job', { id: cancelled.id })).cancellationAccepted, true); verified.push('spine_cancel_job');
  const until = async (id: string, expected: string) => { const deadline = Date.now() + 60000; for (;;) { const job = await call('spine_get_job', { id, includeResult: true }); if (!['queued', 'running'].includes(job.state)) { assert.equal(job.state, expected, JSON.stringify(job)); return job; } if (Date.now() >= deadline) throw new Error('Queue test timed out.'); await new Promise(resolve => setTimeout(resolve, 200)); } };
  await until(cancelled.id, 'cancelled'); assert.equal((await call('spine_cancel_job', { id: cancelled.id })).cancellationAccepted, false);
  const pending = await fixture.jobs.submit({ operation: 'export_frames', args: { input: current, options: { animation: 'qa', skin: 'night', kind: 'bones', start: 0, end: 0.1, fps: 10, physics: false } } }); const resumed = await call('spine_resume_jobs', {}); assert.ok(resumed.pending.includes(pending.id)); await until(pending.id, 'succeeded'); verified.push('spine_resume_jobs');
  const jobs = await call('spine_list_jobs', { limit: 100 }); assert.ok(jobs.jobs.some((job: any) => job.id === cancelled.id && job.state === 'cancelled')); assert.ok(jobs.jobs.some((job: any) => job.id === pending.id && job.state === 'succeeded')); verified.push('spine_list_jobs'); assert.equal((await call('spine_resume_jobs', {})).workerRequested, false);
  for (const tool of tools) { const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }; if (schema.required?.length || !schema.properties) await reject(tool.name, {}); }
  await reject('spine_status', { probeCli: 'invalid' }); await reject('spine_list_jobs', { limit: 0 }); await reject('spine_list_saved_sync', { limit: 0 });
  assert.equal(await fileSha256(demo.path), originalHash);
  const report = { passed: true, version: VERSION, tools: tools.length, isolatedWorkspace: true, directEntrypointsVerified: [...new Set(verified)], invalidInputRejections: [...new Set(rejectedInputs)], nativeOutput: built.output, originalDemoUnchanged: true, directory }, reportPath = path.join(projectRoot, `work/entrypoints-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} finally { await client.close(); }
