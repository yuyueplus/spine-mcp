import { z } from 'zod/v4';
const name = z.string().min(1).max(256), input = z.string().min(1), finite = z.number().finite(), time = finite.min(0).max(300);
export const contactSchema = z.object({ bone: name, start: time, end: time, x: finite.optional(), y: finite.optional(), tolerance: finite.positive().default(0.5) }).strict();
export const auditOptionsSchema = z.object({
  animation: name, skin: name.optional(), start: time.default(0), end: time.optional(), fps: z.number().int().min(1).max(120).default(60),
  physics: z.boolean().default(false), physicsFps: z.number().int().min(1).max(120).default(60), meshVisibility: z.enum(['geometry', 'centroid', 'pixels']).default('geometry'), visibilityPixelSize: finite.min(0.001).max(1000).default(1), maxVisibilityPixels: z.number().int().min(1).max(2000000).default(50000),
  contacts: z.array(contactSchema).max(100).default([]),
  joints: z.array(z.object({ bone: name, min: finite, max: finite }).strict()).max(200).default([]),
  separation: z.array(z.object({ left: name, right: name, minDistance: finite.nonnegative().default(0), axis: z.enum(['x', 'y', 'distance']).default('distance') }).strict()).max(100).default([]),
  limbPairs: z.array(z.object({ a: z.array(name).min(2).max(16), b: z.array(name).min(2).max(16) }).strict()).max(50).default([]),
  maxStep: finite.positive().optional(), stepBones: z.array(name).max(200).default([]),
  meshes: z.boolean().default(true), alphaThreshold: z.number().int().min(0).max(255).default(128), minFlippedArea: finite.nonnegative().default(0.001), maxFindings: z.number().int().min(1).max(10000).default(1000),
  preview: z.enum(['none', 'bones', 'artwork']).default('bones'), maxPreviewPoses: z.number().int().min(1).max(8).default(4),
}).strict();
export const auditSchema = z.object({ input, options: auditOptionsSchema, skeletonName: name.optional() }).strict();

export function auditSampleTimes(start: number, end: number, fps: number, contacts: { start: number; end: number }[]) {
  const times = new Set<number>(Array.from({ length: Math.ceil((end - start) * fps) + 1 }, (_, i) => Math.min(end, start + i / fps)));
  for (const contact of contacts) for (const t of [contact.start, contact.end]) if (t >= start && t <= end) times.add(t);
  return [...times].sort((a, b) => a - b);
}
