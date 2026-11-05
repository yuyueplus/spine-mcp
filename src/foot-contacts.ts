import type { z } from 'zod/v4';
import { Inherit, Physics } from '@esotericsoftware/spine-core';
import { footBakeSchema } from './stability-schema.js';
import { animationSampler } from './animation-sampler.js';
import { savedCharacterChange } from './character-workflow.js';
import type { SpineService } from './service.js';
import { object, type JsonObject, type SpineDocument } from './document.js';
import { constraintTypes } from './constraint-data.js';
import { bakeAllConstraints } from './world-animation.js';
import { randomUUID } from 'node:crypto';
import { animationDuration } from './advanced-animation.js';

const deg = 180 / Math.PI;
const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
export function bakeFootContactData(source: SpineDocument, args: z.output<typeof footBakeSchema>) {
  let diagnostics: unknown;
  if (source.animations?.[args.newName]) throw new Error('Choose a new animation name.');
  const originalSource = source;
  let constraintBake: ReturnType<typeof bakeAllConstraints> | undefined, constraintAnimation: JsonObject | undefined;
  const constrained = Boolean((source.constraints as unknown[] | undefined)?.length || ['ik', 'transform', 'path', 'physics'].some(k => (source[k] as unknown[] | undefined)?.length));
  if (constrained) {
    if (args.constraintMode !== 'bake') throw new Error('Constrained rigs require explicit constraintMode=bake, or bake interacting constraints first.');
    const temporaryName = `__contact_${randomUUID().replaceAll('-', '')}`;
    constraintBake = bakeAllConstraints(source, args.animation, temporaryName, { fps: args.fps, skin: args.skin, physics: args.physics, tolerance: args.tolerance });
    constraintAnimation = constraintBake.data.animations![temporaryName]!;
    source = structuredClone(constraintBake.data); delete source.constraints;
    source.animations = { [args.animation]: structuredClone(constraintAnimation) };
    for (const type of constraintTypes) { delete source[type]; delete source.animations[args.animation]![type]; if (Array.isArray(source.skins)) for (const skin of source.skins) delete object(skin, 'skin')[type]; }
  } else if (args.physics) throw new Error('physics=true requires a constrained rig and constraintMode=bake.');
  const sampler = animationSampler(source, args.animation, args.skin), names = new Map(sampler.skeleton.bones.map(b => [b.data.name, b])), edited = new Set<string>();
  const pose = (name: string) => { const b = names.get(name); if (!b) throw new Error(`Contact bone not found: ${name}`); return b; };
  const chains = args.chains.map(chain => {
    const upper = pose(chain.upper), lower = pose(chain.lower), foot = pose(chain.foot);
    if (lower.parent !== upper || foot.parent !== lower) throw new Error('Contact chain must be a direct upper > lower > foot hierarchy.');
    for (const b of [upper, lower, foot]) { if (edited.has(b.data.name)) throw new Error('Contact chains must not overlap.'); edited.add(b.data.name); }
    const windows = [...chain.contacts].sort((a, b) => a.start - b.start).map((r, i, all) => {
      if (r.end < r.start || r.end > sampler.duration || (i && r.start <= all[i - 1]!.end)) throw new Error('Contact windows overlap, reverse, or exceed the animation.');
      sampler.sample(r.start); const h = upper.appliedPose, k = lower.appliedPose, f = foot.appliedPose, bend = (k.worldX - h.worldX) * (f.worldY - k.worldY) - (k.worldY - h.worldY) * (f.worldX - k.worldX);
      if (Math.abs(bend) < 1e-8) throw new Error('A fully straight chain has no reliable knee direction. Add a small reference bend before contact baking.');
      return { ...r, x: r.x ?? f.worldX, y: r.y ?? f.worldY, direction: Math.sign(bend) };
    });
    return { upper, lower, foot, windows };
  });
  for (const chain of chains) for (let p = chain.upper.parent; p; p = p.parent) if (edited.has(p.data.name)) throw new Error('Contact chains cannot depend on another edited chain.');
  // Runtime durations are float32. Combining that value with exact JSON grid
  // keys can emit two end keys which the native exporter rounds to one time.
  // Keep the saved timeline duration and canonicalize generated grid samples.
  const duration = animationDuration(source.animations![args.animation]!), count = Math.ceil(duration * args.fps);
  if ((count + 1) * edited.size > 200000) throw new Error('Contact bake exceeds 200,000 bone samples.');
  const snap = (t: number) => Math.abs(t * args.fps - Math.round(t * args.fps)) < 0.0001 ? Math.round(t * args.fps) / args.fps : t;
  const times = new Set<number>(Array.from({ length: count + 1 }, (_, i) => snap(Math.min(duration, i / args.fps))));
  for (const chain of chains) for (const w of chain.windows) { times.add(snap(w.start)); times.add(snap(w.end)); }
  for (const bone of edited) for (const keys of Object.values(object(object(source.animations![args.animation]!.bones ?? {}, 'bones')[bone] ?? {}, 'channels'))) if (Array.isArray(keys)) for (const k of keys) times.add(snap(Number(object(k, 'key').time ?? 0)));
  if (times.size * edited.size > 200000) throw new Error('Contact bake including original keys and boundaries exceeds 200,000 bone samples.');
  const tracks = new Map([...edited].map(name => [name, [] as JsonObject[]]));
  for (const time of [...times].sort((a, b) => a - b)) {
    const skeleton = sampler.sample(time);
    for (const { upper, lower, foot, windows } of chains) {
      const w = windows.find(w => time >= w.start - 1e-9 && time <= w.end + 1e-9); if (!w) continue;
      for (const b of [upper, lower, foot, ...(upper.parent ? [upper.parent] : [])]) {
        const p = b.appliedPose, a = Math.hypot(p.a, p.c), d = Math.hypot(p.b, p.d);
        if (p.inherit !== Inherit.Normal || p.a * p.d - p.b * p.c <= 0 || Math.abs(a - d) > 1e-5 * Math.max(1, a) || Math.abs(p.a * p.b + p.c * p.d) > 1e-5 * Math.max(1, a * d)) throw new Error('Contact solving requires positive uniform scale, normal inheritance and no shear on each chain and its parent.');
      }
      const h = upper.appliedPose, k = lower.appliedPose, f = foot.appliedPose, a = Math.hypot(k.worldX - h.worldX, k.worldY - h.worldY), b = Math.hypot(f.worldX - k.worldX, f.worldY - k.worldY), dx = w.x - h.worldX, dy = w.y - h.worldY, distance = Math.hypot(dx, dy);
      if (Math.min(a, b) < 1e-7 || distance > a + b + args.tolerance || distance < Math.abs(a - b) - args.tolerance) throw new Error(`Foot target is unreachable at ${time.toFixed(6)}s; adjust body motion before contact baking.`);
      const q2 = Math.acos(Math.max(-1, Math.min(1, (distance * distance - a * a - b * b) / (2 * a * b)))) * w.direction, q1 = Math.atan2(dy, dx) - Math.atan2(b * Math.sin(q2), a + b * Math.cos(q2));
      const deltaUpper = wrap(q1 - Math.atan2(k.worldY - h.worldY, k.worldX - h.worldX)), deltaLower = wrap(q1 + q2 - Math.atan2(f.worldY - k.worldY, f.worldX - k.worldX));
      upper.pose.rotation += deltaUpper * deg; lower.pose.rotation += (deltaLower - deltaUpper) * deg; foot.pose.rotation -= deltaLower * deg; skeleton.updateWorldTransform(Physics.none);
    }
    for (const name of edited) { const b = pose(name); tracks.get(name)!.push({ time, value: b.pose.rotation - b.data.setupPose.rotation }); }
  }
  const data = structuredClone(source), animation = structuredClone(data.animations![args.animation]!); animation.bones ??= {};
  for (const [name, keys] of tracks) { const bones = object(animation.bones, 'bones'); bones[name] ??= {}; object(bones[name], 'channels').rotate = keys; }
  data.animations![args.newName] = animation; data.skeleton.fps = Math.max(Number(data.skeleton.fps ?? 30), args.fps);
  const finalData = constraintAnimation ? structuredClone(originalSource) : data;
  if (constraintAnimation) {
    finalData.animations ??= {}; finalData.animations[args.newName] = structuredClone(data.animations![args.newName]!);
    for (const type of constraintTypes) if (constraintAnimation[type] !== undefined) finalData.animations[args.newName]![type] = structuredClone(constraintAnimation[type]);
    finalData.skeleton.fps = data.skeleton.fps;
  }
  const check = animationSampler(finalData, args.newName, args.skin), original = animationSampler(originalSource, args.animation, args.skin, { physics: args.physics, fps: args.fps });
  let maxContactError = 0, maxOutsideError = 0, maxShoeOrientationErrorDegrees = 0, maxUnrelatedWorldError = 0;
  const verificationTimes = new Set([...times, ...Array.from({ length: count * 2 + 1 }, (_, i) => Math.min(duration, i / (args.fps * 2)))]);
  const affected = new Set(edited);
  for (const b of originalSource.bones) if (b.parent && affected.has(b.parent)) affected.add(b.name);
  if (verificationTimes.size * originalSource.bones.length * 2 > 500000) throw new Error('Contact verification exceeds 500,000 bone samples.');
  for (const t of [...verificationTimes].sort((a, b) => a - b)) {
    const sk = check.sample(t), before = original.sample(t);
    if (constraintBake) for (const b of sk.bones) if (!affected.has(b.data.name) && b.active) {
      const p = b.appliedPose, q = before.bones[b.data.index]!.appliedPose;
      maxUnrelatedWorldError = Math.max(maxUnrelatedWorldError, ...['worldX', 'worldY', 'a', 'b', 'c', 'd'].map(k => Math.abs(p[k as keyof typeof p] as number - (q[k as keyof typeof q] as number))));
    }
    for (const chain of chains) {
      const w = chain.windows.find(w => t >= w.start && t <= w.end), foot = sk.bones.find(b => b.data.name === chain.foot.data.name)!.appliedPose;
      if (w) {
        maxContactError = Math.max(maxContactError, Math.hypot(foot.worldX - w.x, foot.worldY - w.y));
        const originalFoot = before.bones.find(b => b.data.name === chain.foot.data.name)!.appliedPose;
        maxShoeOrientationErrorDegrees = Math.max(maxShoeOrientationErrorDegrees, Math.abs(wrap(Math.atan2(foot.c, foot.a) - Math.atan2(originalFoot.c, originalFoot.a))) * deg);
      }
      else for (const name of [chain.upper.data.name, chain.lower.data.name, chain.foot.data.name]) { const a = sk.bones.find(b => b.data.name === name)!.appliedPose, b = before.bones.find(b => b.data.name === name)!.appliedPose; maxOutsideError = Math.max(maxOutsideError, Math.hypot(a.worldX - b.worldX, a.worldY - b.worldY)); }
    }
  }
  if (Math.max(maxContactError, maxOutsideError, maxUnrelatedWorldError) > args.tolerance) throw new Error(`Baked contact verification exceeded tolerance: contact ${maxContactError}, outside ${maxOutsideError}, unrelated world ${maxUnrelatedWorldError}. Increase sampling density or fix contact boundary transitions.`);
  if (maxShoeOrientationErrorDegrees > args.orientationToleranceDegrees) throw new Error(`Shoe orientation error ${maxShoeOrientationErrorDegrees} degrees exceeds ${args.orientationToleranceDegrees}. Increase sampling density or fix angle-wrap transitions.`);
  diagnostics = { constraintMode: args.constraintMode, constraintBake: constraintBake?.report ?? null, maxUnrelatedWorldError, maxContactError, maxOutsideError, maxShoeOrientationErrorDegrees, checkedFps: args.fps * 2, checkedSamples: verificationTimes.size, tolerance: args.tolerance, orientationToleranceDegrees: args.orientationToleranceDegrees, bakedBones: [...edited], note: constraintBake ? 'Original rig and animations are retained. Interacting bone/slot/attachment/deform motion is sampled into the NEW animation before contact correction; constraints are disabled only there. Unrelated world transforms, contact position and shoe orientation are checked at double FPS plus keys/boundaries. Dense captured channels are not byte-identical to original channels.' : 'Original animation and unselected channels are retained. Three rotation tracks per chain are baked in the NEW animation; position and shoe orientation are checked at double FPS plus original key/contact boundaries.' };
  return { data: finalData, diagnostics };
}
export async function bakeFootContacts(service: SpineService, raw: z.input<typeof footBakeSchema>) {
  const args = footBakeSchema.parse(raw); let contactVerification: unknown;
  const result = await savedCharacterChange(service, args.input, args.output, source => { const value = bakeFootContactData(source, args); contactVerification = value.diagnostics; return value.data; });
  return { ...result, contactVerification };
}
