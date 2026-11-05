import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Workspace } from './config.js';
import { attachmentEntries } from './attachment-data.js';
import { object, parseDocument, readDocument, type SpineDocument } from './document.js';
import { fileSha256 } from './file-hash.js';

export interface ResourceRef { kind: 'images' | 'audio'; path: string; relative: string; owner: string; frame?: number }
export async function resourceRefs(workspace: Workspace, data: SpineDocument, jsonPath: string) {
  const roots = { images: await workspace.resolve(path.resolve(path.dirname(jsonPath), String(data.skeleton.images ?? '.')), false), audio: await workspace.resolve(path.resolve(path.dirname(jsonPath), String(data.skeleton.audio ?? '.')), false) };
  const refs: ResourceRef[] = [];
  for (const item of attachmentEntries(data)) {
    if (!['region', 'mesh', 'linkedmesh'].includes(String(item.value.type ?? 'region'))) continue;
    const base = String(item.value.path ?? item.value.name ?? item.name), seq = item.value.sequence === undefined ? undefined : object(item.value.sequence, 'sequence');
    for (let index = 0; index < Number(seq?.count ?? 1); index++) {
      const relative = `${base}${seq ? String(index + Number(seq.start ?? 1)).padStart(Number(seq.digits ?? 0), '0') : ''}.png`;
      refs.push({ kind: 'images', path: await workspace.resolve(path.resolve(roots.images, relative), false), relative, owner: `${item.skin}/${item.slot}/${item.name}`, ...(seq ? { frame: index } : {}) });
    }
  }
  for (const [name, raw] of Object.entries(data.events ?? {})) {
    const value = object(raw, 'event'); if (typeof value.audio === 'string' && value.audio) refs.push({ kind: 'audio', path: await workspace.resolve(path.resolve(roots.audio, value.audio), false), relative: value.audio, owner: name });
  }
  if (refs.length > 100000) throw new Error('Resource audit exceeds 100,000 references.');
  return { roots, refs };
}
export async function auditAssets(workspace: Workspace, data: SpineDocument, jsonPath: string, scanUnused = true) {
  const { roots, refs } = await resourceRefs(workspace, data, jsonPath), files: { path: string; bytes: number; sha256: string; owners: string[] }[] = [], missing: ResourceRef[] = [], scanned = new Set<string>();
  const refsByPath = new Map<string, ResourceRef[]>(); for (const ref of refs) { const group = refsByPath.get(ref.path) ?? []; group.push(ref); refsByPath.set(ref.path, group); }
  let bytes = 0, entries = 0;
  for (const filename of new Set(refs.map(ref => ref.path))) {
    let info; try { info = await stat(await workspace.resolve(filename)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!info?.isFile()) { missing.push(...refsByPath.get(filename)!); continue; }
    bytes += info.size; if (bytes > 1024 ** 3) throw new Error('Referenced resources exceed the 1 GiB audit budget.');
    files.push({ path: filename, bytes: info.size, sha256: await fileSha256(filename), owners: refsByPath.get(filename)!.map(ref => ref.owner) });
  }
  const unused: string[] = [], used = new Set(files.map(file => file.path.toLowerCase()));
  const walk = async (folder: string): Promise<void> => {
    const canonical = (await workspace.resolve(folder)).toLowerCase(); if (scanned.has(canonical)) return; scanned.add(canonical);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Asset audit rejects symbolic links and junctions.');
      if (++entries > 20000) throw new Error('Unused-resource scan exceeds 20,000 entries. Choose narrower resource roots.');
      if (entry.isDirectory()) { if (!['.queue', '.jobs', 'previews', 'packages', 'reports', 'node_modules'].includes(entry.name)) await walk(path.join(folder, entry.name)); }
      else if (/\.(png|wav|ogg|mp3|flac|m4a)$/i.test(entry.name) && !used.has(path.join(folder, entry.name).toLowerCase())) unused.push(path.join(folder, entry.name));
    }
  };
  if (scanUnused) for (const root of new Set(Object.values(roots))) { try { await walk(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  const hashes = new Map<string, string[]>(); for (const file of files) { const group = hashes.get(file.sha256) ?? []; group.push(file.path); hashes.set(file.sha256, group); }
  for (const filename of unused) { bytes += (await stat(filename)).size; if (bytes > 1024 ** 3) throw new Error('Asset content scan exceeds 1 GiB.'); const hash = await fileSha256(filename), group = hashes.get(hash) ?? []; group.push(filename); hashes.set(hash, group); }
  return { valid: !missing.length, roots, references: refs.length, bytes, files, missing, sequenceGaps: missing.filter(ref => ref.frame !== undefined), unused, duplicates: [...hashes.values()].filter(group => group.length > 1), unusedScope: 'Not referenced by this selected skeleton; another project may still use these files.' };
}
export async function snapshotEditSources(workspace: Workspace, edits: unknown[]) {
  const files: { path: string; sha256: string }[] = [];
  for (const edit of edits) if (edit && typeof edit === 'object') {
    if ('source' in edit && typeof edit.source === 'string') {
      const filename = await workspace.resolve(edit.source);
      if (!files.some(file => file.path === filename)) {
        files.push({ path: filename, sha256: await fileSha256(filename) }); const assets = await auditAssets(workspace, await readDocument(filename), filename, false); files.push(...assets.files);
      }
    }
    if ('image' in edit && typeof edit.image === 'string') {
      const filename = await workspace.resolve(edit.image);
      if (!files.some(file => file.path === filename)) files.push({ path: filename, sha256: await fileSha256(filename) });
    }
  }
  return { files };
}
export async function assertSnapshot(snapshot: { files: { path: string; sha256: string }[] }) {
  for (const file of snapshot.files) if (await fileSha256(file.path) !== file.sha256) throw new Error(`Resource changed during operation: ${file.path}`);
}
export function relinkAssets(source: SpineDocument, options: { images?: string; audio?: string; paths?: Record<string, string>; audioPaths?: Record<string, string> }) {
  const data = structuredClone(source);
  for (const field of ['images', 'audio'] as const) if (options[field] !== undefined) data.skeleton[field] = options[field];
  for (const item of attachmentEntries(data)) { const original = String(item.value.path ?? item.value.name ?? item.name); if (Object.hasOwn(options.paths ?? {}, original)) item.value.path = options.paths![original]; }
  for (const raw of Object.values(data.events ?? {})) { const event = object(raw, 'event'); if (typeof event.audio === 'string' && Object.hasOwn(options.audioPaths ?? {}, event.audio)) event.audio = options.audioPaths![event.audio]; }
  return parseDocument(data);
}
export function documentDiff(before: unknown, after: unknown, limit = 5000) {
  const changes: { path: string; kind: string; before?: unknown; after?: unknown }[] = []; let total = 0;
  const brief = (value: unknown) => { if (value === undefined) return undefined; const raw = JSON.stringify(value); return raw.length <= 600 ? value : { summary: Array.isArray(value) ? `Array(${value.length})` : typeof value, bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') }; };
  const visit = (a: unknown, b: unknown, pointer: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    } else { total++; if (changes.length < limit) changes.push({ path: pointer || '/', kind: a === undefined ? 'add' : b === undefined ? 'remove' : 'change', before: brief(a), after: brief(b) }); }
  }; visit(before, after, ''); return { total, changes, truncated: total > changes.length };
}
export async function saveReport(workspace: Workspace, kind: string, report: unknown) {
  const directory = await workspace.resolve('reports', false); await mkdir(directory, { recursive: true });
  const filename = path.join(directory, `${kind}-${randomUUID()}.json`); await writeFile(filename, JSON.stringify(report, null, 2), { flag: 'wx' }); return filename;
}
export async function collectAssets(workspace: Workspace, data: SpineDocument, jsonPath: string) {
  const snapshot = await auditAssets(workspace, data, jsonPath, false); if (!snapshot.valid) throw new Error(`Missing resources: ${snapshot.missing.map(ref => ref.path).slice(0, 20).join(', ')}`);
  const sourceHash = await fileSha256(jsonPath);
  const directory = await workspace.resolve(path.join('packages', randomUUID()), false); await mkdir(directory, { recursive: true });
  const destinations = new Map<string, string>(), collected = structuredClone(data), copies: { kind: 'images' | 'audio'; path: string; relative: string }[] = [];
  for (const item of attachmentEntries(collected)) if (['region', 'mesh', 'linkedmesh'].includes(String(item.value.type ?? 'region'))) {
    const original = String(item.value.path ?? item.value.name ?? item.name), base = `asset-${createHash('sha256').update(path.resolve(snapshot.roots.images, original)).digest('hex').slice(0, 24)}`; item.value.path = base;
    const sequence = item.value.sequence === undefined ? undefined : object(item.value.sequence, 'sequence');
    for (let index = 0; index < Number(sequence?.count ?? 1); index++) { const suffix = sequence ? String(index + Number(sequence.start ?? 1)).padStart(Number(sequence.digits ?? 0), '0') : ''; copies.push({ kind: 'images', path: path.resolve(snapshot.roots.images, `${original}${suffix}.png`), relative: `${base}${suffix}.png` }); }
  }
  for (const raw of Object.values(collected.events ?? {})) { const event = object(raw, 'event'); if (typeof event.audio === 'string' && event.audio) { const filename = path.resolve(snapshot.roots.audio, event.audio), relative = `audio-${createHash('sha256').update(filename).digest('hex').slice(0, 24)}${path.extname(filename)}`; copies.push({ kind: 'audio', path: filename, relative }); event.audio = relative; } }
  for (const ref of copies) {
    const root = path.join(directory, ref.kind), destination = path.resolve(root, ref.relative), relative = path.relative(root, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Collection requires resource paths below images/audio roots. Relink ../ paths first.');
    if (destinations.has(destination.toLowerCase())) { if (destinations.get(destination.toLowerCase()) !== ref.path) throw new Error('Case-insensitive package resource collision.'); continue; }
    destinations.set(destination.toLowerCase(), ref.path); await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(ref.path, destination, constants.COPYFILE_EXCL);
    if (await fileSha256(destination) !== snapshot.files.find(file => file.path === ref.path)!.sha256) throw new Error('Copied resource hash does not match source snapshot.');
  }
  const output = path.join(directory, 'skeleton.json'); collected.skeleton.images = 'images/';
  // The installed CLI preserves an explicit audio directory as an absolute
  // native-project setting. Do not invent one when this skeleton has no audio.
  if (copies.some(ref => ref.kind === 'audio')) collected.skeleton.audio = 'audio/';
  else delete collected.skeleton.audio;
  await writeFile(output, JSON.stringify(collected, null, 2), { flag: 'wx' }); await assertSnapshot(snapshot);
  if (await fileSha256(jsonPath) !== sourceHash) throw new Error('Source JSON changed during collection.');
  const check = await auditAssets(workspace, collected, output, false); if (!check.valid) throw new Error('Collected package contains missing resources.');
  const manifest = { schemaVersion: 1, kind: 'collection', targetVersion: data.skeleton.spine, sourceHash, files: [...check.files.map(file => ({ ...file, path: path.relative(directory, file.path).replaceAll('\\', '/') })), { path: 'skeleton.json', bytes: (await stat(output)).size, sha256: await fileSha256(output) }], complete: true };
  const manifestPath = path.join(directory, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return { directory, output, manifestPath, resourceCount: check.files.length };
}
