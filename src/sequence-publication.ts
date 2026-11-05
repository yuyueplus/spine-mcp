import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import type { Workspace } from './config.js';
import type { NativePreviewStatus } from './native-preview.js';
import { atomicJson } from './jobs.js';
import { fileSha256 } from './file-hash.js';
import { replaceFile } from './file-replace.js';

export interface SequencePublication { id: string; generation: number; publishedAt: string; changedImages: number; frameCount: number }
interface Entry { name: string; before: string | null; after: string }
interface Journal { version: 1; id: string; previous: NativePreviewStatus; entries: Entry[] }
export interface PublicationImage { name: string; source: string; sha256: string }
type Replace = typeof replaceFile;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const imageName = /^(?:preview|frame-\d{4})\.png$/;
const journalName = 'sequence-publication.json';
const currentHash = async (file: string) => fileSha256(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
function assignStatus(status: NativePreviewStatus, replacement: NativePreviewStatus) {
  for (const key of Object.keys(status)) delete (status as unknown as Record<string, unknown>)[key];
  Object.assign(status, replacement);
}
async function locations(workspace: Workspace, folder: string, id: string) {
  if (!uuid.test(id)) throw new Error('Invalid sequence publication ID.');
  folder = await workspace.resolve(folder);
  const directory = await workspace.resolve(path.join(folder, `publication-${id}`), false);
  if (path.dirname(directory) !== folder) throw new Error('Publication backup is outside the managed preview.');
  return { folder, directory, journal: path.join(folder, journalName), status: path.join(folder, 'status.json') };
}
async function cleanup(workspace: Workspace, folder: string, id: string) {
  const files = await locations(workspace, folder, id);
  await unlink(files.journal);
  // Resolve the absolute directory again before a recursive removal on Windows.
  const target = await workspace.resolve(files.directory, false);
  if (path.dirname(target) !== files.folder || path.basename(target) !== `publication-${id}`) throw new Error('Invalid publication cleanup path.');
  await rm(target, { recursive: true, force: true });
}

/** Caller holds the preview request/worker lease. Uncommitted files are restored
 * only when their bytes still match our old or new revision. Conflicting external
 * changes retain the journal and backups for inspection instead of being replaced. */
export async function recoverSequencePublication(workspace: Workspace, folder: string, status: NativePreviewStatus, replace: Replace = replaceFile) {
  const journalFile = await workspace.resolve(path.join(folder, journalName), false);
  let journal: Journal;
  try {
    if ((await stat(journalFile)).size > 8 * 1024 * 1024) throw new Error('Sequence publication journal exceeds 8 MiB.');
    journal = JSON.parse(await readFile(journalFile, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (journal.version !== 1 || !uuid.test(journal.id) || !journal.previous || journal.previous.id !== path.basename(folder) || !Array.isArray(journal.entries) || journal.entries.length < 1 || journal.entries.length > 601 || new Set(journal.entries.map(e => e.name)).size !== journal.entries.length || journal.entries.some(e => !imageName.test(e.name) || e.before !== null && !hash.test(e.before) || !hash.test(e.after))) throw new Error('Invalid sequence publication journal.');
  const files = await locations(workspace, folder, journal.id), disk = JSON.parse(await readFile(files.status, 'utf8')) as NativePreviewStatus;
  const committed = disk.sequencePublication?.id === journal.id;
  // Validate the entire rollback before changing even its first target.
  for (const entry of journal.entries) {
    const target = await workspace.resolve(path.join(folder, 'images', entry.name), false), actual = await currentHash(target);
    if (committed ? actual !== entry.after : actual !== entry.before && actual !== entry.after) throw new Error(`Sequence publication conflict: ${entry.name} changed externally. Journal and backups retained.`);
    if (!committed && entry.before !== null && entry.before !== entry.after && await fileSha256(await workspace.resolve(path.join(files.directory, 'before', entry.name))) !== entry.before) throw new Error(`Sequence rollback backup changed: ${entry.name}. Journal retained.`);
  }
  if (!committed) {
    for (const entry of journal.entries) {
      const target = await workspace.resolve(path.join(folder, 'images', entry.name), false), actual = await currentHash(target);
      if (actual === entry.before) continue;
      if (actual !== entry.after) throw new Error(`Sequence rollback conflict: ${entry.name} changed externally. Journal retained.`);
      if (entry.before === null) await unlink(target);
      else {
        const temporary = await workspace.resolve(path.join(files.directory, `restore-${entry.name}`), false);
        await copyFile(await workspace.resolve(path.join(files.directory, 'before', entry.name)), temporary);
        if (await fileSha256(temporary) !== entry.before) throw new Error('Sequence rollback copy failed verification.');
        await replace(temporary, target);
      }
    }
    for (const entry of journal.entries) if (await currentHash(await workspace.resolve(path.join(folder, 'images', entry.name), false)) !== entry.before) throw new Error('Sequence rollback target verification failed. Journal retained.');
    const restored = { ...journal.previous, publicationRecovery: { id: journal.id, state: 'rolled_back' as const, recoveredAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
    await atomicJson(files.status, restored); assignStatus(status, restored);
  } else assignStatus(status, disk);
  await cleanup(workspace, folder, journal.id);
  return { id: journal.id, state: committed ? 'committed' as const : 'rolled_back' as const, images: journal.entries.length };
}

/** Recoverable disk transaction, NOT an atomic multi-texture switch in Spine.
 * All source images and old bytes are staged outside the watched image directory.
 * The status publication ID is the commit marker, written after all file checks. */
export async function publishSequenceImages(workspace: Workspace, folder: string, status: NativePreviewStatus, previous: NativePreviewStatus, images: PublicationImage[], next: NativePreviewStatus, validate: () => Promise<void>, replace: Replace = replaceFile) {
  await recoverSequencePublication(workspace, folder, status, replace);
  if (!images.length || images.length > 601 || new Set(images.map(e => e.name)).size !== images.length || images.some(e => !imageName.test(e.name) || !hash.test(e.sha256))) throw new Error('Invalid sequence publication inventory.');
  const id = randomUUID(), files = await locations(workspace, folder, id), entries: Entry[] = [];
  await mkdir(path.join(files.directory, 'before'), { recursive: true }); await mkdir(path.join(files.directory, 'after'));
  let journalWritten = false;
  try {
    let backupBytes = 0;
    for (const image of images) {
      const source = await workspace.resolve(image.source), target = await workspace.resolve(path.join(folder, 'images', image.name), false), before = await currentHash(target);
      if (await fileSha256(source) !== image.sha256) throw new Error('Cached sequence image changed before staging.');
      entries.push({ name: image.name, before, after: image.sha256 });
      if (before === image.sha256) continue;
      if (before !== null) {
        backupBytes += (await stat(target)).size; if (backupBytes > 128 * 1024 * 1024) throw new Error('Sequence rollback backups exceed 128 MiB.');
        const backup = path.join(files.directory, 'before', image.name); await copyFile(target, backup);
        if (await fileSha256(backup) !== before) throw new Error('Previous sequence image changed during backup.');
      }
      const staged = path.join(files.directory, 'after', image.name); await copyFile(source, staged);
      if (await fileSha256(staged) !== image.sha256) throw new Error('Staged sequence image changed.');
    }
    await validate();
    for (const entry of entries) if (await currentHash(await workspace.resolve(path.join(folder, 'images', entry.name), false)) !== entry.before) throw new Error('Sequence image changed before publication.');
    const journal: Journal = { version: 1, id, previous, entries };
    if (Buffer.byteLength(JSON.stringify(journal)) > 8 * 1024 * 1024) throw new Error('Sequence publication journal exceeds 8 MiB.');
    await atomicJson(files.journal, journal); journalWritten = true;
    for (const entry of entries) if (entry.before !== entry.after) {
      const target = await workspace.resolve(path.join(folder, 'images', entry.name), false);
      if (await currentHash(target) !== entry.before) throw new Error('Sequence image changed during publication.');
      await replace(await workspace.resolve(path.join(files.directory, 'after', entry.name)), target);
    }
    await validate();
    for (const entry of entries) if (await currentHash(await workspace.resolve(path.join(folder, 'images', entry.name))) !== entry.after) throw new Error('Published sequence image failed verification.');
    const publication: SequencePublication = { id, generation: next.generation, frameCount: images.length - 1, changedImages: entries.filter(e => e.before !== e.after).length, publishedAt: new Date().toISOString() };
    next.sequencePublication = publication; next.updatedAt = publication.publishedAt;
    await atomicJson(files.status, next); assignStatus(status, next);
    await cleanup(workspace, folder, id); return publication;
  } catch (error) {
    if (journalWritten) {
      try {
        const recovery = await recoverSequencePublication(workspace, folder, status, replace);
        if (recovery?.state === 'committed') return status.sequencePublication!;
      } catch (rollback) { throw new Error(`Sequence publication failed: ${(error as Error).message}; recovery requires attention: ${(rollback as Error).message}`); }
    } else {
      const target = await workspace.resolve(files.directory, false);
      if (path.dirname(target) !== files.folder || path.basename(target) !== `publication-${id}`) throw new Error('Invalid publication cleanup path.');
      await rm(target, { recursive: true, force: true });
    }
    throw error;
  }
}
