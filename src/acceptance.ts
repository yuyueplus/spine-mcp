import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { visualReviewSchema, reviewAnimationsSchema } from './stability-schema.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { fileSha256 } from './file-hash.js';

async function revision(service: SpineService, input: string, skeletonName?: string) {
  const filename = await service.workspace.resolve(input), hash = await fileSha256(filename), loaded = await service.load(filename, skeletonName), assets = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  if (!assets.valid) throw new Error('Acceptance cannot be assigned to an incomplete resource revision.');
  const files = assets.files.map(f => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  await assertSnapshot({ files }); if (await fileSha256(filename) !== hash) throw new Error('Revision changed while recording acceptance.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ input: filename, hash, skeletonName: skeletonName ?? null, files })).digest('hex');
  return { input: filename, sourceSha256: hash, skeletonName: skeletonName ?? null, files, fingerprint, animations: Object.keys(loaded.data.animations ?? {}).sort() };
}
function selection(available: string[], requested?: string[]) {
  if (requested === undefined) return available;
  const names = reviewAnimationsSchema.parse(requested);
  for (const name of names) if (!available.includes(name)) throw new Error(`Review animation not found: ${name}`);
  return names.toSorted();
}
export async function recordVisualReview(service: SpineService, raw: z.input<typeof visualReviewSchema>) {
  const args = visualReviewSchema.parse(raw), current = await revision(service, args.input, args.skeletonName), evidence = [];
  const animations = selection(current.animations, args.animations), scope = args.animations === undefined ? { type: 'project' as const } : { type: 'animations' as const, animations };
  for (const input of args.evidence) { const filename = await service.workspace.resolve(input); if (!(await stat(filename)).isFile()) throw new Error('Review evidence must be a local file inside the workspace.'); evidence.push({ path: filename, sha256: await fileSha256(filename) }); }
  const id = randomUUID(), root = await service.workspace.resolve('.visual-reviews', false); await mkdir(root, { recursive: true });
  const report = { id, ...current, scope, decision: args.decision, reviewer: args.reviewer, note: args.note, evidence, recordedAt: new Date().toISOString(), provenance: 'Reported by the tool caller; not an editor load/display receipt or an automatic proof of visual quality.' }, reportPath = path.join(root, `${id}.json`);
  await assertSnapshot(current); if (await fileSha256(current.input) !== current.sourceSha256) throw new Error('Source changed before review publication.');
  await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); return { ...report, reportPath };
}
export async function getAcceptance(service: SpineService, input: string, skeletonName?: string, requestedAnimations?: string[]) {
  const current = await revision(service, input, skeletonName), root = await service.workspace.resolve('.visual-reviews', false), reviews: Awaited<ReturnType<typeof recordVisualReview>>[] = [];
  const requested = selection(current.animations, requestedAnimations);
  try {
    const entries = await readdir(root); if (entries.length > 10000) throw new Error('Review archive exceeds 10,000 entries.');
    for (const item of entries) if (/^[a-f0-9-]{36}\.json$/i.test(item)) {
      const filename = await service.workspace.resolve(path.join(root, item)); if ((await stat(filename)).size > 4 * 1024 * 1024) throw new Error('Review record is too large.');
      const review = JSON.parse(await readFile(filename, 'utf8'));
      if (review.input === current.input && review.skeletonName === current.skeletonName) reviews.push(review);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  reviews.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const matching = reviews.filter(r => r.fingerprint === current.fingerprint), applies = (review: typeof reviews[number], animation?: string) => !review.scope || review.scope.type === 'project' || (animation !== undefined && review.scope.type === 'animations' && review.scope.animations.includes(animation));
  const animationAcceptance = requested.map(animation => { const review = matching.find(r => applies(r, animation)); return { animation, visualAcceptance: (review?.decision ?? 'pending') as 'accepted' | 'rejected' | 'pending', review: review ?? null }; });
  const projectReview = matching.find(r => applies(r)), decisions = animationAcceptance.map(r => r.visualAcceptance);
  const visualAcceptance = !requested.length ? projectReview?.decision ?? 'pending' : decisions.includes('rejected') ? 'rejected' : decisions.every(d => d === 'accepted') ? 'accepted' : decisions.includes('accepted') ? 'partial' : 'pending';
  return { input: current.input, sourceSha256: current.sourceSha256, fingerprint: current.fingerprint, structuralValidation: 'passed', visualAcceptance, requestedAnimations: requested, animationAcceptance, review: requested.length === 1 ? animationAcceptance[0]!.review : projectReview ?? null, reviews: matching, previousReviewOutdated: Boolean(reviews.length && !matching.length), previousReview: matching.length ? null : reviews[0] ?? null,
    note: 'Reviews apply only to their project/animation scope. Unreviewed animations remain pending; a partial result is not whole-project acceptance. A structural, native-roundtrip or numeric diagnostic pass never creates visual acceptance. Source or resource changes invalidate earlier reviews. Decisions are caller-reported.' };
}
