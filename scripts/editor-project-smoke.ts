import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { SpineService } from '../src/service.js';

const openInEditor = process.argv.includes('--open'), config = await loadConfig();
let connection = await connectSpine({ local: process.argv.includes('--local') });
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), text = result.content.find(item => item.type === 'text');
  assert.ok(!result.isError && text?.type === 'text', `${name}: ${JSON.stringify(result.content)}`); return JSON.parse(text.text);
};
const reject = async (name: string, args: Record<string, unknown>) => {
  const result = await connection.client.callTool({ name, arguments: args }); assert.equal(result.isError, true, `${name} should reject`);
};
const suffix = randomUUID().slice(0, 8), directory = path.join(config.workspaceRoot, `editor-project-${suffix}`);
await mkdir(directory);
try {
  const status = await call('spine_status', { probeCli: true }); assert.equal(status.serverVersion, VERSION); assert.equal(status.cli.available, true);
  const tools = (await connection.client.listTools()).tools;
  assert.equal(tools.length, TOOL_COUNT);
  for (const name of ['spine_create_project', 'spine_open_project', 'spine_get_editor_open_status']) assert.ok(tools.some(tool => tool.name === name));
  const output = path.join(directory, `MCP-created-${suffix}.spine`), requestId = randomUUID();
  const created = await call('spine_create_project', { output, skeletonName: `MCP-created-${suffix}`, fps: 24, openInEditor, ...(openInEditor ? { openOptions: { requestId, waitMs: 5000 } } : {}) });
  assert.equal(created.created, true); assert.equal(created.verification.passed, true);
  const projectHash = await fileSha256(output), inspected = await call('spine_inspect', { input: output });
  assert.equal(inspected.version, '4.3.23'); assert.equal(inspected.bones.length, 1); assert.equal(inspected.bones[0].name, 'root');
  const readback = JSON.parse(await readFile(inspected.workingJson, 'utf8'));
  assert.equal(readback.skeleton.fps, 24);
  assert.equal(path.resolve(path.dirname(inspected.workingJson), readback.skeleton.images), created.images);
  await reject('spine_create_project', { output }); await reject('spine_create_project', { output: path.join(directory, 'bad.json') });
  await reject('spine_create_project', { output: '../outside.spine' });
  await reject('spine_create_project', { output: path.join(directory, 'unsafe-name.spine'), skeletonName: '../escape' });
  await reject('spine_open_project', { input: inspected.workingJson });
  let opened: any = null, reconnectSurvival: any = null;
  if (openInEditor) {
    assert.equal(created.editorOpen.launchAccepted, true, JSON.stringify(created.editorOpen));
    opened = await call('spine_get_editor_open_status', { id: requestId, waitMs: 10000 });
    assert.equal(opened.projectLoadedVerified, false); assert.equal(opened.settingsModified, false);
    const repeated = await call('spine_open_project', { input: output, requestId, waitMs: 0 }); assert.equal(repeated.reusedRequest, true); assert.equal(repeated.launcherPid, opened.launcherPid);
    await connection.client.close(); connection = await connectSpine({ local: process.argv.includes('--local') });
    reconnectSurvival = await call('spine_get_editor_open_status', { id: requestId });
    assert.equal(reconnectSurvival.launchAccepted, true); assert.equal(reconnectSurvival.launcherPid, opened.launcherPid);
  } else {
    assert.equal(created.editorOpen.requested, false);
    // Reuse an existing observed request to exercise both public lifecycle
    // tools without opening another editor or changing the user's project.
    const previousFile = path.join(config.workspaceRoot, 'visual-acceptance-2.7.0', 'editor-publication.json');
    let previous: any;
    try { previous = JSON.parse(await readFile(previousFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      opened = await call('spine_get_editor_open_status', { id: previous.requestId });
      assert.equal(opened.projectFileUnchanged, true);
      const repeated = await call('spine_open_project', { input: previous.project, requestId: previous.requestId, reuseInstance: false, waitMs: 0 });
      assert.equal(repeated.reusedRequest, true); assert.equal(repeated.launcherPid, opened.launcherPid);
      reconnectSurvival = { reusedExistingRequest: true, newEditorLaunched: false, project: previous.project };
    }
  }
  // Exercise a real import with a deliberately unconfigured GUI. The partial
  // result must retain the verified project, allowing a later open-only retry.
  const noGui = new SpineService({ ...config, guiExecutable: null, guiRuntimeDiscovery: undefined });
  const partial = await noGui.createProject({ output: path.join(directory, 'created-without-launcher.spine'), openInEditor: true });
  assert.equal(partial.created, true); assert.equal(partial.editorOpen.requested, true);
  assert.equal('launchAccepted' in partial.editorOpen && partial.editorOpen.launchAccepted, false);
  assert.equal((await noGui.cli.projectInfo(partial.path)).exitCode, 0);
  assert.equal(await fileSha256(output), projectHash);
  const report = { passed: true, version: VERSION, tools: TOOL_COUNT, checkedAt: new Date().toISOString(), project: output, projectSha256: projectHash, created, rootBoneAndFpsVerified: true, imagePathVerified: true, existingOutputAndInvalidPathsRejected: true, launchFailureRetainsCreatedProject: true, launchFailureProject: partial.path, projectUnchanged: true, opened, reconnectSurvival, inputAutomationUsed: false, editorProjectLoadHumanAccepted: false };
  const reportPath = path.join(config.workspaceRoot, `${openInEditor ? 'editor-open' : 'editor-project'}-report-${VERSION}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, project: output, reportPath, openRequested: openInEditor, windowObserved: opened?.windowObserved ?? false, requestId: openInEditor ? requestId : undefined, projectLoadedVerified: false }, null, 2));
} finally { await connection.client.close(); }
