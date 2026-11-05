import { z } from 'zod/v4';
import { label, filename, sha } from './character-candidates.js';
const finite=z.number().finite();
export const meshTargetRefSchema=z.object({id:label,slot:label,attachment:label}).strict();
export const meshSeamEndpointSchema=z.object({target:label,vertex:z.number().int().min(0).max(1999)}).strict();
export const meshSeamSchema=z.object({name:label,a:meshSeamEndpointSchema,b:meshSeamEndpointSchema,mode:z.enum(['coincident','preserve_source_offset']).default('coincident'),tolerance:finite.min(.0001).max(10).default(.05)}).strict();
export const reviewedSeamPlanSchema=z.object({plan:filename,expectedSha256:sha,selected:z.array(label).min(1).max(128),confirmation:z.literal('use_reviewed_seams')}).strict().refine(a=>new Set(a.selected).size===a.selected.length,'Selected seam candidates must be unique.');
