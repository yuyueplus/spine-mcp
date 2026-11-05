import { VERSION, TOOL_COUNT } from '../src/version.js';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { projectRoot } from '../src/config.js';

const config = JSON.parse(execFileSync('codex', ['mcp', 'get', 'spine43', '--json'], { encoding: 'utf8', windowsHide: true }));
assert.equal(config.transport.type, 'stdio');
const client = new Client({ name: 'spine-registered-check', version: VERSION });
const transport = new StdioClientTransport({ command: config.transport.command, args: config.transport.args, env: { ...process.env as Record<string, string>, ...config.transport.env }, stderr: 'pipe' });
transport.stderr?.on('data', () => undefined);
await client.connect(transport);
try {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, TOOL_COUNT);
  assert.ok(tools.tools.some(tool => tool.name === 'spine_resume_native_preview'));
  assert.ok(tools.tools.some(tool => tool.name === 'spine_control_native_playback'));
  assert.ok(tools.tools.some(tool => tool.name === 'spine_start_native_sequence_preview'));
  for (const name of ['spine_save_character_template', 'spine_apply_character_template', 'spine_recover_job', 'spine_create_project', 'spine_open_project', 'spine_get_editor_open_status', 'spine_check_environment', 'spine_publish_and_open', 'spine_get_publication', 'spine_audit_animation', 'spine_prepare_character', 'spine_build_pose_animation', 'spine_bake_foot_contacts', 'spine_run_regression_suite', 'spine_record_visual_review', 'spine_get_acceptance']) assert.ok(tools.tools.some(tool => tool.name === name));
  const result = await client.callTool({ name: 'spine_status', arguments: { probeCli: true } });
  assert.ok(!result.isError);
  const block = result.content.find(item => item.type === 'text');
  assert.ok(block && block.type === 'text');
  const status = JSON.parse(block.text);
  assert.equal(status.cli.available, true);
  assert.equal(status.cli.editorVersion, '4.3.23');
  const smoke = JSON.parse(await readFile(path.join(projectRoot, 'work/smoke-report.json'), 'utf8'));
  const info = await client.callTool({ name: 'spine_project_info', arguments: { input: smoke.roundTrip.project.path } });
  assert.ok(!info.isError);
  assert.match(JSON.stringify(info.content), /mcp_wave/);
  assert.equal(status.serverVersion, VERSION);
  assert.equal(status.editor.nativeTexturePreviewPlayback, true); assert.equal(status.editor.nativeTexturePreviewResume, true); assert.equal(status.editor.nativeTexturePreviewSupervision, true);
  const report = { version: VERSION, registered: true, connected: true, server: 'spine43', tools: tools.tools.length, editorVersion: status.cli.editorVersion, cliAvailable: status.cli.available, projectInfoVerified: true, cliRoundTripVerified: smoke.cliRoundTripVerified, unicodeAndSpacePathsVerified: smoke.roundTrip.unicodeAndSpacePaths.passed };
  await writeFile(path.join(projectRoot, 'work/registration-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
