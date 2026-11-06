import path from 'node:path';
import { inspectWeights } from './weight-edits.js';
import { inspectMesh, type MeshPage } from './mesh-edits.js';
import { inspectTimelines } from './timeline-tools.js';
import type { AttachmentRef } from './attachment-reuse.js';
import { traceRegion, type AlphaOptions } from './alpha-geometry.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Config } from './config.js';
import { Workspace } from './config.js';
import { SpineCli } from './cli.js';
import { createDemo } from './demo.js';
import { renderPreview } from './preview.js';
import { editProject } from './project-workflow.js';
import { applyEdits, type ProjectEdit } from './edits.js';
import { renderArtwork } from './artwork-preview.js';
import { VERSION, TOOL_COUNT } from './version.js';
import type { PreviewOptions } from './runtime.js';
import { exportFrames, type FrameOptions } from './frames.js';
import { buildProject, editMultiProject, type SkeletonInput } from './multi-project.js';
import { BackgroundJobs } from './jobs.js';
import { SavedProjectSync } from './saved-sync.js';
import { NativePreviews } from './native-preview.js';
import { EditorProjects } from './editor.js';
import { NativeEditorBridge } from './native-editor-bridge.js';
import { editorOpenOptions } from './editor-project.js';
import { ProjectSessions } from './project-session.js';
import { createProject, createProjectOptions, type CreateProjectOptions } from './editor-project.js';
import { checkpoint, type WorkControl } from './progress.js';
import { auditAssets, assertSnapshot, snapshotEditSources } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { exportMedia, type MediaOptions } from './media.js';
import { addAnimation, addBone, loopCheck, readDocument, setBone, setTimeline, summarize, writeDocument, type Channel, type Keyframe, type Transform } from './document.js';

export class SpineService {
  readonly workspace: Workspace;
  readonly cli: SpineCli;
  readonly jobs: BackgroundJobs;
  readonly savedSync: SavedProjectSync;
  readonly nativePreviews: NativePreviews;
  readonly editorProjects: EditorProjects;
  readonly nativeEditor: NativeEditorBridge;
  readonly projectSessions: ProjectSessions;
  constructor(readonly config: Config) {
    this.workspace = new Workspace(config.workspaceRoot);
    this.cli = new SpineCli(config, this.workspace);
    this.jobs = new BackgroundJobs(this.workspace, config);
    this.savedSync = new SavedProjectSync(this.workspace, config);
    this.nativePreviews = new NativePreviews(this);
    this.editorProjects = new EditorProjects(this.workspace, config);
    this.nativeEditor = new NativeEditorBridge(this.workspace, this.editorProjects);
    this.projectSessions = new ProjectSessions(this);
  }
  async doctor(probe = false) {
    const resolvedEditor = await this.editorProjects.resolveExecutable().catch(() => null);
    const exists = async (file: string | null) => {
      if (!file) return false;
      try { await access(file, constants.F_OK); return true; } catch { return false; }
    };
    return {
      serverVersion: VERSION, targetVersion: this.config.targetVersion, tools: TOOL_COUNT,
      nativeEditorBridge: { implemented:true, startupRequired:true, supportedVersion:'4.3.23', fixedBuildSha256:'4a1f51fa672fcffe251e10de6bb9399b0aec6564da0161f0a48aafa45681eaf8', officialPluginApi:false, actualProjectPath:true, nativeDirtyState:true, editableProjectReload:true, nativeTimelineControl:true, nativeTimelineControlPreservesUndo:true, incrementalModelEdits:false, guardedRecoverySnapshots:true, nativeViewRestoration:true, persistedAuthenticatedReceipts:true, ordinaryExistingInstancesSupported:false, inputInjection:false, bytecodeTransformation:false, reloadRequestsFocus:false, startupMayActivateWindow:true },
      projectSessions: { implemented: true, savedFilesOnly: true, explicitSessionId: true, persistentHistory: true, sourceAndResourceDriftDetection: true, revisionGuardedMutations: true, idempotentReceipts: true, restoreToNewFile: true, archivedResourceRestore: true, multiSkeletonRestore: true, nativePreviewBinding: true, nativeEditorMemoryRead: false, editorOnlyMetadataRestoreProven: false },
      liveRooms: { configured: Boolean(this.config.nativeRenderer), gpuNv12Readback: true, hardwareEncoderProbe: true, audioMixing: true, boundedRoomScheduler: true, multiGpuIsolation: 'explicit_container_gpu_uuid', linuxGpuAcceptance: 'requires_target_hardware' },
      characterAssistance: { proceduralLiveIkMotionPack: true, attackAndHitRecipes: true, reusableCharacterBuildRecipes: true, completeCharacterBuildBlueprints: true, resumablePsdRigControlsMotions: true, runtimeInverseContactSolving: true, fkIkTransitionContact: true, psdBitmapMaskClippingAndMerge: true, dependencyAwareTaskBranches: true, unifiedRasterLandmarkTaskReviews: true, coupledMultiMeshRepair: true, geometricSeamProposals: true, exactReviewedSeamSelection: true, timeVertexLocalizedMeshDiagnostics: true, isolatedSkinLinkedMeshRepair: true, explicitSampledPhysicsJointRepair: true, explicitTaskVersionMigration: ['2.16.0', '2.17.0', '2.18.0', '2.19.0', '2.20.0'], liveIkSoleOrientationAndPivots: true, psdGroupedRasterImport: true, psdImportBackgroundJobs: true, persistentCharacterTasks: true, externalAssetPauseAndResume: true, exactCandidateReviewGate: true, liveIkTargetRepair: true, boundsRectangleAlignment: true, layerAlphaAndSeamAudit: true, explicitWorldLandmarks: true, geometryBasedRigSuggestions: true, calibratedLandmarkReviews: true, immutableLandmarkCorrections: true, boundedMeshDeformRepair: true, independentPsdRasterProof: true, psdRasterRuntime: 'psd-tools_1.26.0_local_optional_setup', reviewedPreparationRecipes: true, layerGenerationHandoff: true, protectedPixelAndRepaintMaskAudit: true, exactMaskedRepaintComposition: true, canvasAndAnchorAlignment: true, singleVersionBatchImageReplacement: true, constrainedLocalRotationRepair: 'explicit_bake', constrainedRepairWorldPoseVerification: true, portableLayerImport: true, sourcePinnedImageReplacement: true, linkedUvPropagationGuard: true, reviewedAnimationRepairCandidates: true, sharedCameraComparisonVideo: true, explicitCandidatePromotion: true, anatomyInference: false, automaticImageInpainting: false },
      extensions: { genericBox2dBake:true, explicitRailContactAudit:true, uniformViewSyncAudit:true, pinnedPixelBaselines:true, explicitMultiBoneContact:true, runtimeCrossfadeAndPropHandoff:true, psdSectionRGB16To8BitOptIn:true, psbSectionOptIn:true, officialRuntime42SubsetExport:true, engineAdapterGeneration:['javascript','unity','cocos'], engineEditorsVerified:false, detachedBoundedNativeAcceptance:true, native24HourAcceptance:'requires_elapsed_target_run' },
      workspaceRoot: this.config.workspaceRoot,
      profile: { id: 'spine-4.3.23', node: process.version, previewRuntime: '4.3.13', configSchemaVersion: this.config.schemaVersion ?? 1 },
      production: { editPreflightAndDiff: true, assetAuditRelinkAndCollection: true, granularKeyframeEditing: true, rangePasteAndBoundaryKeys: true, crossProjectAnimationAndRigTransfer: true, skinComposition: true, alphaContourHolesAndIslands: 'native compound meshes; single-mesh JSON available', vertexUvAndLocalTriangleEditing: true, nearestVertexWeightTransferAndMirror: true, surfaceWeightTransfer: true, uvRetopologyDeformInterpolation: true, nativeClippingCompatibilityDiagnosis: true, uvTriangleIntersectionChecks: true, sampledWorldLoopAndVelocityChecks: true, sampledErrorBoundedKeyReduction: true, selectiveConstraintBaking: true, configuredAtlasPackAndUnpack: true, verifiedPortableDelivery: true, checkpointedWorkflowDependencies: true, failedJobRetry: true, resourceSnapshotGuards: true },
      advanced: { savedProjectResourceSynchronization: true, savedSyncDetachedWorkers: true, savedSyncCommitRecovery: true, automaticMotionRetargeting: true, worldReflectionAndSideExchange: true, overlappingMaskedLayers: true, fullInteractingConstraintBaking: true, adaptiveAnimationValidationAndReduction: true, repeatedPhysicsCycles: true, cpuMediaExport: ['apng', 'gif', 'mp4', 'spritesheet'], mediaNeedsLocalFfmpegAndFfprobe: true, byteExactOriginalArchive: true, sampledClippingVisualFallback: true, nativeConcaveImporterFixed: false },
      capabilities: { jsonInspection: true, boneEditing: true, animationEditing: true, slotEditing: true, skinCopying: true, pngAttachments: true, slotAttachmentAndColorTimelines: true, eventEditing: true, globalDrawOrderEditing: true, animationRetiming: true, animationRenaming: true, selectiveTimelineRemoval: true, timelineInventory: true, selectiveTimelineCopyAndMapping: true, keyframeRangeRetiming: true, batchJsonEditing: true, structureRenameDeleteReparent: true, constraints: ['ik', 'transform', 'path', 'physics', 'slider'], meshWeightsAndDeform: true, regionGridGeneration: true, meshTopologyInspection: true, selectedMeshVertexTransforms: true, weightedMeshSubdivisionWithDeform: true, pngAlphaConvexHullInspection: true, alphaHullMeshGeneration: true, alphaHullBoundingBoxesAndClipping: true, distanceBasedAutoWeights: true, weightInspectionCleanupAndSmoothing: true, typedConstraintIdentity: true, weightedImportOrderAndDeformRemapping: true, binaryGeometryPrecisionReadback: true, binaryBoneTimelinePrecisionReadback: true, folderDrawOrderEditing: true, folderDrawOrderCompilation: true, canonicalSliderImport: true, linkedMeshes: true, attachmentCopyAcrossSlotsAndSkins: true, linkedMeshCreationAndIndependence: true, effectiveAttachmentTimelineCopy: true, clippingAndSequences: true, commonBlendModesAndTwoColorTint: true, animationCropMergeLocalMirror: true, isolatedBoneBaking: true, optionalPhysicsPreview: true, continuousPngFramesAndOfflinePlayer: true, verifiedMultiSkeletonProjects: true, batchFileProcessing: true, persistentBackgroundQueue: true, jobProgressCancellationAndRecovery: true, headlessBonePreview: true, headlessPngArtworkPreview: true, verifiedProjectEditing: true, liveUnsavedProjectAccess: false, editorUiAutomation: false, projectImportExportRequiresWorkingCli: true },
      limits: { savedFilesOnly: true, timelineEditing: 'Local timeline editing plus rest-relative world motion retargeting through matched ancestors; explicit planted contact baking for uniform-scale direct two-bone chains is available; constraintMode=bake first captures interacting constraints only in the new animation, without contact/anatomy inference. Source attachments/events are not retargeted. Boundary-key synthesis has runtime and mathematical-curve modes; runtime mode may add supporting keys and raises output editor FPS to at least 240 to avoid native frame snapping. Seconds and playback duration stay unchanged. Flatten folder draw order first.', meshEditing: 'Source mesh only; shared geometry edits affect every link. Transforms use setup slot-local coordinates. Uniform 1–3 subdivisions require a single complete hull and change vertex indices. Midpoints cannot exceed 16 influences; max 10,000 vertices and 5,000,000 deform coordinates. Use spine_check_mesh_intersections for bounded UV-space intersection checks.', attachmentReuse: 'Copy preserves setup geometry only; cross-bone regions may become meshes. Links share geometry and can retain local placement. Effective sequence copying requires matching animated counts.', binaryGeometryReadback: 'Vertex positions, weights, deformation and ten numeric bone timeline channels are supplemented from a matching binary export. Bone/channel/frame/time identities and rounding bounds are checked; JSON curves remain unchanged.', alphaTracing: 'Static PNG regions: convex hull tools remain available; exact contour tools preserve concavities, holes and islands as native compound mesh pieces. Max 16 megapixels and 10000 exact contour vertices. Single-mesh holes/islands are runtime-only JSON.', backgroundQueueLocalOnly: true, frameExportMaxFrames: 300, bakeMaxBoneSamples: 200000, globallyUniqueConstraintNames: false, constraintNamesScopedByType: true, weightSmoothingMaxInfluenceVisits: 5000000, meshTriangleVerification: 'Oriented topology is checked; reordered faces are reported and self-overlap ordering requires visual review.', folderImportRepresentation: 'Folder groups are compiled to equivalent global keys; editor folder structure is not preserved.', sliderImport: 'Slider imports are serialized in the editor-provided animation order and references are re-exported and checked before publication.' },
      stability: { nativeConstantCurveValueBound: 'Bezier convex hull, at most 2e-5 relative per component; nonconstant curves remain strict', queuedLauncherRediscovery: true, publishAndOpen: true, persistentPublicationStages: true, characterPreparationRecipes: true, sparsePoseAnimationRecipes: true, explicitFootContactBaking: true, animationDiagnostics: true, diagnosticPhysicsSampling: true, centroidClippingAndOcclusionClassification: true, idempotentJobRecovery: true, scopedAnimationVisualReviews: true, reusableCharacterTemplates: true, constrainedFootContactBaking: true, pixelCoverageDiagnostics: true, incrementalSequenceFrames: true, longSequenceFrameLimit: 600, revisionBoundVisualReviews: true, regressionSuites: true, exactRevisionQualityWaivers: true, guardedSessionV2Migration: true, segmentedIdempotencyReceipts: true, animatedJointSeamSampling: true, reversibleOrphanArchiveCleanup: true, nativeUnsavedMemoryAccess: false, nativeTimelineControl: true },
      cli: probe ? await this.cli.probe() : { configured: Boolean(this.config.cliExecutable || this.config.cliRuntimeDiscovery), executable: await this.cli.resolveExecutable(), probed: false },
      editor: { executable: this.config.guiExecutable, exists: await exists(this.config.guiExecutable), resolvedLauncher: resolvedEditor, projectCreation: true, projectOpening: true, projectOpenConfigured: Boolean(resolvedEditor), projectOpenStatus: true, projectOpenDefaultNewInstance: true, projectOpenMayActivateWindow: true, projectLoadReceiptAvailable: false, nativeTexturePreview: true, nativeTexturePreviewNeedsOneTimeProjectOpen: true, nativeTexturePreviewMode: 'static or cached animated artwork in a dedicated Spine project', nativeTexturePreviewResume: true, nativeTexturePreviewSupervision: true, nativeTexturePreviewPlayback: true, nativeSequencePreview: true, nativeSinglePngContinuousQualityAccepted: false, nativeTexturePreviewPlaybackMaxFps: 24, automaticEditableProjectReload: false, displayAcknowledgementAvailable: false },
    };
  }
  async load(input: string, skeletonName?: string) {
    const filename = await this.workspace.resolve(input);
    if (path.extname(filename).toLowerCase() === '.json') return { data: await readDocument(filename), jsonPath: filename };
    if (path.extname(filename).toLowerCase() !== '.spine') throw new Error('Input must be Spine .json or .spine.');
    const exported = await this.cli.exportData(filename);
    const files = exported.files.filter(file => file.endsWith('.json'));
    const selected = skeletonName ? files.find(file => path.basename(file, '.json') === skeletonName) : files.length === 1 ? files[0] : undefined;
    if (!selected) throw new Error(`Choose skeletonName from: ${files.map(file => path.basename(file, '.json')).join(', ')}`);
    const data = await readDocument(selected);
    await this.nativePreviews.follow([filename], selected, true);
    return { data, jsonPath: selected };
  }
  async inspect(input: string, skeletonName?: string) {
    const { data, jsonPath } = await this.load(input, skeletonName);
    return { source: input, workingJson: jsonPath, ...summarize(data) };
  }
  async exportData(input: string, format: 'json' | 'binary') {
    const result = await this.cli.exportData(input, format), json = result.files.filter(file => file.endsWith('.json'));
    if (json.length === 1) await this.nativePreviews.follow([input], json[0]!, true);
    return result;
  }
  async validate(input: string) {
    const { data, jsonPath } = await this.load(input);
    return { valid: true, workingJson: jsonPath, version: data.skeleton.spine, checks: ['version', 'bone order and references', 'slot and skin references', 'setup and animated attachment references', 'bone and slot keyframe times', 'slot colors and supported RGBA curves', 'event definitions, payloads and references', 'global/folder draw-order times and permutations', 'ordered constraint references and supported parameter keys/curves', 'mesh UVs, triangles, vertex/weight layouts, linked sources, deform and sequence bounds'], warning: 'Structural validation covers the listed fields. Editor-only information and final visual appearance require separate review.' };
  }
  async animation(input: string, name: string) {
    const { data, jsonPath } = await this.load(input);
    if (!data.animations || !Object.hasOwn(data.animations, name)) throw new Error(`Animation not found: ${name}`);
    const result = { workingJson: jsonPath, name, animation: data.animations[name] };
    if (JSON.stringify(result).length > 1_000_000) throw new Error('Animation exceeds the response size limit. Inspect the local JSON file.');
    return result;
  }
  async inspectWeights(input: string, skin: string, slot: string, name: string, offset: number, limit: number) {
    const { data, jsonPath } = await this.load(input);
    return { workingJson: jsonPath, ...inspectWeights(data, skin, slot, name, offset, limit) };
  }
  async inspectMesh(input: string, ref: AttachmentRef, page: MeshPage) {
    const { data, jsonPath } = await this.load(input);
    return { workingJson: jsonPath, ...inspectMesh(data, ref, page) };
  }
  async inspectTimelines(input: string, animation: string, offset: number, limit: number) {
    const { data, jsonPath } = await this.load(input);
    return { workingJson: jsonPath, ...inspectTimelines(data, animation, offset, limit) };
  }
  async traceRegion(input: string, skin: string, slot: string, name: string, options: AlphaOptions) {
    const { data, jsonPath } = await this.load(input);
    return { workingJson: jsonPath, ...await traceRegion(this.workspace, data, jsonPath, skin, slot, name, options) };
  }
  async editBone(input: string, output: string, bone: string, transform: Transform) {
    const { data, jsonPath } = await this.load(input);
    return this.afterPublish(input, output, { ...await writeDocument(this.workspace, output, setBone(data, bone, transform), path.dirname(jsonPath)), changedBone: bone });
  }
  async addBone(input: string, output: string, name: string, parent: string, transform: Transform) {
    const { data, jsonPath } = await this.load(input);
    return this.afterPublish(input, output, { ...await writeDocument(this.workspace, output, addBone(data, name, parent, transform), path.dirname(jsonPath)), addedBone: name });
  }
  async addAnimation(input: string, output: string, name: string, source?: string) {
    const { data, jsonPath } = await this.load(input);
    return this.afterPublish(input, output, { ...await writeDocument(this.workspace, output, addAnimation(data, name, source), path.dirname(jsonPath)), addedAnimation: name });
  }
  async timeline(input: string, output: string, animation: string, bone: string, channel: Channel, keys: Keyframe[]) {
    const { data, jsonPath } = await this.load(input);
    return this.afterPublish(input, output, { ...await writeDocument(this.workspace, output, setTimeline(data, animation, bone, channel, keys), path.dirname(jsonPath)), animation, bone, channel, keyframeCount: keys.length });
  }
  async loop(input: string, animation: string) { const { data } = await this.load(input); return loopCheck(data, animation); }
  async handoff(input: string) {
    const filename = await this.workspace.resolve(input);
    if (path.extname(filename).toLowerCase() === '.json') await readDocument(filename);
    else if (path.extname(filename).toLowerCase() !== '.spine') throw new Error('Expected .json or .spine.');
    return {
      path: filename,
      kind: filename.endsWith('.spine') ? 'project' : 'skeleton-json',
      action: filename.endsWith('.spine') ? 'Open Project' : 'Import Data',
      instructions: filename.endsWith('.spine') ? 'Use Spine > Open Project. Save any current changes first.' : 'Use Spine > Import Data, choose this JSON, select New project, import, then save as a NEW .spine file next to the JSON. Check the Images path if artwork is missing.',
      automaticallyOpened: false,
    };
  }
  async createDemo() { return createDemo(this.workspace); }
  async openProject(input: string, raw: import('zod/v4').z.input<typeof editorOpenOptions> = {}) {
    const options=editorOpenOptions.parse(raw);
    if(options.requestId){const other=await this.workspace.resolve(options.nativeBridge?path.join('.editor-opens',options.requestId+'.json'):path.join('.editor-bridges',options.requestId,'instance.json'),false);let found=false;try{await access(other);found=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(found)throw new Error('requestId belongs to the other nativeBridge mode; query the existing request instead of launching again.');}
    if(options.nativeBridge)return this.nativeEditor.open(input,{requestId:options.requestId,waitMs:options.waitMs,reuseInstance:options.reuseInstance});
    return this.editorProjects.open(input,options);
  }
  async getEditorOpenStatus(id:string,waitMs=0){
    try{return await this.editorProjects.get(id,waitMs);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const native=await this.nativeEditor.state(id,waitMs) as import('./native-editor-bridge.js').NativeReply;
    return{id,instanceId:id,native,projectLoadedVerified:native.ok===true&&!!native.status?.projectPath,editorUnsavedStateAvailable:native.ok===true};
  }
  async createProject(raw: CreateProjectOptions) {
    const args = createProjectOptions.parse(raw), project = await createProject(this.workspace, this.cli, args);
    if (!args.openInEditor) return { ...project, editorOpen: { requested: false } };
    try { return { ...project, editorOpen: { requested: true, ...await this.openProject(project.path, args.openOptions) } }; }
    catch (error) { return { ...project, editorOpen: { requested: true, launchAccepted: false, projectLoadedVerified: false, error: (error as Error).message, note: 'The created project is retained. Correct the launcher configuration and call spine_open_project with this project path.' } }; }
  }
  async editProject(input: string, output: string, edits: ProjectEdit[], skeletonName?: string, control?: WorkControl) {
    return this.afterPublish(input, output, await editProject(this.workspace, this.cli, input, output, edits, skeletonName, control));
  }
  async buildProject(entries: SkeletonInput[], output: string, control?: WorkControl) { return this.afterPublish(entries.map(entry => entry.input), output, await buildProject(this.workspace, this.cli, entries, output, control)); }
  async editMultiProject(input: string, output: string, changes: { name: string; edits: ProjectEdit[] }[], control?: WorkControl) { return this.afterPublish(input, output, await editMultiProject(this.workspace, this.cli, input, output, changes, control)); }
  async afterPublish<T extends object>(inputs: string | string[], output: string, result: T): Promise<T & { nativePreview?: Awaited<ReturnType<NativePreviews['follow']>> }> {
    const notification = await this.nativePreviews.follow(typeof inputs === 'string' ? [inputs] : inputs, output);
    return notification.sessions.length || notification.errors.length ? { ...result, nativePreview: notification } : result;
  }
  async exportFrames(input: string, options: FrameOptions, skeletonName?: string, control?: WorkControl) {
    const { data, jsonPath } = await this.load(input, skeletonName); return exportFrames(this.workspace, data, jsonPath, options, control);
  }
  async exportMedia(input: string, options: MediaOptions, skeletonName?: string, control?: WorkControl) { return exportMedia(this, input, options, skeletonName, control); }
  async batch(args: { inputs: string[]; action: 'inspect' | 'validate' | 'export'; format?: 'json' | 'binary'; stopOnError?: boolean }, control?: WorkControl) {
    if (!args.inputs.length || args.inputs.length > 100) throw new Error('Batch requires 1–100 input paths.');
    const results: { input: string; success: boolean; skeletons?: unknown[]; result?: unknown; error?: string }[] = [];
    for (let index = 0; index < args.inputs.length; index++) {
      const input = args.inputs[index]!; await checkpoint(control, { phase: args.action, completed: index, total: args.inputs.length, detail: input });
      try {
        if (args.action === 'export') results.push({ input, success: true, result: await this.cli.exportData(input, args.format) });
        else {
          const filename = await this.workspace.resolve(input), files = path.extname(filename).toLowerCase() === '.spine' ? (await this.cli.exportData(filename)).files.filter(file => file.toLowerCase().endsWith('.json')) : [filename];
          const skeletons = [];
          for (const file of files) { const data = await readDocument(file); skeletons.push(args.action === 'inspect' ? { workingJson: file, ...summarize(data) } : { workingJson: file, valid: true, version: data.skeleton.spine }); }
          results.push({ input, success: true, skeletons });
        }
      } catch (error) { results.push({ input, success: false, error: (error as Error).message }); if (args.stopOnError) break; }
    }
    await checkpoint(control, { phase: 'complete', completed: results.length, total: args.inputs.length });
    return { results, succeeded: results.filter(item => item.success).length, failed: results.filter(item => !item.success).length, skipped: args.inputs.length - results.length };
  }
  async editFile(input: string, output: string, edits: ProjectEdit[]) {
    const filename = await this.workspace.resolve(input), sourceHash = await fileSha256(filename), dependencies = await snapshotEditSources(this.workspace, edits);
    const { data, jsonPath } = await this.load(input);
    const snapshot = await auditAssets(this.workspace, data, jsonPath, false);
    const edited = await applyEdits(data, edits, { workspace: this.workspace, jsonPath });
    const editedSnapshot = await auditAssets(this.workspace, edited, jsonPath, false);
    await assertSnapshot(snapshot);
    await assertSnapshot(editedSnapshot);
    await assertSnapshot(dependencies); if (await fileSha256(filename) !== sourceHash) throw new Error('Source changed during JSON editing.');
    return this.afterPublish(input, output, { ...await writeDocument(this.workspace, output, edited, path.dirname(jsonPath)), editCount: edits.length });
  }
  async preview(input: string, animation: string | undefined, times: number[], skin?: string, options: PreviewOptions = {}) {
    const { data } = await this.load(input);
    return renderPreview(this.workspace, data, animation, times, skin, options);
  }
  async artwork(input: string, animation: string | undefined, times: number[], skin?: string, options: PreviewOptions = {}) {
    const { data, jsonPath } = await this.load(input);
    return renderArtwork(this.workspace, data, jsonPath, animation, times, skin, options);
  }
}

