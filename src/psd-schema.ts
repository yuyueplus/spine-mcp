import { z } from 'zod/v4';
const name = z.string().min(1).max(200).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
export const planPsdImportSchema = z.object({ input: z.string().min(1), name: name.default('PSD-Import'), ignoreHidden: z.boolean().default(true), trimWhitespace: z.boolean().default(true), padding: z.number().int().min(0).max(64).default(1), unitsPerPixel: z.number().finite().positive().max(100).default(1), origin: z.object({ x: z.number().finite().min(-1000000).max(1000000), y: z.number().finite().min(-1000000).max(1000000) }).strict().optional(), reviewSkin: name.optional() }).strict();
export const importPsdSchema = z.object({ requestId: z.string().uuid(), plan: z.string().min(1), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
