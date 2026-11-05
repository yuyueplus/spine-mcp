import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { VERSION } from './version.js';
import { publishQualityPolicySchema, type PublishQualityPolicy } from './publish-quality-schema.js';
import { auditOptionsSchema, auditSampleTimes } from './audit-schema.js';
import { auditAnimation } from './animation-audit.js';
import { animationDuration } from './advanced-animation.js';
import { auditAssets, assertSnapshot, resourceRefs, saveReport } from './production-assets.js';
import { attachmentEntries } from './attachment-data.js';
import { fileSha256 } from './file-hash.js';
import type { SpineDocument } from './document.js';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'), sha = z.string().regex(/^[a-f0-9]{64}$/), name = z.string().min(1).max(256);
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const prepareWaiverSchema = z.object({ input: z.string().min(1), skeletonName: name.optional(), animation: name, quality: publishQualityPolicySchema.omit({ waivers: true }).optional(), selections: z.array(z.object({ subject: name, start: z.number().finite().min(0), end: z.number().finite().min(0), triangles: z.array(z.number().int().nonnegative()).min(1).max(10000) }).strict()).min(1).max(100) }).strict();
export const approveWaiverSchema = z.object({ draft: z.string().min(1), expectedSha256: sha, requestId: z.string().uuid(), confirmation: z.literal('reviewed_exact_report'), reason: z.string().trim().min(5).max(2000) }).strict();
const findingSchema = z.object({ code: z.literal('mesh_fold'), time: z.number().finite(), subject: name, triangleIndex: z.number().int().nonnegative(), value: z.number().finite(), limit: z.number().finite() }).strict();
const draftSchema = z.object({ schema: z.literal('spine-quality-waiver-draft/1'), engineVersion: z.string(), input: z.string(), inputSha256: sha, skeletonName: z.string().optional(), dataSignature: sha, resourceSignature: sha, animation: name, profileSignature: sha, options: auditOptionsSchema, selectedFindings: z.array(findingSchema).min(1).max(10000), selections: prepareWaiverSchema.shape.selections, auditReport: z.string() }).strict();

export async function qualityIdentity(service: SpineService, data: SpineDocument, jsonPath: string) {
  const copy = structuredClone(data), refs = await resourceRefs(service.workspace, data, jsonPath), byOwner = new Map<string, string[]>(), resources = [];
  for (const r of refs.refs) { const sha256 = await fileSha256(r.path), owner = `${r.kind}/${r.owner}`, list = byOwner.get(owner) ?? []; list.push(`${r.frame ?? 0}:${sha256}`); byOwner.set(owner, list); resources.push([owner, r.frame ?? 0, sha256]); }
  for (const a of attachmentEntries(copy)) { const list = byOwner.get(`images/${a.skin}/${a.slot}/${a.name}`); if (list) a.value.path = 'content:' + hash(list); }
  for (const [key, value] of Object.entries(copy.events ?? {})) if (value && typeof value === 'object' && !Array.isArray(value) && byOwner.has(`audio/${key}`)) (value as Record<string, unknown>).audio = 'content:' + hash(byOwner.get(`audio/${key}`));
  delete copy.skeleton.images; delete copy.skeleton.audio; delete copy.skeleton.hash;
  return { dataSignature: hash(canonical(copy)), resourceSignature: hash(resources.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) };
}
export function publicationAuditOptions(policy: PublishQualityPolicy, animation: string, start: number, end: number, fps: number, rule?: PublishQualityPolicy['rules'][number]) {
  return auditOptionsSchema.parse({ ...rule, animation, start, end, fps, meshes: true, meshVisibility: 'pixels', visibilityPixelSize: policy.visibilityPixelSize, maxVisibilityPixels: policy.maxVisibilityPixels, alphaThreshold: policy.alphaThreshold, minFlippedArea: policy.minFlippedArea, preview: 'none', maxFindings: 10000 });
}
export const qualityProfileSignature = (options: z.infer<typeof auditOptionsSchema>) => hash(canonical(options));
export async function prepareQualityWaiver(service: SpineService, raw: z.input<typeof prepareWaiverSchema>) {
  const o = prepareWaiverSchema.parse(raw), input = await service.workspace.resolve(o.input), inputSha256 = await fileSha256(input), loaded = await service.load(input, o.skeletonName), assets = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  if (!assets.valid) throw new Error('Waiver preparation requires complete resources.');
  const policy = publishQualityPolicySchema.parse(o.quality ?? {}), animation = loaded.data.animations?.[o.animation]; if (!animation) throw new Error('Waiver animation missing.');
  const rules = policy.rules.filter(r => r.animation === o.animation); if (rules.length > 1) throw new Error('Duplicate waiver animation rules.');
  const rule = rules[0], options = publicationAuditOptions(policy, o.animation, rule?.start ?? 0, rule?.end ?? animationDuration(animation), rule?.fps ?? policy.fps, rule);
  if (Math.ceil((options.end! - options.start) * options.fps) + 1 > policy.maxSamples || auditSampleTimes(options.start, options.end!, options.fps, options.contacts).length > policy.maxSamples) throw new Error('Waiver preparation sample budget exceeded.');
  for (const s of o.selections) if (s.end < s.start) throw new Error('Waiver selection interval is reversed.');
  const audit = await auditAnimation(service, { input: loaded.jsonPath, options }); if (audit.findingsTruncated) throw new Error('Truncated findings cannot be approved; narrow the audit range.');
  const selected = audit.findings.filter(f => f.code === 'mesh_fold' && f.triangleIndex !== undefined && o.selections.some(s => f.subject === s.subject && f.time >= s.start && f.time <= s.end && s.triangles.includes(f.triangleIndex!))).map(f => findingSchema.parse({ code: f.code, time: f.time, subject: f.subject, triangleIndex: f.triangleIndex, value: f.value, limit: f.limit }));
  if (!selected.length) throw new Error('Selections match no sampled mesh-fold findings.');
  const identity = await qualityIdentity(service, loaded.data, loaded.jsonPath); await assertSnapshot(assets); if (await fileSha256(input) !== inputSha256) throw new Error('Waiver source changed.');
  const draft = draftSchema.parse({ schema: 'spine-quality-waiver-draft/1', engineVersion: VERSION, input, inputSha256, skeletonName: o.skeletonName, ...identity, animation: o.animation, profileSignature: qualityProfileSignature(options), options, selectedFindings: selected, selections: o.selections, auditReport: audit.reportPath }), draftPath = await saveReport(service.workspace, 'quality-waiver-draft', draft);
  return { draftPath, draftSha256: await fileSha256(draftPath), selectedFindings: selected.length, requiresExplicitReview: true, approved: false, auditReport: audit.reportPath, scope: 'Only the exact normalized saved data/resources, sampling profile, animation, slot, triangle and sampled instant. No new/worse finding or non-mesh diagnostic is waived.' };
}
export async function approveQualityWaiver(service: SpineService, raw: z.input<typeof approveWaiverSchema>) {
  const o = approveWaiverSchema.parse(raw), filename = await service.workspace.resolve(o.draft); if ((await stat(filename)).size > 8 * 1024 ** 2 || await fileSha256(filename) !== o.expectedSha256) throw new Error('Waiver draft changed.');
  const draft = draftSchema.parse(JSON.parse(await readFile(filename, 'utf8'))); if (draft.engineVersion !== VERSION || await fileSha256(await service.workspace.resolve(draft.input)) !== draft.inputSha256) throw new Error('Waiver draft source/build is stale. Prepare and review again.');
  const loaded = await service.load(draft.input, draft.skeletonName), identity = await qualityIdentity(service, loaded.data, loaded.jsonPath); if (identity.dataSignature !== draft.dataSignature || identity.resourceSignature !== draft.resourceSignature) throw new Error('Waiver resources changed.');
  const folder = await service.workspace.resolve('.quality-waivers', false); await mkdir(folder, { recursive: true }); const output = await service.workspace.resolve(path.join(folder, o.requestId + '.json'), false);
  const body = JSON.stringify({ ...draft, schema: 'spine-quality-waiver/1', approval: { requestId: o.requestId, draftSha256: o.expectedSha256, confirmation: o.confirmation, reason: o.reason } }, null, 2) + '\n';
  try { await writeFile(output, body, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(output, 'utf8') !== body) throw error; }
  return { approved: true, waiver: { path: output, sha256: await fileSha256(output), ...(draft.skeletonName ? { skeleton: draft.skeletonName } : {}) }, confirmationIsCallerReported: true, authenticatedHumanIdentity: false };
}
export async function loadQualityWaivers(service: SpineService, policy: PublishQualityPolicy, identity: { dataSignature: string; resourceSignature: string }, skeletonName?: string) {
  const result = [];
  for (const ref of policy.waivers.filter(r => !r.skeleton || r.skeleton === skeletonName)) {
    const file = await service.workspace.resolve(ref.path); if ((await stat(file)).size > 8 * 1024 ** 2 || await fileSha256(file) !== ref.sha256) throw new Error('Approved waiver hash changed.');
    const raw = JSON.parse(await readFile(file, 'utf8')); if (raw.schema !== 'spine-quality-waiver/1' || raw.approval?.confirmation !== 'reviewed_exact_report' || typeof raw.approval.reason !== 'string' || raw.approval.reason.length < 5) throw new Error('Waiver has not been explicitly approved.');
    const { approval: _approval, ...rest } = raw, draft = draftSchema.parse({ ...rest, schema: 'spine-quality-waiver-draft/1' });
    if (draft.engineVersion !== VERSION || draft.dataSignature !== identity.dataSignature || draft.resourceSignature !== identity.resourceSignature) throw new Error('Approved waiver is stale for this saved project/resource/build revision.');
    result.push({ ...draft, reference: ref });
  }
  return result;
}
export function classifyWaivedFindings(audit: Awaited<ReturnType<typeof auditAnimation>>, options: z.infer<typeof auditOptionsSchema>, waivers: Awaited<ReturnType<typeof loadQualityWaivers>>) {
  const applicable = waivers.filter(w => w.animation === options.animation); for (const w of applicable) if (w.profileSignature !== qualityProfileSignature(options)) throw new Error('Waiver sampling/quality profile changed; review again.');
  const waived = audit.findings.filter(f => f.code === 'mesh_fold' && applicable.some(w => w.selectedFindings.some(b => b.time === f.time && b.subject === f.subject && b.triangleIndex === f.triangleIndex && b.limit === f.limit && f.value !== undefined && f.value <= b.value + 1e-9)));
  const total = Object.values(audit.findingCounts).reduce((n, v) => n + v, 0), blockingCount = total - waived.length;
  return { passed: blockingCount === 0 && !audit.findingsTruncated, rawChecksPassed: audit.checksPassed, waivedCount: waived.length, blockingCount, waiverReferences: applicable.map(w => w.reference), findingsTruncated: audit.findingsTruncated };
}
