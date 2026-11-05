import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './config.js';
import type { SpineCli } from './cli.js';
import { readDocument, writeDocument, safeName } from './document.js';
import { applyEdits, type ProjectEdit } from './edits.js';
import { fileSha256, verifyRoundTrip } from './project-workflow.js';
import { checkpoint, type WorkControl } from './progress.js';
import { auditAssets, assertSnapshot, snapshotEditSources } from './production-assets.js';

export interface SkeletonInput { input: string; name: string; edits?: ProjectEdit[] }
export async function buildProject(workspace: Workspace, cli: SpineCli, entries: SkeletonInput[], output: string, control?: WorkControl, extraSources: { input: string; sha256: string }[] = []) {
  if (!entries.length || entries.length > 50 || new Set(entries.map(item => item.name)).size !== entries.length) throw new Error('Provide 1–50 uniquely named skeletons.');
  const destination = await workspace.resolve(output, false);
  if (path.extname(destination).toLowerCase() !== '.spine') throw new Error('Output must end in .spine.');
  try { await stat(destination); throw new Error('Output exists; choose a new project name.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sources = [...new Set(entries.map(item => item.input))], hashes = new Map<string, string>();
  for (const source of sources) { const filename = await workspace.resolve(source); hashes.set(filename, await fileSha256(filename)); }
  for (const source of extraSources) {
    const filename = await workspace.resolve(source.input);
    if (await fileSha256(filename) !== source.sha256) throw new Error('Project changed after export. Retry after saving.');
    hashes.set(filename, source.sha256);
  }
  const root = await workspace.resolve('.jobs', false); await mkdir(root, { recursive: true }); const job = await mkdtemp(path.join(root, 'build-project-'));
  const working: { input: string; name: string }[] = [], resources: Awaited<ReturnType<typeof auditAssets>>[] = [], dependencies = await snapshotEditSources(workspace, entries.flatMap(entry => entry.edits ?? []));
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!; safeName(entry.name);
    await checkpoint(control, { phase: 'edit', completed: index, total: entries.length, detail: entry.name });
    const input = await workspace.resolve(entry.input), source = await readDocument(input);
    resources.push(await auditAssets(workspace, source, input, false));
    const data = entry.edits?.length ? await applyEdits(source, entry.edits, { workspace, jsonPath: input }) : source;
    if (entry.edits?.length) resources.push(await auditAssets(workspace, data, input, false));
    const written = await writeDocument(workspace, path.join(job, `${index}.json`), data, path.dirname(input)); working.push({ input: written.path, name: entry.name });
  }
  await mkdir(path.dirname(destination), { recursive: true }); const candidate = path.join(path.dirname(destination), `.mcp-build-${randomUUID()}.spine`);
  let ownCandidate = false;
  try {
    await cli.importSkeletons(working, candidate, control); ownCandidate = true;
    await checkpoint(control, { phase: 'verify', completed: 0, total: entries.length });
    const exported = await cli.exportData(candidate), files = exported.files.filter(file => file.toLowerCase().endsWith('.json'));
    if (files.length !== entries.length || entries.some(entry => !files.some(file => path.basename(file, '.json') === entry.name))) throw new Error('Skeleton identities changed during import. No output was published.');
    const checks = [];
    for (let index = 0; index < working.length; index++) {
      const entry = working[index]!, actual = files.find(file => path.basename(file, '.json') === entry.name)!;
      checks.push({ skeleton: entry.name, expected: entry.input, actual, verification: verifyRoundTrip(await readDocument(entry.input), await readDocument(actual), entry.input, actual) });
      await checkpoint(control, { phase: 'verify', completed: index + 1, total: entries.length, detail: entry.name });
    }
    for (const [filename, hash] of hashes) if (await fileSha256(filename) !== hash) throw new Error(`Source changed during the build: ${filename}. No output was published.`);
    for (const snapshot of resources) await assertSnapshot(snapshot); await assertSnapshot(dependencies);
    await checkpoint(control, { phase: 'publish', completed: 0, total: 1 });
    const reportPath = path.join(job, 'verification.json'), report = { output: destination, skeletons: entries.map(item => item.name), checks, binaryGeometryReadback: exported.geometryReadback ?? [], originalUnchanged: true, sources: Object.fromEntries(hashes), note: 'Rebuilt from all exported skeletons; retains checked runtime data. Keep original project for editor-only information.' };
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); await copyFile(candidate, destination, constants.COPYFILE_EXCL);
    return { ...report, reportPath };
  } finally { if (ownCandidate) await unlink(candidate).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
export async function editMultiProject(workspace: Workspace, cli: SpineCli, input: string, output: string, changes: { name: string; edits: ProjectEdit[] }[], control?: WorkControl) {
  const source = await workspace.resolve(input);
  if (path.extname(source).toLowerCase() !== '.spine') throw new Error('Multi-project edit requires a saved .spine project. Build from JSON with spine_build_project.');
  const hash = await fileSha256(source), exported = await cli.exportData(source), files = exported.files.filter(file => file.toLowerCase().endsWith('.json'));
  if (!changes.length || new Set(changes.map(item => item.name)).size !== changes.length) throw new Error('Provide unique skeleton names to edit.');
  for (const change of changes) if (!files.some(file => path.basename(file, '.json') === change.name)) throw new Error(`Missing skeleton: ${change.name}`);
  if (await fileSha256(source) !== hash) throw new Error('Project changed during export. Retry after saving.');
  return buildProject(workspace, cli, files.map(file => ({ input: file, name: path.basename(file, '.json'), edits: changes.find(item => item.name === path.basename(file, '.json'))?.edits })), output, control, [{ input: source, sha256: hash }]);
}
