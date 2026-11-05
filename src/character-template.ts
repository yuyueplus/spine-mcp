import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { type SpineDocument } from './document.js';
import { poseAnimationSchema, footBakeSchema } from './stability-schema.js';
import { buildPoseData, savedCharacterChange } from './character-workflow.js';
import { bakeFootContactData } from './foot-contacts.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { fileSha256 } from './file-hash.js';

const name = z.string().min(1).max(256), alias = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), input = z.string().min(1);
const boneMap = z.record(alias, name).refine(map => Object.keys(map).length <= 200, 'At most 200 roles.');
const slotRole = z.object({ slot: name, attachments: z.record(alias, name).default({}) }).strict();
const slotMap = z.record(alias, slotRole).refine(map => Object.keys(map).length <= 20, 'At most 20 slot roles.');
const recipeSchema = poseAnimationSchema.omit({ input: true, output: true, name: true });
export const saveTemplateSchema = z.object({ input, output: input, name, roles: boneMap, slots: slotMap.default({}), recipe: recipeSchema, contacts: footBakeSchema.shape.chains.optional() }).strict();
export const applyTemplateSchema = z.object({ input, template: input, output: input, animation: name, skin: name.optional(), boneMap: boneMap.default({}), slotMap: slotMap.default({}), timeScale: z.number().finite().min(0.1).max(10).default(1), translationScale: z.number().finite().min(0.01).max(100).default(1), bakeContacts: z.boolean().default(false), constraintMode: z.enum(['reject', 'bake']).default('reject'), physics: z.boolean().default(false) }).strict();
const fileSchema = saveTemplateSchema.omit({ input: true, output: true }).extend({ schema: z.literal('spine-character-template/1'), capturedAt: z.string(), source: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), resources: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()).max(10000) }).strict() }).strict();
export type Template = z.output<typeof fileSchema>;
export const characterTemplateFileSchema = fileSchema;

export function resolveTemplate(template: Pick<Template, 'roles' | 'slots' | 'recipe' | 'contacts'>, data: SpineDocument, overrides: z.output<typeof applyTemplateSchema>) {
  for (const key of Object.keys(overrides.boneMap)) if (!Object.hasOwn(template.roles, key)) throw new Error(`Unknown bone role override: ${key}`);
  for (const key of Object.keys(overrides.slotMap)) if (!Object.hasOwn(template.slots, key)) throw new Error(`Unknown slot role override: ${key}`);
  const roles = new Map(Object.entries(template.roles).map(([role, original]) => [role, Object.hasOwn(overrides.boneMap, role) ? overrides.boneMap[role]! : original])), used = new Set<string>();
  for (const bone of roles.values()) { if (!data.bones.some(b => b.name === bone) || used.has(bone)) throw new Error(`Template bone mapping is missing or duplicated: ${bone}`); used.add(bone); }
  const bone = (role: string) => { const value = roles.get(role); if (!value) throw new Error(`Unknown template bone role: ${role}`); return value; };
  const slots = new Map(Object.entries(template.slots).map(([role, original]) => [role, Object.hasOwn(overrides.slotMap, role) ? overrides.slotMap[role]! : original]));
  const usedSlots = new Set<string>();
  for (const item of slots.values()) { if (!data.slots?.some(s => s.name === item.slot) || usedSlots.has(item.slot)) throw new Error(`Template slot mapping is missing or duplicated: ${item.slot}`); usedSlots.add(item.slot); }
  const t = (time: number) => time * overrides.timeScale, recipe = structuredClone(template.recipe);
  recipe.poses = recipe.poses.map(p => ({ ...p, time: t(p.time), bones: Object.fromEntries(Object.entries(p.bones).map(([role, value]) => [bone(role), { ...value, ...(value.x === undefined ? {} : { x: value.x * overrides.translationScale }), ...(value.y === undefined ? {} : { y: value.y * overrides.translationScale }) }])) }));
  recipe.secondary = recipe.secondary.map(c => ({ ...c, bones: c.bones.map(bone), driver: bone(c.driver), delay: t(c.delay), delayPerBone: t(c.delayPerBone) }));
  recipe.blinks = recipe.blinks.map(c => {
    const item = slots.get(c.slot); if (!item) throw new Error(`Unknown blink slot role: ${c.slot}`);
    const attachment = (role: string) => { if (!Object.hasOwn(item.attachments, role)) throw new Error(`Unknown blink attachment role: ${role}`); return item.attachments[role]!; };
    return { ...c, slot: item.slot, open: attachment(c.open), closed: attachment(c.closed), times: c.times.map(t), duration: t(c.duration) };
  });
  const contacts = template.contacts?.map(c => ({ upper: bone(c.upper), lower: bone(c.lower), foot: bone(c.foot), contacts: c.contacts.map(w => ({ ...w, start: t(w.start), end: t(w.end), ...(w.x === undefined ? {} : { x: w.x * overrides.translationScale }), ...(w.y === undefined ? {} : { y: w.y * overrides.translationScale }) })) }));
  // Absolute contact targets belong to one rig's world origin. Portable
  // templates capture contact windows; resolve anchors on the target pose.
  if (template.contacts?.some(c => c.contacts.some(w => w.x !== undefined || w.y !== undefined))) throw new Error('Reusable contact templates accept timing windows only; omit absolute x/y anchors so each target rig resolves its own planted position.');
  for (const c of contacts ?? []) {
    if (data.bones.find(b => b.name === c.lower)?.parent !== c.upper || data.bones.find(b => b.name === c.foot)?.parent !== c.lower) throw new Error('Template contact mapping must be a direct upper > lower > foot chain.');
    const windows = [...c.contacts].sort((a, b) => a.start - b.start), end = recipe.poses.at(-1)!.time;
    for (let i = 0; i < windows.length; i++) if (windows[i]!.end < windows[i]!.start || windows[i]!.end > end || i > 0 && windows[i]!.start <= windows[i - 1]!.end) throw new Error('Template contact windows overlap, reverse or exceed the recipe duration.');
  }
  return { recipe, contacts, mapping: Object.fromEntries(roles) };
}
export async function saveCharacterTemplate(service: SpineService, raw: z.input<typeof saveTemplateSchema>) {
  const args = saveTemplateSchema.parse(raw), input = await service.workspace.resolve(args.input), hash = await fileSha256(input), loaded = await service.load(input), resources = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  if (!resources.valid) throw new Error('Template capture requires complete source resources.');
  if (!Object.keys(args.roles).length) throw new Error('Provide at least one bone role.');
  const template: Template = { schema: 'spine-character-template/1', name: args.name, roles: args.roles, slots: args.slots, recipe: args.recipe, ...(args.contacts ? { contacts: args.contacts } : {}), source: { sha256: hash, resources: resources.files.map(f => ({ path: f.path, sha256: f.sha256 })) }, capturedAt: new Date().toISOString() };
  const mapped = resolveTemplate(template, loaded.data, applyTemplateSchema.parse({ input, template: 'capture', output: 'unused', animation: `__template_${randomUUID().replaceAll('-', '')}` }));
  buildPoseData(loaded.data, poseAnimationSchema.parse({ ...mapped.recipe, input, output: 'unused', name: `__template_${randomUUID().replaceAll('-', '')}` }));
  const output = await service.workspace.resolve(args.output, false); if (path.extname(output).toLowerCase() !== '.json') throw new Error('Template output must use .json.');
  const text = JSON.stringify(fileSchema.parse(template), null, 2); if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Character template exceeds 8 MiB.');
  await assertSnapshot(resources); if (await fileSha256(input) !== hash) throw new Error('Source changed during template capture.');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, text, { flag: 'wx' }); return { path: output, sha256: await fileSha256(output), name: args.name, roles: Object.keys(args.roles), contactChains: args.contacts?.length ?? 0, originalUnchanged: true, note: 'Data recipe with explicit bone/slot roles, not anatomy inference or executable instructions. No pixels, animation data from the editor, or visual acceptance are inferred.' };
}
export async function applyCharacterTemplate(service: SpineService, raw: z.input<typeof applyTemplateSchema>) {
  const args = applyTemplateSchema.parse(raw), filename = await service.workspace.resolve(args.template); if ((await stat(filename)).size > 8 * 1024 * 1024) throw new Error('Character template exceeds 8 MiB.');
  if (!args.bakeContacts && (args.physics || args.constraintMode !== 'reject' || args.skin)) throw new Error('physics, constraintMode and skin apply only when bakeContacts=true.');
  const hash = await fileSha256(filename), template = fileSchema.parse(JSON.parse(await readFile(filename, 'utf8'))); let details: unknown;
  const result = await savedCharacterChange(service, args.input, args.output, async source => {
    if (Object.hasOwn(source.animations ?? {}, args.animation)) throw new Error('Choose a new animation name.');
    const mapped = resolveTemplate(template, source, args), poseName = args.bakeContacts ? `__template_${randomUUID().replaceAll('-', '')}` : args.animation;
    let data = buildPoseData(source, poseAnimationSchema.parse({ ...mapped.recipe, input: args.input, output: args.output, name: poseName })), contactVerification: unknown;
    if (args.bakeContacts) {
      if (!mapped.contacts?.length) throw new Error('This template has no contact windows to bake.');
      const baked = bakeFootContactData(data, footBakeSchema.parse({ input: args.input, output: args.output, animation: poseName, newName: args.animation, fps: mapped.recipe.fps, skin: args.skin, chains: mapped.contacts, constraintMode: args.constraintMode, physics: args.physics })); data = baked.data; contactVerification = baked.diagnostics; delete data.animations![poseName];
    }
    details = { template: filename, templateSha256: hash, name: template.name, mapping: mapped.mapping, animation: args.animation, timeScale: args.timeScale, translationScale: args.translationScale, contactVerification: contactVerification ?? null, visualAcceptance: 'pending' };
    if (await fileSha256(filename) !== hash) throw new Error('Template changed during application.'); return data;
  });
  return { ...result, templateApplication: details };
}
