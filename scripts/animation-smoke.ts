import { VERSION, TOOL_COUNT } from '../src/version.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/project-workflow.js';

const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const block = result.content.find(item => item.type === 'text');
  assert.ok(block && block.type === 'text');
  return JSON.parse(block.text);
}
try {
  const tools = await client.listTools(); assert.equal(tools.tools.length, TOOL_COUNT);
  assert.equal(client.getServerVersion()?.version, VERSION);
  const demo = await call('spine_create_demo', {}), image = path.join(demo.images, 'arm.png');
  const originalHash = await fileSha256(demo.path), imageHash = await fileSha256(image);
  const preparation: Record<string, unknown>[] = [
    { type: 'add_slot', name: 'overlay', bone: 'arm' },
    { type: 'attach_image', skin: 'default', slot: 'overlay', name: 'overlay', image, transform: { x: 60, color: 'ff4444ff' }, setAsSetup: true },
    { type: 'set_timeline', animation: 'action', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0, curve: [0.15, 0, 0.35, 45] }, { time: 0.5, value: 45 }, { time: 1, value: 0 }] },
    { type: 'set_color_timeline', animation: 'action', slot: 'arm-slot', keyframes: [{ time: 0, color: 'ffffffff' }, { time: 0.5, color: 'ffffff80' }, { time: 1, color: 'ffffffff' }] },
  ];
  const operations: Record<string, unknown>[] = [
    { type: 'set_event', name: 'step', defaults: { int: 1, float: 0.5, string: '脚步' } },
    { type: 'set_event', name: 'impact', defaults: { int: 2, float: 0.25, string: '碰撞' } },
    { type: 'set_event_timeline', animation: 'action', keyframes: [{ time: 0, name: 'step' }, { time: 0.5, name: 'step', int: 7, string: '左脚' }, { time: 0.5, name: 'impact', int: 9, float: 0.75 }, { time: 1, name: 'step' }] },
    { type: 'set_draw_order', animation: 'action', keyframes: [{ time: 0, order: null }, { time: 0.5, order: ['overlay', 'arm-slot'] }, { time: 1, order: null }] },
    { type: 'add_animation', name: 'spare', copyFrom: 'action' },
    { type: 'remove_timeline', animation: 'spare', target: { kind: 'bone', bone: 'arm', channel: 'rotate' } },
    { type: 'retime_animation', animation: 'action', timeScale: 2, timeOffset: 0.25 },
    { type: 'rename_animation', animation: 'action', newName: 'slow_action' },
  ];
  let working = path.join(demo.directory, 'steps', 'prepared.json');
  await call('spine_apply_edits', { input: demo.path, output: working, edits: preparation });
  for (let index = 0; index < operations.length; index++) {
    const { type, ...args } = operations[index]!;
    const output = path.join(demo.directory, 'steps', `animation-${index}.json`);
    working = (await call(`spine_${String(type)}`, { input: working, output, ...args })).path;
  }
  const jsonAnimation = await call('spine_get_animation', { input: working, animation: 'slow_action' });
  assert.deepEqual(jsonAnimation.animation.events.map((key: any) => key.time), [0.25, 1.25, 1.25, 2.25]);
  assert.deepEqual(jsonAnimation.animation.bones.arm.rotate[0].curve, [0.55, 0, 0.95, 45]);
  const spare = await call('spine_get_animation', { input: working, animation: 'spare' });
  assert.equal(spare.animation.bones, undefined); assert.ok(spare.animation.slots);
  const output = path.join(demo.directory, '动画后台验收', 'retimed events.spine');
  const result = await call('spine_edit_project', { input: demo.path, output, skeletonName: 'animation-demo', edits: [...preparation, ...operations] });
  assert.equal(result.published, true); assert.equal(result.verification.passed, true);
  const inspected = await call('spine_inspect', { input: result.exportedJson });
  assert.deepEqual(inspected.animations.map((item: any) => item.name).sort(), ['slow_action', 'spare']);
  assert.equal(inspected.animations.find((item: any) => item.name === 'slow_action').duration, 2.25);
  assert.equal(inspected.events.step.int, 1); assert.equal(inspected.events.impact.string, '碰撞');
  const animation = await call('spine_get_animation', { input: result.exportedJson, animation: 'slow_action' });
  assert.deepEqual(animation.animation.events.map((key: any) => key.time), [0.25, 1.25, 1.25, 2.25]);
  assert.ok(animation.animation.events.some((key: any) => key.name === 'step' && key.int === 7 && key.string === '左脚'));
  assert.deepEqual(animation.animation.bones.arm.rotate[0].curve, [0.55, 0, 0.95, 45]);
  const preview = await call('spine_render_artwork', { input: result.exportedJson, animation: 'slow_action', times: [0.25, 1.25, 2.25] });
  assert.deepEqual(preview.frames[0].slots.map((slot: any) => slot.slot), ['arm-slot', 'overlay']);
  assert.deepEqual(preview.frames[1].slots.map((slot: any) => slot.slot), ['overlay', 'arm-slot']);
  assert.deepEqual(preview.frames[2].slots.map((slot: any) => slot.slot), ['arm-slot', 'overlay']);
  const loop = await call('spine_check_loop', { input: result.exportedJson, animation: 'slow_action' });
  assert.equal(loop.endpointMismatches.length, 0); assert.equal(loop.slotMismatches.length, 0); assert.equal(loop.drawOrderMismatch, false);
  const invalid = await client.callTool({ name: 'spine_retime_animation', arguments: { input: result.exportedJson, output: path.join(demo.directory, 'negative.json'), animation: 'slow_action', timeScale: 1, timeOffset: -1 } });
  assert.ok(invalid.isError);
  assert.equal(await fileSha256(demo.path), originalHash); assert.equal(await fileSha256(image), imageHash);
  const report = { passed: true, server: 'spine43', serverVersion: VERSION, tools: tools.tools.length, input: demo.path, originalSha256: originalHash, originalUnchanged: true, imageUnchanged: true, individualToolsVerified: true, simultaneousEventsVerified: true, bezierRetimingVerified: true, drawOrderVerified: true, timelineRemovalVerified: true, negativeRetimingRejected: true, result, preview, loop };
  const reportPath = path.join(projectRoot, 'work/animation-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, tools: tools.tools.length, report: reportPath, output, preview: preview.path, originalUnchanged: true, imageUnchanged: true, simultaneousEventsVerified: true, bezierRetimingVerified: true, drawOrderVerified: true }, null, 2));
} finally { await client.close(); }
