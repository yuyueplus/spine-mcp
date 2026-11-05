import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SkeletonBinary, SliderData } from '@esotericsoftware/spine-core';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/project-workflow.js';
import { boneDiagramLoader } from '../src/runtime.js';

const { client, timeoutMs } = await connectSpine();
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); return JSON.parse(block.text);
}
try {
  assert.equal((await client.listTools()).tools.length, TOOL_COUNT); assert.equal(client.getServerVersion()?.version, VERSION);
  const demo = await call('spine_create_demo', {}), sourceHash = await fileSha256(demo.path), image = path.join(demo.images, 'arm.png'), imageHash = await fileSha256(image);
  const preparation: Record<string, unknown>[] = [
    { type: 'add_bone', name: 'tip', parent: 'root', transform: { x: 120, length: 60 } },
    { type: 'add_bone', name: 'slider-bone', parent: 'root', transform: { y: -40, length: 30 } },
    // Deliberately put the desired slider animation before earlier names.
    { type: 'set_timeline', animation: 'z-pose', bone: 'slider-bone', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 60 }] },
    { type: 'set_timeline', animation: 'a-idle', bone: 'arm', channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 0.5, value: 30 }, { time: 1, value: 0 }] },
    { type: 'set_timeline', animation: '10', bone: 'slider-bone', channel: 'translate', keyframes: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 1, y: 2 }] },
    { type: 'set_timeline', animation: '2', bone: 'slider-bone', channel: 'translate', keyframes: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 2, y: 1 }] },
    { type: 'set_timeline', animation: '中文/姿态', bone: 'slider-bone', channel: 'translate', keyframes: [{ time: 0, x: 0, y: 0 }, { time: 1, x: 4, y: 6 }] },
    { type: 'set_constraint', definition: { type: 'slider', name: 'pose-slider', animation: 'z-pose', time: 0.5 } },
    { type: 'set_constraint', definition: { type: 'slider', name: 'chinese-slider', animation: '中文/姿态', time: 0.25 } },
    { type: 'add_slot', name: 'overlay', bone: 'arm' },
    { type: 'attach_image', skin: 'default', slot: 'overlay', name: 'overlay', image, transform: { x: 60, color: '669ee6bb' }, setAsSetup: true },
    { type: 'add_slot', name: 'outside-group', bone: 'root' },
  ];
  const prepared = await call('spine_apply_edits', { input: demo.path, output: path.join(demo.directory, 'prepared.json'), edits: preparation });
  const mesh = await call('spine_mesh_from_region', { input: prepared.path, output: path.join(demo.directory, 'mesh.json'), skin: 'default', slot: 'arm-slot', name: 'arm', columns: 4, rows: 2 });
  const weighted = await call('spine_auto_weights', { input: mesh.path, output: path.join(demo.directory, 'weighted.json'), skin: 'default', slot: 'arm-slot', name: 'arm', bones: ['tip', 'arm'], influences: 2, power: 2 });
  const folder = await call('spine_set_folder_draw_order', { input: weighted.path, output: path.join(demo.directory, 'folders.json'), animation: 'a-idle', folders: [{ slots: ['overlay', 'arm-slot'], keyframes: [{ time: 0, order: null }, { time: 0.5, order: ['overlay', 'arm-slot'] }, { time: 1, order: null }] }] });
  const flattened = await call('spine_flatten_draw_order', { input: folder.path, output: path.join(demo.directory, 'global.json') });
  const preview = await call('spine_render_artwork', { input: folder.path, animation: 'a-idle', times: [0, 0.25, 0.5, 0.75, 1] });
  const flatPreview = await call('spine_render_artwork', { input: flattened.path, animation: 'a-idle', times: [0, 0.25, 0.5, 0.75, 1] });
  assert.deepEqual(preview.frames, flatPreview.frames);
  const groupedJson = JSON.parse(await readFile(folder.path, 'utf8'));
  assert.equal(groupedJson.skins[0].attachments['arm-slot'].arm.uvs.length / 2, 15);
  assert.ok(groupedJson.animations['a-idle'].drawOrderFolder); assert.equal(JSON.parse(await readFile(flattened.path, 'utf8')).animations['a-idle'].drawOrderFolder, undefined);
  console.log('Registered mesh generation, automatic binding and folder compilation passed. Checking native project import...');
  const imported = await call('spine_import', { input: folder.path, output: path.join(demo.directory, 'Slider修复与自动绑定.spine'), skeletonName: 'rigging' });
  assert.equal(imported.sliderVerification.checked, 2); assert.equal(imported.folderDrawOrderCompiled, true);
  const inspected = await call('spine_inspect', { input: imported.path });
  const actual = JSON.parse(await readFile(inspected.workingJson, 'utf8'));
  assert.equal(actual.constraints.find((item: any) => item.name === 'pose-slider').animation, 'z-pose');
  assert.equal(actual.constraints.find((item: any) => item.name === 'chinese-slider').animation, '中文/姿态');
  const project = await call('spine_edit_project', { input: folder.path, output: path.join(demo.directory, '完整核对.spine'), skeletonName: 'rigging', edits: [{ type: 'set_bone', bone: 'tip', transform: { length: 70 } }] });
  assert.equal(project.verification.passed, true); assert.equal(project.verification.folderDrawOrderNormalization.editorFolderStructurePreserved, false);
  const binary = await call('spine_export', { input: project.output, format: 'binary' });
  const runtime = new SkeletonBinary(boneDiagramLoader).readSkeletonData(await readFile(binary.files.find((file: string) => file.endsWith('.skel'))));
  assert.deepEqual(runtime.constraints.filter(item => item instanceof SliderData).map(item => [(item as SliderData).name, (item as SliderData).animation.name]), [['pose-slider', 'z-pose'], ['chinese-slider', '中文/姿态']]);
  console.log('Slider names, numeric/folder animation names and binary export passed. Checking all skeletons in a rebuild...');
  const multi = await call('spine_build_project', { entries: [{ input: folder.path, name: 'rig' }, { input: demo.path, name: 'untouched' }], output: path.join(demo.directory, 'multi.spine') });
  const multiEdited = await call('spine_edit_multi_project', { input: multi.output, output: path.join(demo.directory, 'multi-renamed.spine'), changes: [{ name: 'rig', edits: [{ type: 'rename_animation', animation: 'z-pose', newName: '动作/renamed-pose' }] }] });
  assert.equal(multiEdited.checks.length, 2);
  const originalProjectHash = await fileSha256(project.output);
  const job = await call('spine_start_job', { operation: 'edit_project', args: { input: project.output, output: path.join(demo.directory, 'background-renamed.spine'), edits: [{ type: 'rename_animation', animation: 'z-pose', newName: 'zz-background' }] } });
  console.log('Background verified edit queued. Closing the MCP connection...');
  await client.close(); const reopened = await connectSpine(); let completed: any;
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await reopened.client.callTool({ name: 'spine_get_job', arguments: { id: job.id, includeResult: true } });
      const block = result.content.find(item => item.type === 'text'); assert.ok(block && block.type === 'text'); completed = JSON.parse(block.text);
      if (['succeeded', 'failed', 'cancelled'].includes(completed.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(completed.state, 'succeeded', JSON.stringify(completed)); assert.equal(completed.result.verification.passed, true);
  } finally { await reopened.client.close(); }
  assert.equal(await fileSha256(demo.path), sourceHash); assert.equal(await fileSha256(image), imageHash); assert.equal(await fileSha256(project.output), originalProjectHash);
  const report = { passed: true, server: 'spine43', version: VERSION, tools: TOOL_COUNT, source: demo.path, sourceHash, image, imageHash, originalUnchanged: true, imageUnchanged: true, regionGridVertices: 15, automaticWeightsVerified: true, folderRuntimeMatchesCompiled: true, canonicalSliderImportVerified: true, numericAndChineseAnimationNamesVerified: true, binarySliderReferencesVerified: true, imported, project, multi, multiEdited, job: completed, workerSurvivedMcpDisconnect: true, preview, flatPreview };
  const reportPath = path.join(projectRoot, 'work/rigging-report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, project: project.output, multiProject: multiEdited.output, preview: preview.path, sliderFixed: true, workerSurvivedMcpDisconnect: true }, null, 2));
} finally { await client.close(); }
