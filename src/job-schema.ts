import { z } from 'zod/v4';
import { editSchema } from './edits.js';
import { deliveryOptionsSchema } from './production-schema.js';
import { publishSchema, auditSchema, suiteSchema } from './stability-schema.js';
import { importPsdSchema } from './psd-schema.js';
const input = z.string().min(1), name = z.string().min(1).max(256);
export const frameOptionsSchema = z.object({ animation: name.optional(), skin: name.optional(), start: z.number().finite().min(0).max(300).default(0), end: z.number().finite().min(0).max(300), fps: z.number().int().min(1).max(120).default(30), kind: z.enum(['artwork', 'bones']).default('artwork'), physics: z.boolean().default(false) }).strict();
export const mediaOptionsSchema = frameOptionsSchema.extend({ kind: z.literal('artwork').default('artwork'), width: z.number().int().min(16).max(4096).default(320), height: z.number().int().min(16).max(4096).default(300), transparent: z.boolean().default(true), formats: z.array(z.enum(['apng', 'gif', 'mp4', 'spritesheet'])).min(1).max(4).default(['apng']), columns: z.number().int().min(1).max(16).default(8), rows: z.number().int().min(1).max(16).default(8), plays: z.number().int().min(0).max(65535).default(0), crf: z.number().int().min(0).max(51).default(18), omitEndFrame: z.boolean().default(true) }).strict();
export const skeletonInputSchema = z.object({ input, name, edits: z.array(editSchema).min(1).max(100).optional() }).strict();
export const multiChangeSchema = z.object({ name, edits: z.array(editSchema).min(1).max(100) }).strict();
export const batchSchema = z.object({ inputs: z.array(input).min(1).max(100), action: z.enum(['inspect', 'validate', 'export']), format: z.enum(['json', 'binary']).default('json'), stopOnError: z.boolean().default(false) }).strict();
export const pipelineSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), resume: z.boolean().default(true), steps: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), dependsOn: z.array(name).max(50).default([]), operation: z.enum(['audit_assets', 'preflight', 'edit_json', 'edit_project', 'collect_assets', 'deliver', 'export_frames', 'export_media']), input: input.optional(), inputFrom: name.optional(), output: input.optional(), edits: z.array(editSchema).min(1).max(100).optional(), options: deliveryOptionsSchema.optional(), frames: frameOptionsSchema.optional(), media: mediaOptionsSchema.optional(), skeletonName: name.optional() }).strict()).min(1).max(50) }).strict();
export const jobSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('import_psd'), args: importPsdSchema }).strict(),
  z.object({ operation: z.literal('character_task'), args: z.object({ id: z.string().uuid(), expectedPlanSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict(),
  z.object({ operation: z.literal('publish_and_open'), args: publishSchema }).strict(),
  z.object({ operation: z.literal('audit_animation'), args: auditSchema }).strict(),
  z.object({ operation: z.literal('regression_suite'), args: suiteSchema }).strict(),
  z.object({ operation: z.literal('export_media'), args: z.object({ input, skeletonName: name.optional(), options: mediaOptionsSchema }).strict() }).strict(),
  z.object({ operation: z.literal('pipeline'), args: pipelineSchema }).strict(),
  z.object({ operation: z.literal('deliver'), args: z.object({ input, skeletonName: name.optional(), options: deliveryOptionsSchema }).strict() }).strict(),
  z.object({ operation: z.literal('edit_project'), args: z.object({ input, output: input, edits: z.array(editSchema).min(1).max(100), skeletonName: name.optional() }).strict() }).strict(),
  z.object({ operation: z.literal('build_project'), args: z.object({ entries: z.array(skeletonInputSchema).min(1).max(50), output: input }).strict() }).strict(),
  z.object({ operation: z.literal('edit_multi_project'), args: z.object({ input, output: input, changes: z.array(multiChangeSchema).min(1).max(50) }).strict() }).strict(),
  z.object({ operation: z.literal('export_frames'), args: z.object({ input, skeletonName: name.optional(), options: frameOptionsSchema }).strict() }).strict(),
  z.object({ operation: z.literal('batch'), args: batchSchema }).strict(),
]);
export type JobRequest = z.infer<typeof jobSchema>;
