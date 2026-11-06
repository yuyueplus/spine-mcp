import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { productData, productDefinition, productFixture } from './product-fixture.js';
import { createRigProfile } from '../src/product-rig.js';
import { planMotionPack, planMotionPackSchema, makeMotionRecipe } from '../src/product-motion.js';
import { prepareIKMotionRig, makeLiveIKMotion } from '../src/ik-motion.js';
import { constraintList } from '../src/constraint-data.js';
import { animationSampler } from '../src/animation-sampler.js';
import { previewConstruction } from '../src/character-construction.js';

for (const scale of [.45, 1, 2.1]) for (const preset of ['walk', 'run', 'jump'] as const) {
  test('live IK ' + preset + ' retains constraints, loops and foot contacts at scale ' + scale, () => {
    const source = productData(scale), original = structuredClone(source);
    const options = planMotionPackSchema.parse({ input: 'a', profile: 'b', expectedSha256: '0'.repeat(64), name: 'test', driver: 'ik', motions: [{ preset, name: 'new' }] });
    const rig = prepareIKMotionRig(source, productDefinition, 'Test', 'default');
    const recipe = makeMotionRecipe(rig.reference, productDefinition, { preset, name: 'new' }, options);
    const live = makeLiveIKMotion(rig, productDefinition, recipe.recipe, 'new', 'default', .25, recipe.contacts);
    assert.deepEqual(source, original);
    assert.equal(constraintList(live.data).length, 2);
    assert.ok(constraintList(live.data).every(c => c.mix === 0));
    const tracks = live.data.animations!.new!.bones as any;
    assert.equal(tracks.leg_L_upper, undefined);
    assert.equal(tracks.leg_R_lower, undefined);
    assert.ok(tracks.Test_foot_L.translate.length > 30);
    assert.deepEqual(live.data.animations!.source, original.animations!.source);
    const sampler = animationSampler(live.data, 'new');
    for (const chain of recipe.contacts) for (const window of chain.contacts) {
      const name = productDefinition.roles[chain.foot]!, first = sampler.sample(window.start).findBone(name)!.appliedPose;
      const anchor = { x: first.worldX, y: first.worldY };
      for (let t = window.start; t <= window.end + 1e-8; t += 1 / 120) {
        const p = sampler.sample(t).findBone(name)!.appliedPose;
        assert.ok(Math.hypot(p.worldX - anchor.x, p.worldY - anchor.y) < .03, 'foot slipped at ' + t);
      }
    }
    assert.ok(live.verification.maxPositionError < .25);
  });
}
test('live IK plan reconstructs the same digest through durable construction', async () => {
  const f = await productFixture(), before = await readFile(f.input);
  const profile = await createRigProfile(f.service, { requestId: randomUUID(), input: f.input, name: 'rig', definition: productDefinition });
  const plan = await planMotionPack(f.service, { input: f.input, profile: profile.profile, expectedSha256: profile.profileSha256, name: 'ik', driver: 'ik', motions: [{ preset: 'walk', name: 'new_walk' }, { preset: 'attack', name: 'new_attack' }, { preset: 'hit', name: 'new_hit' }], reviewVideo: false });
  const preview = await previewConstruction(f.service, f.data, plan.construction);
  assert.equal(preview.dataSha256, plan.construction.expectedDataSha256);
  assert.equal(plan.contactVerification.length, 3);
  assert.deepEqual(await readFile(f.input), before);
});
test('existing independent IK targets are reused without changing original constraints', () => {
  const source = prepareIKMotionRig(productData(), productDefinition, 'Existing', 'default').actual;
  const rig = prepareIKMotionRig(source, productDefinition, 'Ignored', 'default');
  assert.equal(rig.controls.length, 0);
  assert.deepEqual(rig.actual, source);
  for (const c of constraintList(rig.reference)) assert.equal(c.mix, 0);
  for(const c of constraintList(source))c.mix=1;
  assert.equal(prepareIKMotionRig(source,productDefinition,'Ignored','default').controls.length,0);
});
test('live IK rejects partial mix, physics, shared targets and unsupported transforms', () => {
  const base = prepareIKMotionRig(productData(), productDefinition, 'Existing', 'default').actual;
  for(const c of constraintList(base))c.mix=1;
  const mixed = structuredClone(base); constraintList(mixed)[0]!.mix = .5;
  assert.throws(() => prepareIKMotionRig(mixed, productDefinition, 'New', 'default'), /full-mix/);
  const shared = structuredClone(base); constraintList(shared)[1]!.target = constraintList(shared)[0]!.target;
  assert.throws(() => prepareIKMotionRig(shared, productDefinition, 'New', 'default'), /independent IK target/);
  const mirrored = productData(); mirrored.bones[0]!.scaleX = -1;
  const rig = prepareIKMotionRig(mirrored, productDefinition, 'New', 'default');
  const options = planMotionPackSchema.parse({ input: 'a', profile: 'b', expectedSha256: '0'.repeat(64), name: 'x', motions: [{ preset: 'walk', name: 'new' }] });
  assert.throws(() => makeMotionRecipe(rig.reference, productDefinition, { preset: 'walk', name: 'new' }, options), /positive uniform/);
});
test('attack and hit are finite, deterministic and return to baseline', () => {
  for (const preset of ['attack', 'hit'] as const) {
    const a = planMotionPackSchema.parse({ input: 'a', profile: 'b', expectedSha256: '0'.repeat(64), name: 'x', motions: [{ preset, name: 'new' }] });
    const one = makeMotionRecipe(productData(), productDefinition, { preset, name: 'new' }, a);
    assert.deepEqual(one, makeMotionRecipe(productData(), productDefinition, { preset, name: 'new' }, a));
    assert.deepEqual(one.recipe.poses[0]!.bones, one.recipe.poses.at(-1)!.bones);
    assert.notDeepEqual(one.recipe.poses[Math.floor(one.recipe.poses.length / 2)]!.bones, one.recipe.poses[0]!.bones);
  }
});
test('new IK controllers preserve every old bone world pose and support a rotated root', () => {
  const data=productData();data.bones[0]!.rotation=12;
  const rig=prepareIKMotionRig(data,productDefinition,'Fresh','default');
  const options=planMotionPackSchema.parse({input:'a',profile:'b',expectedSha256:'0'.repeat(64),name:'x',motions:[{preset:'walk',name:'new'}]});
  const recipe=makeMotionRecipe(rig.reference,productDefinition,{preset:'walk',name:'new'},options);
  const live=makeLiveIKMotion(rig,productDefinition,recipe.recipe,'new','default',.25,recipe.contacts);
  for(const clip of Object.keys(data.animations!)){
    const before=animationSampler(data,clip),after=animationSampler(live.data,clip);
    for(let i=0;i<=20;i++){
      const a=before.sample(before.duration*i/20),b=after.sample(before.duration*i/20);
      for(const bone of data.bones){
        const p=a.findBone(bone.name)!.appliedPose,q=b.findBone(bone.name)!.appliedPose;
        for(const key of ['worldX','worldY','a','b','c','d'] as const)assert.ok(Math.abs(p[key]-q[key])<1e-7,clip+' '+bone.name+' '+key);
      }
    }
  }
});
test('live IK adapts unequal thigh/shin proportions and an offset shoe origin', () => {
  for(const [upperRatio,lowerRatio,offset] of [[.7,1.3,0],[1.25,.8,0],[1,1,2]]){
    const data=productData();
    for(const side of ['L','R']){
      const upper=data.bones.find(b=>b.name==='leg_'+side+'_upper')!,lower=data.bones.find(b=>b.name==='leg_'+side+'_lower')!,foot=data.bones.find(b=>b.name==='foot_'+side)!;
      upper.length=Number(upper.length)*upperRatio!;lower.x=upper.length;lower.length=Number(lower.length)*lowerRatio!;
      foot.x=Number(lower.length)+offset!;foot.y=offset;
    }
    const rig=prepareIKMotionRig(data,productDefinition,'Variant','default');
    const options=planMotionPackSchema.parse({input:'a',profile:'b',expectedSha256:'0'.repeat(64),name:'x',motions:[{preset:'walk',name:'new'}]});
    const recipe=makeMotionRecipe(rig.reference,productDefinition,{preset:'walk',name:'new'},options);
    const live=makeLiveIKMotion(rig,productDefinition,recipe.recipe,'new','default',.25,recipe.contacts);
    assert.ok(live.verification.maxPositionError<.25);
  }
});
