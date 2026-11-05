import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { atomicJson, exists } from './jobs.js';
import { syncLease } from './sync-lock.js';
import { fileSha256 } from './file-hash.js';
import { archiveProject, verifyArchive } from './original-archive.js';
import { auditAssets, assertSnapshot, documentDiff, resourceRefs, snapshotEditSources } from './production-assets.js';
import { readDocument, writeDocument, type SpineDocument } from './document.js';
import { applyEdits, editSchema } from './edits.js';
import { editMultiProject, buildProject } from './multi-project.js';
import { attachmentEntries } from './attachment-data.js';
import { publishQualityPolicySchema } from './publish-quality-schema.js';
import { checkPublishQuality, assertPublishQuality } from './publish-quality.js';
import { VERSION } from './version.js';

const uuid = z.string().uuid(), input = z.string().min(1), note = z.string().max(2000).default('');
const mutation = { id: uuid, requestId: uuid, expectedRevision: z.number().int().nonnegative() };
export const previewLeaseSchema = z.object({ enabled: z.boolean().default(true), durationSeconds: z.number().int().min(5).max(28800).default(3600), renewBeforeSeconds: z.number().int().min(0).max(3600).default(120) }).strict();
export const createSessionSchema = z.object({ input, name: z.string().min(1).max(200), skeletonName: z.string().min(1).max(256).optional(), requestId: uuid.optional(), maxVersions: z.number().int().min(2).max(100).default(30), maxArchiveMiB: z.number().int().min(1).max(4096).default(1024), quality: publishQualityPolicySchema.default(publishQualityPolicySchema.parse({})), previewLease: previewLeaseSchema.default(previewLeaseSchema.parse({})) }).strict();
export const checkpointSessionSchema = z.object({ ...mutation, input: input.optional(), note, acceptExternalChanges: z.boolean().default(false) }).strict();
export const editSessionSchema = z.object({ ...mutation, output: input, edits: z.array(editSchema).min(1).max(100), note }).strict();
export const restoreSessionSchema = z.object({ ...mutation, versionId: uuid, output: input, note, acceptExternalChanges: z.boolean().default(false) }).strict();
export const bindSessionSchema = z.object({ ...mutation, previewId: uuid.nullable() }).strict();
export const configureSessionSchema = z.object({ ...mutation, name: z.string().trim().min(1).max(200).optional(), maxVersions: z.number().int().min(2).max(100).optional(), maxArchiveMiB: z.number().int().min(1).max(4096).optional(), quality: publishQualityPolicySchema.optional(), previewLease: previewLeaseSchema.optional() }).strict().refine(v => ['name', 'maxVersions', 'maxArchiveMiB', 'quality', 'previewLease'].some(k => (v as Record<string, unknown>)[k] !== undefined), 'Provide a session setting to change.');
export const archiveSessionSchema = z.object({ ...mutation, archived: z.boolean() }).strict();
export const touchSessionSchema = z.object(mutation).strict();
export const migrateSessionSchema = z.object(mutation).strict();
export const compactSessionSchema = z.object({ ...mutation, keepRecent: z.number().int().min(1).max(128).default(64) }).strict();
const hashedFile = z.object({ path: input, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const gateSummary = z.object({ checksPassed: z.boolean(), mode: z.enum(['enforce', 'report']), reports: z.array(z.string()) });
const versionSchema = z.object({ id: uuid, index: z.number().int().positive(), createdAt: input, action: z.enum(['initial', 'checkpoint', 'edit', 'restore']), note: z.string(), source: input, sourceSha256: z.string(), trackedFiles: z.array(hashedFile).min(1).max(10001), manifest: input, archiveBytes: z.number().nonnegative(), skeletons: z.array(z.string()).min(1).max(50), restoredFrom: uuid.optional(), operationResult: z.unknown().optional(), quality: gateSummary.optional() });
type Version = z.infer<typeof versionSchema>;
const deliverySchema = z.object({ state: z.enum(['pending', 'requested', 'failed', 'superseded', 'not_bound', 'not_required']), previewId: uuid.optional(), expectedGeneration: z.number().int().optional(), input: input.optional(), generation: z.number().int().optional(), error: z.string().optional() });
const receiptSchema = z.object({ signature: z.string(), operation: z.string(), revision: z.number().int(), versionId: uuid, output: input.optional(), preview: deliverySchema });
type Receipt = z.infer<typeof receiptSchema>;
const stateSchema = z.object({ schema: z.enum(['spine-project-session/1', 'spine-project-session/2']), minimumWriterVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(), receiptIndex: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}), receiptSegments: z.record(z.string(), z.object({ count: z.number().int().positive(), bytes: z.number().int().positive() })).default({}), id: uuid, name: z.string(), origin: input, skeletonName: z.string().optional(), createdAt: input, updatedAt: input, revision: z.number().int().nonnegative(), currentVersionId: uuid, maxVersions: z.number().int().min(2).max(100), maxArchiveMiB: z.number().int().min(1).max(4096), versions: z.array(versionSchema).min(1).max(100), preview: z.object({ id: uuid, generation: z.number().int().nonnegative() }).nullable(), receipts: z.record(z.string(), receiptSchema), archived: z.boolean().default(false), creationKey: z.string().optional(), quality: publishQualityPolicySchema.default(publishQualityPolicySchema.parse({})), previewLease: previewLeaseSchema.default(previewLeaseSchema.parse({})), lastActivityAt: input.optional(), pendingRenewal: z.object({ previewId: uuid, requestId: uuid, expectedGeneration: z.number().int(), durationSeconds: z.number().int() }).optional(), lastRenewalAt: input.optional(), renewalError: z.string().optional() });
type State = z.infer<typeof stateSchema>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const newer = (a: string, b: string) => { const av = a.split('.').map(Number), bv = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i]! > bv[i]!; return false; };
const current = (s: State) => { const v = s.versions.find(v => v.id === s.currentVersionId); if (!v) throw new Error('Session current version is missing.'); return v; };
const creationKey = (s: Pick<State, 'origin' | 'name' | 'skeletonName' | 'maxVersions' | 'maxArchiveMiB' | 'quality' | 'previewLease'>) => digest({ input: s.origin, name: s.name, skeletonName: s.skeletonName, maxVersions: s.maxVersions, maxArchiveMiB: s.maxArchiveMiB, quality: Object.fromEntries(Object.entries(s.quality).filter(([key, value]) => key !== 'waivers' || (value as unknown[]).length > 0)), previewLease: s.previewLease });
const renewalId = (value: unknown) => { const chars = digest(value).slice(0, 32).split(''); chars[12] = '4'; chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16); const hex = chars.join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };

/** Saved-file context only. Every mutation is guarded by a session revision and
 * a cross-process lease; old request receipts never replay an edit. */
export class ProjectSessions {
  constructor(readonly service: SpineService) {}
  async root() { const dir = await this.service.workspace.resolve('.project-sessions', false); await mkdir(dir, { recursive: true }); return dir; }
  async folder(id: string, existing = true) { uuid.parse(id); return this.service.workspace.resolve(path.join(await this.root(), id), existing); }
  async read(id: string) {
    const folder = await this.folder(id), filename = await this.service.workspace.resolve(path.join(folder, 'state.json'));
    if ((await stat(filename)).size > 16 * 1024 * 1024) throw new Error('Session metadata exceeds 16 MiB.');
    const raw = JSON.parse(await readFile(filename, 'utf8'));
    if (raw.minimumWriterVersion && newer(raw.minimumWriterVersion, VERSION)) throw new Error('Session requires a newer writer; reload/upgrade this MCP server before writing.');
    if (raw.schema === 'spine-project-session/2' && !raw.minimumWriterVersion) throw new Error('Version 2 session is missing its writer guard.');
    const state = stateSchema.parse(raw);
    if (state.id !== id || new Set(state.versions.map(v => v.id)).size !== state.versions.length) throw new Error('Invalid session identity/history.');
    return state;
  }
  async save(state: State) {
    const folder = await this.folder(state.id), filename = await this.service.workspace.resolve(path.join(folder, 'state.json'), false);
    if (await exists(filename)) {
      const bytes = await readFile(filename), previous = JSON.parse(bytes.toString('utf8'));
      if (previous.minimumWriterVersion && newer(previous.minimumWriterVersion, VERSION)) throw new Error('Session requires a newer writer.');
      if (previous.schema === 'spine-project-session/1') {
        const backups = await this.service.workspace.resolve(path.join(folder, 'migrations'), false); await mkdir(backups, { recursive: true });
        const backup = await this.service.workspace.resolve(path.join(backups, `session-v1-${createHash('sha256').update(bytes).digest('hex')}.json`), false);
        try { await writeFile(backup, bytes, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(backup)).equals(bytes)) throw error; }
      }
    }
    state.schema = 'spine-project-session/2'; state.minimumWriterVersion = VERSION;
    if (Object.keys(state.receipts).length > 256) await this.packReceipts(state, 64);
    if (Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024) throw new Error('Session metadata exceeds 16 MiB; start a new session.');
    await atomicJson(filename, stateSchema.parse(state));
  }
  async receipt(state: State, requestId: string): Promise<Receipt | undefined> {
    if (Object.hasOwn(state.receipts, requestId)) return state.receipts[requestId];
    const hash = state.receiptIndex[requestId]; if (!hash) return;
    const filename = await this.service.workspace.resolve(path.join(await this.folder(state.id), 'receipts', hash + '.json'));
    if ((await stat(filename)).size > 8 * 1024 ** 2 || await fileSha256(filename) !== hash) throw new Error('Archived request receipt segment is damaged.');
    const segment = JSON.parse(await readFile(filename, 'utf8'));
    if (segment.schema !== 'spine-session-receipts/1' || segment.sessionId !== state.id || !segment.receipts?.[requestId]) throw new Error('Invalid archived request receipt identity.');
    return receiptSchema.parse(segment.receipts[requestId]);
  }
  async packReceipts(state: State, keepRecent: number) {
    const entries = Object.entries(state.receipts).sort((a, b) => b[1].revision - a[1].revision), selected = entries.slice(keepRecent).filter(([, r]) => r.preview.state !== 'pending');
    if (!selected.length) return;
    const body = JSON.stringify({ schema: 'spine-session-receipts/1', sessionId: state.id, receipts: Object.fromEntries(selected.sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n';
    if (Buffer.byteLength(body) > 8 * 1024 ** 2) throw new Error('Request receipt segment exceeds 8 MiB. Compact in smaller batches.');
    const hash = createHash('sha256').update(body).digest('hex'), folder = path.join(await this.folder(state.id), 'receipts'); await mkdir(folder, { recursive: true });
    const file = await this.service.workspace.resolve(path.join(folder, hash + '.json'), false);
    try { await writeFile(file, body, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await fileSha256(file) !== hash) throw error; }
    state.receiptSegments[hash] = { count: selected.length, bytes: Buffer.byteLength(body) };
    for (const [id] of selected) { state.receiptIndex[id] = hash; delete state.receipts[id]; }
  }
  async migrate(raw: z.input<typeof migrateSessionSchema>) { const args = migrateSessionSchema.parse(raw); return this.mutate('migrate', args, async () => ({ noPreview: true })); }
  async compact(raw: z.input<typeof compactSessionSchema>) { const args = compactSessionSchema.parse(raw); return this.mutate('compact_receipts', args, async s => { await this.packReceipts(s, args.keepRecent); return { noPreview: true }; }); }
  async locked<T>(id: string, action: () => Promise<T>) {
    const root = await this.root(); let release: (() => Promise<void>) | null = null;
    for (let i = 0; i < 50 && !release; i++) { release = await syncLease(this.service.workspace, path.join(root, `${id}.lock`)); if (!release) await new Promise(resolve => setTimeout(resolve, 40)); }
    if (!release) throw new Error('Project session is busy; retry the same request ID.');
    try { return await action(); } finally { await release(); }
  }
  async fingerprint(input: string) {
    const source = await this.service.workspace.resolve(input), extension = path.extname(source).toLowerCase();
    if (!['.json', '.spine'].includes(extension)) throw new Error('Bind a saved .spine project or Spine JSON.');
    const sourceSha256 = await fileSha256(source), files = extension === '.json' ? [source] : (await this.service.cli.exportData(source)).files.filter(f => f.endsWith('.json'));
    if (!files.length || files.length > 50) throw new Error('Session requires 1–50 saved skeletons.');
    const tracked = new Map<string, string>([[source, sourceSha256]]);
    for (const filename of files) {
      const assets = await auditAssets(this.service.workspace, await readDocument(filename), filename, false);
      if (!assets.valid) throw new Error('Session snapshots require complete image/audio resources.');
      for (const f of assets.files) tracked.set(f.path, f.sha256);
    }
    if (tracked.size > 10001) throw new Error('Session exceeds 10,000 referenced resources.');
    const trackedFiles = [...tracked].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    await assertSnapshot({ files: trackedFiles });
    return { source, sourceSha256, trackedFiles, skeletons: files.map(f => path.basename(f, '.json')) };
  }
  async capture(input: string, action: Version['action'], note: string, index: number, skeletonName?: string): Promise<Version> {
    const fp = await this.fingerprint(input);
    if (skeletonName && !fp.skeletons.includes(skeletonName) && path.extname(fp.source).toLowerCase() === '.spine') throw new Error('Selected skeleton does not exist in this branch.');
    if (fp.skeletons.length > 1 && !skeletonName) throw new Error(`Select skeletonName for editing this multi-skeleton session: ${fp.skeletons.join(', ')}`);
    const archive = await archiveProject(this.service, fp.source);
    await assertSnapshot({ files: fp.trackedFiles });
    const manifest = JSON.parse(await readFile(archive.manifestPath, 'utf8'));
    if (manifest.sourceHash !== fp.sourceSha256) throw new Error('Session source changed while archiving.');
    const verified = await verifyArchive(this.service, archive.manifestPath); if (!verified.valid) throw new Error('Session archive verification failed.');
    return { id: randomUUID(), index, action, note, createdAt: new Date().toISOString(), ...fp, manifest: archive.manifestPath, archiveBytes: manifest.files.reduce((n: number, f: { bytes: number }) => n + f.bytes, 0) };
  }
  budget(state: State, next: Version) {
    if (state.versions.length >= state.maxVersions) throw new Error('Session version limit reached; configure a higher limit or start a new session. Existing history was retained.');
    if (state.versions.reduce((n, v) => n + v.archiveBytes, next.archiveBytes) > state.maxArchiveMiB * 1024 ** 2) throw new Error('Session archive budget exceeded; configure a higher limit or start a new session. Existing history was retained.');
  }
  async drift(version: Version) {
    const changes: { path: string; reason: string }[] = [];
    for (const file of version.trackedFiles) {
      try { const p = await this.service.workspace.resolve(file.path); if (await fileSha256(p) !== file.sha256) changes.push({ path: p, reason: 'bytes_changed' }); }
      catch (error) { changes.push({ path: file.path, reason: (error as Error).message }); }
    }
    return changes;
  }
  async unchanged(version: Version) { const changes = await this.drift(version); if (changes.length) throw new Error(`Saved source/resources changed outside this session (${changes.length} files). Inspect spine_get_session, then explicitly checkpoint with acceptExternalChanges=true. No output was overwritten.`); }
  view(state: State) {
    const v = current(state);
    return { storageSchema: state.schema, minimumWriterVersion: state.minimumWriterVersion, migrationRequired: state.schema === 'spine-project-session/1', id: state.id, name: state.name, archived: state.archived, revision: state.revision, origin: state.origin, currentVersionId: v.id, currentInput: v.source, skeletonName: state.skeletonName, preview: state.preview, quality: state.quality, previewLease: state.previewLease, lastActivityAt: state.lastActivityAt, lastRenewalAt: state.lastRenewalAt, pendingRenewal: state.pendingRenewal, renewalError: state.renewalError, createdAt: state.createdAt, updatedAt: state.updatedAt, archiveBytes: state.versions.reduce((n, v) => n + v.archiveBytes, 0), maxVersions: state.maxVersions, maxArchiveMiB: state.maxArchiveMiB, versions: state.versions.map(({ trackedFiles, operationResult, ...version }) => ({ ...version, trackedFiles: trackedFiles.length })), savedFilesOnly: true, editorStateRead: false };
  }
  async get(id: string) {
    const s = await this.read(id), changes = await this.drift(current(s));
    let previewStatus: { state: string; expiresAt?: string; secondsRemaining?: number; autoRenewEnabled?: boolean; explicitlyStopped?: boolean; error?: string } | null = null;
    if (s.preview) try { const p = await this.service.nativePreviews.get(s.preview.id); previewStatus = { state: p.state, expiresAt: p.expiresAt, secondsRemaining: Math.max(0, (Date.parse(p.expiresAt) - Date.now()) / 1000), autoRenewEnabled: s.previewLease.enabled, explicitlyStopped: Boolean(p.stopRequested || p.state === 'stopped') }; }
    catch (error) { previewStatus = { state: 'unavailable', error: (error as Error).message }; }
    return { ...this.view(s), previewStatus, inSync: !changes.length, externalChanges: changes.slice(0, 100), externalChangesCount: changes.length };
  }
  async list(limit = 50, includeArchived = false) {
    const sessions = [], errors = [];
    for (const entry of await readdir(await this.root(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuid.safeParse(entry.name).success) continue;
      try { const s = await this.read(entry.name); sessions.push({ id: s.id, name: s.name, archived: s.archived, revision: s.revision, currentInput: current(s).source, updatedAt: s.updatedAt, versions: s.versions.length, preview: s.preview }); }
      catch (error) { errors.push({ id: entry.name, error: (error as Error).message }); }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); const selected = sessions.filter(s => includeArchived || !s.archived); return { total: selected.length, archivedCount: sessions.filter(s => s.archived).length, sessions: selected.slice(0, limit), errors };
  }
  async create(raw: z.input<typeof createSessionSchema>) {
    const args = createSessionSchema.parse(raw), id = args.requestId ?? randomUUID(), source = await this.service.workspace.resolve(args.input);
    return this.locked(id, async () => {
      const folder = await this.folder(id, false);
      if (await exists(path.join(folder, 'state.json'))) {
        const state = await this.read(id);
        if ((state.creationKey ?? creationKey(state)) !== creationKey({ ...args, origin: source })) throw new Error('Session creation request ID belongs to different arguments.');
        return { ...this.view(state), reused: true };
      }
      await mkdir(folder, { recursive: true }); const v = await this.capture(source, 'initial', '', 1, args.skeletonName), now = new Date().toISOString();
      if (v.archiveBytes > args.maxArchiveMiB * 1024 ** 2) throw new Error('Initial archive exceeds session budget.');
      const s: State = { schema: 'spine-project-session/2', minimumWriterVersion: VERSION, receiptIndex: {}, receiptSegments: {}, id, name: args.name, origin: source, skeletonName: args.skeletonName, createdAt: now, updatedAt: now, revision: 0, currentVersionId: v.id, maxVersions: args.maxVersions, maxArchiveMiB: args.maxArchiveMiB, versions: [v], preview: null, receipts: {}, archived: false, quality: args.quality, previewLease: args.previewLease };
      s.creationKey = creationKey(s);
      await this.save(s); return { ...this.view(s), reused: false };
    });
  }
  async storage(id: string) {
    const s = await this.read(id), used = s.versions.reduce((n, v) => n + v.archiveBytes, 0), limit = s.maxArchiveMiB * 1024 ** 2;
    return { id, archived: s.archived, versions: s.versions.length, versionLimit: s.maxVersions, versionsRemaining: s.maxVersions - s.versions.length, accountedSnapshotBytes: used, archiveLimitBytes: limit, archiveBytesRemaining: Math.max(0, limit - used), archiveUsedPercent: used / limit * 100, metadataBytes: (await stat(path.join(await this.folder(id), 'state.json'))).size,
      warnings: [...(s.versions.length / s.maxVersions >= 0.8 ? ['Version capacity is at least 80% used.'] : []), ...(used / limit >= 0.8 ? ['Snapshot capacity is at least 80% used.'] : [])],
      requestReceipts: Object.keys(s.receipts).length + Object.keys(s.receiptIndex).length, inlineReceipts: Object.keys(s.receipts).length, archivedReceipts: Object.keys(s.receiptIndex).length, receiptSegments: Object.keys(s.receiptSegments).length, requestReceiptLimit: 100000, physicalGarbageCollection: false, archivesDeleted: false, note: 'Snapshot accounting includes each retained version, not a measurement of shared workspace disk usage. Configure limits or archive the session; originals and historical PNG/audio bytes are never deleted.' };
  }
  async configure(raw: z.input<typeof configureSessionSchema>) {
    const args = configureSessionSchema.parse(raw);
    return this.mutate('configure', args, async s => {
      if (args.maxVersions !== undefined && args.maxVersions < s.versions.length) throw new Error('Version limit cannot be below retained history.');
      if (args.maxArchiveMiB !== undefined && args.maxArchiveMiB * 1024 ** 2 < s.versions.reduce((n, v) => n + v.archiveBytes, 0)) throw new Error('Archive limit cannot be below retained snapshot bytes.');
      for (const key of ['name', 'maxVersions', 'maxArchiveMiB', 'quality', 'previewLease'] as const) if (args[key] !== undefined) (s as Record<string, unknown>)[key] = args[key];
      return { noPreview: true };
    });
  }
  async archive(raw: z.input<typeof archiveSessionSchema>) {
    const args = archiveSessionSchema.parse(raw);
    return this.mutate('archive', args, async s => { s.archived = args.archived; if (s.archived) { s.preview = null; delete s.pendingRenewal; } return { noPreview: true }; });
  }
  async touch(raw: z.input<typeof touchSessionSchema>) {
    const args = touchSessionSchema.parse(raw);
    return this.mutate('touch', args, async s => { await this.unchanged(current(s)); return {}; });
  }
  async quality(s: State, version: Version) {
    const entries = await this.portable(version), reports = []; let passed = true, sampled = 0;
    for (const entry of entries) {
      const selected = entries.length === 1 || entry.name === s.skeletonName;
      const policy = { ...s.quality, ...(selected ? {} : { animations: undefined, rules: [] }), waivers: s.quality.waivers.filter(w => w.skeleton ? w.skeleton === entry.name : selected).map(({ skeleton: _skeleton, ...ref }) => ref) };
      const report = await checkPublishQuality(this.service, entry.input, policy, undefined, undefined, s.quality.maxSamples - sampled); reports.push(report.reportPath); sampled += report.budgetedSamples;
      passed &&= report.checksPassed; assertPublishQuality(report);
      if (sampled > s.quality.maxSamples) throw new Error(`Publication quality sampling budget exceeded. Report: ${report.reportPath}`);
    }
    return { checksPassed: passed, mode: s.quality.mode, reports };
  }
  async completeRenewal(s: State) {
    const pending = s.pendingRenewal;
    if (!pending || !s.preview || pending.previewId !== s.preview.id) return;
    try {
      const status = await this.service.nativePreviews.get(pending.previewId);
      if (!s.previewLease.enabled || status.stopRequested || status.state === 'stopped') {
        const request = await this.service.nativePreviews.request(await this.service.nativePreviews.folder(pending.previewId));
        const committed = request.mutationReceipts?.some(r => r.requestId === pending.requestId && r.operation === 'resume');
        if (!committed) { delete s.pendingRenewal; await this.save(s); return; }
      }
      const resumed = await this.service.nativePreviews.resume(pending.previewId, { durationSeconds: pending.durationSeconds }, { requestId: pending.requestId, expectedGeneration: pending.expectedGeneration });
      s.preview.generation = resumed.requestReceipt.generation; s.lastRenewalAt = new Date().toISOString();
      delete s.pendingRenewal; delete s.renewalError; await this.save(s);
    } catch (error) { s.renewalError = (error as Error).message; await this.save(s); }
  }
  async renewPreview(s: State, requestId: string) {
    await this.completeRenewal(s);
    if (!s.preview || !s.previewLease.enabled || s.pendingRenewal) return;
    const status = await this.service.nativePreviews.get(s.preview.id);
    if (status.pendingGeneration !== s.preview.generation) throw new Error('Bound preview changed externally. Bind it again using its current state before editing.');
    if (status.stopRequested || status.state === 'stopped') return;
    const remaining = (Date.parse(status.expiresAt) - Date.now()) / 1000;
    if (status.state !== 'expired' && status.state !== 'failed' && !(remaining <= s.previewLease.renewBeforeSeconds)) return;
    s.pendingRenewal = { previewId: s.preview.id, expectedGeneration: s.preview.generation, durationSeconds: s.previewLease.durationSeconds, requestId: renewalId({ session: s.id, requestId, preview: s.preview.id, generation: s.preview.generation, duration: s.previewLease.durationSeconds }) };
    await this.save(s); await this.completeRenewal(s);
  }
  async portable(version: Version) {
    const manifestPath = await this.service.workspace.resolve(version.manifest), checked = await verifyArchive(this.service, manifestPath);
    if (!checked.valid) throw new Error('Historical archive is damaged; restore/diff refused.');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { previews: { skeleton: string; json: string }[] };
    return Promise.all(manifest.previews.map(async p => ({ name: p.skeleton, input: await this.service.workspace.resolve(path.resolve(path.dirname(manifestPath), p.json)) })));
  }
  async previewRequest(s: State, v: Version): Promise<Receipt['preview']> {
    if (!s.preview) return { state: 'not_bound' };
    const status = await this.service.nativePreviews.get(s.preview.id);
    if (status.pendingGeneration !== s.preview.generation) return { state: 'failed', previewId: s.preview.id, error: 'Bound preview changed externally during commit; saved output retained. Bind it again explicitly.' };
    const portable = await this.portable(v), selected = portable.length === 1 ? portable[0] : portable.find(p => p.name === s.skeletonName);
    if (!selected) throw new Error('Historical snapshot lacks the bound skeleton.');
    return { state: 'pending', previewId: s.preview.id, expectedGeneration: s.preview.generation, input: selected.input };
  }
  async finish(s: State, requestId: string, reused: boolean, cached?: Receipt) {
    const receipt = cached ?? s.receipts[requestId]!;
    if (receipt.preview.state === 'pending') {
      if (receipt.revision !== s.revision) receipt.preview.state = 'superseded';
      else try {
        const p = receipt.preview, status = await this.service.nativePreviews.update(p.previewId!, p.input, {}, { requestId, expectedGeneration: p.expectedGeneration });
        p.state = 'requested'; p.generation = status.requestReceipt.generation;
        if (s.preview && s.preview.id === p.previewId) s.preview.generation = p.generation;
      } catch (error) { receipt.preview.state = 'failed'; receipt.preview.error = (error as Error).message; }
      await this.save(s);
    }
    return { ...this.view(s), requestReceipt: { requestId, reused, ...receipt }, output: receipt.output, visualAcceptance: 'pending', editorDisplayAcknowledged: false, editorProjectReloaded: false };
  }
  async mutate<A extends { id: string; requestId: string; expectedRevision: number }>(operation: string, args: A, action: (s: State) => Promise<{ version?: Version; preview?: State['preview']; noPreview?: boolean }>) {
    return this.locked(args.id, async () => {
      const s = await this.read(args.id), signature = digest({ operation, args });
      const cached = await this.receipt(s, args.requestId);
      if (cached) {
        if (cached.signature !== signature) throw new Error('Request ID belongs to another session operation/arguments.');
        return this.finish(s, args.requestId, true, cached);
      }
      if (s.revision !== args.expectedRevision) throw new Error('Session revision is stale; read spine_get_session and review current context.');
      if (Object.keys(s.receipts).length + Object.keys(s.receiptIndex).length >= 100000) throw new Error('Session request receipt limit reached.');
      s.creationKey ??= creationKey(s);
      const administrative = ['configure', 'archive', 'migrate', 'compact_receipts'].includes(operation);
      if (s.archived && !administrative) throw new Error('Session is archived. Unarchive it before editing, binding or renewing previews.');
      if (!administrative && operation !== 'bind_preview') await this.renewPreview(s, args.requestId);
      if (s.preview && !administrative && operation !== 'bind_preview') {
        const status = await this.service.nativePreviews.get(s.preview.id);
        if (status.pendingGeneration !== s.preview.generation) throw new Error('Bound preview changed externally. Bind it again using its current state before editing.');
      }
      const result = await action(s);
      if (result.version) { this.budget(s, result.version); result.version.quality = await this.quality(s, result.version); s.versions.push(result.version); s.currentVersionId = result.version.id; }
      if (result.preview !== undefined) { s.preview = result.preview; delete s.pendingRenewal; }
      const v = current(s), preview: Receipt['preview'] = result.noPreview ? { state: 'not_required' } : await this.previewRequest(s, v);
      if (!administrative) s.lastActivityAt = new Date().toISOString();
      s.revision++; s.updatedAt = new Date().toISOString();
      s.receipts[args.requestId] = { signature, operation, revision: s.revision, versionId: v.id, ...(result.version ? { output: v.source } : {}), preview };
      await this.save(s); return this.finish(s, args.requestId, false);
    });
  }
  async checkpoint(raw: z.input<typeof checkpointSessionSchema>) {
    const args = checkpointSessionSchema.parse(raw);
    return this.mutate('checkpoint', args, async s => {
      if (!args.acceptExternalChanges) await this.unchanged(current(s));
      const version = await this.capture(args.input ?? current(s).source, 'checkpoint', args.note, s.versions.length + 1, s.skeletonName); return { version };
    });
  }
  async bind(raw: z.input<typeof bindSessionSchema>) {
    const args = bindSessionSchema.parse(raw);
    return this.mutate('bind_preview', args, async s => {
      await this.unchanged(current(s));
      return { preview: args.previewId ? { id: args.previewId, generation: (await this.service.nativePreviews.get(args.previewId)).pendingGeneration } : null };
    });
  }
  async newOutput(output: string) {
    const file = await this.service.workspace.resolve(output, false);
    if (await exists(file)) throw new Error('Output exists. An interrupted uncommitted output must be inspected and explicitly checkpointed as a branch, or use a new path.');
    if (!['.json', '.spine'].includes(path.extname(file).toLowerCase())) throw new Error('Output must end in .json or .spine.');
    return file;
  }
  async edit(raw: z.input<typeof editSessionSchema>) {
    const args = editSessionSchema.parse(raw);
    return this.mutate('edit', args, async s => {
      const before = current(s); await this.unchanged(before);
      if (s.versions.length >= s.maxVersions) throw new Error('Session version limit reached.');
      const output = await this.newOutput(args.output), input = before.source, native = path.extname(input).toLowerCase() === '.spine';
      if (native && path.extname(output).toLowerCase() !== '.spine') throw new Error('Native session edits preserve all skeletons in a NEW .spine output.');
      let operationResult: unknown;
      if (native) operationResult = await editMultiProject(this.service.workspace, this.service.cli, input, output, [{ name: s.skeletonName ?? before.skeletons[0]!, edits: args.edits }]);
      else {
        if (path.extname(output).toLowerCase() !== '.json') throw new Error('JSON session edits write NEW JSON; build native separately then checkpoint that branch.');
        const data = await readDocument(input), dependencies = await snapshotEditSources(this.service.workspace, args.edits), edited = await applyEdits(data, args.edits, { workspace: this.service.workspace, jsonPath: input });
        const assets = await auditAssets(this.service.workspace, edited, input, false); if (!assets.valid) throw new Error('Edit introduces missing resources.');
        await this.unchanged(before); await assertSnapshot(assets); await assertSnapshot(dependencies);
        const diff = documentDiff(data, edited, 100); operationResult = { ...await writeDocument(this.service.workspace, output, edited, path.dirname(input)), diff };
      }
      await this.unchanged(before);
      const version = await this.capture(output, 'edit', args.note, s.versions.length + 1, s.skeletonName); version.operationResult = operationResult; return { version };
    });
  }
  async restore(raw: z.input<typeof restoreSessionSchema>) {
    const args = restoreSessionSchema.parse(raw);
    return this.mutate('restore', args, async s => {
      if (!args.acceptExternalChanges) await this.unchanged(current(s)); if (s.versions.length >= s.maxVersions) throw new Error('Session version limit reached.');
      const old = s.versions.find(v => v.id === args.versionId); if (!old) throw new Error('Historical version is not in this session.');
      const output = await this.newOutput(args.output), entries = await this.portable(old); let operationResult: unknown;
      if (path.extname(output).toLowerCase() === '.spine') operationResult = await buildProject(this.service.workspace, this.service.cli, entries, output);
      else {
        if (entries.length !== 1) throw new Error('Multi-skeleton history restores to a NEW .spine to retain every skeleton.');
        operationResult = await writeDocument(this.service.workspace, output, await readDocument(entries[0]!.input), path.dirname(entries[0]!.input));
      }
      if (!args.acceptExternalChanges) await this.unchanged(current(s));
      const version = await this.capture(output, 'restore', args.note, s.versions.length + 1, s.skeletonName); version.restoredFrom = old.id;
      version.operationResult = { result: operationResult, historicalResourcesRetained: true, originalNativeBytesInArchive: true, rebuiltNativeEditorOnlyMetadataPreservationProven: false }; return { version };
    });
  }
  async normalized(version: Version) {
    const entries = await this.portable(version), skeletons: [string, SpineDocument][] = [], resources: [string, string][] = [];
    for (const entry of entries) {
      const data = await readDocument(entry.input), refs = await resourceRefs(this.service.workspace, data, entry.input);
      const byOwner = new Map<string, string[]>();
      for (const ref of refs.refs) { const hash = await fileSha256(ref.path), key = `${ref.kind}/${ref.owner}`, values = byOwner.get(key) ?? []; values.push(hash); byOwner.set(key, values); resources.push([`${entry.name}/${key}/${ref.frame ?? 0}`, hash]); }
      for (const a of attachmentEntries(data)) if (byOwner.has(`images/${a.skin}/${a.slot}/${a.name}`)) a.value.path = `content:${digest(byOwner.get(`images/${a.skin}/${a.slot}/${a.name}`))}`;
      for (const [name, value] of Object.entries(data.events ?? {})) if (value && typeof value === 'object' && !Array.isArray(value) && byOwner.has(`audio/${name}`)) (value as Record<string, unknown>).audio = `content:${digest(byOwner.get(`audio/${name}`))}`;
      delete data.skeleton.images; delete data.skeleton.audio; delete data.skeleton.hash; skeletons.push([entry.name, data]);
    }
    // A JSON filename is not a skeleton identity; branches often have new names.
    await this.portable(version);
    return { skeletons: Object.fromEntries(skeletons.length === 1 ? [['selected', skeletons[0]![1]]] : skeletons), resources: Object.fromEntries(resources.map(([k, v]) => [entries.length === 1 ? k.slice(k.indexOf('/') + 1) : k, v])) };
  }
  async compare(id: string, fromVersionId: string, toVersionId?: string, limit = 100) {
    const s = await this.read(id), from = s.versions.find(v => v.id === uuid.parse(fromVersionId)), to = s.versions.find(v => v.id === (toVersionId ? uuid.parse(toVersionId) : s.currentVersionId));
    if (!from || !to) throw new Error('Choose historical versions from this session.');
    const before = await this.normalized(from), after = await this.normalized(to);
    return { id, fromVersionId: from.id, toVersionId: to.id, dataDiff: documentDiff(before.skeletons, after.skeletons, limit), resourceDiff: documentDiff(before.resources, after.resources, limit), originalNativeBytesEqual: from.sourceSha256 === to.sourceSha256, editorOnlyMetadataCompared: false, comparisonScope: 'Saved exported data and referenced image/audio content; archive resource relocation is normalized.' };
  }
}
