import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { IkConstraint } from '@esotericsoftware/spine-core';
import type { SpineService } from './service.js';
import { parseDocument, writeDocument, object, type SpineDocument, type JsonObject } from './document.js';
import { constraintList, resolveConstraint } from './constraint-data.js';
import { animationSampler } from './animation-sampler.js';
import { tracks } from './advanced-animation.js';
import { insertBoundary } from './production-keyframes.js';
import { coalesceBakingTimes } from './world-animation.js';
import { filename, label, request, operation, captureSource, verifySource, newFolder, writeCandidate } from './character-candidates.js';
import { repairSchema, comparisonMedia } from './animation-repair.js';

const finite = z.number().finite(), coordinate = finite.min(-1000000).max(1000000), time = finite.min(0).max(300), point = z.object({ time, x: coordinate, y: coordinate }).strict();
const motion = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('offset'), x: coordinate, y: coordinate, fadeSeconds: finite.positive().max(150).default(0.1) }).strict(),
  z.object({ mode: z.literal('world_path'), points: z.array(point).min(2).max(600) }).strict(),
]);
export const ikTargetRepairSchema = z.object({ ...request, input: filename, animation: label, newName: label, skin: label.optional(), fps: z.number().int().min(1).max(120).default(60), tolerance: finite.positive().max(10).default(0.05), endEffectorTolerance: finite.positive().max(100).optional(), windows: z.array(z.object({ constraint: label, start: time, end: time, motion }).strict()).min(1).max(16), comparison: repairSchema.shape.comparison }).strict();
type Args = z.output<typeof ikTargetRepairSchema>;
const descendants = (data: SpineDocument, start: Iterable<string>) => { const set = new Set(start); for (const b of data.bones) if (b.parent && set.has(b.parent)) set.add(b.name); return set; };
export function influenceClosure(data: SpineDocument, names: string[]) {
  let set = descendants(data, names), previous = -1;
  while (set.size !== previous) {
    previous = set.size;
    for (const c of constraintList(data)) {
      const slotBone = data.slots?.find(s => s.name === c.target || s.name === c.slot)?.bone;
      const refs = [c.source, c.target, slotBone, c.bone, ...(Array.isArray(c.bones) ? c.bones : [])];
      if (refs.some(n => typeof n === 'string' && set.has(n))) set = descendants(data, [...set, ...[c.bone, ...(Array.isArray(c.bones) ? c.bones : [])].filter((n): n is string => typeof n === 'string')]);
    }
  }
  return set;
}
export function buildIkTargetRepair(source: SpineDocument, args: Args) {
  if (!source.animations?.[args.animation] || Object.hasOwn(source.animations, args.newName)) throw new Error('Choose an existing source animation and a NEW candidate name.');
  const definitions = constraintList(source);
  if (definitions.some(c => c.type === 'physics')) throw new Error('Live IK target repair does not support interacting physics. Use explicit constraint baking for that rig.');
  const original = animationSampler(source, args.animation, args.skin), duration = original.duration;
  let data = structuredClone(source); data.animations![args.newName] = structuredClone(source.animations![args.animation]!);
  const windows = args.windows.map(w => {
    if (w.end <= w.start || w.end > duration) throw new Error('IK repair windows must have positive duration inside the animation.');
    const c = resolveConstraint(source, w.constraint, 'ik'), target = String(c.target), chain = c.bones as string[];
    if (!chain?.length || chain.length > 2) throw new Error('IK repair supports active one- or two-bone IK chains.');
    if (descendants(source, chain).has(target)) throw new Error('IK target is inside the constrained chain.');
    const ancestors = new Set<string>([target]); let parent = source.bones.find(b => b.name === target)?.parent;
    while (parent) { ancestors.add(parent); parent = source.bones.find(b => b.name === parent)?.parent; }
    for (const other of definitions) if ([other.bone, ...(Array.isArray(other.bones) ? other.bones : [])].some(n => typeof n === 'string' && ancestors.has(n))) throw new Error('IK target/parent is constrained. Use an independent controller or explicit baking.');
    if (w.motion.mode === 'world_path') {
      const p = w.motion.points;
      if (p[0]!.time !== w.start || p.at(-1)!.time !== w.end || p.some((v, i) => v.time < w.start || v.time > w.end || i > 0 && v.time <= p[i - 1]!.time)) throw new Error('World-path points must be strictly ordered and include both window endpoints.');
    }
    return { ...w, target, chain, affected: influenceClosure(source, [target, ...chain]) };
  });
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) if (windows[i]!.target === windows[j]!.target && windows[i]!.start <= windows[j]!.end && windows[j]!.start <= windows[i]!.end) throw new Error('Windows on a shared IK target must not overlap or touch.');
  function desired(w: typeof windows[number], t: number) {
    const s = original.sample(t), bone = s.bones.find(b => b.data.name === w.target)!;
    const ik = s.constraints.find(c => c instanceof IkConstraint && c.data.name === w.constraint) as IkConstraint | undefined;
    if (!bone?.active || !ik?.active || ik.appliedPose.mix <= 0) throw new Error('Selected IK controller and constraint must stay active with positive mix.');
    if (w.motion.mode === 'offset') {
      const fade = Math.min(w.motion.fadeSeconds, (w.end - w.start) / 2), u = Math.max(0, Math.min(1, (t - w.start) / fade, (w.end - t) / fade)), weight = u * u * (3 - 2 * u);
      return { x: bone.appliedPose.worldX + w.motion.x * weight, y: bone.appliedPose.worldY + w.motion.y * weight };
    }
    const p = w.motion.points, left = p.findLastIndex(v => v.time <= t), a = p[Math.max(0, left)]!, b = p[Math.min(p.length - 1, left + 1)]!, u = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }
  const sourceTimes = tracks(source, source.animations![args.animation]!).flatMap(t => t.frames.map(k => Number(k.time ?? 0)));
  let addedKeys = 0;
  for (const w of windows) {
    for (const t of [w.start, w.end]) if (t > 0 && t < duration) {
      const expected = desired(w, t), p = original.sample(t).bones.find(b => b.data.name === w.target)!.appliedPose;
      if (Math.hypot(expected.x - p.worldX, expected.y - p.worldY) > args.tolerance) throw new Error('Interior world-path boundaries must match the original controller position.');
    }
    const anim = data.animations![args.newName]!; anim.bones ??= {}; const channels = object(anim.bones, 'bones'); channels[w.target] ??= {}; const target = object(channels[w.target], 'target channels');
    if (target.translate && (target.translatex || target.translatey)) throw new Error('Mixed combined/split target translation tracks must be normalized before IK repair.');
    const names = target.translatex || target.translatey ? ['translatex', 'translatey'] : ['translate'];
    const times = coalesceBakingTimes([w.start, w.end, ...sourceTimes.filter(t => t >= w.start && t <= w.end), ...(w.motion.mode === 'world_path' ? w.motion.points.map(p => p.time) : []), ...Array.from({ length: Math.ceil((w.end - w.start) * args.fps) + 1 }, (_, i) => Math.min(w.end, w.start + i / args.fps))]);
    if (addedKeys + times.length * names.length > 20000) throw new Error('IK repair exceeds 20,000 controller keys.');
    const samples = times.map(t => {
      const world = desired(w, t), s = original.sample(t), bone = s.bones.find(b => b.data.name === w.target)!, pose = bone.appliedPose, local = pose.worldToParent({ ...world } as any);
      if (![local.x, local.y].every(Number.isFinite)) throw new Error('IK controller parent transform is singular.');
      return { time: t, x: local.x - bone.data.setupPose.x, y: local.y - bone.data.setupPose.y };
    });
    for (const name of names) {
      const value = name === 'translate' ? { x: 0, y: 0 } : { value: 0 };
      const current = object(object(data.animations![args.newName]!.bones, 'bones')[w.target], 'tracks');
      if (!Array.isArray(current[name])) current[name] = [{ time: 0, ...value }, { time: duration, ...value }];
      if (Number((current[name] as JsonObject[])[0]!.time ?? 0) > 0) (current[name] as JsonObject[]).unshift({ time: 0, ...value, curve: 'stepped' });
      for (const t of [w.start, w.end]) data = insertBoundary(data, args.newName, { kind: 'bone', bone: w.target, channel: name as any }, t);
      const out = object(object(data.animations![args.newName]!.bones, 'bones')[w.target], 'tracks'), old = out[name] as JsonObject[], tail = old.find(k => Math.abs(Number(k.time ?? 0) - w.end) <= 1e-6);
      out[name] = [...old.filter(k => Number(k.time ?? 0) < w.start - 1e-6), ...samples.map(p => ({ time: p.time, ...(name === 'translate' ? { x: p.x, y: p.y } : { value: name === 'translatex' ? p.x : p.y }), ...(Math.abs(p.time - w.end) <= 1e-6 && tail?.curve !== undefined ? { curve: tail.curve } : {}) })), ...old.filter(k => Number(k.time ?? 0) > w.end + 1e-6)];
      addedKeys += samples.length;
    }
  }
  if (addedKeys > 20000) throw new Error('IK repair exceeds 20,000 controller keys.');
  data = parseDocument(data);
  const after = animationSampler(data, args.newName, args.skin), verificationTimes = [...new Set([0, duration, ...sourceTimes, ...windows.flatMap(w => [w.start, w.end, ...(w.motion.mode === 'world_path' ? w.motion.points.map(p => p.time) : [])]), ...Array.from({ length: Math.ceil(duration * args.fps * 2) + 1 }, (_, i) => Math.min(duration, i / (args.fps * 2)))])].sort((a, b) => a - b);
  if (verificationTimes.length * source.bones.length > 300000) throw new Error('IK repair verification exceeds 300,000 bone poses.');
  let maxTargetError = 0, maxOutsideWorldError = 0, maxUnselectedWorldError = 0, maxEndEffectorError = 0;
  const changed = new Set(windows.flatMap(w => [...w.affected]));
  for (const t of verificationTimes) {
    const a = original.sample(t), b = after.sample(t), active = windows.filter(w => t >= w.start && t <= w.end), allowed = new Set(active.flatMap(w => [...w.affected]));
    for (const s of [a, b]) for (const bone of s.bones) if (bone.active && !['worldX', 'worldY', 'a', 'b', 'c', 'd'].every(k => Number.isFinite((bone.appliedPose as any)[k]))) throw new Error('IK repair contains a non-finite world pose.');
    for (const w of active) {
      const expected = desired(w, t), pose = b.bones.find(v => v.data.name === w.target)!.appliedPose;
      maxTargetError = Math.max(maxTargetError, Math.hypot(pose.worldX - expected.x, pose.worldY - expected.y));
      const bone = b.bones.find(v => v.data.name === w.chain.at(-1))!, tip = bone.appliedPose.localToWorld({ x: bone.data.length, y: 0 } as any);
      maxEndEffectorError = Math.max(maxEndEffectorError, Math.hypot(tip.x - expected.x, tip.y - expected.y));
    }
    for (let i = 0; i < a.bones.length; i++) {
      const p = a.bones[i]!, q = b.bones[i]!; if (!p.active || allowed.has(p.data.name)) continue;
      const error = Math.max(...['worldX', 'worldY', 'a', 'b', 'c', 'd'].map(k => Math.abs((p.appliedPose as any)[k] - (q.appliedPose as any)[k])));
      if (!q.active) throw new Error('IK repair changed unrelated bone activation.');
      if (changed.has(p.data.name)) maxOutsideWorldError = Math.max(maxOutsideWorldError, error); else maxUnselectedWorldError = Math.max(maxUnselectedWorldError, error);
    }
  }
  if (Math.max(maxTargetError, maxOutsideWorldError, maxUnselectedWorldError) > args.tolerance) throw new Error(`IK target/world verification failed (${maxTargetError}, ${maxOutsideWorldError}, ${maxUnselectedWorldError}); increase FPS or revise the windows.`);
  if (args.endEffectorTolerance !== undefined && maxEndEffectorError > args.endEffectorTolerance) throw new Error('IK end effector cannot reach the requested target within tolerance.');
  for (const [name, anim] of Object.entries(source.animations!)) if (JSON.stringify(data.animations![name]) !== JSON.stringify(anim)) throw new Error('IK repair changed an original animation.');
  return { data, report: { baked: false, controllersEditable: true, addedKeys, editedTargets: [...new Set(windows.map(w => w.target))], windows: windows.map(w => ({ ...w, affected: [...w.affected] })), constraintsPreserved: JSON.stringify(data.constraints) === JSON.stringify(source.constraints), constraintTimelinesPreserved: JSON.stringify(data.animations![args.newName]!.constraints) === JSON.stringify(source.animations![args.animation]!.constraints), originalAnimationsPreserved: true, maxTargetError, maxOutsideWorldError, maxUnselectedWorldError, maxEndEffectorError, endEffectorTolerance: args.endEffectorTolerance, checkedSamples: verificationTimes.length, tolerance: args.tolerance, scope: 'Only selected IK target translation tracks change in the NEW animation. Constraints and other tracks remain live. Finite-sample world checks do not infer contacts, anatomy or visual acceptance.' } };
}
export async function createIkTargetRepair(service: SpineService, raw: z.input<typeof ikTargetRepairSchema>) {
  const args = ikTargetRepairSchema.parse(raw);
  return operation(service, args.requestId, 'ik_target_repair', args, async () => {
    const source = await captureSource(service, args.input), built = buildIkTargetRepair(source.data, args), folder = await newFolder(service, 'ik-target-repairs'), json = (await writeDocument(service.workspace, path.join(folder, 'candidate.json'), built.data, path.dirname(source.jsonPath))).path;
    const comparison = await comparisonMedia(service, parseDocument(JSON.parse(await readFile(json, 'utf8'))), json, args.animation, args.newName, args.skin, args.comparison); await verifySource(service, source.source);
    return writeCandidate(service, 'ik_target_repair', json, source.source, { animation: args.animation, newName: args.newName, verification: built.report, comparison }, true, [comparison.manifest, comparison.player, ...comparison.files, ...(comparison.video ? [comparison.video] : [])]);
  });
}
