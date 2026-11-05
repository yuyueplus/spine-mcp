import path from 'node:path';
import type { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { characterSchema, poseAnimationSchema } from './stability-schema.js';
import { addBone, parseDocument, writeDocument, object, type JsonObject, type SpineDocument } from './document.js';
import { meshFromRegion, autoWeights } from './mesh-generation.js';
import { attachmentEntries } from './attachment-data.js';
import { fileSha256 } from './file-hash.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { cleanWeights } from './weight-edits.js';

export async function savedCharacterChange(service: SpineService, input: string, output: string, operation: (data: SpineDocument) => SpineDocument | Promise<SpineDocument>) {
  const source = await service.workspace.resolve(input), sha256 = await fileSha256(source), loaded = await service.load(source), assets = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  if (!assets.valid) throw new Error('Complete the referenced resources before building a character.');
  const data = parseDocument(await operation(loaded.data));
  await assertSnapshot(assets); if (await fileSha256(source) !== sha256) throw new Error('Source changed during character preparation.');
  return service.afterPublish(source, output, { ...await writeDocument(service.workspace, output, data, path.dirname(loaded.jsonPath)), sourceSha256: sha256, originalUnchanged: true, visualAcceptance: 'pending' });
}
export async function prepareCharacter(service: SpineService, raw: z.input<typeof characterSchema>) {
  const args = characterSchema.parse(raw);
  return savedCharacterChange(service, args.input, args.output, source => prepareCharacterData(source, args));
}
export function prepareCharacterData(source: SpineDocument, args: z.output<typeof characterSchema>) {
    let data = source;
    for (const b of args.bones) data = addBone(data, b.name, b.parent, b.transform);
    for (const binding of args.bindings) {
      const ref = attachmentEntries(data).find(a => a.skin === binding.skin && a.slot === binding.slot && a.name === binding.attachment);
      if (!ref) throw new Error(`Attachment not found: ${binding.skin}/${binding.slot}/${binding.attachment}`);
      if ((ref.value.type ?? 'region') === 'region') data = meshFromRegion(data, binding.skin, binding.slot, binding.attachment, binding.columns, binding.rows);
      else if (ref.value.type !== 'mesh' || ref.value.parent || ref.value.source) throw new Error('Character bindings require independent regions or meshes; make linked geometry independent first.');
      data = autoWeights(data, binding.skin, binding.slot, binding.attachment, binding.bones, binding.influences, binding.power);
      if (binding.minWeight > 0) data = cleanWeights(data, binding.skin, binding.slot, binding.attachment, { minWeight: binding.minWeight, maxInfluences: binding.influences });
    }
    return data;
  
}

/** Pose recipe values are offsets from setup (scale values are multipliers).
 * Sparse pose keys become smooth editable curves. Secondary chains are baked
 * from delayed driver rotation with an explicit amplitude limit. */
export function buildPoseData(source: SpineDocument, args: z.output<typeof poseAnimationSchema>) {
  if (Object.hasOwn(source.animations ?? {}, args.name)) throw new Error('Animation name exists; choose a new name.');
  for (let i = 0; i < args.poses.length; i++) if ((i === 0 && args.poses[i]!.time !== 0) || (i > 0 && args.poses[i]!.time <= args.poses[i - 1]!.time)) throw new Error('Poses must start at zero and have strictly increasing times.');
  const names = new Set(source.bones.map(b => b.name)), data = structuredClone(source), duration = args.poses.at(-1)!.time;
  const tracks: Record<string, JsonObject> = {}, definitions = [['rotate', ['rotation'], ['value'], 0], ['translate', ['x', 'y'], ['x', 'y'], 0], ['scale', ['scaleX', 'scaleY'], ['x', 'y'], 1]] as const;
  const boneNames = new Set(args.poses.flatMap(p => Object.keys(p.bones)));
  if (boneNames.size * args.poses.length * 3 > 200000) throw new Error('Pose recipe exceeds 200,000 channel keys.');
  for (const bone of boneNames) {
    if (!names.has(bone)) throw new Error(`Pose bone not found: ${bone}`);
    const channels: JsonObject = {};
    for (const [channel, fields, outputFields, fallback] of definitions) {
      if (!args.poses.some(p => fields.some(field => p.bones[bone]?.[field] !== undefined))) continue;
      let values: number[] = fields.map(() => fallback);
      const keys = args.poses.map(p => { const v = p.bones[bone]; values = fields.map((field, i) => v?.[field] ?? values[i]!); return { time: p.time, ...Object.fromEntries(outputFields.map((f, i) => [f, values[i]])) } as JsonObject; });
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i]!, b = keys[i + 1]!, mode = args.poses[i]!.curve;
        if (mode === 'stepped') a.curve = 'stepped';
        else if (mode === 'smooth') a.curve = outputFields.flatMap(f => [Number(a.time) + (Number(b.time) - Number(a.time)) / 3, Number(a[f]), Number(b.time) - (Number(b.time) - Number(a.time)) / 3, Number(b[f])]);
      }
      channels[channel] = keys;
    }
    tracks[bone] = channels;
  }
  const evaluateDriver = (bone: string, time: number) => {
    const keys = tracks[bone]?.rotate as JsonObject[] | undefined;
    if (!keys?.length) throw new Error(`Secondary driver needs an explicit pose rotation track: ${bone}`);
    const t = Math.max(0, Math.min(duration, time));
    for (let i = 1; i < keys.length; i++) if (t <= Number(keys[i]!.time)) { const a = keys[i - 1]!, b = keys[i]!, dt = Number(b.time) - Number(a.time), u = (t - Number(a.time)) / dt, mode = args.poses[i - 1]!.curve, w = mode === 'stepped' ? 0 : mode === 'smooth' ? u * u * (3 - 2 * u) : u; return Number(a.value) + (Number(b.value) - Number(a.value)) * w; }
    return Number(keys.at(-1)!.value);
  };
  const used = new Set<string>();
  for (const chain of args.secondary) for (const [index, bone] of chain.bones.entries()) {
    if (!args.poses.some(p => p.bones[chain.driver]?.rotation !== undefined)) throw new Error('Secondary drivers must have an explicit primary pose rotation track.');
    if (!names.has(bone) || used.has(bone) || tracks[bone]?.rotate) throw new Error(`Secondary bone is missing, repeated or already keyed: ${bone}`);
    used.add(bone); tracks[bone] ??= {};
    const count = Math.ceil(duration * args.fps); if (count * args.secondary.reduce((n, c) => n + c.bones.length, 0) > 200000) throw new Error('Secondary animation bake exceeds 200,000 keys.');
    tracks[bone]!.rotate = Array.from({ length: count + 1 }, (_, i) => { const time = Math.min(duration, i / args.fps), delayed = evaluateDriver(chain.driver, time - chain.delay - index * chain.delayPerBone), value = Math.max(-chain.maxAngle, Math.min(chain.maxAngle, delayed * chain.gain)); return { time, value }; });
  }
  const slots: JsonObject = {};
  for (const blink of args.blinks) {
    if (!source.slots?.some(s => s.name === blink.slot)) throw new Error(`Blink slot not found: ${blink.slot}`);
    for (const name of [blink.open, blink.closed]) if (!attachmentEntries(source).some(a => a.slot === blink.slot && a.name === name)) throw new Error(`Blink attachment not found: ${name}`);
    if (Object.hasOwn(slots, blink.slot)) throw new Error('Only one blink recipe per slot is allowed.');
    const times = [...blink.times].sort((a, b) => a - b); if (times.some((t, i) => t <= 0 || t + blink.duration >= duration || (i > 0 && t <= times[i - 1]! + blink.duration))) throw new Error('Blink windows overlap, start at zero or end outside the animation.');
    slots[blink.slot] = { attachment: [{ time: 0, name: blink.open }, ...times.flatMap(time => [{ time, name: blink.closed }, { time: time + blink.duration, name: blink.open }]), { time: duration, name: blink.open }] };
  }
  data.animations ??= {}; data.animations[args.name] = { bones: tracks, ...(Object.keys(slots).length ? { slots } : {}) }; data.skeleton.fps = Math.max(Number(data.skeleton.fps ?? 30), args.fps); return data;
}
export async function buildPoseAnimation(service: SpineService, raw: z.input<typeof poseAnimationSchema>) {
  const args = poseAnimationSchema.parse(raw);
  return savedCharacterChange(service, args.input, args.output, source => buildPoseData(source, args));
}
