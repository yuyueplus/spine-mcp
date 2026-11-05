import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import type { Workspace } from './config.js';
import { atomicJson, exists } from './jobs.js';
import { processAlive, syncLease } from './sync-lock.js';
import { sampleArtwork, renderArtwork } from './scene-preview.js';
import { fileSha256 } from './file-hash.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { readDocument } from './document.js';
import { replaceFile } from './file-replace.js';
import { NativePlaybackRunner, nativePlaybackControl, playbackPlan, type PlaybackRequest, type PlaybackStatus } from './native-playback.js';
import { NativeSequenceRenderer, SequenceSuperseded, nativeSequenceRange, nativeSequenceDocument, sequenceLayout, type NativeSequenceLayout, type NativeSequenceStatus } from './native-sequence.js';
import { recoverSequencePublication, type SequencePublication } from './sequence-publication.js';
import { waitForNativePreview, nativePreviewWaitOptions } from './native-preview-wait.js';
import { verifyRoundTrip } from './project-workflow.js';
import { previewRequestId, previewMutationOptions, previewFingerprint, readPreviewCreation, writePreviewCreation, checkPreviewMutation, recordPreviewMutation, type PreviewCreation, type MutationReceipt } from './preview-requests.js';

const viewport = z.object({ minX: z.number().finite(), maxX: z.number().finite(), minY: z.number().finite(), maxY: z.number().finite() }).refine(v => v.maxX > v.minX && v.maxY > v.minY, 'Viewport must have positive dimensions.');
export const nativePreviewOptions = z.object({
  animation: z.string().min(1).max(256).optional(), time: z.number().finite().min(0).max(300).default(0), skin: z.string().min(1).max(256).optional(), skeletonName: z.string().min(1).max(256).optional(),
  width: z.number().int().min(64).max(1024).default(512), height: z.number().int().min(64).max(1024).default(512),
  physics: z.boolean().default(false), fps: z.number().int().min(1).max(120).default(60),
  durationSeconds: z.number().int().min(5).max(28800).default(3600), viewport: viewport.optional(),
}).strict();
export const nativePreviewChanges = z.object({ animation: z.string().min(1).max(256).nullable().optional(), skin: z.string().min(1).max(256).nullable().optional(), time: nativePreviewOptions.shape.time.removeDefault().optional(), physics: nativePreviewOptions.shape.physics.removeDefault().optional(), fps: nativePreviewOptions.shape.fps.removeDefault().optional(), skeletonName: nativePreviewOptions.shape.skeletonName, viewport: viewport.optional(), refit: z.boolean().default(false) }).strict();
export const nativePreviewResumeOptions = z.object({ durationSeconds: nativePreviewOptions.shape.durationSeconds.removeDefault().optional() }).strict();
type Options = z.infer<typeof nativePreviewOptions>;
export interface NativePreviewRequest { id: string; input: string; sources: string[]; generation: number; options: Options; expiresAt: string; stop?: boolean; recoveryEpoch?: string; projectSha256?: string; playback?: PlaybackRequest; sequence?: NativeSequenceLayout; mutationReceipts?: MutationReceipt[] }
type Request = NativePreviewRequest;
export interface NativePreviewRecovery { supervisorPid: number; state: 'starting' | 'watching' | 'waiting' | 'stopped' | 'expired' | 'exhausted'; epoch?: string; updatedAt: string; workerPid?: number; workerStartedAt?: string; restartCount: number; consecutiveFailures: number; nextRestartAt?: string; lastError?: string }
export interface NativePreviewStatus { id: string; state: 'starting' | 'watching' | 'rendering' | 'recovering' | 'stopped' | 'expired' | 'failed' | 'interrupted'; project: string; image: string; input: string; generation: number; updatedAt: string; expiresAt: string; publishedAt?: string; textureRevision?: number; textureSha256?: string; renderMs?: number; workerPid?: number; lastError?: string; lastErrorGeneration?: number; sourceSignature?: string; projectSha256?: string; consecutiveRenderErrors?: number; lastErrorAt?: string; lastSuccessAt?: string; playback?: PlaybackStatus; sequence?: NativeSequenceStatus; publishedRevision?: { sourceSha256: string; resources: { path: string; sha256: string }[]; missing: string[] }; sequencePublication?: SequencePublication; publicationRecovery?: { id: string; state: 'rolled_back'; recoveredAt: string } }
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const live = (s: NativePreviewStatus) => ['starting', 'watching', 'rendering', 'recovering', 'interrupted'].includes(s.state);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function nativePreviewLeaseOwner(workspace: Workspace, folder: string, kind: 'worker' | 'supervisor' | 'creation') {
  const lease = await workspace.resolve(path.join(folder, `${kind}.lock`), false);
  try { const owner = JSON.parse(await readFile(path.join(lease, 'owner.json'), 'utf8')); return { held: processAlive(owner.pid), pid: processAlive(owner.pid) ? Number(owner.pid) : undefined }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    try { return { held: Date.now() - (await stat(lease)).mtimeMs < 5000, pid: undefined }; }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; return { held: false, pid: undefined }; }
  }
}

/** A fixed PNG is the ONLY mutable preview asset. The native editor reloads it
 * through its documented image watcher. No editor input/IPC/activation is used. */
export class NativePreviews {
  constructor(readonly service: SpineService) {}
  get workspace() { return this.service.workspace; }
  async root() { const root = await this.workspace.resolve('.native-previews', false); await mkdir(root, { recursive: true }); return root; }
  async folder(id: string) { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid native preview id.'); return this.workspace.resolve(path.join(await this.root(), id)); }
  async kick(folder: string) {
    if ((await nativePreviewLeaseOwner(this.workspace, folder, 'supervisor')).held) return;
    const child = spawn(process.execPath, [fileURLToPath(new URL('./native-preview-supervisor.js', import.meta.url)), folder], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, SPINE_NATIVE_PREVIEW_CONFIG: JSON.stringify(this.service.config) } });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  }
  async request(folder: string) { return JSON.parse(await readFile(await this.workspace.resolve(path.join(folder, 'request.json')), 'utf8')) as Request; }
  async status(folder: string): Promise<NativePreviewStatus> {
    const status = JSON.parse(await readFile(await this.workspace.resolve(path.join(folder, 'status.json')), 'utf8')) as NativePreviewStatus;
    if (status.id !== path.basename(folder) || !['MCP-preview.spine', 'MCP-sequence.spine'].some(name => samePath(path.resolve(status.project), path.join(folder, name))) || !samePath(path.resolve(status.image), path.join(folder, 'images/preview.png'))) throw new Error('Native preview output paths do not match the managed session.');
    await this.workspace.resolve(status.project, false); await this.workspace.resolve(status.image, false); return status;
  }
  async recovery(folder: string): Promise<NativePreviewRecovery | null> {
    try { return JSON.parse(await readFile(path.join(folder, 'supervisor.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async get(id: string) {
    const folder = await this.folder(id), status = await this.status(folder), request = await this.request(folder), root = await this.root();
    // Resolve shared prerequisites before launching parallel checks, so every
    // rejection has a handler immediately, including rejected lease paths.
    const [worker, supervisor, recovery, projectReady, creation, creator] = await Promise.all([nativePreviewLeaseOwner(this.workspace, folder, 'worker'), nativePreviewLeaseOwner(this.workspace, folder, 'supervisor'), this.recovery(folder), exists(status.project), readPreviewCreation(this.workspace, root, id), nativePreviewLeaseOwner(this.workspace, folder, 'creation')]);
    const active = !request.stop && Date.parse(request.expiresAt) > Date.now();
    if (!worker.held && !active) status.state = request.stop ? 'stopped' : 'expired';
    else if (active && !worker.held && recovery?.epoch === request.recoveryEpoch && recovery?.state === 'exhausted') status.state = 'failed';
    else if (active && !worker.held && supervisor.held) status.state = 'recovering';
    else if (active && !live(status) && request.generation > status.generation) status.state = worker.held ? 'recovering' : 'interrupted';
    else if (live(status) && !worker.held && Date.now() - Date.parse(status.updatedAt) > 5000) status.state = 'interrupted';
    if (creation && creation.phase !== 'ready') status.state = request.stop || creation.phase === 'cancelled' ? 'stopped' : creator.held ? 'starting' : creation.phase === 'failed' ? 'failed' : 'interrupted';
    return { ...status, projectSha256: request.projectSha256 ?? status.projectSha256, workerPid: worker.pid ?? status.workerPid, expiresAt: request.expiresAt, pendingGeneration: request.generation, pendingInput: request.input, options: request.options, stopRequested: Boolean(request.stop), directory: folder,
      nativeProjectReady: projectReady, workerAlive: worker.held, supervisorAlive: supervisor.held, recovery: recovery ? { ...recovery, current: recovery.epoch === request.recoveryEpoch } : null,
      resumable: (!creation || creation.phase === 'ready') && projectReady && await exists(status.image), requestedPlayback: request.playback ?? null, creation: creation ? { ...creation, ownerAlive: creator.held } : null,
      mode: request.sequence ? 'native-image-sequence' as const : 'native-image-watch' as const, publicationPending: await exists(path.join(folder, 'sequence-publication.json')), editorProjectReloaded: false, editorDisplayAcknowledged: false,
      instructions: request.sequence ? 'Open MCP-sequence.spine once, switch to ANIMATE, expand Animations and click the visibility dot at the FAR LEFT of the MCP-playback row to ACTIVATE it; selecting its name alone does not activate it, enable loop and start playback ONCE. Spine then plays preloaded sequence images on its own native clock, with NO per-frame file writes. Background edits/resources prepare and replace the sequence only when content changes; a loading placeholder may briefly appear during that actual resource update. Native play/pause/seek/speed controls remain in Spine; MCP does not read/control that native clock. update_native_preview changes animation/skin/physics/input/refit while keeping the fixed sequence range/frame count/native FPS. stop_native_preview stops resource synchronization, not the native clock. Resume renews synchronization in the SAME project. No GUI launch, input or activation. Status confirms resources, not native display.' : 'Open project once in Spine. Its Images watcher reloads preview.png after MCP edits. Experimental spine_control_native_playback repeatedly replaces that PNG and can show native LOADING placeholders; it has FAILED native visual quality acceptance. Prefer spine_start_native_sequence_preview for native continuous playback. Single-pose refresh remains supported. The experimental clock supports play/pause/seek/stop, speed, range and loop, without native timeline control or audio. PNG rates are not editor FPS. Resume renews the SAME project and bounded supervisor recovery. No input/focus commands, GUI launches or display receipt.' };
  }
  async list() {
    const root = await this.root(), previews = [], errors: { id: string; error: string }[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)) {
      try { previews.push(await this.get(entry.name)); } catch (error) { errors.push({ id: entry.name, error: (error as Error).message }); }
    }
    return { previews, errors };
  }
  async wait(id: string, options: unknown = {}) { return waitForNativePreview(this.service, id, nativePreviewWaitOptions.parse(options)); }
  async lock<T>(folder: string, action: () => Promise<T>): Promise<T> {
    for (let i = 0; i < 125; i++) { const release = await syncLease(this.workspace, path.join(folder, 'request.lock')); if (release) { try { return await action(); } finally { await release(); } } await delay(40); }
    throw new Error('Native preview request is busy. Retry the preview update; the edited output is already saved.');
  }
  active(preview: Awaited<ReturnType<NativePreviews['get']>>) { return !preview.stopRequested && (Boolean(preview.creation?.ownerAlive && preview.creation.phase !== 'ready') || Date.parse(preview.expiresAt) > Date.now() && (live(preview) || preview.nativeProjectReady && (!preview.creation || preview.creation.phase === 'ready'))); }
  async assertCreated(id: string) { const creation = await readPreviewCreation(this.workspace, await this.root(), id); if (creation && creation.phase !== 'ready') throw new Error(`Preview creation is ${creation.phase}. Retry the original start call with requestId=${id} before editing or resuming it.`); }
  async recoverActive() {
    const root = await this.workspace.resolve('.native-previews', false); if (!await exists(root)) return { requested: [] as string[], errors: [] as string[] };
    const listed = await this.list(), requested: string[] = [], errors = listed.errors.map(item => `${item.id}: ${item.error}`);
    for (const preview of listed.previews.filter(p => this.active(p) && p.resumable)) {
      try { const folder = await this.folder(preview.id); await this.kick(folder); requested.push(preview.id); }
      catch (error) { errors.push(`${preview.id}: ${(error as Error).message}`); }
    }
    return { requested, errors };
  }
  async startSequence(input: string, rawOptions: unknown, rawRange: unknown = {}, requestId?: string) {
    const options = nativePreviewOptions.parse(rawOptions), range = nativeSequenceRange.parse(rawRange), source = await this.workspace.resolve(input), loaded = await loadStable(this.service, source, options.skeletonName);
    const layout = sequenceLayout(loaded.data, options.animation, range, options.width, options.height);
    return this.start(input, { ...options, time: layout.start }, layout, requestId);
  }
  async start(input: string, rawOptions: unknown = {}, sequence?: NativeSequenceLayout, requestId?: string) {
    const options = nativePreviewOptions.parse(rawOptions), source = await this.workspace.resolve(input);
    const loaded = await loadStable(this.service, source, options.skeletonName), snapshot = await sourceSignature(this.service, { input: source, options } as Request, loaded);
    const id = requestId === undefined ? randomUUID() : previewRequestId.parse(requestId), root = await this.root(), folder = await this.workspace.resolve(path.join(root, id), false), images = path.join(folder, 'images');
    const fingerprint = previewFingerprint({ input: source, options, sequence: sequence ?? null, source: snapshot.signature });
    let creation!: PreviewCreation, request!: Request, status!: NativePreviewStatus, reused = false, pending = false;
    const creatorLease: { release?: () => Promise<void> } = {};
    await this.lock(root, async () => {
      const previous = await readPreviewCreation(this.workspace, root, id); reused = Boolean(previous);
      if (previous && previous.fingerprint !== fingerprint) throw new Error('requestId belongs to a different preview source/resource revision or creation parameters. Use a new requestId.');
      if (previous?.phase === 'ready' || previous?.phase === 'cancelled') { creation = previous; pending = true; return; }
      if (previous && (await nativePreviewLeaseOwner(this.workspace, folder, 'creation')).held) { creation = previous; pending = true; return; }
      if ((await this.list()).previews.filter(p => p.id !== id && this.active(p)).length >= 4) throw new Error('Stop an existing native preview before starting more than four.');
      if (!previous && await exists(folder)) throw new Error('An unowned preview directory already exists for requestId; it will not be overwritten.');
      const now = new Date().toISOString();
      creation = previous ?? { schema: 1, id, fingerprint, sourceSha256: loaded.sourceHash, phase: 'reserved', attempts: 0, createdAt: now, updatedAt: now };
      // Reserve the ID durably BEFORE creating its output directory. An early
      // interruption can safely rebuild missing bootstrap metadata on retry.
      await writePreviewCreation(this.workspace, root, creation); await mkdir(images, { recursive: true });
      let oldRequest: Request | undefined;
      if (await exists(path.join(folder, 'request.json'))) oldRequest = await this.request(folder);
      if (oldRequest && (oldRequest.id !== id || !samePath(oldRequest.input, source) || oldRequest.generation > 1)) throw new Error('Incomplete preview metadata changed; refusing to reset it.');
      const expiresAt = new Date(Date.now() + Math.max(600, options.durationSeconds) * 1000).toISOString();
      request = { id, input: source, sources: [...new Set([source, loaded.jsonPath])], generation: 1, options: { ...options }, expiresAt, recoveryEpoch: randomUUID(), ...(sequence ? { sequence } : {}), ...(oldRequest?.stop ? { stop: true } : {}), ...(oldRequest?.mutationReceipts ? { mutationReceipts: oldRequest.mutationReceipts } : {}) };
      status = await exists(path.join(folder, 'status.json')) ? await this.status(folder) : { id, state: 'starting', project: path.join(folder, sequence ? 'MCP-sequence.spine' : 'MCP-preview.spine'), image: path.join(images, 'preview.png'), input: source, generation: 0, updatedAt: now, expiresAt };
      if (status.project !== path.join(folder, sequence ? 'MCP-sequence.spine' : 'MCP-preview.spine')) throw new Error('Preview creation mode does not match the existing metadata.');
      await atomicJson(path.join(folder, 'request.json'), request); await atomicJson(path.join(folder, 'status.json'), status);
      creatorLease.release = await syncLease(this.workspace, path.join(folder, 'creation.lock')) ?? undefined;
      if (!creatorLease.release) throw new Error('Preview creation is busy; query the same requestId.');
      creation.phase = 'preparing'; creation.attempts++; delete creation.error;
      try { await writePreviewCreation(this.workspace, root, creation); } catch (error) { await creatorLease.release(); delete creatorLease.release; throw error; }
    });
    if (pending) {
      const current = await this.get(id);
      if (creation.phase === 'ready' && current.projectSha256 && await fileSha256(current.project) !== current.projectSha256) throw new Error('The created native project changed. It will not be recreated or overwritten.');
      return { ...current, creationReused: true, creationPending: creation.phase !== 'ready' && creation.phase !== 'cancelled' };
    }
    const ensureCurrent = async () => {
      const latest = await this.request(folder);
      if (latest.stop) throw new Error('Preview creation cancelled by stop request.');
      if (latest.generation !== 1) throw new Error('Preview creation request changed before completion.');
      await assertSnapshot(snapshot.assets);
      if (await fileSha256(source) !== loaded.sourceHash) throw new Error('Source changed during preview creation.');
    };
    let creationCommitted = false;
    try {
      await ensureCurrent();
      const rendered = await renderPose(this.service, request, loaded); request.options.viewport = rendered.viewport;
      try { await this.lock(folder, async () => { await ensureCurrent(); await publishImage(this.service, rendered.path, status.image, false); await atomicJson(path.join(folder, 'request.json'), request); }); }
      finally { await unlink(rendered.path).catch(() => undefined); }
      Object.assign(status, { generation: 1, textureRevision: (status.textureRevision ?? 0) + 1, publishedAt: new Date().toISOString(), textureSha256: await fileSha256(status.image), renderMs: rendered.renderMs, sourceSignature: rendered.signature, publishedRevision: rendered.revision });
      if (sequence) { const renderer = new NativeSequenceRenderer(this.service, folder, status, () => atomicJson(path.join(folder, 'status.json'), status)); await renderer.render(request, await sourceSignature(this.service, request, loaded)); }
      const document = sequence ? nativeSequenceDocument(options, sequence) : { skeleton: { spine: '4.3.23', images: './images/', width: options.width, height: options.height }, bones: [{ name: 'root' }], slots: [{ name: 'preview', bone: 'root', attachment: 'preview' }], skins: [{ name: 'default', attachments: { preview: { preview: { width: options.width, height: options.height } } } }] };
      const json = path.join(folder, 'preview.json');
      if (await exists(json)) { if (previewFingerprint(JSON.parse(await readFile(json, 'utf8'))) !== previewFingerprint(document)) throw new Error('Prepared preview JSON changed; refusing to overwrite it.'); }
      else await writeFile(json, JSON.stringify(document, null, 2), { flag: 'wx' });
      await ensureCurrent(); creation.phase = 'importing'; await writePreviewCreation(this.workspace, root, creation);
      const existing = await exists(status.project), before = existing ? await fileSha256(status.project) : undefined;
      if (before && status.projectSha256 && before !== status.projectSha256) throw new Error('Existing preview native project changed; refusing to overwrite it.');
      if (!existing) await this.service.cli.importProject(json, status.project, sequence ? 'MCP-sequence' : 'MCP-preview');
      // An uncertain completed CLI import is independently verified on retry.
      const exported = await this.service.cli.exportData(status.project), actual = exported.files.filter(f => f.endsWith('.json'));
      if (actual.length !== 1) throw new Error('Native preview project must contain one skeleton.');
      const actualData = await readDocument(actual[0]!); verifyRoundTrip(await readDocument(json), actualData, json, actual[0]!);
      const assets = await auditAssets(this.workspace, actualData, actual[0]!, false); await assertSnapshot(assets);
      if (assets.missing.length) throw new Error('Imported native preview references missing resources.');
      status.projectSha256 = await fileSha256(status.project);
      if (before && status.projectSha256 !== before) throw new Error('Existing preview project changed during independent verification.');
      await this.lock(folder, async () => {
        await ensureCurrent(); request = await this.request(folder); request.projectSha256 = status.projectSha256;
        request.expiresAt = new Date(Date.now() + options.durationSeconds * 1000).toISOString(); status.expiresAt = request.expiresAt;
        await atomicJson(path.join(folder, 'request.json'), request); status.state = 'watching'; delete status.lastError; delete status.lastErrorAt; delete status.lastErrorGeneration; status.updatedAt = new Date().toISOString(); await atomicJson(path.join(folder, 'status.json'), status);
        creation.phase = 'ready'; await writePreviewCreation(this.workspace, root, creation);
      });
      creationCommitted = true;
      await this.kick(folder); return { ...await this.get(id), creationReused: reused, creationPending: false };
    } catch (error) {
      // Native publication is already durable. A later supervisor-start or
      // response-read failure must not revoke it or block future mutations.
      if (creationCommitted) throw error;
      const cancelled = (await this.request(folder)).stop; status.state = cancelled ? 'stopped' : 'failed'; status.lastError = (error as Error).message; status.updatedAt = new Date().toISOString();
      await atomicJson(path.join(folder, 'status.json'), status); creation.phase = cancelled ? 'cancelled' : 'failed'; creation.error = status.lastError; await writePreviewCreation(this.workspace, root, creation); throw error;
    } finally { if (creatorLease.release) await creatorLease.release(); }
  }
  async update(id: string, input: string | undefined, rawChanges: unknown = {}, rawConditions: unknown = {}) {
    const folder = await this.folder(id), conditions = previewMutationOptions.parse(rawConditions), changes = nativePreviewChanges.parse(rawChanges), filename = input ? await this.workspace.resolve(input, false) : undefined;
    await this.assertCreated(id);
    const fingerprint = previewFingerprint({ operation: 'update', input: filename ?? null, changes, conditions }); let receipt!: MutationReceipt, reused = false;
    await this.lock(folder, async () => {
      const request = await this.request(folder), previous = checkPreviewMutation(request, conditions, 'update', fingerprint);
      if (previous) { receipt = previous; reused = true; return; }
      if (request.stop || Date.parse(request.expiresAt) <= Date.now()) throw new Error('Preview has stopped or expired. Use spine_resume_native_preview with the same id.');
      if (filename) await this.workspace.resolve(filename);
      if (request.sequence && changes.time !== undefined) throw new Error('Native sequence time is controlled by the Spine timeline. MCP does not seek that native clock.');
      const { refit, animation, skin, ...rest } = changes;
      const candidate = { ...request.options, ...rest, ...(animation !== undefined ? { animation: animation ?? undefined } : {}), ...(skin !== undefined ? { skin: skin ?? undefined } : {}) };
      if (refit) delete candidate.viewport;
      request.options = nativePreviewOptions.parse(candidate); if (filename) { request.input = filename; request.sources = [...new Set([...request.sources, filename])].slice(-2048); }
      request.generation++; request.recoveryEpoch = randomUUID(); receipt = recordPreviewMutation(request, conditions, 'update', fingerprint); await atomicJson(path.join(folder, 'request.json'), request);
    });
    if (!reused) await this.kick(folder); return { ...await this.get(id), requestReceipt: { ...receipt, reused } };
  }
  async resume(id: string, rawOptions: unknown = {}, rawConditions: unknown = {}) {
    const options = nativePreviewResumeOptions.parse(rawOptions), conditions = previewMutationOptions.parse(rawConditions), folder = await this.folder(id);
    await this.assertCreated(id);
    const fingerprint = previewFingerprint({ operation: 'resume', options, conditions }); let receipt!: MutationReceipt, reused = false;
    await this.lock(await this.root(), async () => {
      await this.lock(folder, async () => {
        const request = await this.request(folder), cached = checkPreviewMutation(request, conditions, 'resume', fingerprint);
        if (cached) { receipt = cached; reused = true; return; }
        const previous = await this.get(id);
        if (!previous.resumable) throw new Error('Native preview project or final image is missing. Restore those files before resuming this preview.');
        if (!this.active(previous) && (await this.list()).previews.filter(p => this.active(p)).length >= 4) throw new Error('Stop an existing native preview before resuming more than four.');
        const projectHash = await fileSha256(previous.project);
        if (previous.projectSha256 && projectHash !== previous.projectSha256) throw new Error('Native preview project changed. Restore the generated project before resuming; it will not be overwritten.');
        request.projectSha256 ??= projectHash;
        request.options.durationSeconds = options.durationSeconds ?? request.options.durationSeconds;
        request.expiresAt = new Date(Date.now() + request.options.durationSeconds * 1000).toISOString();
        request.stop = false; request.generation++; request.recoveryEpoch = randomUUID();
        receipt = recordPreviewMutation(request, conditions, 'resume', fingerprint); await atomicJson(path.join(folder, 'request.json'), request);
      });
    });
    if (!reused) await this.kick(folder); return { ...await this.get(id), requestReceipt: { ...receipt, reused } };
  }
  async stop(id: string, rawConditions: unknown = {}) {
    const folder = await this.folder(id), conditions = previewMutationOptions.parse(rawConditions), fingerprint = previewFingerprint({ operation: 'stop', conditions }); let receipt!: MutationReceipt, reused = false;
    await this.lock(folder, async () => { const request = await this.request(folder), previous = checkPreviewMutation(request, conditions, 'stop', fingerprint); if (previous) { receipt = previous; reused = true; return; } request.stop = true; receipt = recordPreviewMutation(request, conditions, 'stop', fingerprint); await atomicJson(path.join(folder, 'request.json'), request); });
    return { ...await this.get(id), requestReceipt: { ...receipt, reused } };
  }
  async controlPlayback(id: string, rawControl: unknown) {
    await this.assertCreated(id);
    const control = nativePlaybackControl.parse(rawControl), folder = await this.folder(id), before = await this.request(folder);
    if (before.sequence) throw new Error('Native sequences play on the Spine timeline. Use native play/pause/seek/speed controls; this tool only controls the experimental single-PNG clock.');
    const loaded = ['play', 'seek'].includes(control.action) ? await loadStable(this.service, before.input, before.options.skeletonName) : undefined;
    await this.lock(folder, async () => {
      const request = await this.request(folder);
      if (request.stop || Date.parse(request.expiresAt) <= Date.now()) throw new Error('Preview stopped or expired. Resume the same preview first.');
      if (request.generation !== before.generation || request.input !== before.input) throw new Error('Preview changed during playback validation. Retry against the latest branch.');
      if (control.action === 'stop') delete request.playback;
      else {
        if (!request.playback && control.action !== 'play') throw new Error('Start playback before pausing or seeking.');
        const old = request.playback, status = await this.status(folder);
        const rangeChanged = control.start !== undefined || control.end !== undefined;
        const start = control.start ?? old?.start ?? 0, currentTime = status.playback?.revision === old?.revision ? status.playback?.currentTime : old?.time;
        request.playback = { state: control.action === 'pause' ? 'paused' : old?.state ?? 'playing', start, end: control.end ?? old?.end, playbackFps: control.playbackFps ?? old?.playbackFps ?? 8, speed: control.speed ?? old?.speed ?? 1, loop: control.loop ?? old?.loop ?? true, time: control.time ?? (rangeChanged ? start : currentTime ?? start), revision: randomUUID() };
        if (control.action === 'play') { request.playback.state = 'playing'; if (status.playback?.state === 'completed' && control.time === undefined) request.playback.time = start; }
        if (loaded) { playbackPlan(loaded.data, request); if (await fileSha256(request.input) !== loaded.sourceHash) throw new Error('Source changed during playback validation. Retry.'); }
      }
      request.generation++; request.recoveryEpoch = randomUUID(); await atomicJson(path.join(folder, 'request.json'), request);
    });
    await this.kick(folder); return this.get(id);
  }
  async follow(inputs: string[], output: string, alias = false) {
    const sessions: { id: string; generation: number; image: string }[] = [], errors: string[] = [];
    try {
      // No preview directory is created for ordinary editing installations.
      const root = await this.workspace.resolve('.native-previews', false); if (!await exists(root)) return { sessions, errors };
      const sources = inputs.map(f => path.resolve(this.workspace.root, f)), target = path.resolve(this.workspace.root, output);
      const listed = await this.list(); errors.push(...listed.errors.map(item => `${item.id}: ${item.error}`));
      for (const preview of listed.previews.filter(p => this.active(p) && p.resumable)) {
        const folder = await this.folder(preview.id);
        try { await this.lock(folder, async () => {
          const request = await this.request(folder); if (request.stop || Date.parse(request.expiresAt) <= Date.now() || !request.sources.some(old => sources.some(source => samePath(old, source)))) return;
          if (!request.sources.some(old => samePath(old, target))) request.sources = [...request.sources.slice(0, 1), ...request.sources.slice(-2046), target];
          if (!alias) { request.input = target; request.generation++; request.recoveryEpoch = randomUUID(); }
          await atomicJson(path.join(folder, 'request.json'), request);
          if (!alias) sessions.push({ id: preview.id, generation: request.generation, image: preview.image });
        }); if (sessions.some(session => session.id === preview.id)) await this.kick(folder); } catch (error) { errors.push(`${preview.id}: ${(error as Error).message}`); }
      }
    } catch (error) { errors.push((error as Error).message); }
    return { sessions, errors };
  }
}

type LoadedPose = Awaited<ReturnType<SpineService['load']>> & { sourceHash: string };
async function loadStable(service: SpineService, input: string, skeletonName?: string): Promise<LoadedPose> {
  const sourceHash = await fileSha256(input), loaded = await service.load(input, skeletonName);
  if (await fileSha256(input) !== sourceHash) throw new Error('Source changed while loading. The previous preview remains visible.');
  return { ...loaded, sourceHash };
}
async function sourceSignature(service: SpineService, request: Request, loaded?: LoadedPose) {
  const current = loaded ?? await loadStable(service, request.input, request.options.skeletonName), assets = await auditAssets(service.workspace, current.data, current.jsonPath, false);
  const sourceHash = current.sourceHash;
  if (await fileSha256(request.input) !== sourceHash) throw new Error('Source changed while preparing preview.');
  return { loaded: current, assets, sourceHash, signature: `${sourceHash}:${assets.files.map(r => `${r.path}:${r.sha256}`).sort().join('|')}:${assets.missing.map(r => r.path).sort().join('|')}` };
}
async function renderPose(service: SpineService, request: Request, loaded?: LoadedPose) {
  const start = Date.now(), snapshot = await sourceSignature(service, request, loaded), { data, jsonPath } = snapshot.loaded, options = request.options;
  let bounds = options.viewport;
  if (!bounds) {
    const sample = await sampleArtwork(service.workspace, data, jsonPath, options.animation, [options.time], options.skin, options), vertices = sample.frames[0]!.slots.flatMap(slot => slot.vertices ?? []);
    if (!vertices.length) throw new Error('The selected pose contains no visible artwork.');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < vertices.length; i += 2) { minX = Math.min(minX, vertices[i]!); maxX = Math.max(maxX, vertices[i]!); minY = Math.min(minY, vertices[i + 1]!); maxY = Math.max(maxY, vertices[i + 1]!); }
    const margin = Math.max(maxX - minX, maxY - minY, 1) * 0.12; bounds = { minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin };
  }
  const rendered = await renderArtwork(service.workspace, data, jsonPath, options.animation, [options.time], options.skin, { ...options, viewport: bounds, clean: true, transparent: true });
  try { await assertSnapshot(snapshot.assets); if (await fileSha256(request.input) !== snapshot.sourceHash) throw new Error('Source changed while rendering. The previous preview remains visible.'); }
  catch (error) { await unlink(rendered.path); throw error; }
  return { path: rendered.path, viewport: bounds, renderMs: Date.now() - start, signature: snapshot.signature, revision: { sourceSha256: snapshot.sourceHash, resources: snapshot.assets.files.map(file => ({ path: file.path, sha256: file.sha256 })), missing: snapshot.assets.missing.map(file => file.path) } };
}
async function publishImage(service: SpineService, source: string, destination: string, consume = true) {
  // Stage OUTSIDE the watched images directory. Otherwise each transient PNG
  // appears as a new image asset and triggers extra native scan/loading work.
  const target = await service.workspace.resolve(destination, false), temporary = await service.workspace.resolve(path.join(path.dirname(path.dirname(target)), `.preview-${randomUUID()}.png`), false);
  try { await copyFile(source, temporary); await replaceFile(temporary, target); } finally { if (consume) await unlink(source).catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}
async function waitForPreviewRequest(manager: NativePreviews, folder: string, generation: number, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const latest = await manager.request(folder);
    if (latest.generation !== generation || latest.stop || Date.parse(latest.expiresAt) <= Date.now()) return;
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}

export async function runNativePreview(service: SpineService, folder: string) {
  const manager = service.nativePreviews, id = path.basename(folder); if (path.resolve(await manager.folder(id)) !== path.resolve(folder)) throw new Error('Native preview worker directory does not match workspace.');
  const release = await syncLease(service.workspace, path.join(folder, 'worker.lock')); if (!release) return;
  const statusFile = path.join(folder, 'status.json'), status = await manager.status(folder); status.workerPid = process.pid;
  const save = async () => { status.updatedAt = new Date().toISOString(); await atomicJson(statusFile, status); };
  const player = new NativePlaybackRunner(service, folder, status, save, (source, destination) => publishImage(service, source, destination, false));
  const sequence = new NativeSequenceRenderer(service, folder, status, save);
  let lastCheck = 0;
  let cache: { input: string; hash: string; skeletonName?: string; loaded: LoadedPose } | undefined;
  try {
    await manager.lock(folder, () => recoverSequencePublication(service.workspace, folder, status));
    status.workerPid = process.pid;
    // A renderer can exit after PNG rename but before saving status. Reconcile
    // that publication gap by rendering the latest request again on restart.
    if (status.textureSha256 && (!await exists(status.image) || await fileSha256(status.image) !== status.textureSha256)) delete status.sourceSignature;
    for (;;) {
      // A previous rollback may have hit a temporary file lock. Recover before
      // loading any new source, even when that source is missing or malformed.
      if (await exists(path.join(folder, 'sequence-publication.json'))) { await manager.lock(folder, () => recoverSequencePublication(service.workspace, folder, status)); status.workerPid = process.pid; }
      const request = await manager.request(folder);
      status.expiresAt = request.expiresAt;
      if (request.stop || Date.parse(request.expiresAt) <= Date.now()) { status.state = request.stop ? 'stopped' : 'expired'; await save(); return; }
      if (request.generation !== status.generation || Date.now() - lastCheck >= 2000) {
        lastCheck = Date.now();
        try {
          const hash = await fileSha256(request.input);
          if (!cache || !samePath(cache.input, request.input) || cache.hash !== hash || cache.skeletonName !== request.options.skeletonName) cache = { input: request.input, hash, skeletonName: request.options.skeletonName, loaded: await loadStable(service, request.input, request.options.skeletonName) };
          const current = await sourceSignature(service, request, cache.loaded);
          if (request.sequence) { if (request.generation !== status.generation || current.signature !== status.sourceSignature || !await sequence.complete(request)) await sequence.render(request, current); }
          else if (request.playback) { await player.ensure(request, current); delete status.lastError; delete status.lastErrorAt; status.consecutiveRenderErrors = 0; }
          else if (request.generation !== status.generation || current.signature !== status.sourceSignature || status.playback) {
            status.state = 'rendering'; await save(); const rendered = await renderPose(service, request, current.loaded);
            await manager.lock(folder, async () => {
              const latest = await manager.request(folder);
              if (latest.stop || Date.parse(latest.expiresAt) <= Date.now() || latest.generation !== request.generation) { await unlink(rendered.path); return; }
              await publishImage(service, rendered.path, status.image);
              Object.assign(status, { input: request.input, generation: request.generation, textureRevision: (status.textureRevision ?? 0) + 1, publishedAt: new Date().toISOString(), sourceSignature: rendered.signature, publishedRevision: rendered.revision, renderMs: rendered.renderMs, textureSha256: await fileSha256(status.image) });
              if (!latest.options.viewport) { latest.options.viewport = rendered.viewport; await atomicJson(path.join(folder, 'request.json'), latest); }
              delete status.lastError; delete status.lastErrorAt; delete status.lastErrorGeneration; status.consecutiveRenderErrors = 0; status.lastSuccessAt = new Date().toISOString();
              delete status.playback;
            });
          }
          status.state = 'watching'; await save();
        } catch (error) { if (NativePlaybackRunner.superseded(error) || error instanceof SequenceSuperseded) continue; status.state = 'watching'; status.lastError = (error as Error).message; status.lastErrorGeneration = request.generation; if (status.playback) { status.playback.state = 'error'; status.playback.error = status.lastError; } if (status.sequence) { status.sequence.state = 'error'; status.sequence.error = status.lastError; } status.lastErrorAt = new Date().toISOString(); status.consecutiveRenderErrors = (status.consecutiveRenderErrors ?? 0) + 1; await save(); await waitForPreviewRequest(manager, folder, request.generation, Math.min(10_000, 1500 * status.consecutiveRenderErrors)); continue; }
      }
      if (request.playback && !status.lastError) { try { await player.tick(request); } catch (error) { if (!NativePlaybackRunner.superseded(error)) throw error; } }
      await delay(request.playback ? 20 : 250);
    }
  } catch (error) { status.state = 'failed'; status.lastError = (error as Error).message; await save(); }
  finally { await release(); }
}
