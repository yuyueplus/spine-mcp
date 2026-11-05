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
  const tools = await client.listTools();
  assert.equal(tools.tools.length, TOOL_COUNT);
  const status = await call('spine_status', {});
  assert.equal(status.serverVersion, VERSION);
  const demo = await call('spine_create_demo', {}), image = path.join(demo.images, 'arm.png');
  const originalHash = await fileSha256(demo.path), imageHash = await fileSha256(image);
  const operations: Record<string, unknown>[] = [
    { type: 'add_slot', name: 'badge-slot', bone: 'arm' },
    { type: 'add_skin', name: 'night', copyFrom: 'default', baseSkin: 'base' },
    { type: 'attach_image', skin: 'base', slot: 'badge-slot', name: 'badge', image, transform: { x: 120, width: 24, height: 24, rotation: 45 }, setAsSetup: true },
    { type: 'attach_image', skin: 'base', slot: 'arm-slot', name: 'arm-alt', image, transform: { x: 60, y: 8, color: 'ff8866ff', scaleX: 0.8, rotation: 15 } },
    { type: 'set_slot', slot: 'badge-slot', setup: { color: 'ffdd88ff', blend: 'normal', visible: true } },
    { type: 'set_attachment_timeline', animation: 'showcase', slot: 'arm-slot', keyframes: [{ time: 0, name: 'arm' }, { time: 0.5, name: 'arm-alt' }, { time: 1, name: null }, { time: 1.5, name: 'arm' }] },
    { type: 'set_color_timeline', animation: 'showcase', slot: 'arm-slot', keyframes: [{ time: 0, color: 'ffffffff' }, { time: 0.75, color: 'ffd96680' }, { time: 1.5, color: 'ffffffff' }] },
    { type: 'set_timeline', animation: 'showcase', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 35 }, { time: 1.5, value: 0 }] },
    { type: 'add_animation', name: 'showcase-copy', copyFrom: 'showcase' },
    { type: 'add_bone', name: 'tip', parent: 'arm', transform: { x: 120, length: 24 } },
  ];
  // Exercise the six individual editing tools as well as the shared batch schema.
  let working = demo.path;
  for (let index = 0; index < 7; index++) {
    const { type, ...args } = operations[index]!;
    const output = path.join(demo.directory, 'steps', `edit-${index}.json`);
    const result = await call(`spine_${String(type)}`, { input: working, output, ...args });
    working = result.path;
  }
  const jsonOutput = path.join(demo.directory, 'steps', 'batch.json');
  await call('spine_apply_edits', { input: working, output: jsonOutput, edits: operations.slice(7) });
  const beforePreview = await call('spine_render_artwork', { input: jsonOutput, animation: 'showcase', times: [0, 0.5, 0.75, 1, 1.5], skin: 'base' });
  assert.equal(beforePreview.frames[1].slots[0].attachment, 'arm-alt');
  assert.equal(beforePreview.frames[3].slots[0].attachment, null);
  assert.ok(Math.abs(beforePreview.frames[2].slots[0].color.a - 128 / 255) < 0.00001);
  console.log(JSON.stringify({ stage: 'json-tools-and-artwork-passed', tools: tools.tools.length, preview: beforePreview.path }));
  const output = path.join(demo.directory, '完整后台工程', 'artwork showcase.spine');
  const result = await call('spine_edit_project', { input: demo.path, output, edits: operations, skeletonName: 'artwork-showcase' });
  assert.equal(result.published, true); assert.equal(result.verification.passed, true);
  const inspection = await call('spine_inspect', { input: result.exportedJson });
  assert.equal(inspection.bones.length, 3); assert.equal(inspection.slots.length, 2); assert.equal(inspection.skins.length, 2);
  assert.equal(inspection.attachments.length, 4);
  assert.equal((await call('spine_validate', { input: result.exportedJson })).valid, true);
  const animation = await call('spine_get_animation', { input: result.exportedJson, animation: 'showcase' });
  assert.equal(animation.animation.slots['arm-slot'].attachment[1].name, 'arm-alt');
  assert.equal(animation.animation.slots['arm-slot'].rgba[1].color.toLowerCase(), 'ffd96680');
  const preview = await call('spine_render_artwork', { input: result.exportedJson, animation: 'showcase', times: [0, 0.5, 0.75, 1, 1.5], skin: 'base' });
  assert.equal(preview.frames[1].slots[0].attachment, 'arm-alt');
  assert.equal(preview.frames[3].slots[0].attachment, null);
  const skinPreview = await call('spine_render_artwork', { input: result.exportedJson, animation: 'showcase', times: [0, 0.5, 1], skin: 'night' });
  assert.equal(skinPreview.frames[0].slots[0].attachment, 'arm');
  assert.equal(await fileSha256(demo.path), originalHash); assert.equal(await fileSha256(image), imageHash);
  const report = { passed: true, serverVersion: status.serverVersion, server: 'spine43', tools: tools.tools.length, original: demo.path, originalSha256: originalHash, originalUnchanged: true, image, imageSha256: imageHash, imageUnchanged: true, individualToolsVerified: true, jsonBatchVerified: true, result, preview, skinPreview };
  const reportPath = path.join(projectRoot, 'work/artwork-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, tools: tools.tools.length, report: reportPath, output, preview: preview.path, skinPreview: skinPreview.path, originalUnchanged: true, imageUnchanged: true }, null, 2));
} finally { await client.close(); }
