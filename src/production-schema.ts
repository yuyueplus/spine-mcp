import { z } from 'zod/v4';
import { publishQualityPolicySchema } from './publish-quality-schema.js';
import { boneTimelineChannels, slotTimelineChannels } from './timeline-tools.js';
import { constraintTypes } from './constraint-data.js';
const name = z.string().min(1).max(256), number = z.number().finite(), time = number.min(0).max(300), json = z.record(z.string(), z.json());
export const refSchema = z.object({ skin: name, slot: name, name }).strict();
export const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bone'), bone: name, channel: z.enum(boneTimelineChannels) }).strict(),
  z.object({ kind: z.literal('slot'), slot: name, channel: z.enum(slotTimelineChannels) }).strict(),
  z.object({ kind: z.literal('events') }).strict(), z.object({ kind: z.literal('drawOrder') }).strict(),
  z.object({ kind: z.literal('constraint'), constraint: z.string().max(256), constraintType: z.enum(constraintTypes), channel: name }).strict(),
  refSchema.extend({ kind: z.literal('attachment'), channel: z.enum(['deform', 'sequence']) }).strict(),
]);
const collision = z.enum(['error', 'overwrite', 'keep']).default('error');
const bakeOptions = { fps: z.number().int().min(1).max(120).default(60), skin: name.optional(), physics: z.boolean().default(false), tolerance: number.positive().max(100).default(0.01) };
export const layerSchema = z.object({ animation: name, start: time.default(0), end: time.optional(), sourceStart: time.default(0), timeScale: number.positive().max(100).default(1), weight: number.min(0).max(1).default(1), fadeIn: time.default(0), fadeOut: time.default(0), mode: z.enum(['override', 'additive']).default('override'), loop: z.boolean().default(false), bones: z.array(name).min(1).max(2000).optional(), slots: z.array(name).min(1).max(2000).optional(), includeDrawOrder: z.boolean().optional(), includeEvents: z.boolean().default(true), discreteThreshold: number.min(0).max(1).default(0.5) }).strict();
export const adaptiveOptionsShape = { tolerance: number.positive().max(100).default(0.01), maxDepth: z.number().int().min(1).max(16).default(10), minDepth: z.number().int().min(0).max(16).default(2), maxSamples: z.number().int().min(5).max(10000).default(2000), skin: name.optional() };
export const nameMapsSchema = z.object({ bones: z.record(name, name).optional(), slots: z.record(name, name).optional(), skins: z.record(name, name).optional(), events: z.record(name, name).optional(), constraints: z.record(name, name).optional() }).strict();
export const packSettingsSchema = z.object({ maxWidth: z.number().int().min(16).max(8192).default(2048), maxHeight: z.number().int().min(16).max(8192).default(2048), paddingX: z.number().int().min(0).max(64).default(2), paddingY: z.number().int().min(0).max(64).default(2), rotation: z.boolean().default(false), pot: z.boolean().default(true), duplicatePadding: z.boolean().default(true), edgePadding: z.boolean().default(true), stripWhitespaceX: z.boolean().default(false), stripWhitespaceY: z.boolean().default(false), premultiplyAlpha: z.boolean().default(false), useIndexes: z.boolean().default(false), filterMin: z.enum(['Nearest', 'Linear']).default('Linear'), filterMag: z.enum(['Nearest', 'Linear']).default('Linear') }).strict();
export const productionEditSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bake_clipping'), animation: name, newName: name, fps: z.number().int().min(1).max(120).default(30), skin: name.optional(), physics: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('retarget_animation'), source: z.string().min(1), animation: name, newName: name, boneMap: z.record(name, name).optional(), autoMap: z.boolean().default(true), translationScale: number.positive().max(1000).optional(), sourceSkin: name.optional(), ...bakeOptions }).strict(),
  z.object({ type: z.literal('world_mirror'), animation: name, newName: name, axis: z.enum(['x', 'y']), pivotX: number.default(0), pivotY: number.default(0), swapSides: z.boolean().default(false), boneMap: z.record(name, name).optional(), bones: z.array(name).min(1).max(2000).optional(), ...bakeOptions }).strict(),
  z.object({ type: z.literal('compose_animation'), newName: name, layers: z.array(layerSchema).min(1).max(20), ...bakeOptions }).strict(),
  z.object({ type: z.literal('bake_constraints'), animation: name, newName: name, ...bakeOptions }).strict(),
  z.object({ type: z.literal('simplify_animation_adaptive'), animation: name, newName: name, fps: z.number().int().min(1).max(120).default(60), ...adaptiveOptionsShape }).strict(),
  z.object({ type: z.literal('relink_assets'), images: z.string().optional(), audio: z.string().optional(), paths: z.record(name, name).optional(), audioPaths: z.record(name, name).optional() }).strict(),
  z.object({ type: z.literal('edit_keyframes'), animation: name, target: targetSchema, action: z.enum(['upsert', 'delete']), keyframes: z.array(json).max(10000).optional(), times: z.array(time).max(10000).optional(), indices: z.array(z.number().int().nonnegative()).max(10000).optional(), start: time.optional(), end: time.optional(), collision }).strict(),
  z.object({ type: z.literal('edit_curves'), animation: name, target: targetSchema, times: z.array(time).min(1).max(10000), curve: z.union([z.literal('linear'), z.literal('stepped'), z.array(number).min(4).max(28)]) }).strict(),
  z.object({ type: z.literal('insert_boundary_keys'), animation: name, targets: z.array(targetSchema).min(1).max(100), times: z.array(time).min(1).max(1000), mode: z.enum(['runtime', 'curve']).default('runtime') }).strict(),
  z.object({ type: z.literal('paste_keyframes'), fromAnimation: name, toAnimation: name, mappings: z.array(z.object({ from: targetSchema, to: targetSchema }).strict()).min(1).max(100), start: time, end: time, destination: time, collision, boundaries: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('key_pose'), animation: name, sourceAnimation: name, time, destination: time, bones: z.array(name).min(1).max(2000), skin: name.optional(), collision }).strict(),
  z.object({ type: z.literal('transfer_animation'), source: z.string().min(1).describe('Saved source skeleton JSON inside workspace.'), animation: name, newName: name, maps: nameMapsSchema.default({}), replace: z.boolean().default(false), includeEvents: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('transfer_rig'), source: z.string().min(1), root: name, parent: name, prefix: name, includeAnimations: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('merge_skins'), skins: z.array(name).min(2).max(100), newName: name, collision: z.enum(['error', 'first', 'last']).default('error') }).strict(),
  refSchema.extend({ type: z.literal('mesh_from_contours'), threshold: z.number().int().min(1).max(255).default(1), representation: z.enum(['compound', 'single-mesh']).default('compound') }).strict(),
  refSchema.extend({ type: z.literal('edit_mesh_vertices'), changes: z.array(z.object({ index: z.number().int().nonnegative(), x: number.optional(), y: number.optional(), u: number.min(0).max(1).optional(), v: number.min(0).max(1).optional() }).strict()).min(1).max(10000) }).strict(),
  refSchema.extend({ type: z.literal('refine_selected_triangles'), triangles: z.array(z.number().int().nonnegative()).min(1).max(10000) }).strict(),
  refSchema.extend({ type: z.literal('replace_mesh_topology'), mesh: z.object({ vertices: z.array(number).min(6).max(660000), uvs: z.array(number.min(0).max(1)).min(6).max(20000), triangles: z.array(z.number().int().nonnegative()).min(3).max(600000), hull: z.number().int().min(0).max(10000) }).strict(), deformPolicy: z.enum(['reject', 'clear', 'interpolate']).default('reject') }).strict(),
  z.object({ type: z.literal('transfer_weights'), from: refSchema, to: refSchema, method: z.enum(['nearest-vertex', 'surface']).default('nearest-vertex'), maxDistance: number.nonnegative().optional(), minWeight: number.min(0).max(1).default(0), boneMap: z.record(name, name).optional(), mirror: z.enum(['x', 'y']).optional(), lockedBones: z.array(name).max(256).optional(), clearDeform: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('simplify_animation'), animation: name, newName: name, fps: z.number().int().min(1).max(120).default(60), tolerance: number.positive().max(100).default(0.001), skin: name.optional() }).strict(),
  z.object({ type: z.literal('selective_bake'), animation: name, newName: name, constraints: z.array(name).min(1).max(100), fps: z.number().int().min(1).max(120).default(60), skin: name.optional(), physics: z.boolean().default(false), tolerance: number.positive().max(100).default(0.01) }).strict(),
]);
export type ProductionEdit = z.infer<typeof productionEditSchema>;
export const deliveryOptionsSchema = z.object({ formats: z.array(z.enum(['json', 'binary'])).min(1).max(2).default(['json', 'binary']), atlas: z.boolean().default(true), atlasPreset: z.enum(['portable', 'compact', 'pixel']).default('portable'), packSettings: packSettingsSchema.optional(), includeProject: z.boolean().default(true), quality: publishQualityPolicySchema.optional() }).strict();

