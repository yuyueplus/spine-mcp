import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

// A diagnostic, not a reload implementation. Never open, forward a file to,
// activate, terminate, or inject into an editor process to infer success.
const execFileAsync = promisify(execFile);
const config = await loadConfig(), connection = await connectSpine({ local: true });
const calls: string[] = [];
async function call(name: string, args: Record<string, unknown>) {
  calls.push(name);
  const response = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs });
  const block = response.content.find(item => item.type === 'text');
  if (response.isError || block?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`);
  return JSON.parse(block.text);
}
async function optionalJson(filename: string) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function windowsInventory() {
  if (process.platform !== 'win32') return { available: false, reason: 'Windows installation inventory only.' };
  // Only process metadata, listening socket metadata and file existence. Paths
  // are read through an environment value, never interpolated into shell code.
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$spineGuiPath = $env:SPINE_RELOAD_CHECK_GUI
$spineProcesses = @(Get-Process -Name SpinePro,Spine -ErrorAction SilentlyContinue | Where-Object { -not $spineGuiPath -or $_.Path -eq $spineGuiPath })
$spineProcessIds = @($spineProcesses | ForEach-Object { $_.Id })
$spineCandidates = @(
  [IO.Path]::Combine($env:ProgramFiles, 'Spine', 'Spine.com')
  [IO.Path]::Combine([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), 'Spine', 'Spine.com')
)
if ($spineGuiPath) { $spineCandidates += [IO.Path]::Combine([IO.Path]::GetDirectoryName($spineGuiPath), 'Spine.com') }
$spineAssociationKey = Get-Item -LiteralPath 'Registry::HKEY_CLASSES_ROOT\.spine' -ErrorAction SilentlyContinue
$spineProgId = if ($spineAssociationKey) { $spineAssociationKey.GetValue('') } else { $null }
[pscustomobject]@{
  available = $true
  processes = @($spineProcesses | ForEach-Object { [pscustomobject]@{ id = $_.Id; path = $_.Path; hasWindow = $_.MainWindowHandle -ne 0; title = $_.MainWindowTitle } })
  tcpListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $spineProcessIds } | Select-Object OwningProcess,LocalAddress,LocalPort)
  udpEndpoints = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $spineProcessIds } | Select-Object OwningProcess,LocalAddress,LocalPort)
  standardConsoleLaunchers = @($spineCandidates | ForEach-Object { [pscustomobject]@{ path = $_; exists = Test-Path -LiteralPath $_ -PathType Leaf } })
  fileAssociationProgId = $spineProgId
} | ConvertTo-Json -Depth 6 -Compress
`;
  const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024,
    env: { ...process.env, SPINE_RELOAD_CHECK_GUI: config.guiExecutable ?? '' },
  });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

try {
  const status = await call('spine_status', { probeCli: true });
  assert.equal(status.serverVersion, VERSION);
  assert.equal((await connection.client.listTools()).tools.length, TOOL_COUNT);
  assert.equal(status.cli.available, true, 'A working background CLI is required for the isolated native fixture.');
  const inventory = await windowsInventory();
  const settingsFile = path.join(os.homedir(), 'Spine', 'settings', 'editor-3.json');
  let reuseInstance: boolean | null = null;
  try {
    // Spine settings use relaxed libGDX JSON. Read one scalar, never rewrite or
    // print the full file (which may contain unrelated private preferences).
    const match = (await readFile(settingsFile, 'utf8')).match(/(?:^|[,{\s])"?reuseInstance"?\s*:\s*(true|false)\b/);
    if (match) reuseInstance = match[1] === 'true';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const pointer = await optionalJson(path.join(config.workspaceRoot, 'current-native-preview.json'));
  const visualPath = pointer?.lastVisualVerification?.reportPath ?? path.join(config.workspaceRoot, `native-preview-visual-test-${VERSION}.json`);
  const visual = await optionalJson(visualPath);
  const previewBefore = pointer ? await call('spine_get_native_preview', { id: pointer.id }) : null;
  const previewHashes = pointer ? { project: await fileSha256(pointer.project), image: await fileSha256(pointer.image) } : null;

  const demo = await call('spine_create_demo', {}), inputHash = await fileSha256(demo.path);
  const baseline = await call('spine_build_project', {
    entries: [{ input: demo.path, name: 'reload-control' }], output: path.join(demo.directory, 'reload-control.spine'),
  });
  const baselineHash = await fileSha256(baseline.output);
  const markerBone = 'mcp-reload-probe', markerSlot = 'mcp-reload-probe-slot', markerAnimation = 'mcp-reload-probe-animation';
  const edited = await call('spine_edit_project', {
    input: baseline.output, output: path.join(demo.directory, 'reload-candidate.spine'), skeletonName: 'reload-control',
    edits: [
      { type: 'add_bone', name: markerBone, parent: 'root', transform: { x: 100, y: 100, length: 80 } },
      { type: 'add_slot', name: markerSlot, bone: markerBone },
      { type: 'add_animation', name: markerAnimation },
      { type: 'set_timeline', animation: markerAnimation, bone: markerBone, channel: 'rotate', keyframes: [{ time: 0, value: 0 }, { time: 1, value: 45 }] },
    ],
  });
  const inspected = await call('spine_inspect', { input: edited.output });
  const actual = JSON.parse(await readFile(inspected.workingJson, 'utf8'));
  assert.ok(actual.bones.some((bone: any) => bone.name === markerBone && bone.parent === 'root' && bone.length === 80));
  assert.ok(actual.slots.some((slot: any) => slot.name === markerSlot && slot.bone === markerBone));
  const frames = actual.animations[markerAnimation]?.bones?.[markerBone]?.rotate;
  assert.equal(frames?.length, 2);
  assert.equal(frames[0].time ?? 0, 0); assert.equal(frames[0].value ?? 0, 0);
  assert.equal(frames[1].time, 1); assert.equal(frames[1].value, 45);
  assert.equal(await fileSha256(demo.path), inputHash);
  assert.equal(await fileSha256(baseline.output), baselineHash);

  const previewAfter = pointer ? await call('spine_get_native_preview', { id: pointer.id }) : null;
  if (pointer && previewHashes) {
    assert.equal(await fileSha256(pointer.project), previewHashes.project);
    assert.equal(await fileSha256(pointer.image), previewHashes.image);
  }
  const report = {
    version: VERSION, checkedAt: new Date().toISOString(), investigationCompleted: true,
    editableProjectHotReloadImplemented: false, editableProjectHotReloadVerified: false,
    conclusion: 'No supported route was established on this installation that reloads an editable project while preserving unsaved state, focus, animation/time and viewport.',
    cli: { executable: status.cli.executable, available: status.cli.available, editorVersion: status.cli.editorVersion, fullHelpReturned: /--input|--export/.test(status.cli.stdout ?? '') },
    installation: inventory, settings: { file: settingsFile, reuseInstance, changed: false },
    diskRoundTrip: { passed: true, baseline: baseline.output, candidate: edited.output, readback: inspected.workingJson, markerBone, markerSlot, markerAnimation, rotationKeyframes: frames, inputsUnchanged: true, editorMemoryRead: false },
    nativeOpenForwardingProbe: { performed: false, reason: 'No verified target-instance, dirty-state guard, no-focus option or live-state receipt was found. Opening/forwarding a file can activate a window or trigger a save prompt. A successful CLI export is not a GUI reload test.' },
    requirements: [
      { requirement: 'Target the intended editor instance', verified: false },
      { requirement: 'Force re-read of an already-open project', verified: false },
      { requirement: 'Preserve or reject unsaved edits without prompting', verified: false },
      { requirement: 'Preserve focus, animation/time and viewport', verified: false },
      { requirement: 'Observe changed bones, slots and keys in editor memory', verified: false },
    ],
    evidenceLimits: ['No TCP/UDP endpoint does not exclude named pipes or other IPC.', 'No standard launcher at inspected locations does not prove none exists elsewhere.', 'Reuse instance is a project-open setting, not a documented transactional reload API.', 'Unverified is not a proof that every possible undocumented route is impossible.'],
    existingPreview: { id: pointer?.id ?? null, beforeState: previewBefore?.state ?? null, afterState: previewAfter?.state ?? null, hashesUnchanged: Boolean(previewHashes), manualAutomaticRefreshPassed: visual?.passed === true && visual?.automaticNativeRefreshUserConfirmed === true, manualVerificationReport: visual ? visualPath : null, mode: 'sampled-static-artwork-in-dedicated-native-project', programmaticDisplayReceipt: false },
    sources: [
      { url: 'https://en.esotericsoftware.com/spine-command-line-interface', finding: 'Saved-file batch operations and positional project opening; no documented safe running-project reload transaction.' },
      { url: 'https://en.esotericsoftware.com/spine-settings', finding: 'Reuse instance routes OS-opened files to an existing instance.' },
      { url: 'https://esotericsoftware.com/forum/d/29562-spine-cli--mcp-automation-and-json-round-trip', finding: 'Official support describes data-level JSON export/edit/import, not an editor-internal structural automation interface.' },
    ],
    guiLaunchOrFileForwardingUsed: false, inputAutomationUsed: false, calls,
  };
  const reportPath = path.join(config.workspaceRoot, `native-reload-check-${VERSION}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ investigationCompleted: true, diskRoundTripPassed: true, editableProjectHotReloadVerified: false, previewUnchanged: report.existingPreview.hashesUnchanged, reportPath, candidate: edited.output }, null, 2));
} finally { await connection.client.close(); }
