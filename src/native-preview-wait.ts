import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { fileSha256 } from './file-hash.js';
import { NativeSequenceRenderer } from './native-sequence.js';

export const nativePreviewWaitOptions = z.object({ generation: z.number().int().min(1).optional(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), waitMs: z.number().int().min(0).max(30000).default(10000) }).strict();
type Options = z.infer<typeof nativePreviewWaitOptions>;
type Outcome = 'published' | 'timeout' | 'superseded' | 'error' | 'stopped' | 'expired' | 'source_changed' | 'unverified';
const token = (s: Awaited<ReturnType<SpineService['nativePreviews']['get']>>) => JSON.stringify([s.generation, s.pendingGeneration, s.textureRevision, s.sourceSignature, s.state, s.sequence?.state, s.publicationPending, s.stopRequested]);

/** Read-only bounded wait. This verifies saved bytes, never a native display or
 * timeline receipt. Existing experimental single-image playback is excluded. */
export async function waitForNativePreview(service: SpineService, id: string, options: Options) {
  const began = Date.now(), manager = service.nativePreviews, folder = await manager.folder(id), initial = await manager.request(folder);
  if (initial.playback) throw new Error('Wait supports static artwork and native sequences, not experimental single-PNG playback.');
  const generation = options.generation ?? initial.generation;
  if (generation > initial.generation) throw new Error('Cannot wait for an unrequested future generation. Use a generation returned by an edit/update.');
  let expectedHash = options.sourceSha256, lastCheck = 'Waiting for the requested publication.';
  const result = (outcome: Outcome, status: Awaited<ReturnType<typeof manager.get>>, reason?: string) => ({ outcome, id, requestedGeneration: generation, generation: status.generation, pendingGeneration: status.pendingGeneration, input: status.input, pendingInput: status.pendingInput, requestedSourceSha256: expectedHash, publishedSourceSha256: status.publishedRevision?.sourceSha256, textureRevision: status.textureRevision, sequencePublication: status.sequencePublication, elapsedMs: Date.now() - began, ...(reason ? { reason } : {}), sourceVerified: outcome === 'published', resourcesVerified: outcome === 'published', imageSetVerified: outcome === 'published', projectVerified: outcome === 'published', editorDisplayAcknowledged: false, editorProjectReloaded: false });
  for (;;) {
    const current = await manager.get(id);
    if (current.pendingGeneration > generation || current.generation > generation) return result('superseded', current, 'A newer request replaced this generation; no historical display acknowledgement is inferred.');
    if (current.stopRequested || current.state === 'stopped') return result('stopped', current);
    if (current.state === 'expired' || Date.parse(current.expiresAt) <= Date.now()) return result('expired', current);
    if (current.state === 'failed' || current.lastError && current.lastErrorGeneration === generation) return result('error', current, current.lastError ?? 'Renderer recovery was exhausted.');
    if (expectedHash === undefined) expectedHash = await fileSha256(await service.workspace.resolve(current.pendingInput));
    if (current.state === 'watching' && current.generation === generation && !current.publicationPending && !current.lastError && (!current.sequence || current.sequence.state === 'ready')) {
      const revision = current.publishedRevision;
      if (!revision || !current.projectSha256) return result('unverified', current, 'This older publication lacks revision evidence. Request an update or resume using the current server, then wait for its returned generation.');
      if (!Array.isArray(revision.missing) || revision.missing.some(file => typeof file !== 'string')) return result('unverified', current, 'The publication lacks a complete missing-resource inventory. Request a current-server update.');
      if (revision.missing.length) return result('error', current, `The saved source references ${revision.missing.length} missing resource(s); resource verification cannot pass.`);
      if (!/^[a-f0-9]{64}$/.test(revision.sourceSha256) || !Array.isArray(revision.resources) || revision.resources.length > 10000 || revision.resources.some(r => !r || typeof r.path !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256))) throw new Error('Invalid or over-budget preview revision manifest (maximum 10000 resources).');
      try {
        const sourceHash = await fileSha256(await service.workspace.resolve(current.input));
        if (sourceHash !== expectedHash) return result('source_changed', current, 'The saved input no longer matches the requested source revision.');
        if (revision.sourceSha256 !== expectedHash) lastCheck = 'The worker has not published this source revision yet.';
        else {
          let assetsMatch = true;
          for (let start = 0; start < revision.resources.length; start += 16) {
            const matches = await Promise.all(revision.resources.slice(start, start + 16).map(async resource => await fileSha256(await service.workspace.resolve(resource.path)) === resource.sha256));
            if (matches.some(match => !match)) { assetsMatch = false; break; }
          }
          const projectMatches = await fileSha256(await service.workspace.resolve(current.project)) === current.projectSha256;
          if (!projectMatches) return result('error', current, 'The generated native project changed; no verified publication receipt can be returned.');
          const imageMatches = await fileSha256(await service.workspace.resolve(current.image)) === current.textureSha256;
          const request = await manager.request(folder);
          const framesMatch = !request.sequence || await new NativeSequenceRenderer(service, folder, current, async () => undefined).complete(request);
          const after = await manager.get(id);
          if (assetsMatch && imageMatches && framesMatch && token(current) === token(after) && await fileSha256(await service.workspace.resolve(current.input)) === expectedHash) return result('published', after);
          lastCheck = 'Resource/image bytes or publication state changed during verification; waiting for a consistent revision.';
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        lastCheck = 'A required saved file is missing; no publication receipt has been granted.';
      }
    }
    if (Date.now() - began >= options.waitMs) return result('timeout', current, lastCheck);
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(0, began + options.waitMs - Date.now()))));
  }
}
