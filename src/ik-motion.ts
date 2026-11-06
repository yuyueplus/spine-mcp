import type { SpineDocument } from './document.js';
import type { RigDefinition } from './product-rig.js';
import { constraintList, normalizedConstraint } from './constraint-data.js';
import { animationSampler } from './animation-sampler.js';
import { constructControls, type Construction } from './character-construction.js';
import { buildPoseData } from './character-workflow.js';
import { poseAnimationSchema } from './stability-schema.js';
import { footBakeSchema } from './stability-schema.js';
import { bakeFootContactData } from './foot-contacts.js';

type Recipe = { fps: number; poses: { time: number; bones: Record<string, any>; curve: string }[]; secondary: any[]; blinks: any[] };
export type IKMotionRig = ReturnType<typeof prepareIKMotionRig>;
const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));

/** The reference has disabled IK only in memory. Published constraints stay live. */
export function prepareIKMotionRig(source: SpineDocument, rig: RigDefinition, prefix: string, skin: string) {
  const constraints = constraintList(source), controls: Construction['controls'] = [];
  const legs: { upper: string; lower: string; foot: string; target: string; constraint: string }[] = [];
  if (constraints.some(c => c.type === 'physics')) throw Error('Procedural live IK does not support interacting physics.');
  const setup = animationSampler(source, undefined, skin).sample(0);
  for (const side of ['L', 'R']) {
    const [upper, lower, foot] = ['leg_' + side + '_upper', 'leg_' + side + '_lower', 'foot_' + side].map(r => rig.roles[r]);
    if (!upper || !lower || !foot) throw Error('Live IK needs explicit left and right leg roles.');
    const owners = constraints.filter(c => c.bone === upper || c.bone === lower || Array.isArray(c.bones) && c.bones.some(b => b === upper || b === lower));
    let target: string, name: string;
    if (owners.length) {
      const c = owners[0]!, n = normalizedConstraint(c);
      if (owners.length !== 1 || c.type !== 'ik' || JSON.stringify(c.bones) !== JSON.stringify([upper, lower]) ||
          ![0,1].includes(Number(n.mix)) || n.softness !== 0 || n.stretch || n.compress || n.skin)
        throw Error('Live IK locomotion requires independent full-mix, zero-softness two-bone IK without stretch or skin gating.');
      target = String(c.target); name = String(c.name);
    } else {
      target = prefix + '_foot_' + side; name = prefix + '_leg_' + side;
      if (source.bones.some(b => b.name === target) || constraints.some(c => c.name === name))
        throw Error('Generated IK name conflicts; choose a new ikPrefix.');
      const u = setup.findBone(upper)!, l = setup.findBone(lower)!;
      const tip = l.appliedPose.localToWorld({ x: l.data.length, y: 0 } as any);
      const cross = (l.appliedPose.worldX - u.appliedPose.worldX) * (tip.y - l.appliedPose.worldY) -
        (l.appliedPose.worldY - u.appliedPose.worldY) * (tip.x - l.appliedPose.worldX);
      controls.push({ name, bones: [upper, lower], target, createTargetParent: rig.roles.root!, mix: 0, softness: 0, bendPositive: cross >= 0 });
    }
    let parent = source.bones.find(b => b.name === target)?.parent ?? rig.roles.root;
    while (parent) {
      if ([upper, lower, foot].includes(parent) || constraints.some(c => c.bone === parent || Array.isArray(c.bones) && c.bones.includes(parent)))
        throw Error('Live IK target must have an independent unconstrained parent.');
      parent = source.bones.find(b => b.name === parent)?.parent;
    }
    if (legs.some(l => l.target === target)) throw Error('Each leg needs an independent IK target.');
    legs.push({ upper, lower, foot, target, constraint: name });
  }
  const allowed = new Set(legs.map(l => l.constraint));
  const relevant = new Set(Object.values(rig.roles));
  if (constraints.some(c => !allowed.has(String(c.name)) && (relevant.has(String(c.bone)) ||
      Array.isArray(c.bones) && c.bones.some(b => relevant.has(String(b))))))
    throw Error('Another constraint drives a procedural role; use an independent rig.');
  const actual = constructControls(source, controls).data, reference = structuredClone(actual);
  for (const c of constraintList(reference)) if (allowed.has(String(c.name))) c.mix = 0;
  return { actual, reference, controls, legs };
}

export function makeLiveIKMotion(rig: IKMotionRig, definition: RigDefinition, recipe: Recipe, name: string, skin: string, tolerance: number, contacts: any[] = []) {
  const mapped = {
    ...recipe,
    poses: recipe.poses.map(p => ({ ...p, curve: 'linear', bones: Object.fromEntries(Object.entries(p.bones).map(([role, value]) => [definition.roles[role]!, structuredClone(value)])) })),
    secondary: recipe.secondary.map(c => ({ ...c, bones: c.bones.map((r: string) => definition.roles[r]!), driver: definition.roles[c.driver]! }))
  };
  let desiredData = buildPoseData(rig.reference, poseAnimationSchema.parse({ input: 'ik-reference', output: 'ik-reference', name, ...mapped }));
  if (contacts.length) {
    desiredData.constraints = constraintList(desiredData).filter(c => !rig.legs.some(l => l.constraint === c.name));
    const temporary = '__ik_reference_' + name;
    desiredData.animations![temporary] = desiredData.animations![name]!;
    delete desiredData.animations![name];
    desiredData = bakeFootContactData(desiredData, footBakeSchema.parse({
      input: 'ik-reference', output: 'ik-reference', animation: temporary, newName: name, skin, fps: 120,
      chains: contacts.map(c => ({ ...c, upper: definition.roles[c.upper], lower: definition.roles[c.lower], foot: definition.roles[c.foot] }))
    })).data;
    delete desiredData.animations![temporary];
  }
  const desired = animationSampler(desiredData, name, skin);
  const outputFps = recipe.fps * Math.max(1, Math.min(Math.floor(120 / recipe.fps), Math.floor(990 / recipe.poses.length)));
  const duration = mapped.poses.at(-1)!.time;
  const channels = new Map<string, Set<string>>();
  for (const p of mapped.poses) for (const [bone, values] of Object.entries(p.bones)) {
    if (!channels.has(bone)) channels.set(bone, new Set());
    for (const channel of Object.keys(values)) channels.get(bone)!.add(channel);
  }
  const poses = Array.from({ length: Math.round(duration * outputFps) + 1 }, (_, i) => {
    const time = Math.min(duration, i / outputFps), sample = desired.sample(time), bones: Record<string, any> = {};
    for (const [name, fields] of channels) {
      const b = sample.findBone(name)!, pose = b.pose as any, setup = b.data.setupPose as any;
      bones[name] = Object.fromEntries([...fields].map(field => [field, field.startsWith('scale') ? pose[field] / setup[field] : pose[field] - setup[field]]));
    }
    for (const leg of rig.legs) {
      const lower = sample.findBone(leg.lower)!, target = sample.findBone(leg.target)!;
      const tip = lower.appliedPose.localToWorld({ x: lower.data.length, y: 0 } as any);
      const local = target.parent ? target.parent.appliedPose.worldToLocal(tip) : tip;
      bones[leg.target] = { x: local.x - target.data.setupPose.x, y: local.y - target.data.setupPose.y };
      delete bones[leg.upper]; delete bones[leg.lower];
    }
    return { time, curve: 'linear' as const, bones };
  });
  const args = () => poseAnimationSchema.parse({ input: 'live-ik', output: 'live-ik', name, fps: Math.min(120, outputFps), poses, ikMix:Object.fromEntries(rig.legs.map(l=>[l.constraint,1])), secondary: mapped.secondary, blinks: mapped.blinks });
  let data = buildPoseData(rig.actual, args());
  const initial = animationSampler(data, name, skin);
  for (const p of poses) {
    const wanted = desired.sample(p.time), got = initial.sample(p.time);
    for (const leg of rig.legs) {
      const a = wanted.findBone(leg.foot)!.appliedPose, b = got.findBone(leg.foot)!.appliedPose;
      p.bones[leg.foot] ??= {};
      p.bones[leg.foot].rotation = Number(p.bones[leg.foot].rotation ?? 0) -
        wrap(Math.atan2(b.c, b.a) - Math.atan2(a.c, a.a)) * 180 / Math.PI;
    }
  }
  data = buildPoseData(rig.actual, args());
  const actual = animationSampler(data, name, skin);
  let maxPositionError = 0, maxFootAngleError = 0, worstBone = '', worstTime = 0;
  for (let i = 0; i <= Math.ceil(duration * outputFps * 2); i++) {
    const time = Math.min(duration, i / (outputFps * 2)), a = desired.sample(time), b = actual.sample(time);
    for (const bone of Object.values(definition.roles)) {
      const p = a.findBone(bone)!.appliedPose, q = b.findBone(bone)!.appliedPose;
      const error = Math.hypot(p.worldX - q.worldX, p.worldY - q.worldY);
      if (error > maxPositionError) { maxPositionError = error; worstBone = bone; worstTime = time; }
    }
    for (const leg of rig.legs) {
      const p = a.findBone(leg.foot)!.appliedPose, q = b.findBone(leg.foot)!.appliedPose;
      maxFootAngleError = Math.max(maxFootAngleError, Math.abs(wrap(Math.atan2(p.c, p.a) - Math.atan2(q.c, q.a))) * 180 / Math.PI);
    }
  }
  if (maxPositionError > tolerance || maxFootAngleError > .25)
    throw Error('Live IK verification failed for ' + name + ': position=' + maxPositionError + ', foot angle=' + maxFootAngleError + ', bone=' + worstBone + ', time=' + worstTime);
  const { input: _input, output: _output, ...motion } = args();
  return {
    motion, data,
    verification: { mode: 'live_ik', samplingFps: outputFps, samples: Math.ceil(duration * outputFps * 2) + 1, maxPositionError, maxFootAngleError, tolerance, constraintsRemainEditable: true, originalAnimationsPreserved: true }
  };
}
