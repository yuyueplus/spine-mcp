import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { SpineDocument } from './document.js';
import type { SpineService } from './service.js';
import type { NativePreviewRequest, NativePreviewStatus } from './native-preview.js';
import { animationDuration } from './advanced-animation.js';
import { sampleArtwork, renderArtwork } from './scene-preview.js';
import { assertSnapshot, type auditAssets } from './production-assets.js';
import { atomicJson } from './jobs.js';
import { fileSha256 } from './file-hash.js';
import { replaceFile } from './file-replace.js';
import { VERSION } from './version.js';
import { publishSequenceImages, recoverSequencePublication, type PublicationImage } from './sequence-publication.js';

export const nativeSequenceRange = z.object({ start: z.number().finite().min(0).max(300).default(0), end: z.number().finite().min(0).max(300).optional(), nativeFps: z.number().int().min(1).max(60).default(30), maxFrames: z.number().int().min(2).max(600).default(120), chunkFrames: z.number().int().min(1).max(120).default(30) }).strict();
export interface NativeSequenceLayout { start: number; end: number; nativeFps: number; frameCount: number; maxFrames?: number; chunkFrames?: number }
export interface NativeSequenceStatus { state: 'preparing' | 'ready' | 'error'; layout: NativeSequenceLayout; preparedFrames: number; publishedFrames: number; sourceSignature?: string; cacheKey?: string; cacheReused?: boolean; renderMs?: number; publishedAt?: string; error?: string; renderedFrames?: number; reusedFrames?: number; deduplicatedFrames?: number; publishedChangedFrames?: number; samplingMs?: number; prepareMs?: number; chunks?: Cache['chunks'] }
export function sequenceLayout(data: SpineDocument, animation: string | undefined, range: { start: number; end?: number; nativeFps: number; maxFrames?: number; chunkFrames?: number }, width: number, height: number): NativeSequenceLayout {
  const value = animation && data.animations?.[animation]; if (!value) throw new Error('Native sequence preview requires an existing animation.');
  const duration = animationDuration(value), end = range.end ?? duration;
  if (!(end > range.start) || end > duration + 1e-6) throw new Error(`Sequence requires start < end <= animation duration (${duration}).`);
  const frameCount = Math.max(1, Math.ceil((end - range.start) * range.nativeFps - 1e-5));
  if (frameCount < 2 || frameCount > (range.maxFrames ?? 120) || frameCount * width * height > 64_000_000) throw new Error('Native sequence requires 2–120 frames by default (explicit maxFrames up to 600) and at most 64 million output pixels. Shorten range or lower nativeFps/dimensions.');
  return { start: range.start, end, nativeFps: range.nativeFps, frameCount, maxFrames: range.maxFrames ?? 120, chunkFrames: range.chunkFrames ?? 30 };
}
export const nativeSequenceTimes = (layout: NativeSequenceLayout) => Array.from({ length: layout.frameCount }, (_, i) => layout.start + i / layout.nativeFps);
export function nativeSequenceDocument(options: NativePreviewRequest['options'], layout: NativeSequenceLayout) {
  return { skeleton: { spine: '4.3.23', images: './images/', width: options.width, height: options.height }, bones: [{ name: 'root' }], slots: [{ name: 'preview', bone: 'root', attachment: 'preview' }], skins: [{ name: 'default', attachments: { preview: { preview: { path: 'frame-', width: options.width, height: options.height, sequence: { count: layout.frameCount, start: 0, digits: 4, setup: 0 } } } } }], animations: { 'MCP-playback': { bones: { root: { rotate: [{ time: 0, value: 0 }, { time: layout.frameCount / layout.nativeFps, value: 0 }] } }, attachments: { default: { preview: { preview: { sequence: [{ time: 0, mode: 'loop', index: 0, delay: 1 / layout.nativeFps }] } } } } } } };
}
interface Cache { key: string; directory: string; hashes: string[]; frameKeys?: string[]; bytes: number; renderMs: number; samplingMs?: number; renderedFrames?: number; reusedFrames?: number; deduplicatedFrames?: number; chunks?: { startFrame: number; endFrame: number; renderedFrames: number; reusedFrames: number; deduplicatedFrames: number }[] }
type Snapshot = { signature: string; sourceHash: string; assets: Awaited<ReturnType<typeof auditAssets>>; loaded: { data: SpineDocument; jsonPath: string } };
export class SequenceSuperseded extends Error {}
export class NativeSequenceRenderer {
  constructor(private service: SpineService, private folder: string, private status: NativePreviewStatus, private save: () => Promise<void>) {}
  private frame(folder: string, index: number) { return path.join(folder, `frame-${String(index).padStart(4, '0')}.png`); }
  private async remove(directory: string) {
    const target = await this.service.workspace.resolve(directory, false);
    if (path.dirname(target) !== this.folder || !/^sequence-[a-f0-9-]{36}$/.test(path.basename(target))) throw new Error('Refusing to remove a directory outside the managed sequence cache.');
    await rm(target, { recursive: true, force: true });
  }
  private async current(request: NativePreviewRequest) { const r = await this.service.nativePreviews.request(this.folder); if (r.stop || Date.parse(r.expiresAt) <= Date.now() || r.generation !== request.generation) throw new SequenceSuperseded(); }
  private async diskCache(key?: string, count?: number) {
    try {
      const c = JSON.parse(await readFile(path.join(this.folder, 'sequence-cache.json'), 'utf8')) as Cache;
      if (key !== undefined && c.key !== key || !Array.isArray(c.hashes) || c.hashes.length < 2 || c.hashes.length > 600 || count !== undefined && c.hashes.length !== count || path.dirname(c.directory) !== this.folder || !/^sequence-[a-f0-9-]{36}$/.test(path.basename(c.directory))) return;
      if (c.frameKeys && (c.frameKeys.length !== c.hashes.length || c.frameKeys.some(k => !/^[a-f0-9]{64}$/.test(k)))) return;
      await this.service.workspace.resolve(c.directory);
      for (let i = 0; i < c.hashes.length; i++) if (await fileSha256(await this.service.workspace.resolve(this.frame(c.directory, i))) !== c.hashes[i]) return;
      return c;
    } catch { return; }
  }
  async render(request: NativePreviewRequest, snapshot: Snapshot) {
    await this.service.nativePreviews.lock(this.folder, () => recoverSequencePublication(this.service.workspace, this.folder, this.status));
    const previousStatus = structuredClone(this.status);
    const layout = request.sequence; if (!layout) throw new Error('Missing native sequence layout.');
    const checked = sequenceLayout(snapshot.loaded.data, request.options.animation, layout, request.options.width, request.options.height);
    if (checked.frameCount !== layout.frameCount) throw new Error('Native sequence layout changed. Create a new sequence preview for a different native frame count or timing.');
    const times = nativeSequenceTimes(layout), options = { ...request.options }, began = Date.now();
    if (times.length * snapshot.loaded.data.bones.length > 200_000 || times.length * (snapshot.loaded.data.slots?.length ?? 0) > 30_000 || options.physics && times.reduce((sum, t) => sum + Math.ceil(t * options.fps), 0) * snapshot.loaded.data.bones.length * 4 > 500_000) throw new Error('Native sequence exceeds the geometry/physics sampling budget.');
    const { time: _time, durationSeconds: _ttl, ...pose } = options, key = createHash('sha256').update(JSON.stringify({ version: VERSION, signature: snapshot.signature, pose, layout })).digest('hex'), old = await this.diskCache();
    let cache = old?.key === key && old.hashes.length === times.length ? old : undefined;
    const reused = Boolean(cache); let renderedFrames = 0, reusedFrames = cache ? times.length : 0, deduplicatedFrames = 0, samplingMs = 0;
    this.status.sequence = { state: 'preparing', layout, preparedFrames: cache ? times.length : 0, publishedFrames: 0, cacheKey: key, cacheReused: reused }; await this.save();
    if (!cache) {
      const states: string[] = [], samplingBegan = Date.now();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sampledVertices = 0;
      for (let i = 0; i < times.length; i += 8) {
        await this.current(request);
        const sampled = await sampleArtwork(this.service.workspace, snapshot.loaded.data, snapshot.loaded.jsonPath, options.animation, times.slice(i, i + 8), options.skin, options), imageHashes = new Map<string, string>();
        for (const image of sampled.assets.values()) imageHashes.set(image.path, createHash('sha256').update(image.bytes).digest('hex'));
        for (const frame of sampled.frames) {
          for (const slot of frame.slots) if (slot.vertices) {
            sampledVertices += slot.vertices.length / 2; if (sampledVertices > 8_000_000) throw new Error('Sequence fingerprint sampling exceeds eight million vertices. Shorten range or simplify geometry.');
            for (let j = 0; j < slot.vertices.length; j += 2) { minX = Math.min(minX, slot.vertices[j]!); maxX = Math.max(maxX, slot.vertices[j]!); minY = Math.min(minY, slot.vertices[j + 1]!); maxY = Math.max(maxY, slot.vertices[j + 1]!); }
          }
          states.push(createHash('sha256').update(JSON.stringify({ version: VERSION, slots: frame.slots, images: [...new Set(frame.slots.flatMap(s => s.image ? [s.image] : []))].sort().map(image => [image, imageHashes.get(image)]) })).digest('hex'));
        }
      }
      if (!options.viewport) {
        if (!Number.isFinite(minX)) throw new Error('Sequence has no visible artwork.'); const margin = Math.max(maxX - minX, maxY - minY, 1) * 0.12; options.viewport = { minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin };
      }
      const frameKeys = states.map(state => createHash('sha256').update(JSON.stringify({ state, width: options.width, height: options.height, viewport: options.viewport })).digest('hex'));
      samplingMs = Date.now() - samplingBegan;
      await assertSnapshot(snapshot.assets); if (await fileSha256(request.input) !== snapshot.sourceHash) throw new Error('Source changed while sampling native sequence.');
      const directory = path.join(this.folder, `sequence-${randomUUID()}`); await mkdir(directory); let complete = false;
      const oldFrames = new Map(old?.frameKeys?.map((frameKey, index) => [frameKey, { path: this.frame(old.directory, index), sha256: old.hashes[index]! }]) ?? []), prepared = new Map<string, { path: string; sha256: string }>(), actions: ('rendered' | 'reused' | 'deduplicated')[] = [];
      cache = { key, directory, hashes: [], frameKeys, bytes: 0, renderMs: 0, samplingMs };
      try {
        for (let i = 0; i < times.length; i++) {
          await this.current(request); const target = this.frame(directory, i), previous = oldFrames.get(frameKeys[i]!), duplicate = prepared.get(frameKeys[i]!);
          if (previous || duplicate) { await copyFile((previous ?? duplicate)!.path, target); actions.push(previous ? 'reused' : 'deduplicated'); if (previous) reusedFrames++; else deduplicatedFrames++; }
          else {
            const renderBegan = Date.now(), r = await renderArtwork(this.service.workspace, snapshot.loaded.data, snapshot.loaded.jsonPath, options.animation, [times[i]!], options.skin, { ...options, clean: true, transparent: true });
            try { await replaceFile(r.path, target); } finally { await unlink(r.path).catch(() => undefined); }
            cache.renderMs += Date.now() - renderBegan; renderedFrames++; actions.push('rendered');
          }
          const bytes = await readFile(target), hash = createHash('sha256').update(bytes).digest('hex');
          if ((previous || duplicate) && hash !== (previous ?? duplicate)!.sha256) throw new Error('Reused sequence frame changed during copying.');
          cache.bytes += bytes.length; if (cache.bytes > 64 * 1024 * 1024) throw new Error('Native sequence cache exceeds 64 MiB.');
          cache.hashes.push(hash); prepared.set(frameKeys[i]!, { path: target, sha256: hash }); this.status.sequence.preparedFrames = i + 1;
          if ((i + 1) % (layout.chunkFrames ?? 30) === 0 || i === times.length - 1) await this.save();
        }
        cache.renderedFrames = renderedFrames; cache.reusedFrames = reusedFrames; cache.deduplicatedFrames = deduplicatedFrames; cache.chunks = [];
        for (let start = 0; start < times.length; start += layout.chunkFrames ?? 30) { const values = actions.slice(start, start + (layout.chunkFrames ?? 30)); cache.chunks.push({ startFrame: start, endFrame: start + values.length - 1, renderedFrames: values.filter(v => v === 'rendered').length, reusedFrames: values.filter(v => v === 'reused').length, deduplicatedFrames: values.filter(v => v === 'deduplicated').length }); }
        await assertSnapshot(snapshot.assets); if (await fileSha256(request.input) !== snapshot.sourceHash) throw new Error('Source changed while preparing native sequence.');
        await this.service.nativePreviews.lock(this.folder, async () => { await this.current(request); await atomicJson(path.join(this.folder, 'sequence-cache.json'), cache); }); complete = true;
      } finally { if (!complete) await this.remove(directory); }
    }
    await this.service.nativePreviews.lock(this.folder, async () => {
      const validate = async () => { await this.current(request); await assertSnapshot(snapshot.assets); if (await fileSha256(request.input) !== snapshot.sourceHash) throw new Error('Source changed before sequence publication.'); };
      await validate();
      const images = path.join(this.folder, 'images'); let publishedChangedFrames = 0;
      const publicationImages: PublicationImage[] = [];
      for (let i = 0; i < times.length; i++) {
        const target = await this.service.workspace.resolve(this.frame(images, i), false); let matches = false;
        try { matches = await fileSha256(target) === cache!.hashes[i]; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if (!matches) publishedChangedFrames++;
        publicationImages.push({ name: path.basename(target), source: this.frame(cache!.directory, i), sha256: cache!.hashes[i]! });
      }
      publicationImages.push({ name: 'preview.png', source: this.frame(cache!.directory, 0), sha256: cache!.hashes[0]! });
      const next: NativePreviewStatus = { ...this.status, state: 'watching', sequence: { state: 'ready', layout, preparedFrames: times.length, publishedFrames: times.length, cacheKey: key, cacheReused: reused, sourceSignature: snapshot.signature, renderMs: cache!.renderMs, publishedAt: new Date().toISOString(), renderedFrames, reusedFrames, deduplicatedFrames, publishedChangedFrames, samplingMs, prepareMs: Date.now() - began, chunks: cache!.chunks }, input: request.input, generation: request.generation, sourceSignature: snapshot.signature, publishedRevision: { sourceSha256: snapshot.sourceHash, resources: snapshot.assets.files.map(file => ({ path: file.path, sha256: file.sha256 })), missing: snapshot.assets.missing.map(file => file.path) }, renderMs: Date.now() - began, textureSha256: cache!.hashes[0], textureRevision: (this.status.textureRevision ?? 0) + 1, publishedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), consecutiveRenderErrors: 0 };
      delete next.lastError; delete next.lastErrorAt; delete next.lastErrorGeneration;
      await publishSequenceImages(this.service.workspace, this.folder, this.status, previousStatus, publicationImages, next, validate);
    });
    for (const entry of await readdir(this.folder, { withFileTypes: true })) if (entry.isDirectory() && /^sequence-[a-f0-9-]{36}$/.test(entry.name) && path.join(this.folder, entry.name) !== cache.directory) await this.remove(path.join(this.folder, entry.name));
  }
  async complete(request: NativePreviewRequest) {
    if (!request.sequence) return true;
    const cacheKey = this.status.sequence?.cacheKey; if (!cacheKey) return false;
    const cache = await this.diskCache(cacheKey, request.sequence.frameCount); if (!cache) return false;
    for (let i = 0; i < cache.hashes.length; i++) { try { if (await fileSha256(this.frame(path.join(this.folder, 'images'), i)) !== cache.hashes[i]) return false; } catch { return false; } }
    try { return await fileSha256(this.status.image) === cache.hashes[0]; } catch { return false; }
  }
}
