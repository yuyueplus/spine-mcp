import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import type { SpineDocument } from './document.js';
import type { NativePreviewRequest, NativePreviewStatus } from './native-preview.js';
import { animationDuration } from './advanced-animation.js';
import { renderArtwork, sampleArtwork } from './scene-preview.js';
import { atomicJson } from './jobs.js';
import { fileSha256 } from './file-hash.js';
import { replaceFile } from './file-replace.js';
import { assertSnapshot, type auditAssets } from './production-assets.js';
import { VERSION } from './version.js';
import { padPreviewPng } from './native-png.js';

export const nativePlaybackControl = z.object({
  action: z.enum(['play', 'pause', 'seek', 'stop']),
  start: z.number().finite().min(0).max(300).optional(), end: z.number().finite().min(0).max(300).optional(),
  playbackFps: z.number().int().min(1).max(24).optional(), speed: z.number().finite().min(0.1).max(4).optional(),
  loop: z.boolean().optional(), time: z.number().finite().min(0).max(300).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'seek' && value.time === undefined) ctx.addIssue({ code: 'custom', message: 'Seek requires time.' });
  if (value.action !== 'play' && ['start', 'end', 'playbackFps', 'speed', 'loop'].some(k => value[k as keyof typeof value] !== undefined)) ctx.addIssue({ code: 'custom', message: 'Range, FPS, speed and loop may only be changed with play.' });
  if (['pause', 'stop'].includes(value.action) && value.time !== undefined) ctx.addIssue({ code: 'custom', message: 'Time is supported by play and seek.' });
});
export interface PlaybackRequest { state: 'playing' | 'paused'; start: number; end?: number; playbackFps: number; speed: number; loop: boolean; time: number; revision: string }
export interface PlaybackStatus {
  state: 'building' | 'playing' | 'paused' | 'completed' | 'error'; revision: string; currentTime: number;
  cacheKey?: string; cacheFrames?: number; cachedFrames?: number; cacheBytes?: number; cacheBuildMs?: number;
  frameIndex?: number; publishedFrames: number; skippedFrames: number; cacheReused?: boolean;
  start?: number; end?: number; playbackFps?: number; speed?: number; loop?: boolean; error?: string;
}
export function playbackPlan(data: SpineDocument, request: NativePreviewRequest) {
  const playback = request.playback;
  if (!playback) throw new Error('Playback is not configured.');
  const animation = request.options.animation && data.animations?.[request.options.animation];
  if (!animation) throw new Error('Select an existing animation with spine_update_native_preview before playback.');
  const duration = animationDuration(animation), end = playback.end ?? duration, start = playback.start;
  if (!(end > start) || end > duration + 1e-6 || end > 300) throw new Error(`Playback requires 0 <= start < end <= animation duration (${duration}).`);
  if (playback.time < start || playback.time > end) throw new Error('Playback/seek time must be inside the selected range.');
  // Native JSON rounds times (eg 20/30 -> 0.6666667). Do not add a nearly
  // duplicate last interval solely because of that serialization precision.
  const intervals = Math.max(1, Math.ceil((end - start) * playback.playbackFps - 1e-5)), times = Array.from({ length: intervals + 1 }, (_, i) => i === intervals ? end : start + i / playback.playbackFps);
  if (times.length > 120 || times.length * request.options.width * request.options.height > 64_000_000 || times.length * data.bones.length > 200_000 || times.length * (data.slots?.length ?? 0) > 30_000) throw new Error('Playback cache exceeds 120 frames, 64 million output pixels or geometry budget. Shorten the range or lower playbackFps.');
  if (request.options.physics && times.reduce((total, time) => total + Math.ceil(time * request.options.fps), 0) * data.bones.length * 2 > 500_000) throw new Error('Playback cache exceeds the physics simulation budget. Shorten the range or lower the physics sampling FPS.');
  return { ...playback, start, end, times };
}
export function playbackPosition(from: number, elapsedMs: number, plan: Pick<ReturnType<typeof playbackPlan>, 'start' | 'end' | 'speed' | 'loop'>) {
  const position = from + Math.max(0, elapsedMs) / 1000 * plan.speed;
  return { time: plan.loop ? plan.start + ((position - plan.start) % (plan.end - plan.start) + plan.end - plan.start) % (plan.end - plan.start) : Math.min(plan.end, position), completed: !plan.loop && position >= plan.end };
}
interface Cache { key: string; directory: string; times: number[]; hashes: string[]; bytes: number; buildMs: number; viewport: NonNullable<NativePreviewRequest['options']['viewport']> }
type Snapshot = { signature: string; sourceHash: string; assets: Awaited<ReturnType<typeof auditAssets>>; loaded: { data: SpineDocument; jsonPath: string } };
class Superseded extends Error {}

/** This clock publishes cached PNGs. It has no access to the editor clock or UI. */
export class NativePlaybackRunner {
  private cache?: Cache;
  private plan?: ReturnType<typeof playbackPlan>;
  private clock?: { revision: string; generation: number; from: number; started: number; lastTick: number };
  constructor(private service: SpineService, private folder: string, private status: NativePreviewStatus, private save: () => Promise<void>, private publish: (source: string, destination: string) => Promise<void>) {}
  private frame(cache: Cache, index: number) { return path.join(cache.directory, `frame-${String(index).padStart(4, '0')}.png`); }
  private async removeCache(directory: string) {
    const target = await this.service.workspace.resolve(directory, false);
    if (path.dirname(target) !== this.folder || !/^playback-[a-f0-9-]{36}$/.test(path.basename(target))) throw new Error('Refusing to remove a directory outside the managed playback cache.');
    await rm(target, { recursive: true, force: true });
  }
  private async current(request: NativePreviewRequest) {
    const latest = await this.service.nativePreviews.request(this.folder);
    if (latest.stop || Date.parse(latest.expiresAt) <= Date.now() || latest.generation !== request.generation) throw new Superseded();
  }
  private async diskCache(key: string, times: number[]) {
    try {
      const cache = JSON.parse(await readFile(path.join(this.folder, 'playback-cache.json'), 'utf8')) as Cache;
      if (cache.key !== key || JSON.stringify(cache.times) !== JSON.stringify(times) || cache.hashes.length !== times.length || path.dirname(cache.directory) !== this.folder || !/^playback-[a-f0-9-]{36}$/.test(path.basename(cache.directory))) return;
      await this.service.workspace.resolve(cache.directory);
      for (let i = 0; i < times.length; i++) if (await fileSha256(await this.service.workspace.resolve(this.frame(cache, i))) !== cache.hashes[i]) return;
      return cache;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) return; }
  }
  async ensure(request: NativePreviewRequest, snapshot: Snapshot) {
    const plan = playbackPlan(snapshot.loaded.data, request), { time: _time, durationSeconds: _ttl, ...pose } = request.options;
    const recoveredTime = this.status.playback?.revision === plan.revision ? this.status.playback.currentTime : plan.time;
    const resumeTime = Math.max(plan.start, Math.min(plan.end, recoveredTime));
    const key = createHash('sha256').update(JSON.stringify({ schema: 2, rendererVersion: VERSION, signature: snapshot.signature, pose, times: plan.times })).digest('hex');
    if (this.cache?.key !== key) {
      let cache = await this.diskCache(key, plan.times), reused = Boolean(cache);
      if (!cache) {
        const directory = path.join(this.folder, `playback-${randomUUID()}`), started = Date.now(); await mkdir(directory);
        let complete = false;
        try {
          this.status.playback = { state: 'building', revision: plan.revision, currentTime: resumeTime, cachedFrames: 0, cacheFrames: plan.times.length, publishedFrames: this.status.playback?.publishedFrames ?? 0, skippedFrames: 0 };
          await this.save();
          let bounds = request.options.viewport;
          if (!bounds) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < plan.times.length; i += 8) { await this.current(request); const sample = await sampleArtwork(this.service.workspace, snapshot.loaded.data, snapshot.loaded.jsonPath, request.options.animation, plan.times.slice(i, i + 8), request.options.skin, request.options); for (const frame of sample.frames) for (const slot of frame.slots) if (slot.vertices) for (let j = 0; j < slot.vertices.length; j += 2) { minX = Math.min(minX, slot.vertices[j]!); maxX = Math.max(maxX, slot.vertices[j]!); minY = Math.min(minY, slot.vertices[j + 1]!); maxY = Math.max(maxY, slot.vertices[j + 1]!); } }
            if (!Number.isFinite(minX)) throw new Error('The selected range contains no visible artwork.');
            const margin = Math.max(maxX - minX, maxY - minY, 1) * 0.12; bounds = { minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin };
          }
          cache = { key, directory, times: plan.times, hashes: [], bytes: 0, buildMs: 0, viewport: bounds };
          for (let i = 0; i < plan.times.length; i++) {
            await this.current(request);
            const rendered = await renderArtwork(this.service.workspace, snapshot.loaded.data, snapshot.loaded.jsonPath, request.options.animation, [plan.times[i]!], request.options.skin, { ...request.options, viewport: bounds, clean: true, transparent: true });
            try { await replaceFile(rendered.path, this.frame(cache, i)); } finally { await unlink(rendered.path).catch(() => undefined); }
            cache.hashes.push(await fileSha256(this.frame(cache, i))); cache.bytes += (await stat(this.frame(cache, i))).size;
            if (cache.bytes > 64 * 1024 * 1024) throw new Error('Playback cache exceeds 64 MiB. Lower output dimensions or shorten the range.');
            this.status.playback.cachedFrames = i + 1; await this.save();
          }
          const lengths = await Promise.all(plan.times.map((_, i) => stat(this.frame(cache!, i)).then(info => info.size))), paddedLength = Math.ceil((Math.max(...lengths) + 12) / 4096) * 4096;
          if (paddedLength * plan.times.length > 64 * 1024 * 1024) throw new Error('Constant-size playback cache exceeds 64 MiB. Lower dimensions or shorten the range.');
          for (let i = 0; i < plan.times.length; i++) { await this.current(request); const frame = this.frame(cache, i); await writeFile(frame, padPreviewPng(await readFile(frame), paddedLength)); cache.hashes[i] = await fileSha256(frame); }
          cache.bytes = paddedLength * plan.times.length;
          await assertSnapshot(snapshot.assets);
          if (await fileSha256(request.input) !== snapshot.sourceHash) throw new Error('Source changed while building the playback cache.');
          await this.service.nativePreviews.lock(this.folder, async () => { await this.current(request); cache!.buildMs = Date.now() - started; await atomicJson(path.join(this.folder, 'playback-cache.json'), cache); });
          complete = true;
        } finally { if (!complete) await this.removeCache(directory); }
      }
      this.cache = cache;
      // Remove abandoned or superseded caches only after a complete replacement exists.
      for (const entry of await readdir(this.folder, { withFileTypes: true })) if (entry.isDirectory() && /^playback-[a-f0-9-]{36}$/.test(entry.name) && path.join(this.folder, entry.name) !== cache.directory) await this.removeCache(path.join(this.folder, entry.name));
      // A ready cache is not a published frame. tick() commits the selected PNG
      // before exposing playing/paused and its matching texture receipt.
      this.status.playback = { state: 'building', revision: plan.revision, currentTime: resumeTime, cacheKey: key, cacheFrames: plan.times.length, cachedFrames: plan.times.length, cacheBytes: cache.bytes, cacheBuildMs: cache.buildMs, publishedFrames: this.status.playback?.publishedFrames ?? 0, skippedFrames: 0, cacheReused: reused };
      this.clock = undefined;
    }
    this.plan = plan;
    this.status.sourceSignature = snapshot.signature;
    if (this.status.playback) delete this.status.playback.error;
    return true;
  }
  async tick(request: NativePreviewRequest) {
    if (!this.cache || !this.plan || !request.playback || this.status.sourceSignature === undefined) return;
    const plan = { ...this.plan, ...request.playback, end: this.plan.end }, previous = this.status.playback;
    if (!this.clock || this.clock.revision !== plan.revision || this.clock.generation !== request.generation) {
      // On worker restart continue from the last committed frame, never elapsed downtime.
      const recoveredTime = previous?.revision === plan.revision ? previous.currentTime : plan.time;
      this.clock = { revision: plan.revision, generation: request.generation, from: Math.max(plan.start, Math.min(plan.end, recoveredTime)), started: performance.now(), lastTick: -1 };
    }
    const elapsed = performance.now() - this.clock.started, tick = plan.state === 'playing' ? Math.floor(elapsed * plan.playbackFps / 1000) : 0;
    if ((tick === this.clock.lastTick || this.clock.lastTick === Infinity) && this.status.generation === request.generation) return;
    const position = plan.state === 'playing' ? playbackPosition(this.clock.from, elapsed, plan) : { time: plan.time, completed: false };
    let index = this.cache.times.findIndex(t => t > position.time + 1e-8) - 1;
    if (index < 0) index = this.cache.times.length - 1;
    const state = position.completed ? 'completed' : plan.state;
    await this.service.nativePreviews.lock(this.folder, async () => {
      await this.current(request);
      const prior = this.status.playback, changed = prior?.cacheKey !== this.cache!.key || prior?.frameIndex !== index || this.status.generation !== request.generation;
      if (changed) {
        await this.publish(this.frame(this.cache!, index), this.status.image);
        Object.assign(this.status, { input: request.input, generation: request.generation, publishedAt: new Date().toISOString(), textureRevision: (this.status.textureRevision ?? 0) + 1, textureSha256: this.cache!.hashes[index], renderMs: this.cache!.buildMs, consecutiveRenderErrors: 0, lastSuccessAt: new Date().toISOString() });
        delete this.status.lastError; delete this.status.lastErrorAt;
      }
      this.status.playback = { ...prior!, state, revision: plan.revision, currentTime: this.cache!.times[index]!, frameIndex: index, cacheKey: this.cache!.key, cacheFrames: this.cache!.times.length, cacheBytes: this.cache!.bytes, cacheBuildMs: this.cache!.buildMs, start: plan.start, end: plan.end, playbackFps: plan.playbackFps, speed: plan.speed, loop: plan.loop, publishedFrames: (prior?.publishedFrames ?? 0) + Number(changed), skippedFrames: (prior?.skippedFrames ?? 0) + Math.max(0, tick - this.clock!.lastTick - 1) };
      this.status.state = 'watching'; await this.save();
    });
    this.clock.lastTick = tick;
    if (position.completed) this.clock.lastTick = Infinity;
  }
  static superseded(error: unknown) { return error instanceof Superseded; }
}
