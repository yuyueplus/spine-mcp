import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { Inherit, IkConstraint } from '@esotericsoftware/spine-core';
import type { SpineService } from './service.js';
import { parseDocument, writeDocument, object, type SpineDocument, type JsonObject } from './document.js';
import { animationSampler } from './animation-sampler.js';
import { tracks } from './advanced-animation.js';
import { constraintList, resolveConstraint } from './constraint-data.js';
import { insertBoundary } from './production-keyframes.js';
import { coalesceBakingTimes } from './world-animation.js';
import { buildIkTargetRepair, ikTargetRepairSchema, influenceClosure } from './ik-target-repair.js';
import { buildRuntimeIkContactRepair } from './runtime-ik-contact.js';
import { comparisonMedia, repairSchema } from './animation-repair.js';
import { filename, label, request, captureSource, verifySource, newFolder, operation, writeCandidate } from './character-candidates.js';

const finite = z.number().finite(), coordinate = finite.min(-1000000).max(1000000), time = finite.min(0).max(300);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const angle = finite.min(-3600).max(3600);
const contact = z.object({ start: time, end: time, mode: z.enum(['sole', 'heel', 'toe']).default('sole'), anchor: point.optional(), angleDegrees: angle.optional(), angles: z.array(z.object({ time, degrees: angle }).strict()).min(2).max(120).optional(), transitionSeconds: finite.positive().max(10).default(0.15) }).strict();
export const ikContactRepairSchema = z.object({ ...request, input: filename, animation: label, newName: label, solver: z.enum(['strict', 'runtime']).default('strict'), allowFk: z.boolean().default(false), skin: label.optional(), fps: z.number().int().min(1).max(120).default(60), tolerance: finite.positive().max(10).default(0.1), orientationToleranceDegrees: finite.positive().max(10).default(0.25), chains: z.array(z.object({ constraint: label, foot: label, heel: point, toe: point, contacts: z.array(contact).min(1).max(12) }).strict()).min(1).max(8), comparison: repairSchema.shape.comparison }).strict();
type Args = z.output<typeof ikContactRepairSchema>;
const degrees = 180 / Math.PI, wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
const smooth = (u: number) => { u = Math.min(1, Math.max(0, u)); return u * u * (3 - 2 * u); };
const world = (p: any, v: { x: number; y: number }) => ({ x: p.worldX + p.a * v.x + p.b * v.y, y: p.worldY + p.c * v.x + p.d * v.y });
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export function buildIkContactRepair(source: SpineDocument, args: Args): { data: SpineDocument; report: Record<string, any> } {
  if (args.solver === 'runtime') return buildRuntimeIkContactRepair(source, args);
  if (!source.animations?.[args.animation] || Object.hasOwn(source.animations, args.newName)) throw new Error('Choose an existing animation and a NEW clip name.');
  const original = animationSampler(source, args.animation, args.skin), duration = original.duration, definitions = constraintList(source);
  const sourceTimes = tracks(source, source.animations[args.animation]!).flatMap(t => t.frames.map(k => Number(k.time ?? 0)));
  const edited = new Set<string>(), windows = args.chains.flatMap(chain => {
    const c = resolveConstraint(source, chain.constraint, 'ik'), names = c.bones as string[], foot = source.bones.find(b => b.name === chain.foot);
    if (names?.length !== 2 || !foot || foot.parent !== names[1]) throw new Error('Contact orientation repair requires a two-bone IK chain with a direct foot child.');
    if (distance(chain.heel, chain.toe) < 1e-5) throw new Error('Heel and toe landmarks must be distinct foot-local coordinates.');
    for (const n of [...names, chain.foot, String(c.target)]) { if (edited.has(n)) throw new Error('Contact chains and controllers must not overlap.'); edited.add(n); }
    for (const other of definitions) if (other !== c && [other.bone, ...(Array.isArray(other.bones) ? other.bones : [])].some(n => [...names, chain.foot].includes(String(n)))) throw new Error('Another constraint writes the selected chain/foot.');
    return chain.contacts.map(w => {
      if (w.end <= w.start || w.end > duration) throw new Error('Contact windows must be positive and inside the animation.');
      if (w.angles && (w.angleDegrees !== undefined || w.mode === 'sole' || w.angles[0]!.time !== w.start || w.angles.at(-1)!.time !== w.end || w.angles.some((v, i) => v.time < w.start || v.time > w.end || i > 0 && (v.time <= w.angles![i - 1]!.time || Math.abs(v.degrees - w.angles![i - 1]!.degrees) > 180)))) throw new Error('Rolling angles require heel/toe mode, ordered endpoints, and increments at most 180 degrees.');
      const s = original.sample(w.start), f = s.bones.find(b => b.data.name === chain.foot)!.appliedPose, heel = world(f, chain.heel), toe = world(f, chain.toe), anchor = w.anchor ?? (w.mode === 'toe' ? toe : heel);
      return { ...chain, ...w, anchor, initialAngle: Math.atan2(toe.y - heel.y, toe.x - heel.x), initialLength: distance(heel, toe), begin: Math.fround(Math.max(0, w.start - w.transitionSeconds)), finish: Math.fround(Math.min(duration, w.end + w.transitionSeconds)), names, target: String(c.target), affected: influenceClosure(source, [String(c.target), ...names, chain.foot]) };
    });
  });
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) if (windows[i]!.target === windows[j]!.target && windows[i]!.begin <= windows[j]!.finish && windows[j]!.begin <= windows[i]!.finish) throw new Error('Contact windows including transitions on a shared controller must not overlap or touch.');
  if (windows.length > 16) throw new Error('At most 16 contact windows per repair.');
  const desired = (w: typeof windows[number], t: number) => {
    const s = original.sample(t), foot = s.bones.find(b => b.data.name === w.foot)!, f = foot.appliedPose, controller = s.bones.find(b => b.data.name === w.target)!, ik = s.constraints.find(c => c instanceof IkConstraint && c.data.name === w.constraint) as IkConstraint | undefined;
    if (!ik?.active || Math.abs(ik.appliedPose.mix - 1) > 1e-6 || ik.appliedPose.softness !== 0 || ik.appliedPose.stretch || ik.appliedPose.compress || !foot.active) throw new Error('Contact IK must remain active, fully mixed, with zero softness and no stretch/compress.');
    for (const b of [foot, ...w.names.map(n => s.bones.find(b => b.data.name === n)!), ...(foot.parent?.parent?.parent ? [foot.parent.parent.parent] : [])]) {
      const p = b.appliedPose, a = Math.hypot(p.a, p.c), d = Math.hypot(p.b, p.d);
      if (p.inherit !== Inherit.Normal || p.scaleX <= 0 || p.scaleY <= 0 || p.a * p.d - p.b * p.c <= 0 || Math.abs(a - d) > 1e-5 * Math.max(1, a) || Math.abs(p.a * p.b + p.c * p.d) > 1e-5 * Math.max(1, a * d) || Math.abs(p.shearX) + Math.abs(p.shearY) > 1e-6) throw new Error('Contact orientation requires positive uniform scale, normal inheritance and no shear on foot, chain and parent.');
    }
    if (Math.abs(f.x - foot.parent!.data.length) > 1e-5 || Math.abs(f.y) > 1e-5) throw new Error('Foot origin must stay at the lower-bone tip (x=length, y=0).');
    const heel = world(f, w.heel), toe = world(f, w.toe), sourceAngle = Math.atan2(toe.y - heel.y, toe.x - heel.x);
    if (w.mode === 'sole' && t >= w.start && t <= w.end && Math.abs(distance(heel, toe) - w.initialLength) > args.tolerance) throw new Error('A planted sole cannot change length. Remove contact-time scale animation or use a single heel/toe pivot.');
    let targetAngle = w.angleDegrees === undefined ? w.initialAngle : w.angleDegrees / degrees;
    if (w.angles) { const i = Math.max(0, w.angles.findLastIndex(v => v.time <= t)), a = w.angles[i]!, b = w.angles[Math.min(i + 1, w.angles.length - 1)]!, u = b.time === a.time ? 0 : Math.min(1, Math.max(0, (t - a.time) / (b.time - a.time))); targetAngle = (a.degrees + (b.degrees - a.degrees) * u) / degrees; }
    const weight = t < w.start ? smooth((t - w.begin) / (w.start - w.begin)) : t > w.end ? smooth((w.finish - t) / (w.finish - w.end)) : 1;
    const delta = wrap(targetAngle - sourceAngle) * weight, cos = Math.cos(delta), sin = Math.sin(delta), a = cos * f.a - sin * f.c, b = cos * f.b - sin * f.d, c = sin * f.a + cos * f.c, d = sin * f.b + cos * f.d;
    const pivot = w.mode === 'toe' ? w.toe : w.heel, goal = { x: w.anchor.x - a * pivot.x - b * pivot.y, y: w.anchor.y - c * pivot.x - d * pivot.y }, p = controller.appliedPose;
    return { x: p.worldX + (goal.x - p.worldX) * weight, y: p.worldY + (goal.y - p.worldY) * weight, angle: sourceAngle + delta, targetAngle, weight };
  };
  let plannedSamples = 0;
  const samples = windows.map(w => {
    const times = coalesceBakingTimes([w.begin, w.start, w.end, w.finish, ...sourceTimes.filter(t => t >= w.begin && t <= w.finish), ...(w.angles?.map(v => v.time) ?? []), ...Array.from({ length: Math.ceil((w.finish - w.begin) * args.fps) + 1 }, (_, i) => Math.min(w.finish, w.begin + i / args.fps))]);
    if (times.length > 600) throw new Error('Contact window exceeds 600 controller samples; split it or lower FPS.');
    plannedSamples += times.length; if (plannedSamples * source.bones.length > 300000) throw new Error('Contact planning exceeds 300,000 bone poses.');
    return { w, times, points: times.map(time => ({ time, ...desired(w, time) })) };
  });
  // Construct explicit controller paths; do not bake the chain or its constraints.
  const built = buildIkTargetRepair(source, ikTargetRepairSchema.parse({ requestId: args.requestId, input: args.input, animation: args.animation, newName: args.newName, skin: args.skin, fps: args.fps, tolerance: args.tolerance, endEffectorTolerance: args.tolerance, windows: samples.map(({ w, points }) => ({ constraint: w.constraint, start: w.begin, end: w.finish, motion: { mode: 'world_path', points: points.map(({ time, x, y }) => ({ time, x, y })) } })), comparison: args.comparison }));
  let data = built.data, footKeys = 0;
  for (const { w, times } of samples) {
    const beforeFoot = animationSampler(data, args.newName, args.skin), anim = data.animations![args.newName]!; anim.bones ??= {}; const bones = object(anim.bones, 'bones'); bones[w.foot] ??= {}; const channels = object(bones[w.foot], 'channels');
    if (!Array.isArray(channels.rotate)) channels.rotate = [{ time: 0, value: 0 }, { time: duration, value: 0 }];
    if (Number((channels.rotate as JsonObject[])[0]!.time ?? 0) > 0) (channels.rotate as JsonObject[]).unshift({ time: 0, value: 0, curve: 'stepped' });
    for (const t of [w.begin, w.finish]) data = insertBoundary(data, args.newName, { kind: 'bone', bone: w.foot, channel: 'rotate' }, t);
    const out = object(object(data.animations![args.newName]!.bones, 'bones')[w.foot], 'channels'), old = out.rotate as JsonObject[], tail = old.find(k => Math.abs(Number(k.time ?? 0) - w.finish) <= 1e-6);
    const keys = times.map(time => {
      const expected = desired(w, time), s = beforeFoot.sample(time), bone = s.bones.find(b => b.data.name === w.foot)!, parent = bone.parent!.appliedPose, p = bone.appliedPose, det = parent.a * parent.d - parent.b * parent.c, dx = Math.cos(expected.angle), dy = Math.sin(expected.angle), x = (parent.d * dx - parent.b * dy) / det, y = (-parent.c * dx + parent.a * dy) / det;
      const localAngle = Math.atan2((w.toe.y - w.heel.y) * p.scaleY, (w.toe.x - w.heel.x) * p.scaleX), raw = (Math.atan2(y, x) - localAngle) * degrees - bone.data.setupPose.rotation;
      const sourceFoot = original.sample(time).bones.find(b => b.data.name === w.foot)!, reference = sourceFoot.pose.rotation - sourceFoot.data.setupPose.rotation, value = reference + wrap((raw - reference) / degrees) * degrees;
      if (!Number.isFinite(value)) throw new Error('Contact orientation inverse is singular.');
      return { time, value, ...(Math.abs(time - w.finish) <= 1e-6 && tail?.curve !== undefined ? { curve: tail.curve } : {}) };
    });
    for (let i = 1; i < keys.length; i++) if (Math.abs(keys[i]!.value - keys[i - 1]!.value) > 180) throw new Error('Contact rotation crosses an ambiguous 360-degree seam; split/rebase the source rotation first.');
    out.rotate = [...old.filter(k => Number(k.time ?? 0) < w.begin - 1e-6), ...keys, ...old.filter(k => Number(k.time ?? 0) > w.finish + 1e-6)]; footKeys += keys.length;
  }
  data = parseDocument(data); const after = animationSampler(data, args.newName, args.skin), verifyTimes = coalesceBakingTimes([0, duration, ...sourceTimes, ...samples.flatMap(s => s.times), ...Array.from({ length: Math.ceil(duration * args.fps * 2) + 1 }, (_, i) => Math.min(duration, i / (args.fps * 2)))]);
  if (verifyTimes.length * source.bones.length > 300000) throw new Error('Contact verification exceeds 300,000 bone poses.');
  let maxAnchorError = 0, maxOrientationErrorDegrees = 0, maxOutsideWorldError = 0, maxUnselectedWorldError = 0; const changed = new Set(windows.flatMap(w => [...w.affected]));
  for (const t of verifyTimes) {
    const a = original.sample(t), b = after.sample(t), active = windows.filter(w => t >= w.begin && t <= w.finish), allowed = new Set(active.flatMap(w => [...w.affected]));
    for (const w of active) {
      const expected = desired(w, t), p = b.bones.find(b => b.data.name === w.foot)!.appliedPose, heel = world(p, w.heel), toe = world(p, w.toe);
      maxOrientationErrorDegrees = Math.max(maxOrientationErrorDegrees, Math.abs(wrap(Math.atan2(toe.y - heel.y, toe.x - heel.x) - expected.angle)) * degrees);
      if (t >= w.start - 1e-7 && t <= w.end + 1e-7) {
        maxAnchorError = Math.max(maxAnchorError, distance(w.mode === 'toe' ? toe : heel, w.anchor));
        if (w.mode === 'sole') maxAnchorError = Math.max(maxAnchorError, distance(toe, { x: w.anchor.x + Math.cos(expected.targetAngle) * w.initialLength, y: w.anchor.y + Math.sin(expected.targetAngle) * w.initialLength }));
      }
    }
    for (let i = 0; i < a.bones.length; i++) {
      const p = a.bones[i]!, q = b.bones[i]!;
      if (q.active && !['worldX', 'worldY', 'a', 'b', 'c', 'd'].every(k => Number.isFinite((q.appliedPose as any)[k]))) throw new Error('Contact output has a non-finite pose.');
      if (!p.active || allowed.has(p.data.name)) continue;
      if (!q.active) throw new Error('Contact repair changed unrelated bone activation.');
      const error = Math.max(...['worldX', 'worldY', 'a', 'b', 'c', 'd'].map(k => Math.abs((p.appliedPose as any)[k] - (q.appliedPose as any)[k])));
      if (changed.has(p.data.name)) maxOutsideWorldError = Math.max(maxOutsideWorldError, error); else maxUnselectedWorldError = Math.max(maxUnselectedWorldError, error);
    }
  }
  if (Math.max(maxAnchorError, maxOutsideWorldError, maxUnselectedWorldError) > args.tolerance || maxOrientationErrorDegrees > args.orientationToleranceDegrees) throw new Error(`Contact verification failed (anchor=${maxAnchorError}, angle=${maxOrientationErrorDegrees}, outside=${maxOutsideWorldError}, unrelated=${maxUnselectedWorldError}); revise contact anchors or raise FPS.`);
  for (const [name, anim] of Object.entries(source.animations)) if (JSON.stringify(data.animations![name]) !== JSON.stringify(anim)) throw new Error('Contact repair changed an original clip.');
  return { data, report: { ...built.report, footKeys, editedFeet: args.chains.map(c => c.foot), contactModes: windows.map(w => w.mode), maxAnchorError, maxOrientationErrorDegrees, maxOutsideWorldError, maxUnselectedWorldError, orientationToleranceDegrees: args.orientationToleranceDegrees, checkedContactSamples: verifyTimes.length, scope: 'Explicit foot-local heel/toe landmarks and contact windows; only target translation and foot rotation in a NEW clip. Live constraints remain editable. Sampling verifies tolerances; visual/anatomical acceptance is separate.' } };
}
export async function createIkContactRepair(service: SpineService, raw: z.input<typeof ikContactRepairSchema>) {
  const args = ikContactRepairSchema.parse(raw);
  return operation(service, args.requestId, 'ik_contact_repair', args, async () => {
    const source = await captureSource(service, args.input), built = buildIkContactRepair(source.data, args), directory = await newFolder(service, 'ik-contact-repairs'), json = (await writeDocument(service.workspace, path.join(directory, 'candidate.json'), built.data, path.dirname(source.jsonPath))).path;
    const comparison = await comparisonMedia(service, parseDocument(JSON.parse(await readFile(json, 'utf8'))), json, args.animation, args.newName, args.skin, args.comparison); await verifySource(service, source.source);
    return writeCandidate(service, 'ik_contact_repair', json, source.source, { animation: args.animation, newName: args.newName, verification: built.report, comparison }, true, [comparison.manifest, comparison.player, ...comparison.files, ...(comparison.video ? [comparison.video] : [])]);
  });
}
