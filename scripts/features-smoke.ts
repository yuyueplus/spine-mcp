import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/project-workflow.js';

const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); return JSON.parse(block.text);
}
const reportPath = path.join(projectRoot, 'work/features-report.json');
try {
  assert.equal((await client.listTools()).tools.length, TOOL_COUNT); assert.equal(client.getServerVersion()?.version, VERSION);
  const demo = await call('spine_create_demo', {}), image = path.join(demo.images, 'arm.png'), sourceHash = await fileSha256(demo.path), imageHash = await fileSha256(image);
  for (const [index, color] of ['#46d09b', '#5798f5'].entries()) await writeFile(path.join(demo.images, `seq${index + 1}.png`), new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24"><rect width="120" height="24" rx="8" fill="${color}"/></svg>`).render().asPng(), { flag: 'wx' });
  const edits: Record<string, unknown>[] = [];
  for (const [name, x, y, length] of [['control', 60, 70, 20], ['ik-bone', -20, -30, 80], ['transform-bone', 0, 0, 30], ['physics-bone', -40, 30, 60], ['path-bone', 0, 0, 30], ['slider-bone', 0, -50, 40]] as const) edits.push({ type: 'add_bone', name, parent: 'root', transform: { x, y, length } });
  edits.push({ type: 'set_timeline', animation: 'a-pose', bone: 'slider-bone', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 60 }] });
  for (const [name, bone] of [['clip-slot', 'root'], ['mesh-slot', 'arm'], ['linked-slot', 'root'], ['path-slot', 'root']] as const) edits.push({ type: 'add_slot', name, bone });
  edits.push(
    { type: 'set_attachment', skin: 'default', slot: 'mesh-slot', name: 'mesh', attachment: { type: 'mesh', path: 'arm', width: 120, height: 24, uvs: [0, 1, 0, 0, 1, 0, 1, 1], vertices: [0, -12, 0, 12, 120, 12, 120, -12], triangles: [0, 1, 2, 0, 2, 3], hull: 4 }, setAsSetup: true },
    { type: 'set_weights', skin: 'default', slot: 'mesh-slot', name: 'mesh', weights: Array.from({ length: 4 }, () => [{ bone: 'arm', weight: 0.8 }, { bone: 'control', weight: 0.2 }]) },
    { type: 'set_attachment', skin: 'default', slot: 'linked-slot', name: 'linked', attachment: { type: 'mesh', source: 'mesh', slot: 'mesh-slot', path: 'arm', width: 120, height: 24, color: '719be8aa' }, setAsSetup: true },
    { type: 'set_attachment', skin: 'default', slot: 'clip-slot', name: 'clip', attachment: { type: 'clipping', end: 'mesh-slot', vertexCount: 4, vertices: [-10, -20, -10, 100, 100, 100, 100, -20] }, setAsSetup: true },
    { type: 'set_attachment', skin: 'default', slot: 'path-slot', name: 'path', attachment: { type: 'path', vertexCount: 6, vertices: [-10, -35, 0, -35, 33, -35, 66, -35, 100, -35, 110, -35], lengths: [100], constantSpeed: true }, setAsSetup: true },
    { type: 'set_attachment', skin: 'default', slot: 'arm-slot', name: 'sequence', attachment: { path: 'seq', x: 60, width: 120, height: 24, sequence: { count: 2, start: 1, digits: 0, setup: 0 } } },
    { type: 'set_attachment_timeline', animation: 'action', slot: 'arm-slot', keyframes: [{ time: 0, name: 'sequence' }, { time: 1, name: 'sequence' }] },
    { type: 'set_attachment_animation', animation: 'action', skin: 'default', slot: 'arm-slot', name: 'sequence', channel: 'sequence', keyframes: [{ time: 0, mode: 'loop', delay: 0.25 }, { time: 1, mode: 'hold', index: 0 }] },
    { type: 'set_attachment_animation', animation: 'action', skin: 'default', slot: 'mesh-slot', name: 'mesh', channel: 'deform', keyframes: [{ time: 0 }, { time: 0.5, offset: 2, vertices: [0, 14, 0, 14] }, { time: 1 }] },
    { type: 'set_timeline', animation: 'action', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 35 }, { time: 1, value: 0 }] },
    { type: 'set_constraint', definition: { type: 'ik', name: 'aim', bones: ['ik-bone'], target: 'control' } },
    { type: 'set_constraint', definition: { type: 'transform', name: 'copy', bones: ['transform-bone'], source: 'control', properties: { x: { to: { x: {} } }, y: { to: { y: {} } } } } },
    { type: 'set_constraint', definition: { type: 'path', name: 'follow', bones: ['path-bone'], slot: 'path-slot', position: 0.5 } },
    { type: 'set_constraint', definition: { type: 'physics', name: 'spring', bone: 'physics-bone', rotate: 1, strength: 20, gravity: 30, wind: 15 } },
    { type: 'set_constraint', definition: { type: 'slider', name: 'driver', animation: 'a-pose', time: 0.5 } },
    { type: 'set_constraint_timeline', animation: 'action', constraint: 'aim', channel: 'parameters', keyframes: [{ time: 0, mix: 1 }, { time: 1, mix: 0.7 }] },
    { type: 'set_constraint_timeline', animation: 'action', constraint: 'copy', channel: 'parameters', keyframes: [{ time: 0, mixX: 0.5, mixY: 0.5 }, { time: 1, mixX: 1, mixY: 1 }] },
    { type: 'set_constraint_timeline', animation: 'action', constraint: 'follow', channel: 'position', keyframes: [{ time: 0, value: 0.2 }, { time: 1, value: 0.8 }] },
    { type: 'set_constraint_timeline', animation: 'action', constraint: 'spring', channel: 'wind', keyframes: [{ time: 0, value: 15 }, { time: 1, value: 20 }] },
    { type: 'set_constraint_timeline', animation: 'action', constraint: 'driver', channel: 'time', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] },
    { type: 'set_slot_order', order: ['clip-slot', 'arm-slot', 'mesh-slot', 'linked-slot', 'path-slot'] },
    { type: 'set_slot', slot: 'linked-slot', setup: { blend: 'screen', dark: '091d32' } },
    { type: 'rename', target: { kind: 'bone', name: 'control' }, newName: 'target' },
    { type: 'rename', target: { kind: 'slot', name: 'mesh-slot' }, newName: 'deformed-slot' },
    { type: 'add_bone', name: 'discard', parent: 'root' }, { type: 'delete', target: { kind: 'bone', name: 'discard' } },
    { type: 'reparent_bone', bone: 'slider-bone', parent: 'arm', preserveWorld: false },
    { type: 'crop_animation', animation: 'action', newName: 'middle', start: 0.2, end: 0.8, fps: 20 },
    { type: 'mirror_animation', animation: 'action', newName: 'mirrored', axis: 'x', bones: ['arm'] },
    { type: 'merge_animations', animations: ['middle', 'middle'], newName: 'combined', fps: 20 },
  );
  console.log('Checking geometry, structure, five constraints and advanced animation through registered MCP...');
  const output = path.join(demo.directory, '新功能后台验收.spine');
  const project = await call('spine_edit_project', { input: demo.path, output, edits, skeletonName: 'showcase' });
  const preview = await call('spine_render_artwork', { input: project.exportedJson, animation: 'action', times: [0, 0.25, 0.5, 0.75, 1], physics: true });
  const bones = await call('spine_render_preview', { input: project.exportedJson, animation: 'action', times: [0, 0.5, 1], physics: true });
  const bakePath = path.join(demo.directory, 'baked.json');
  const baked = await call('spine_bake_animation', { input: project.exportedJson, output: bakePath, animation: 'action', newName: 'baked', fps: 20, physics: true });
  console.log('Checking multi-skeleton rebuilding...');
  const multi = await call('spine_build_project', { entries: [{ input: project.exportedJson, name: 'rig' }, { input: baked.path, name: 'baked' }], output: path.join(demo.directory, '多骨架.spine') });
  const multiEdited = await call('spine_edit_multi_project', { input: multi.output, output: path.join(demo.directory, '多骨架修改.spine'), changes: [{ name: 'baked', edits: [{ type: 'rename', target: { kind: 'bone', name: 'arm' }, newName: 'baked-arm' }] }] });
  const batch = await call('spine_batch', { inputs: [multiEdited.output, project.exportedJson], action: 'validate' }); assert.equal(batch.failed, 0); assert.equal(batch.results[0].skeletons.length, 2);
  console.log('Submitting frame export; closing the MCP connection to verify persistence...');
  const job = await call('spine_start_job', { operation: 'export_frames', args: { input: project.exportedJson, options: { animation: 'action', start: 0, end: 1, fps: 12, kind: 'artwork', physics: true } } });
  await client.close();
  const reopened = await connectSpine();
  let completed: any;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await reopened.client.callTool({ name: 'spine_get_job', arguments: { id: job.id, includeResult: true } });
      const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); completed = JSON.parse(block.text);
      if (['succeeded', 'failed', 'cancelled'].includes(completed.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(completed.state, 'succeeded', JSON.stringify(completed)); assert.equal(completed.result.frameCount, 13);
  } finally { await reopened.client.close(); }
  assert.equal(await fileSha256(demo.path), sourceHash); assert.equal(await fileSha256(image), imageHash);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, originalUnchanged: true, imagesUnchanged: true, project, preview, bones, baked, multi, multiEdited, batch, job: completed, workerSurvivedMcpDisconnect: true };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, reportPath, output, preview: preview.path, player: completed.result.player, tools: TOOL_COUNT, workerSurvivedMcpDisconnect: true }, null, 2));
} finally { await client.close(); }
