import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { Workspace } from './config.js';
import { atomicJson } from './jobs.js';
import type { NativePreviewRequest } from './native-preview.js';

export const previewRequestId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, 'Use a lowercase UUID v4 requestId.');
export const previewMutationOptions = z.object({ requestId: previewRequestId.optional(), expectedGeneration: z.number().int().positive().optional() }).strict();
export type MutationOptions = z.infer<typeof previewMutationOptions>;
export interface MutationReceipt { requestId?: string; fingerprint: string; operation: 'update' | 'resume' | 'stop'; generation: number; appliedAt: string }
export interface PreviewCreation { schema: 1; id: string; fingerprint: string; sourceSha256: string; phase: 'reserved' | 'preparing' | 'importing' | 'ready' | 'failed' | 'cancelled'; createdAt: string; updatedAt: string; attempts: number; error?: string }
export const previewFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const creationPath = (root: string, id: string) => path.join(root, `start-${previewRequestId.parse(id)}.json`);
export async function readPreviewCreation(workspace: Workspace, root: string, id: string): Promise<PreviewCreation | null> {
  const file = await workspace.resolve(creationPath(root, id), false);
  try {
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('Preview creation record exceeds 8 MiB.');
    const record = JSON.parse(await readFile(file, 'utf8')) as PreviewCreation;
    if (record.schema !== 1 || record.id !== id || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !/^[a-f0-9]{64}$/.test(record.sourceSha256) || !['reserved', 'preparing', 'importing', 'ready', 'failed', 'cancelled'].includes(record.phase) || !Number.isInteger(record.attempts) || record.attempts < 0) throw new Error('Invalid preview creation record.');
    return record;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function writePreviewCreation(workspace: Workspace, root: string, record: PreviewCreation) {
  record.updatedAt = new Date().toISOString();
  await atomicJson(await workspace.resolve(creationPath(root, record.id), false), record);
}
export function checkPreviewMutation(request: NativePreviewRequest, options: MutationOptions, operation: MutationReceipt['operation'], fingerprint: string) {
  const receipts = request.mutationReceipts ?? [];
  if (!Array.isArray(receipts) || receipts.length > 1024 || receipts.some(r => !r || !previewRequestId.safeParse(r.requestId).success || !/^[a-f0-9]{64}$/.test(r.fingerprint) || !['update', 'resume', 'stop'].includes(r.operation) || !Number.isInteger(r.generation) || r.generation < 1) || new Set(receipts.map(r => r.requestId)).size !== receipts.length) throw new Error('Invalid preview mutation receipt history.');
  const previous = options.requestId && receipts.find(r => r.requestId === options.requestId);
  if (previous) {
    if (previous.operation !== operation || previous.fingerprint !== fingerprint) throw new Error('requestId belongs to a different preview mutation or arguments. Use a new requestId.');
    return previous;
  }
  if (options.expectedGeneration !== undefined && options.expectedGeneration !== request.generation) throw new Error(`Preview generation conflict: expected ${options.expectedGeneration}, current ${request.generation}. No request changed.`);
  if (options.requestId && receipts.length >= 1024) throw new Error('Preview has 1024 retained mutation receipts. Existing receipts remain reusable; new idempotent mutations require a new session. Calls without requestId remain available.');
  return null;
}
export function recordPreviewMutation(request: NativePreviewRequest, options: MutationOptions, operation: MutationReceipt['operation'], fingerprint: string): MutationReceipt {
  const receipt = { ...(options.requestId ? { requestId: options.requestId } : {}), operation, fingerprint, generation: request.generation, appliedAt: new Date().toISOString() };
  if (options.requestId) request.mutationReceipts = [...request.mutationReceipts ?? [], receipt];
  return receipt;
}
