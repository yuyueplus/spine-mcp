import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod/v4';
import type { SpineService } from './service.js';
import type { WorkControl } from './progress.js';
import { checkpoint } from './progress.js';
import { publishQualityPolicySchema } from './publish-quality-schema.js';
import { animationDuration } from './advanced-animation.js';
import { auditAnimation } from './animation-audit.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { atomicJson } from './jobs.js';
import { auditSampleTimes } from './audit-schema.js';
import { qualityIdentity, loadQualityWaivers, publicationAuditOptions, classifyWaivedFindings } from './quality-waivers.js';

export const qualityResourceSignature = (files: { path: string; sha256: string }[]) => createHash('sha256').update(JSON.stringify(files.map(f => [f.path, f.sha256]).sort((a, b) => a[0]!.localeCompare(b[0]!)))).digest('hex');

export async function checkPublishQuality(service: SpineService, input: string, raw: z.input<typeof publishQualityPolicySchema> = {}, skeletonName?: string, control?: WorkControl, remainingSamples?: number) {
  const policy = publishQualityPolicySchema.parse(raw), source = await service.workspace.resolve(input), sourceSha256 = await fileSha256(source);
  const sampleBudget = remainingSamples === undefined ? policy.maxSamples : Math.min(policy.maxSamples, Math.max(0, Math.floor(remainingSamples)));
  const loaded = await service.load(source, skeletonName), assets = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  const names = policy.animations ?? Object.keys(loaded.data.animations ?? {}), reports: { animation: string; passed: boolean; samples: number; requestedSamples: number; reportPath?: string; findingCounts?: Record<string, number>; waivers?: ReturnType<typeof classifyWaivedFindings>; error?: string }[] = [];
  let samples = 0;
  const errors: string[] = [];
  let waivers: Awaited<ReturnType<typeof loadQualityWaivers>> = [];
  if (policy.waivers.length && assets.valid) try { waivers = await loadQualityWaivers(service, policy, await qualityIdentity(service, loaded.data, loaded.jsonPath), skeletonName); } catch (error) { errors.push((error as Error).message); }
  if (!assets.valid) errors.push('Referenced image/audio resources are missing.');
  if (names.length > 200) errors.push('More than 200 animations; select an explicit subset.');
  for (const rule of policy.rules) if (!names.includes(rule.animation)) errors.push(`Rules refer to an unselected animation: ${rule.animation}`);
  if (!errors.length) for (const [index, animation] of names.entries()) {
    await checkpoint(control, { phase: 'publish-quality', completed: index, total: names.length });
    const data = loaded.data.animations?.[animation];
    if (!data) { errors.push(`Animation missing: ${animation}`); continue; }
    const rules = policy.rules.filter(r => r.animation === animation);
    if (rules.length > 1) { errors.push(`Duplicate rules for animation: ${animation}`); continue; }
    const rule = rules[0], end = rule?.end ?? animationDuration(data), start = rule?.start ?? 0, fps = rule?.fps ?? policy.fps;
    const uniformCount = Math.ceil((end - start) * fps) + 1;
    if (!Number.isFinite(uniformCount) || uniformCount < 1 || samples + uniformCount > sampleBudget) { errors.push(`Quality sample budget exceeded or invalid range at ${animation}; select animations or raise maxSamples.`); break; }
    const requested = auditSampleTimes(start, end, fps, rule?.contacts ?? []).length;
    if (samples + requested > sampleBudget) { errors.push(`Quality sample budget exceeded including contact boundaries at ${animation}.`); break; }
    samples += requested;
    try {
      const options = publicationAuditOptions(policy, animation, start, end, fps, rule), audit = await auditAnimation(service, { input: loaded.jsonPath, options }, control), classified = classifyWaivedFindings(audit, options, waivers);
      reports.push({ animation, passed: classified.passed, samples: audit.samples, requestedSamples: requested, reportPath: audit.reportPath, findingCounts: audit.findingCounts, waivers: classified });
    } catch (error) { reports.push({ animation, passed: false, samples: 0, requestedSamples: requested, error: (error as Error).message }); }
  }
  await assertSnapshot(assets);
  if (await fileSha256(source) !== sourceSha256) throw new Error('Quality input changed during validation.');
  const folder = await service.workspace.resolve(path.join('reports', `publish-quality-${randomUUID()}`), false); await mkdir(folder, { recursive: true });
  const reportPath = path.join(folder, 'quality.json'), checksPassed = !errors.length && reports.every(r => r.passed);
  const report = { schema: 'spine-publication-quality/1', input: source, sourceSha256, resourceSignature: qualityResourceSignature(assets.files), skeletonName, policy, sampleBudget, checksPassed, publishingAllowed: policy.mode === 'report' || checksPassed, errors, sampledPoses: reports.reduce((n, r) => n + r.samples, 0), budgetedSamples: samples, animationCount: names.length, noAnimations: !names.length, reports, resourcesVerified: assets.valid, visualAcceptance: 'pending', editorDisplayAcknowledged: false, note: 'Pixel-center mesh checks run automatically. Explicit character rules are required for anatomical joint limits and foot contact windows. Finite sampling and pixel resolution do not certify natural motion. Report mode explicitly permits failed findings; enforce mode blocks publication.', reportPath };
  await atomicJson(reportPath, report); return report;
}

export function assertPublishQuality(report: Awaited<ReturnType<typeof checkPublishQuality>>) {
  if (!report.publishingAllowed) throw new Error(`Publication quality gate failed; no session version/editor handoff was committed. Report: ${report.reportPath}`);
}
