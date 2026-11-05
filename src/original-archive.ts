import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import type { SpineService } from './service.js';
import { readDocument } from './document.js';
import { collectAssets, auditAssets, assertSnapshot } from './production-assets.js';
import { fileSha256 } from './file-hash.js';

export async function archiveProject(service: SpineService, input: string) {
  const source = await service.workspace.resolve(input), format = path.extname(source).toLowerCase(); if (!['.spine', '.json'].includes(format)) throw new Error('Original-project archiving requires a saved .spine or Spine JSON file.');
  const hash = await fileSha256(source), exports = format === '.json' ? { files: [source] } : await service.cli.exportData(source), directory = await service.workspace.resolve(path.join('archives', `original-${randomUUID()}`), false); await mkdir(directory, { recursive: true });
  const originalName = `original${format}`, original = path.join(directory, originalName); await copyFile(source, original, constants.COPYFILE_EXCL); if (await fileSha256(original) !== hash) throw new Error('Source changed while archiving original bytes.');
  const previews: { skeleton: string; directory: string; json: string }[] = [], snapshots: Awaited<ReturnType<typeof auditAssets>>[] = [];
  for (const [index, filename] of exports.files.filter(file => file.endsWith('.json')).entries()) {
    const data = await readDocument(filename), snapshot = await auditAssets(service.workspace, data, filename, false); if (!snapshot.valid) throw new Error('Cannot archive a project with missing referenced resources.'); snapshots.push(snapshot);
    const collected = await collectAssets(service.workspace, data, filename), target = path.join(directory, `preview-${index}`); await cp(collected.directory, target, { recursive: true, force: false, errorOnExist: true }); previews.push({ skeleton: path.basename(filename, '.json'), directory: path.basename(target), json: `${path.basename(target)}/skeleton.json` });
  }
  for (const snapshot of snapshots) await assertSnapshot(snapshot); if (await fileSha256(source) !== hash) throw new Error('Original project changed during archiving.');
  const files: { path: string; bytes: number; sha256: string }[] = []; let bytes = 0;
  const walk = async (folder: string): Promise<void> => { for (const item of await readdir(folder, { withFileTypes: true })) { if (item.isSymbolicLink()) throw new Error('Archives reject symbolic links.'); const filename = path.join(folder, item.name); if (item.isDirectory()) await walk(filename); else { const size = (await stat(filename)).size; bytes += size; if (bytes > 1024 ** 3 || files.length >= 20000) throw new Error('Archive exceeds 1 GiB or 20,000 files.'); files.push({ path: path.relative(directory, filename).replaceAll('\\', '/'), bytes: size, sha256: await fileSha256(filename) }); } } }; await walk(directory);
  const manifest = { schemaVersion: 1, kind: 'original-project-archive', complete: true, targetVersion: '4.3.23', source, sourceHash: hash, savedFormat: format.slice(1), original: originalName, originalProjectByteExact: true, editorOnlyMetadataRetainedInOriginal: format === '.spine', editedProjectMetadataPreservationProven: false, previews, files, note: 'Original saved file bytes and resources retained. Portable collected JSON previews have rebased resource paths. The byte-identical original still contains its original resource paths. Native editor-only information is retained only when the input is a native .spine file; editing/reimport cannot prove every editor-only field is preserved.' }, manifestPath = path.join(directory, 'archive.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' }); return { directory, manifestPath, original, previews, files: files.length, originalProjectByteExact: true, sourceUnchanged: true, complete: true };
}
export async function verifyArchive(service: SpineService, input: string) {
  const filename = await service.workspace.resolve(input), manifest = JSON.parse(await readFile(filename, 'utf8')) as { kind: string; complete: boolean; original: string; sourceHash: string; previews: { json: string }[]; files: { path: string; sha256: string }[] };
  if (manifest.kind !== 'original-project-archive' || !manifest.complete || !Array.isArray(manifest.files) || manifest.files.length > 20000 || !Array.isArray(manifest.previews)) throw new Error('Invalid original-project archive.');
  const directory = path.dirname(filename), canonicalDirectory = await realpath(directory), issues: string[] = [];
  const inside = (relative: string) => { const file = path.resolve(directory, relative), result = path.relative(directory, file); if (!relative || path.isAbsolute(relative) || result === '..' || result.startsWith(`..${path.sep}`) || path.isAbsolute(result)) throw new Error('Archive reference escapes its directory.'); return file; };
  const checked = async (relative: string) => { const file = await service.workspace.resolve(inside(relative)), canonical = await realpath(file), result = path.relative(canonicalDirectory, canonical); if (result === '..' || result.startsWith(`..${path.sep}`) || path.isAbsolute(result)) throw new Error('Archive symbolic link escapes its directory.'); return file; };
  for (const entry of manifest.files) { try { if (await fileSha256(await checked(entry.path)) !== entry.sha256) issues.push(`Hash differs: ${entry.path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; issues.push(`Missing: ${entry.path}`); } }
  if (!manifest.files.some(file => file.path === manifest.original && file.sha256 === manifest.sourceHash)) issues.push('Original project hash is not recorded.');
  for (const preview of manifest.previews) { const file = await checked(preview.json); if (!manifest.files.some(entry => entry.path === preview.json)) issues.push(`Preview is not hashed: ${preview.json}`); const result = await auditAssets(service.workspace, await readDocument(file), file, false); if (!result.valid) issues.push(`Missing portable preview resources: ${preview.json}`); for (const resource of result.files) { const relative = path.relative(directory, resource.path).replaceAll('\\', '/'); if (relative.startsWith('../') || path.isAbsolute(relative) || !manifest.files.some(entry => entry.path === relative && entry.sha256 === resource.sha256)) issues.push(`Preview resource is outside the hashed archive: ${resource.path}`); else await checked(relative); } }
  return { valid: !issues.length, checkedFiles: manifest.files.length, originalProjectByteExact: !issues.length, issues };
}
