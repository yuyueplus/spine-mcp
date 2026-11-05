import { z } from 'zod/v4';
import { addAnimation, addBone, parseDocument, setBone, setTimeline, type SpineDocument } from './document.js';
import { addSkin, addSlot, setSlot, setAttachmentTimeline, setColorTimeline } from './slot-edits.js';
import { attachImage } from './image-assets.js';
import { blendModes } from './slot-data.js';
import type { Workspace } from './config.js';
import { setEvent, setEventTimeline, setDrawOrder, setFolderDrawOrder, retimeAnimation, renameAnimation, removeTimeline } from './animation-edits.js';
import { renameObject, deleteObject, reparentBone, setSlotOrder } from './structure.js';
import { setConstraint, setConstraintTimeline, setSkinMembers } from './constraint-edits.js';
import { constraintTypes } from './constraint-data.js';
import { setAttachment, setAttachmentTimeline as setAttachmentAnimation, setWeights } from './geometry-edits.js';
import { cropAnimation, mergeAnimations, mirrorAnimation, bakeAnimation } from './advanced-animation.js';
import { meshFromRegion, autoWeights } from './mesh-generation.js';
import { compileFolderDrawOrder } from './draw-order-compilation.js';
import { cleanWeights, smoothWeights } from './weight-edits.js';
import { meshFromAlpha, polygonFromRegion } from './alpha-geometry.js';
import { copyAttachment, linkMesh, unlinkMesh } from './attachment-reuse.js';
import { transformMesh, refineMesh } from './mesh-edits.js';
import { copyTimelines, retimeKeyframes } from './timeline-tools.js';
import { productionEditSchema } from './production-schema.js';
import { applyProductionEdit } from './production-edits.js';

const finite = z.number().finite();
const name = z.string().min(1).max(256);
export const transformSchema = z.object({ x: finite.optional(), y: finite.optional(), rotation: finite.optional(), length: finite.nonnegative().optional(), scaleX: finite.optional(), scaleY: finite.optional(), shearX: finite.optional(), shearY: finite.optional() }).strict();
export const keyframeSchema = z.object({ time: finite.nonnegative(), value: finite.optional(), x: finite.optional(), y: finite.optional(), curve: z.union([z.literal('stepped'), z.array(finite)]).optional() }).strict();
const color = z.string().regex(/^[0-9a-f]{6}([0-9a-f]{2})?$/i);
export const slotSetupSchema = z.object({ attachment: name.nullable().optional(), color: color.optional(), dark: z.string().regex(/^[0-9a-f]{6}$/i).nullable().optional(), blend: z.enum(blendModes).optional(), visible: z.boolean().optional() }).strict();
export const slotChangesSchema = slotSetupSchema.extend({ bone: name.optional() });
export const regionTransformSchema = z.object({ x: finite.optional(), y: finite.optional(), rotation: finite.optional(), scaleX: finite.optional(), scaleY: finite.optional(), width: finite.positive().optional(), height: finite.positive().optional(), color: color.optional() }).strict();
export const attachmentFrameSchema = z.object({ time: finite.nonnegative(), name: name.nullable().describe('Attachment placeholder name, or null to hide the slot.') }).strict();
export const colorFrameSchema = z.object({ time: finite.nonnegative(), color, curve: z.union([z.literal('stepped'), z.array(finite).length(16)]).optional() }).strict();
export const eventPayloadSchema = z.object({ int: z.number().int().min(-2147483648).max(2147483647).optional(), float: finite.optional(), string: z.string().max(16384).optional() }).strict();
export const eventFrameSchema = eventPayloadSchema.extend({ time: finite.nonnegative(), name }).strict();
export const drawOrderFrameSchema = z.object({ time: finite.nonnegative(), order: z.array(name).max(5000).nullable().describe('Every slot name once, from back to front; null restores setup order.') }).strict();
export const folderDrawOrderSchema = z.object({ slots: z.array(name).min(1).max(5000), keyframes: z.array(drawOrderFrameSchema).max(10000) }).strict();
export const timelineTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bone'), bone: name, channel: z.enum(['rotate', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'shear', 'shearx', 'sheary', 'inherit']) }).strict(),
  z.object({ kind: z.literal('slot'), slot: name, channel: z.enum(['attachment', 'rgba', 'rgb', 'alpha', 'rgba2', 'rgb2']) }).strict(),
  z.object({ kind: z.literal('events') }).strict(), z.object({ kind: z.literal('drawOrder') }).strict(),
]);
export const namedTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bone'), name }).strict(), z.object({ kind: z.literal('slot'), name }).strict(),
  z.object({ kind: z.literal('skin'), name }).strict(), z.object({ kind: z.literal('animation'), name }).strict(),
  z.object({ kind: z.literal('constraint'), name, constraintType: z.enum(constraintTypes).optional().describe('Required when this name is shared by multiple constraint types.') }).strict(),
  z.object({ kind: z.literal('attachment'), skin: name, slot: name, name }).strict(),
]);
export const constraintDefinitionSchema = z.object({ name, type: z.enum(constraintTypes) }).catchall(z.json());
export const constraintSelectorSchema = z.union([name, z.object({ name, type: z.enum(constraintTypes) }).strict()]);
export const constraintFrameSchema = z.record(z.string(), z.json());
export const influenceSchema = z.object({ bone: name, weight: finite.nonnegative(), x: finite.optional(), y: finite.optional() }).strict();
export const weightOptionsShape = {
  vertices: z.array(z.number().int().nonnegative()).min(1).max(10000).optional(),
  maxInfluences: z.number().int().min(1).max(16).default(4), minWeight: finite.min(0).max(1).default(0.001), clearDeform: z.boolean().default(false),
};
export const alphaOptionsShape = { alphaThreshold: z.number().int().min(1).max(255).default(1), padding: finite.min(0).max(64).default(1), maxVertices: z.number().int().min(4).max(512).default(64) };
export const polygonOptionsShape = { targetSlot: name, targetName: name, kind: z.enum(['boundingbox', 'clipping']), endSlot: name.optional(), replace: z.boolean().default(false), setAsSetup: z.boolean().default(true) };
export const attachmentRefSchema = z.object({ skin: name, slot: name, name }).strict();
export const detailedTimelineTargetSchema = z.discriminatedUnion('kind', [
  ...timelineTargetSchema.options,
  z.object({ kind: z.literal('constraint'), constraint: z.string().max(256), constraintType: z.enum(constraintTypes), channel: name }).strict(),
  attachmentRefSchema.extend({ kind: z.literal('attachment'), channel: z.enum(['deform', 'sequence']) }).strict(),
]);
export const timelineMappingSchema = z.object({ from: detailedTimelineTargetSchema, to: detailedTimelineTargetSchema }).strict();
export const copyTimelinesShape = { fromAnimation: name, toAnimation: name, mappings: z.array(timelineMappingSchema).min(1).max(100), replace: z.boolean().default(false), timeScale: finite.positive().default(1), timeOffset: finite.default(0) };
export const retimeKeyframesShape = { animation: name, targets: z.array(detailedTimelineTargetSchema).min(1).max(100), start: finite.min(0).max(300), end: finite.min(0).max(300), timeScale: finite.positive().default(1), timeOffset: finite.default(0) };
export const copyAttachmentOptionsShape = { preserveWorld: z.boolean().default(true), copyTimelines: z.boolean().default(true), setAsSetup: z.boolean().default(false) };
export const linkMeshOptionsShape = { inheritTimelines: z.boolean().default(true), copyTimelines: z.boolean().default(false), preserveWorld: z.boolean().default(false), setAsSetup: z.boolean().default(false) };
export const meshTransformSchema = z.object({ x: finite.optional(), y: finite.optional(), rotation: finite.optional(), scaleX: finite.optional(), scaleY: finite.optional(), pivotX: finite.optional(), pivotY: finite.optional() }).strict();
export const meshTransformOptionsShape = { transform: meshTransformSchema, vertices: z.array(z.number().int().nonnegative()).min(1).max(10000).optional(), transformDeform: z.boolean().default(true) };
export const meshPageShape = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(500).default(100), triangleOffset: z.number().int().nonnegative().default(0), triangleLimit: z.number().int().min(1).max(500).default(100) };
export const editSchema = z.discriminatedUnion('type', [
  ...productionEditSchema.options,
  z.object({ type: z.literal('set_bone'), bone: name, transform: transformSchema }).strict(),
  z.object({ type: z.literal('add_bone'), name, parent: name, transform: transformSchema.default({}) }).strict(),
  z.object({ type: z.literal('add_animation'), name, copyFrom: name.optional() }).strict(),
  z.object({ type: z.literal('set_timeline'), animation: name, bone: name, channel: z.enum(['rotate', 'translate', 'scale', 'shear']), keyframes: z.array(keyframeSchema).min(1).max(10000) }).strict(),
  z.object({ type: z.literal('add_slot'), name, bone: name, setup: slotSetupSchema.default({}) }).strict(),
  z.object({ type: z.literal('set_slot'), slot: name, setup: slotChangesSchema }).strict(),
  z.object({ type: z.literal('add_skin'), name, copyFrom: name.optional(), baseSkin: name.optional().describe('Required only for copyFrom=default. Moves existing default attachments into this NEW named base skin in the output before copying. Select the base skin explicitly in previews.') }).strict(),
  z.object({ type: z.literal('attach_image'), skin: name, slot: name, name, image: z.string().min(1), transform: regionTransformSchema.default({}), replace: z.boolean().default(false), setAsSetup: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('set_attachment_timeline'), animation: name, slot: name, keyframes: z.array(attachmentFrameSchema).min(1).max(10000) }).strict(),
  z.object({ type: z.literal('set_color_timeline'), animation: name, slot: name, keyframes: z.array(colorFrameSchema).min(1).max(10000) }).strict(),
  z.object({ type: z.literal('set_event'), name, defaults: eventPayloadSchema.default({}) }).strict(),
  z.object({ type: z.literal('set_event_timeline'), animation: name, keyframes: z.array(eventFrameSchema).max(10000) }).strict(),
  z.object({ type: z.literal('set_draw_order'), animation: name, keyframes: z.array(drawOrderFrameSchema).max(10000) }).strict(),
  z.object({ type: z.literal('retime_animation'), animation: name, timeScale: finite.positive().default(1), timeOffset: finite.default(0) }).strict(),
  z.object({ type: z.literal('copy_timelines'), ...copyTimelinesShape }).strict(),
  z.object({ type: z.literal('retime_keyframes'), ...retimeKeyframesShape }).strict(),
  z.object({ type: z.literal('rename_animation'), animation: name, newName: name }).strict(),
  z.object({ type: z.literal('remove_timeline'), animation: name, target: timelineTargetSchema }).strict(),
  z.object({ type: z.literal('rename'), target: namedTargetSchema, newName: name }).strict(),
  z.object({ type: z.literal('delete'), target: namedTargetSchema, cascade: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('reparent_bone'), bone: name, parent: name, preserveWorld: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('set_slot_order'), order: z.array(name).max(5000) }).strict(),
  z.object({ type: z.literal('set_constraint'), definition: constraintDefinitionSchema, index: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal('set_constraint_timeline'), animation: name, constraint: z.string().max(256), constraintType: z.enum(constraintTypes).optional(), channel: name.default('parameters'), keyframes: z.array(constraintFrameSchema).max(10000) }).strict(),
  z.object({ type: z.literal('set_skin_members'), skin: name, bones: z.array(name).optional(), constraints: z.array(constraintSelectorSchema).optional() }).strict(),
  z.object({ type: z.literal('set_attachment'), skin: name, slot: name, name, attachment: z.record(z.string(), z.json()), replace: z.boolean().default(false), setAsSetup: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('copy_attachment'), from: attachmentRefSchema, to: attachmentRefSchema, ...copyAttachmentOptionsShape }).strict(),
  z.object({ type: z.literal('link_mesh'), from: attachmentRefSchema, to: attachmentRefSchema, ...linkMeshOptionsShape }).strict(),
  z.object({ type: z.literal('unlink_mesh'), skin: name, slot: name, name, preserveTimelines: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('transform_mesh'), skin: name, slot: name, name, ...meshTransformOptionsShape }).strict(),
  z.object({ type: z.literal('refine_mesh'), skin: name, slot: name, name, iterations: z.number().int().min(1).max(3).default(1) }).strict(),
  z.object({ type: z.literal('set_attachment_animation'), animation: name, skin: name, slot: name, name, channel: z.enum(['deform', 'sequence']), keyframes: z.array(constraintFrameSchema).max(10000) }).strict(),
  z.object({ type: z.literal('set_weights'), skin: name, slot: name, name, weights: z.array(z.array(influenceSchema).min(1).max(16)).min(3).max(10000), clearDeform: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('mesh_from_region'), skin: name, slot: name, name, columns: z.number().int().min(1).max(64).default(2), rows: z.number().int().min(1).max(64).default(2) }).strict(),
  z.object({ type: z.literal('mesh_from_alpha'), skin: name, slot: name, name, ...alphaOptionsShape }).strict(),
  z.object({ type: z.literal('polygon_from_region'), skin: name, slot: name, name, ...alphaOptionsShape, ...polygonOptionsShape }).strict(),
  z.object({ type: z.literal('auto_weights'), skin: name, slot: name, name, bones: z.array(name).min(1).max(256), influences: z.number().int().min(1).max(8).default(4), power: finite.min(1).max(8).default(2), clearDeform: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('clean_weights'), skin: name, slot: name, name, ...weightOptionsShape }).strict(),
  z.object({ type: z.literal('smooth_weights'), skin: name, slot: name, name, ...weightOptionsShape, strength: finite.min(0).max(1).default(0.5), iterations: z.number().int().min(1).max(20).default(2) }).strict(),
  z.object({ type: z.literal('set_folder_draw_order'), animation: name, folders: z.array(folderDrawOrderSchema).max(100) }).strict(),
  z.object({ type: z.literal('flatten_draw_order') }).strict(),
  z.object({ type: z.literal('crop_animation'), animation: name, newName: name, start: finite.nonnegative(), end: finite.positive(), fps: z.number().int().min(1).max(120).default(60) }).strict(),
  z.object({ type: z.literal('merge_animations'), animations: z.array(name).min(2).max(20), newName: name, gap: finite.nonnegative().default(0), fps: z.number().int().min(1).max(120).default(60) }).strict(),
  z.object({ type: z.literal('mirror_animation'), animation: name, newName: name, axis: z.enum(['x', 'y']), bones: z.array(name).optional() }).strict(),
  z.object({ type: z.literal('bake_animation'), animation: name, newName: name, fps: z.number().int().min(1).max(120).default(60), skin: name.optional(), physics: z.boolean().default(false) }).strict(),
]);
export type ProjectEdit = z.infer<typeof editSchema>;

export async function applyEdits(source: SpineDocument, edits: ProjectEdit[], assets?: { workspace: Workspace; jsonPath: string }): Promise<SpineDocument> {
  if (!edits.length || edits.length > 100) throw new Error('Provide 1 to 100 edits.');
  let data = parseDocument(source);
  for (const raw of edits) {
    const edit = editSchema.parse(raw);
    switch (edit.type) {
      case 'retarget_animation': case 'world_mirror': case 'compose_animation': case 'bake_constraints': case 'simplify_animation_adaptive': case 'bake_clipping':
      case 'relink_assets': case 'edit_keyframes': case 'edit_curves': case 'insert_boundary_keys': case 'paste_keyframes': case 'key_pose': case 'transfer_animation': case 'transfer_rig': case 'merge_skins': case 'mesh_from_contours': case 'edit_mesh_vertices': case 'refine_selected_triangles': case 'replace_mesh_topology': case 'transfer_weights': case 'simplify_animation': case 'selective_bake': data = await applyProductionEdit(data, edit, assets); break;
      case 'set_bone': data = setBone(data, edit.bone, edit.transform); break;
      case 'add_bone': data = addBone(data, edit.name, edit.parent, edit.transform); break;
      case 'add_animation': data = addAnimation(data, edit.name, edit.copyFrom); break;
      case 'set_timeline': data = setTimeline(data, edit.animation, edit.bone, edit.channel, edit.keyframes); break;
      case 'add_slot': data = addSlot(data, edit.name, edit.bone, edit.setup); break;
      case 'set_slot': data = setSlot(data, edit.slot, edit.setup); break;
      case 'add_skin': data = addSkin(data, edit.name, edit.copyFrom, edit.baseSkin); break;
      case 'attach_image':
        if (!assets) throw new Error('attach_image requires a workspace and source JSON path.');
        data = await attachImage(assets.workspace, data, assets.jsonPath, edit.skin, edit.slot, edit.name, edit.image, edit.transform, edit.replace, edit.setAsSetup);
        break;
      case 'set_attachment_timeline': data = setAttachmentTimeline(data, edit.animation, edit.slot, edit.keyframes); break;
      case 'set_color_timeline': data = setColorTimeline(data, edit.animation, edit.slot, edit.keyframes); break;
      case 'set_event': data = setEvent(data, edit.name, edit.defaults); break;
      case 'set_event_timeline': data = setEventTimeline(data, edit.animation, edit.keyframes); break;
      case 'set_draw_order': data = setDrawOrder(data, edit.animation, edit.keyframes); break;
      case 'retime_animation': data = retimeAnimation(data, edit.animation, edit.timeScale, edit.timeOffset); break;
      case 'copy_timelines': data = copyTimelines(data, edit.fromAnimation, edit.toAnimation, edit.mappings, edit); break;
      case 'retime_keyframes': data = retimeKeyframes(data, edit.animation, edit.targets, edit.start, edit.end, edit.timeScale, edit.timeOffset); break;
      case 'rename_animation': data = renameAnimation(data, edit.animation, edit.newName); break;
      case 'remove_timeline': data = removeTimeline(data, edit.animation, edit.target); break;
      case 'rename': data = renameObject(data, edit.target, edit.newName); break;
      case 'delete': data = deleteObject(data, edit.target, edit.cascade); break;
      case 'reparent_bone': data = reparentBone(data, edit.bone, edit.parent, edit.preserveWorld); break;
      case 'set_slot_order': data = setSlotOrder(data, edit.order); break;
      case 'set_constraint': data = setConstraint(data, edit.definition, edit.index); break;
      case 'set_constraint_timeline': data = setConstraintTimeline(data, edit.animation, edit.constraint, edit.channel, edit.keyframes, edit.constraintType); break;
      case 'set_skin_members': data = setSkinMembers(data, edit.skin, edit.bones, edit.constraints); break;
      case 'set_attachment': data = setAttachment(data, edit.skin, edit.slot, edit.name, edit.attachment, edit.replace, edit.setAsSetup); break;
      case 'copy_attachment': data = copyAttachment(data, edit.from, edit.to, edit); break;
      case 'link_mesh': data = linkMesh(data, edit.from, edit.to, edit); break;
      case 'unlink_mesh': data = unlinkMesh(data, { skin: edit.skin, slot: edit.slot, name: edit.name }, edit.preserveTimelines); break;
      case 'transform_mesh': data = transformMesh(data, edit, edit.transform, edit.vertices, edit.transformDeform); break;
      case 'refine_mesh': data = refineMesh(data, edit, edit.iterations); break;
      case 'set_attachment_animation': data = setAttachmentAnimation(data, edit.animation, edit.skin, edit.slot, edit.name, edit.channel, edit.keyframes); break;
      case 'set_weights': data = setWeights(data, edit.skin, edit.slot, edit.name, edit.weights, edit.clearDeform); break;
      case 'mesh_from_region': data = meshFromRegion(data, edit.skin, edit.slot, edit.name, edit.columns, edit.rows); break;
      case 'mesh_from_alpha':
        if (!assets) throw new Error('mesh_from_alpha requires a workspace and source JSON path.');
        data = await meshFromAlpha(assets.workspace, data, assets.jsonPath, edit.skin, edit.slot, edit.name, edit); break;
      case 'polygon_from_region':
        if (!assets) throw new Error('polygon_from_region requires a workspace and source JSON path.');
        data = await polygonFromRegion(assets.workspace, data, assets.jsonPath, edit.skin, edit.slot, edit.name, edit); break;
      case 'auto_weights': data = autoWeights(data, edit.skin, edit.slot, edit.name, edit.bones, edit.influences, edit.power, edit.clearDeform); break;
      case 'clean_weights': data = cleanWeights(data, edit.skin, edit.slot, edit.name, edit); break;
      case 'smooth_weights': data = smoothWeights(data, edit.skin, edit.slot, edit.name, edit); break;
      case 'set_folder_draw_order': data = setFolderDrawOrder(data, edit.animation, edit.folders); break;
      case 'flatten_draw_order': data = compileFolderDrawOrder(data); break;
      case 'crop_animation': data = cropAnimation(data, edit.animation, edit.newName, edit.start, edit.end, edit.fps); break;
      case 'merge_animations': data = mergeAnimations(data, edit.animations, edit.newName, edit.gap, edit.fps); break;
      case 'mirror_animation': data = mirrorAnimation(data, edit.animation, edit.newName, edit.axis, edit.bones); break;
      case 'bake_animation': data = bakeAnimation(data, edit.animation, edit.newName, edit.fps, edit.skin, edit.physics); break;
      default: { const unhandled: never = edit; throw new Error(`Unhandled project edit: ${JSON.stringify(unhandled)}`); }
    }
  }
  return data;
}
