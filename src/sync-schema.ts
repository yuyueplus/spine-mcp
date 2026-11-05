import { z } from 'zod/v4';
export const syncOptionsSchema = z.object({
  intervalMs: z.number().int().min(250).max(30000).default(2000),
  stableMs: z.number().int().min(500).max(30000).default(1500),
  durationSeconds: z.number().int().min(5).max(86400).default(3600),
  includeInitial: z.boolean().default(true),
  maxRevisions: z.number().int().min(1).max(100).default(20),
  maxOutputMiB: z.number().int().min(1).max(1024).default(512),
  verifyEverySeconds: z.number().int().min(1).max(300).default(30),
}).strict();
export const syncResumeOptionsSchema = z.object({ durationSeconds: z.number().int().min(5).max(86400).optional(), maxRevisions: z.number().int().min(1).max(100).optional(), maxOutputMiB: z.number().int().min(1).max(1024).optional() }).strict();
export const syncRequestSchema = z.object({ schemaVersion: z.literal(1), input: z.string().min(1), options: syncOptionsSchema }).strict();
export type SyncOptions = z.infer<typeof syncOptionsSchema>;
export type SyncRequest = z.infer<typeof syncRequestSchema>;
