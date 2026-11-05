import type { SpineService } from './service.js';
import { resolveLauncher } from './launcher-discovery.js';

export async function checkEnvironment(service: SpineService, probeCli = false) {
  const [cli, editor] = await Promise.all([resolveLauncher(service.config, 'cli'), resolveLauncher(service.config, 'gui')]);
  const probe = probeCli ? await service.cli.probe() : undefined;
  return {
    targetVersion: service.config.targetVersion, cli: { ...cli, ...(probe ? { probed: true, available: probe.available, reportedVersion: 'editorVersion' in probe ? probe.editorVersion : undefined, reason: probe.reason } : { probed: false, available: null }) }, editor,
    readiness: { jsonTools: true, nativeBuildEntryFound: Boolean(cli.executable), nativeBuildProbed: probe?.available ?? null, editorOpenEntryFound: Boolean(editor.executable) },
    recommendations: [
      ...(!cli.executable ? ['Configure cliExecutable as a persistent standard installed Spine CLI. If this installation extracts a temporary runtime, start its installed editor and check again.'] : []),
      ...(cli.temporary || editor.temporary ? ['The current entrypoint is temporary. It is rescanned for each call; a stable installed launcher avoids dependence on temporary extraction folders.'] : []),
    ],
    editorControl: { savedProjectCreateAndOpen: true, openingMayActivateWindow: true, nativeLoadReceipt: false, unsavedMemory: false, nativePlayPauseSeek: false, nativeAnimationSelection: false, editableRigHotReload: false,
      feasibility: 'No supported in-process editor bridge has been verified. The official FAQ currently documents no editor plugin system; the published CLI describes saved-file import/export and project opening, not unsaved-memory access, editable-rig hot reload or native timeline control. File and window observations do not prove these controls. A supported editor IPC/API is required for a future bridge.',
      researchedAt: '2026-10-24', researchResult: 'no_supported_bridge_found',
      alternatives: { savedFileEditing: true, nativeProjectOpening: true, dedicatedPreviewImageWatch: true, nativePreloadedSequence: true, editableRigHotReload: false },
      references: ['https://en.esotericsoftware.com/support', 'https://en.esotericsoftware.com/spine-command-line-interface', 'https://esotericsoftware.com/spine-settings', 'https://esotericsoftware.com/spine-images'] },
    automaticChanges: { launcherFiles: false, activation: false, editorSettings: false, inputSimulation: false },
  };
}
