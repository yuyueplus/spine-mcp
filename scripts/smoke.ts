import { VERSION, TOOL_COUNT } from '../src/version.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { projectRoot } from '../src/config.js';

const client = new Client({ name: 'spine-mcp-smoke', version: VERSION });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'dist/src/index.js')], stderr: 'pipe' });
transport.stderr?.on('data', () => undefined);
await client.connect(transport);
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const text = result.content.find(block => block.type === 'text');
  assert.ok(text && text.type === 'text');
  return JSON.parse(text.text);
}
try {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, TOOL_COUNT);
  const status = await call('spine_status', {});
  assert.equal(status.targetVersion, '4.3.23');
  const demo = await call('spine_create_demo', {});
  const output = path.join(demo.directory, 'mcp-wave.json');
  await call('spine_set_timeline', { input: demo.path, output, animation: 'mcp_wave', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.25, value: 35 }, { time: 0.5, value: 0 }, { time: 0.75, value: -35 }, { time: 1, value: 0 }] });
  const inspection = await call('spine_inspect', { input: output });
  assert.equal(inspection.animations[0].duration, 1);
  const animation = await call('spine_get_animation', { input: output, animation: 'mcp_wave' });
  assert.equal(animation.animation.bones.arm.rotate[1].value, 35);
  const validated = await call('spine_validate', { input: output });
  assert.equal(validated.valid, true);
  const loop = await call('spine_check_loop', { input: output, animation: 'mcp_wave' });
  assert.equal(loop.endpointMismatches.length, 0);
  const repeat = await client.callTool({ name: 'spine_set_bone', arguments: { input: output, output, bone: 'arm', transform: { rotation: 10 } } });
  assert.ok(repeat.isError, 'Existing output must be rejected');
  const handoff = await call('spine_editor_handoff', { input: output });
  const preview = await call('spine_render_preview', { input: output, animation: 'mcp_wave', times: [0, 0.25, 0.5, 0.75, 1] });
  assert.ok(Math.abs(preview.frames[1].bones.find((bone: any) => bone.name === 'arm').rotation - 35) < 0.01);
  const resource = await client.readResource({ uri: 'spine://status' });
  assert.equal(resource.contents.length, 1);
  let roundTrip: Record<string, unknown> | null = null;
  if (status.cli.configured) {
    const project = await call('spine_import', { input: output, output: path.join(demo.directory, 'mcp-wave.spine'), skeletonName: 'mcp-demo' });
    const info = await call('spine_project_info', { input: project.path });
    assert.match(info.stdout, /Spine version:\s*4\.3\.23/);
    const exported = await call('spine_export', { input: project.path });
    const exportedJson = exported.files.find((file: string) => file.endsWith('.json'));
    const data = JSON.parse(await readFile(exportedJson, 'utf8'));
    assert.equal(data.skeleton.spine, '4.3.23');
    assert.equal(data.bones.length, 2);
    assert.equal(data.animations.mcp_wave.bones.arm.rotate.length, 5);
    assert.equal(data.animations.mcp_wave.bones.arm.rotate[1].value, 35);
    assert.equal(data.animations.mcp_wave.bones.arm.rotate[3].value, -35);
    const imagesPath = path.resolve(path.dirname(exportedJson), data.skeleton.images);
    assert.ok((await stat(path.join(imagesPath, 'arm.png'))).size > 0, `Round-trip must preserve the image path: ${imagesPath}`);
    const binary = await call('spine_export', { input: project.path, format: 'binary' });
    assert.ok(binary.files.some((file: string) => file.endsWith('.skel')));
    const atlas = await call('spine_pack_atlas', { imagesDirectory: demo.images, name: 'mcp-demo' });
    assert.ok(atlas.files.some((file: string) => file.endsWith('.atlas')));
    const relocated = await call('spine_import', { input: exportedJson, output: path.join(demo.directory, '中文 演示', 'mcp wave.spine'), skeletonName: '中文 骨架' });
    const relocatedExport = await call('spine_export', { input: relocated.path });
    const relocatedJson = relocatedExport.files.find((file: string) => file.endsWith('.json'));
    const relocatedData = JSON.parse(await readFile(relocatedJson, 'utf8'));
    assert.equal(relocatedData.animations.mcp_wave.bones.arm.rotate[1].value, 35);
    assert.ok((await stat(path.resolve(path.dirname(relocatedJson), relocatedData.skeleton.images, 'arm.png'))).size > 0);
    roundTrip = { project, info, exported, binary, atlas, imagesPath, unicodeAndSpacePaths: { project: relocated.path, export: relocatedJson, passed: true }, boneCount: data.bones.length, rotationKeyframes: data.animations.mcp_wave.bones.arm.rotate };
  }
  const report = { passed: true, tools: tools.tools.map(tool => tool.name), status, demo, output, inspection, validated, loop, handoff, preview, cliRoundTripVerified: Boolean(roundTrip), editorUiVerified: false, roundTrip };
  await mkdir(path.join(projectRoot, 'work'), { recursive: true });
  await writeFile(path.join(projectRoot, 'work/smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
