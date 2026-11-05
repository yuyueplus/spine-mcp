import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/project-workflow.js';

const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  assert.ok(!result.isError, JSON.stringify(result.content));
  const block = result.content.find(item => item.type === 'text');
  assert.ok(block && block.type === 'text');
  return JSON.parse(block.text);
}
try {
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'spine_edit_project'));
  const earlier = JSON.parse(await readFile(path.join(projectRoot, 'work/smoke-report.json'), 'utf8'));
  const source: string = earlier.roundTrip.project.path;
  const originalHash = await fileSha256(source);
  const output = path.join(path.dirname(source), `后台完成-${randomUUID().slice(0, 8)}`, 'verified animation.spine');
  const result = await call('spine_edit_project', {
    input: source, output,
    edits: [
      { type: 'set_bone', bone: 'arm', transform: { x: 15 } },
      { type: 'add_bone', name: 'tip', parent: 'arm', transform: { x: 120, length: 25 } },
      { type: 'add_animation', name: 'background_wave', copyFrom: 'mcp_wave' },
      { type: 'set_timeline', animation: 'background_wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.25, value: 55 }, { time: 0.5, value: 0 }, { time: 0.75, value: -55 }, { time: 1, value: 0 }] },
    ],
  });
  assert.equal(result.published, true);
  assert.equal(result.verification.passed, true);
  assert.equal(await fileSha256(source), originalHash);
  const inspected = await call('spine_inspect', { input: output });
  assert.equal(inspected.bones.length, 3);
  assert.equal(inspected.bones.find((bone: any) => bone.name === 'arm').x, 15);
  assert.deepEqual(inspected.animations.map((animation: any) => animation.name).sort(), ['background_wave', 'mcp_wave']);
  const animation = await call('spine_get_animation', { input: result.exportedJson, animation: 'background_wave' });
  assert.equal(animation.animation.bones.arm.rotate[1].value, 55);
  assert.equal(animation.animation.bones.arm.rotate[3].value, -55);
  const preview = await call('spine_render_preview', { input: result.exportedJson, animation: 'background_wave', times: [0, 0.25, 0.5, 0.75, 1] });
  const arm = preview.frames[1].bones.find((bone: any) => bone.name === 'arm');
  assert.ok(Math.abs(arm.rotation - 55) < 0.01);
  const duplicate = await client.callTool({ name: 'spine_edit_project', arguments: { input: source, output, edits: [{ type: 'set_bone', bone: 'arm', transform: { x: 3 } }] } });
  assert.ok(duplicate.isError);
  assert.equal(await fileSha256(source), originalHash);
  const report = { passed: true, server: 'spine43', tools: tools.tools.length, input: source, originalSha256: originalHash, originalUnchanged: true, result, preview, existingOutputRejected: true };
  await writeFile(path.join(projectRoot, 'work/workflow-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, tools: tools.tools.length, source, output, originalUnchanged: true, verification: result.verification, report: result.reportPath, preview: preview.path }, null, 2));
} finally { await client.close(); }
