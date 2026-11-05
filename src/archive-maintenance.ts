import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, rename, rm, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { atomicJson, exists } from './jobs.js';
import { fileSha256 } from './file-hash.js';
import { verifyArchive } from './original-archive.js';
import { syncLease } from './sync-lock.js';
import { checkpoint, type WorkControl } from './progress.js';

const uuid = z.string().uuid(), sha = z.string().regex(/^[a-f0-9]{64}$/), bounds = { maxFiles: z.number().int().min(100).max(500000).default(100000), maxNativeProjects: z.number().int().min(0).max(1000).default(100) };
export const cleanupPlanSchema = z.object({ archiveIds: z.array(uuid).min(1).max(100).optional(), minAgeHours: z.number().finite().min(0).max(87600).default(24), ...bounds }).strict();
export const cleanupApplySchema = z.object({ planId: uuid, expectedPlanSha256: sha, requestId: uuid }).strict();
export const cleanupRestoreSchema = z.object({ cleanupId: uuid, requestId: uuid }).strict();
export const cleanupPurgeSchema = z.object({ cleanupId: uuid, requestId: uuid, expectedFingerprint: sha, confirmation: z.literal('permanently_delete_quarantined_archives') }).strict();
type Options = z.infer<typeof cleanupPlanSchema>;
type Entry = { id: string; manifestSha256: string; bytes: number; state: 'planned' | 'moved' | 'restored' | 'purged' };
type Journal = { schema: 'spine-archive-cleanup/1'; id: string; requestId: string; planSha256: string; options: Options; state: 'moving' | 'quarantined' | 'restoring' | 'restored' | 'purging' | 'purged' | 'rolled_back'; entries: Entry[]; restoreRequestId?: string; purgeRequestId?: string };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class ArchiveMaintenance {
  constructor(readonly service: SpineService) {}
  async root() { const root = await this.service.workspace.resolve('.archive-maintenance', false); await mkdir(root, { recursive: true }); return root; }
  async source(id: string, existing = true) { uuid.parse(id); return this.service.workspace.resolve(path.join('archives', 'original-' + id), existing); }
  async trash(planId: string, archiveId: string, existing = false) { uuid.parse(planId); uuid.parse(archiveId); return this.service.workspace.resolve(path.join(await this.root(), 'trash', planId, archiveId), existing); }
  async locked<T>(action: () => Promise<T>) { const release = await syncLease(this.service.workspace, path.join(await this.root(), 'maintenance.lock')); if (!release) throw new Error('Archive maintenance is busy. Retry the same request.'); try { return await action(); } finally { await release(); } }
  async journal(id: string) {
    uuid.parse(id); const file = await this.service.workspace.resolve(path.join(await this.root(), id + '.json')); if ((await stat(file)).size > 1024 ** 2) throw new Error('Cleanup journal too large.');
    const j = JSON.parse(await readFile(file, 'utf8')) as Journal; if (j.schema !== 'spine-archive-cleanup/1' || j.id !== id || !Array.isArray(j.entries) || j.entries.length > 100) throw new Error('Invalid cleanup journal.');
    uuid.parse(j.requestId); sha.parse(j.planSha256); j.options = cleanupPlanSchema.parse(j.options); z.enum(['moving', 'quarantined', 'restoring', 'restored', 'purging', 'purged', 'rolled_back']).parse(j.state);
    for (const e of j.entries) { uuid.parse(e.id); sha.parse(e.manifestSha256); z.number().finite().nonnegative().parse(e.bytes); z.enum(['planned', 'moved', 'restored', 'purged']).parse(e.state); }
    const planFile = await this.service.workspace.resolve(path.join(await this.root(), id + '-plan.json')); if ((await stat(planFile)).size > 1024 ** 2 || await fileSha256(planFile) !== j.planSha256) throw new Error('Cleanup journal no longer matches its reviewed plan.');
    const plan = JSON.parse(await readFile(planFile, 'utf8')), expected = plan.candidates.filter((e: { eligible: boolean }) => e.eligible).map((e: Entry) => [e.id, e.manifestSha256, e.bytes]);
    if (plan.id !== id || digest(expected) !== digest(j.entries.map(e => [e.id, e.manifestSha256, e.bytes])) || digest(cleanupPlanSchema.parse(plan.options)) !== digest(j.options)) throw new Error('Cleanup journal entries differ from the reviewed plan.');
    return j;
  }
  async save(j: Journal) { await atomicJson(path.join(await this.root(), j.id + '.json'), j); }
  view(j: Journal) { return { ...j, purgeFingerprint: digest({ id: j.id, planSha256: j.planSha256, entries: j.entries.map(e => [e.id, e.manifestSha256]) }), physicalBytesReclaimed: j.state === 'purged' ? j.entries.reduce((n, e) => n + e.bytes, 0) : 0, note: 'Quarantine is reversible and does not reclaim physical disk space. Only an explicit permanent purge removes quarantined bytes. Saved project/resource references are scanned; unsaved editor memory and arbitrary external programs are outside this snapshot.' }; }
  async assertTree(folder: string, maxFiles: number, recorded?: Set<string>) {
    if ((await lstat(folder)).isSymbolicLink()) throw new Error('Cleanup rejects symbolic links/junctions at the archive root.');
    let files = 0; const walk = async (dir: string): Promise<void> => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = await this.service.workspace.resolve(path.join(dir, e.name)); if (e.isSymbolicLink() || (await lstat(p)).isSymbolicLink()) throw new Error('Cleanup rejects symbolic links/junctions.'); if (e.isDirectory()) await walk(p); else { if (++files > maxFiles) throw new Error('Cleanup archive tree exceeds the file budget.'); if (recorded && !recorded.has(path.relative(folder, p).replaceAll('\\', '/'))) throw new Error('Archive contains unrecorded files; cleanup will not remove them.'); } } }; await walk(folder);
  }
  async checked(folder: string, expected?: string) {
    const manifest = await this.service.workspace.resolve(path.join(folder, 'archive.json')), hash = await fileSha256(manifest); if (expected && hash !== expected) throw new Error('Archive manifest changed after planning.');
    const verified = await verifyArchive(this.service, manifest); if (!verified.valid) throw new Error('Archive contents changed or are incomplete.');
    const data = JSON.parse(await readFile(manifest, 'utf8')); await this.assertTree(folder, 20001, new Set(['archive.json', ...data.files.map((f: { path: string }) => f.path)])); return { hash, bytes: data.files.reduce((n: number, f: { bytes: number }) => n + f.bytes, 0) + (await stat(manifest)).size };
  }
  async references(ids: string[], o: Options, control?: WorkControl) {
    const refs = new Map(ids.map(id => [id, [] as string[]])), files: string[] = [], root = this.service.workspace.root;
    const walk = async (folder: string): Promise<void> => { for (const e of await readdir(folder, { withFileTypes: true })) {
      const p = await this.service.workspace.resolve(path.join(folder, e.name));
      if (folder === root && ['archives', '.archive-maintenance'].includes(e.name)) continue;
      if (e.isSymbolicLink()) throw new Error('Reference scan found a symbolic link; cleanup refuses incomplete visibility.');
      if (e.isDirectory()) await walk(p); else { if (files.length >= o.maxFiles) throw new Error('Reference scan file budget exceeded. Increase maxFiles or use a smaller workspace.'); files.push(p); }
    } }; await walk(root);
    const mark = (value: unknown, owner: string) => { const text = typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value).toLowerCase(); for (const id of ids) if (text.includes(id.toLowerCase())) { const list = refs.get(id)!; if (list.length < 100 && !list.includes(owner)) list.push(owner); } };
    let natives = 0;
    for (const [index, p] of files.entries()) {
      if (index % 100 === 0) await checkpoint(control, { phase: 'archive-reference-scan', completed: index, total: files.length });
      const ext = path.extname(p).toLowerCase();
      if (ext === '.spine') { if (++natives > o.maxNativeProjects) throw new Error('Native project reference budget exceeded; cleanup refuses incomplete visibility.'); const exported = await this.service.cli.exportData(p); for (const file of exported.files.filter(f => f.endsWith('.json'))) mark(JSON.parse(await readFile(file, 'utf8')), p); }
      else if (['.json', '.atlas', '.html', '.svg', '.toml', '.yaml', '.yml', '.ini', '.txt'].includes(ext)) {
        if ((await stat(p)).size > 16 * 1024 ** 2) throw new Error(`Reference file too large to scan safely: ${p}`);
        const text = await readFile(p, 'utf8'); if (ext === '.json') { try { const data = JSON.parse(text), diagnostic = path.relative(root, p).split(path.sep)[0] === 'reports' && !(data?.skeleton && Array.isArray(data.bones)); if (!diagnostic) mark(data, p); } catch { throw new Error(`Cannot parse reference JSON; cleanup refuses partial visibility: ${p}`); } } else mark(text, p);
      }
    }
    return { refs, scannedFiles: files.length, scannedNativeProjects: natives };
  }
  async plan(raw: z.input<typeof cleanupPlanSchema>, control?: WorkControl) {
    const o = cleanupPlanSchema.parse(raw), archives = await this.service.workspace.resolve('archives', false); await mkdir(archives, { recursive: true });
    const ids = o.archiveIds ?? (await readdir(archives, { withFileTypes: true })).filter(e => e.isDirectory() && e.name.startsWith('original-') && uuid.safeParse(e.name.slice(9)).success).map(e => e.name.slice(9));
    if (ids.length > 100) throw new Error('Select at most 100 explicit archive IDs.'); if (new Set(ids).size !== ids.length) throw new Error('Archive IDs must be unique.');
    const scanned = await this.references(ids, o, control), candidates = [];
    for (const id of ids) { const folder = await this.source(id), entry = await this.checked(folder); await this.assertTree(folder, o.maxFiles); const ageHours = (Date.now() - (await stat(folder)).mtimeMs) / 3600000, references = scanned.refs.get(id)!; candidates.push({ id, manifestSha256: entry.hash, bytes: entry.bytes, ageHours, references, eligible: !references.length && ageHours >= o.minAgeHours }); }
    const id = randomUUID(), plan = { schema: 'spine-archive-cleanup-plan/1', id, options: o, candidates, scannedFiles: scanned.scannedFiles, scannedNativeProjects: scanned.scannedNativeProjects, eligibleBytes: candidates.filter(e => e.eligible).reduce((n, e) => n + e.bytes, 0), createdAt: new Date().toISOString(), sourceFilesChanged: false, dryRun: true, scanScope: 'Saved JSON metadata/projects, native .spine exported data, atlas and common reference text. Session history and shared image/audio paths protect archives. Diagnostic reports are excluded; their old links may need restored quarantine. Archive interiors are self-contained portable snapshots. External/unsaved writes cannot be locked by this tool.' };
    const file = path.join(await this.root(), id + '-plan.json'); await writeFile(file, JSON.stringify(plan, null, 2), { flag: 'wx' }); return { ...plan, planPath: file, planSha256: await fileSha256(file) };
  }
  async apply(raw: z.input<typeof cleanupApplySchema>, control?: WorkControl) {
    const o = cleanupApplySchema.parse(raw); return this.locked(async () => {
      const journalPath = path.join(await this.root(), o.planId + '.json'); let j: Journal;
      if (await exists(journalPath)) { j = await this.journal(o.planId); if (j.requestId !== o.requestId || j.planSha256 !== o.expectedPlanSha256) throw new Error('Cleanup plan already belongs to different request arguments.'); if (j.state !== 'moving') return { ...this.view(j), reused: true }; }
      else {
        const file = await this.service.workspace.resolve(path.join(await this.root(), o.planId + '-plan.json')); if ((await stat(file)).size > 1024 ** 2 || await fileSha256(file) !== o.expectedPlanSha256) throw new Error('Cleanup plan changed.');
        const plan = JSON.parse(await readFile(file, 'utf8')); if (plan.schema !== 'spine-archive-cleanup-plan/1' || plan.id !== o.planId || plan.candidates.length > 100) throw new Error('Invalid cleanup plan.');
        j = { schema: 'spine-archive-cleanup/1', id: o.planId, requestId: o.requestId, planSha256: o.expectedPlanSha256, options: cleanupPlanSchema.parse(plan.options), state: 'moving', entries: plan.candidates.filter((e: { eligible: boolean }) => e.eligible).map((e: Entry) => ({ id: uuid.parse(e.id), manifestSha256: sha.parse(e.manifestSha256), bytes: e.bytes, state: 'planned' })) }; if (!j.entries.length) throw new Error('Plan has no eligible orphan archives.'); await this.save(j);
      }
      try {
        const scanned = await this.references(j.entries.map(e => e.id), j.options, control); if ([...scanned.refs.values()].some(r => r.length)) throw new Error('Archive gained a saved reference after planning.');
        for (const e of j.entries) {
          const source = await this.source(e.id, false), trash = await this.trash(j.id, e.id); if (await exists(source) && await exists(trash)) throw new Error('Both original and quarantine archive paths exist.');
          if (await exists(source)) { if ((Date.now() - (await stat(source)).mtimeMs) / 3600000 < j.options.minAgeHours) throw new Error('Archive was recently touched after planning.'); await this.checked(source, e.manifestSha256); await this.assertTree(source, j.options.maxFiles); await mkdir(path.dirname(trash), { recursive: true }); await this.service.workspace.resolve(source); await this.service.workspace.resolve(trash, false); await rename(source, trash); }
          else await this.checked(await this.trash(j.id, e.id, true), e.manifestSha256);
          e.state = 'moved'; await this.save(j); await checkpoint(control, { phase: 'archive-quarantine', completed: j.entries.filter(e => e.state === 'moved').length, total: j.entries.length });
        }
        const after = await this.references(j.entries.map(e => e.id), j.options, control); if ([...after.refs.values()].some(r => r.length)) throw new Error('New saved references appeared while moving archives.');
        j.state = 'quarantined'; await this.save(j); return { ...this.view(j), reused: false };
      } catch (error) { await this.moveBack(j); j.state = 'rolled_back'; await this.save(j); throw error; }
    });
  }
  async moveBack(j: Journal) {
    for (const e of j.entries) {
      if (e.state === 'purged') throw new Error('A permanently purged archive cannot be restored.');
      const source = await this.source(e.id, false), trash = await this.trash(j.id, e.id);
      if (await exists(trash)) { if (await exists(source)) throw new Error('Restore refuses an existing original archive path.'); await this.checked(trash, e.manifestSha256); await this.assertTree(trash, j.options.maxFiles); await this.service.workspace.resolve(source, false); await this.service.workspace.resolve(trash); await rename(trash, source); }
      else await this.checked(await this.source(e.id), e.manifestSha256);
      e.state = 'restored'; await this.save(j);
    }
  }
  async restore(raw: z.input<typeof cleanupRestoreSchema>) {
    const o = cleanupRestoreSchema.parse(raw); return this.locked(async () => { const j = await this.journal(o.cleanupId); if (['purging', 'purged'].includes(j.state)) throw new Error('Purge has started; restoration is unavailable.'); if (j.restoreRequestId && j.restoreRequestId !== o.requestId) throw new Error('Restore request ID differs.'); if (j.state === 'restored') return { ...this.view(j), reused: true }; j.restoreRequestId = o.requestId; j.state = 'restoring'; await this.save(j); await this.moveBack(j); j.state = 'restored'; await this.save(j); return { ...this.view(j), reused: false }; });
  }
  async purge(raw: z.input<typeof cleanupPurgeSchema>, control?: WorkControl) {
    const o = cleanupPurgeSchema.parse(raw); return this.locked(async () => {
      const j = await this.journal(o.cleanupId); if (this.view(j).purgeFingerprint !== o.expectedFingerprint || j.purgeRequestId && j.purgeRequestId !== o.requestId) throw new Error('Purge fingerprint/request differs.'); if (j.state === 'purged') return { ...this.view(j), reused: true }; if (!['quarantined', 'purging'].includes(j.state)) throw new Error('Only quarantined archives can be permanently purged.');
      const scanned = await this.references(j.entries.map(e => e.id), j.options, control); if ([...scanned.refs.values()].some(r => r.length)) throw new Error('Saved references now use this archive; restore it instead of purging.');
      j.purgeRequestId = o.requestId; j.state = 'purging'; await this.save(j);
      for (const e of j.entries) {
        const target = await this.trash(j.id, e.id); if (await exists(target)) { await this.checked(target, e.manifestSha256); await this.assertTree(target, j.options.maxFiles); const checked = await this.service.workspace.resolve(target), parent = await this.service.workspace.resolve(path.join(await this.root(), 'trash', j.id)); if (path.dirname(checked) !== parent || path.basename(checked) !== e.id) throw new Error('Purge target containment changed.'); await rm(checked, { recursive: true }); }
        e.state = 'purged'; await this.save(j);
      }
      j.state = 'purged'; await this.save(j); return { ...this.view(j), reused: false };
    });
  }
}
