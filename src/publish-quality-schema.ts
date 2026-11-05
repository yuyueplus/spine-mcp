import { z } from 'zod/v4';
import { auditOptionsSchema } from './audit-schema.js';

const ruleSchema = auditOptionsSchema.pick({ animation: true, skin: true, start: true, end: true, fps: true, physics: true, physicsFps: true, contacts: true, joints: true, separation: true, limbPairs: true, maxStep: true, stepBones: true }).extend({ fps: z.number().int().min(1).max(120).optional() }).strict();
export const qualityWaiverRefSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), skeleton: z.string().min(1).optional() }).strict();

export const publishQualityPolicySchema = z.object({
  mode: z.enum(['enforce', 'report']).default('enforce'),
  animations: z.array(z.string().min(1).max(256)).min(1).max(200).refine(v => new Set(v).size === v.length, 'Animation names must be unique.').optional(),
  fps: z.number().int().min(1).max(120).default(60),
  maxSamples: z.number().int().min(1).max(50000).default(6000),
  visibilityPixelSize: z.number().finite().min(0.01).max(100).default(0.1),
  maxVisibilityPixels: z.number().int().min(1).max(2000000).default(2000000),
  alphaThreshold: z.number().int().min(0).max(255).default(128),
  minFlippedArea: z.number().finite().nonnegative().default(0.001),
  rules: z.array(ruleSchema).max(30).default([]),
  waivers: z.array(qualityWaiverRefSchema).max(30).default([]),
}).strict();
export type PublishQualityPolicy = z.infer<typeof publishQualityPolicySchema>;
