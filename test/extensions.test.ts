import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {productFixture,productData} from './product-fixture.js';
import {parseDocument,writeDocument} from '../src/document.js';
import {animationSampler} from '../src/animation-sampler.js';
import {applyPhysicsResult,viewAuditSchema,auditViews} from '../src/physics-tools.js';
import {visualBaselineSchema,createVisualBaseline,compareVisualBaseline,comparePixels} from '../src/visual-regression.js';
import {chainContactSchema,bakeChainData,solveChain} from '../src/chain-contact.js';
import {motionSequenceSchema,composeMotionData} from '../src/motion-sequence.js';
import {runtime42Schema,convert42Data} from '../src/runtime-compatibility.js';

test('physics bake converts through animated parents and retains original clips',()=>{
 const data=productData(),before=JSON.stringify(data),p=animationSampler(data,'source').sample(0).findBone('head')!.appliedPose;
 const r={engine:'official Box2D',version:'3.1.1',bodyIds:['head'],frames:[{time:0,poses:[{x:p.worldX,y:p.worldY,rotation:0,vx:0,vy:0,angularVelocity:0,visible:true}]},{time:1,poses:[{x:p.worldX+10,y:p.worldY-20,rotation:25,vx:0,vy:0,angularVelocity:0,visible:true}]}]};
 const out=applyPhysicsResult(data,'source','physical',r),b=animationSampler(out,'physical').sample(1).findBone('head')!.appliedPose;assert.ok(Math.hypot(b.worldX-p.worldX-10,b.worldY-p.worldY+20)<1e-5);assert.equal(JSON.stringify(data),before);assert.deepEqual(out.animations!.source,data.animations!.source);
 assert.throws(()=>applyPhysicsResult(data,'source','bad',{...r,bodyIds:['pelvis','head']}),/ancestors/);
});
test('view synchronization detects a wrong view instead of just checking matching names',async()=>{
 const f=await productFixture(),data=productData();data.bones.push({name:'zoom',parent:'root',x:4,y:500,scaleX:2,scaleY:2});const input=(await writeDocument(f.service.workspace,'views.json',data)).path;
 const good=await auditViews(f.service,{input,animation:'source',times:[0],pairs:[{source:'head',view:'zoom',scale:2,offset:{x:4,y:0}}]});assert.equal(good.passed,true);const bad=await auditViews(f.service,{input,animation:'source',times:[0,.5],pairs:[{source:'head',view:'zoom',scale:2,offset:{x:8,y:0}}]});assert.equal(bad.passed,false);
 assert.equal(viewAuditSchema.safeParse({input,animation:'source',times:[],pairs:[]}).success,false);
});

test('physics binding rejects physics constraints and avoids rotation jumps at parent angle wrap',()=>{
 const source=parseDocument({skeleton:{spine:'4.3.23'},bones:[{name:'root',rotation:170},{name:'ball',parent:'root'}],animations:{turn:{bones:{root:{rotate:[{time:0,value:0},{time:1,value:20}]}}}}});
 const result={engine:'official Box2D',version:'3.1.1',bodyIds:['ball'],frames:[0,1].map(time=>({time,poses:[{x:0,y:0,rotation:0,vx:0,vy:0,angularVelocity:0,visible:true}]}))};const output=applyPhysicsResult(source,'turn','physical',result);
 for(const t of[0,.25,.5,.75,1]){const b=animationSampler(output,'physical').sample(t).findBone('ball')!.appliedPose;assert.ok(Math.abs(Math.atan2(b.c,b.a))<1e-5);}
 const constrained=parseDocument({...source,constraints:[{name:'spring',type:'physics',bone:'ball',mix:1}]});assert.throws(()=>applyPhysicsResult(constrained,'turn','bad',result),/interacting constraint/);
});
test('visual baseline detects an actual rendered change and preserves baseline pixels',async()=>{
 const f=await productFixture(),baseline=await createVisualBaseline(f.service,{requestId:randomUUID(),input:f.input,name:'reference',frames:[{animation:'source',time:0}],width:128,height:256,viewport:{minX:-25,maxX:25,minY:130,maxY:300}});
 const common={requestId:randomUUID(),baseline:baseline.baseline,expectedSha256:baseline.baselineSha256,input:f.input};assert.equal((await compareVisualBaseline(f.service,common)).passed,true);
 const changed=productData();changed.bones[1]!.x=5;const input=(await writeDocument(f.service.workspace,'changed.json',changed)).path;const result=await compareVisualBaseline(f.service,{...common,requestId:randomUUID(),input});assert.equal(result.passed,false);assert.ok(result.frames[0].changedPixels>0);
 const b=JSON.parse(await readFile(baseline.baseline,'utf8'));await writeFile(b.frames[0].image.path,'corrupt');await assert.rejects(compareVisualBaseline(f.service,{...common,requestId:randomUUID()}),/changed/);
});
test('visual ignore masks are explicit and cannot hide every pixel',()=>{
 const a={width:2,height:1,data:new Uint8Array([0,0,0,255,0,0,0,255])},b={...a,data:new Uint8Array([255,0,0,255,0,0,0,255])},options={pixelTolerance:0,maxChangedRatio:0,maxMeanError:0,ignore:[]};assert.equal(comparePixels(a,b,options).passed,false);assert.equal(comparePixels(a,b,{...options,ignore:[{x:0,y:0,width:1,height:1}]}).passed,true);assert.throws(()=>comparePixels(a,b,{...options,ignore:[{x:0,y:0,width:2,height:1}]}),/All pixels/);
});
test('non-humanoid four-joint contact preserves the source and satisfies interpolated endpoints',()=>{
 const source=parseDocument({skeleton:{spine:'4.3.23',fps:30},bones:[{name:'root'},{name:'a',parent:'root',x:20},{name:'b',parent:'a',x:20},{name:'tip',parent:'b',x:20}],animations:{idle:{bones:{root:{rotate:[{time:0,value:0},{time:1,value:0}]}}}}}),before=JSON.stringify(source),args=chainContactSchema.parse({requestId:randomUUID(),input:'source.json',animation:'idle',newName:'reach',chains:[{bones:['root','a','b','tip'],targets:[{time:0,x:45,y:10},{time:1,x:40,y:15}]}]});const r=bakeChainData(source,args);assert.ok(r.maxContactError<=.25);assert.equal(JSON.stringify(source),before);assert.deepEqual(r.data.animations!.idle,source.animations!.idle);assert.throws(()=>solveChain([{x:0,y:0},{x:10,y:0},{x:20,y:0}],{x:100,y:0},.1),/unreachable/);
});
test('runtime crossfade captures slots/draw order and creates one new clip',()=>{
 const source=productData(),before=JSON.stringify(source),a=motionSequenceSchema.parse({requestId:randomUUID(),input:'source.json',newName:'combo',clips:[{animation:'source',duration:1,mix:0},{animation:'ordered',duration:1,mix:.2}]});const r=composeMotionData(source,a);assert.equal(r.duration,1.8);assert.ok(r.checkedFrames>100);assert.ok(r.maxSampledStateError<.05);assert.equal(JSON.stringify(source),before);assert.deepEqual(r.data.animations!.source,source.animations!.source);assert.ok(r.data.animations!.combo!.slots);
});
test('prop handoff follows an independent actor branch with a verified contact point',()=>{
 const source=productData();source.bones.push({name:'prop',parent:'root',x:100});const a=motionSequenceSchema.parse({requestId:randomUUID(),input:'source.json',newName:'handoff',clips:[{animation:'source',duration:1,mix:0}],props:[{bone:'prop',windows:[{start:0,end:1,targetBone:'hand_L',offset:{x:3,y:1}}]}]});const r=composeMotionData(source,a);assert.ok(r.maxPropError<.001);assert.throws(()=>composeMotionData(source,{...a,props:[{bone:'pelvis',windows:a.props[0]!.windows}]}),/leaf/);
});

test('vertical singular chains seed their bend perpendicular to the chain',()=>{
 const solved=solveChain([{x:0,y:0},{x:0,y:20},{x:0,y:40},{x:0,y:60}],{x:0,y:45},.1);
 assert.ok(Math.hypot(solved.at(-1)!.x,solved.at(-1)!.y-45)<.1);
 for(let i=1;i<solved.length;i++)assert.ok(Math.abs(Math.hypot(solved[i]!.x-solved[i-1]!.x,solved[i]!.y-solved[i-1]!.y)-20)<1e-6);
});

test('prop blending preserves reflections and shear, including the unchanged blend boundaries',()=>{
 const source=productData();source.bones[0]!.scaleX=-1;source.bones[0]!.scaleY=1.2;source.bones.push({name:'prop',parent:'root',x:100,rotation:30,shearY:8});
 const args=motionSequenceSchema.parse({requestId:randomUUID(),input:'source.json',newName:'affine-handoff',clips:[{animation:'source',duration:1,mix:0}],props:[{bone:'prop',windows:[{start:0,end:1,targetBone:'hand_L',blendIn:.2,blendOut:.2}]}]}),r=composeMotionData(source,args);
 for(const time of[0,.5,1]){const a=animationSampler(source,'source').sample(time).findBone('prop')!.appliedPose,b=animationSampler(r.data,'affine-handoff').sample(time).findBone('prop')!.appliedPose;
  for(const [x,y]of[[a.a*a.d-a.b*a.c,b.a*b.d-b.b*b.c],[a.a*a.a+a.c*a.c,b.a*b.a+b.c*b.c],[a.b*a.b+a.d*a.d,b.b*b.b+b.d*b.d],[a.a*a.b+a.c*a.d,b.a*b.b+b.c*b.d]])assert.ok(Math.abs(x!-y!)<1e-5);
  if(time===0||time===1)for(const key of['worldX','worldY','a','b','c','d']as const)assert.ok(Math.abs(a[key]-b[key])<1e-5);
 }
});
test('Spine4.2 export actually plays the common subset and rejects unsupported source links',()=>{
 const source=productData(),before=JSON.stringify(source),a=runtime42Schema.parse({requestId:randomUUID(),input:'source.json',animations:['source','ordered'],atlas:false}),r=convert42Data(source,a);assert.equal(r.output.skeleton.spine,'4.2.120');assert.equal(r.verification.passed,true);assert.ok(r.verification.poses>100);assert.equal(JSON.stringify(source),before);
 const linked=productData();(linked.skins as any[])[0].attachments.body.body.source='other';assert.throws(()=>convert42Data(linked,a),/independent meshes/);
});

test('Spine4.2 constrained export requires explicit baking and preserves actual IK poses',()=>{
 const source=parseDocument({skeleton:{spine:'4.3.23',fps:30},bones:[{name:'root'},{name:'arm',parent:'root',length:40},{name:'goal',parent:'root',x:25,y:25}],constraints:[{type:'ik',name:'aim',bones:['arm'],target:'goal',mix:1}],skins:[{name:'default',attachments:{}}],animations:{reach:{bones:{goal:{translate:[{time:0,x:0,y:0},{time:1,x:-10,y:10}]}}}}}),before=JSON.stringify(source),a=runtime42Schema.parse({requestId:randomUUID(),input:'rig.json',animations:['reach'],atlas:false});
 assert.throws(()=>convert42Data(source,a),/constraintMode=bake/);
 const r=convert42Data(source,{...a,constraintMode:'bake'});assert.equal(r.bakedConstraints,true);assert.equal(r.output.constraints,undefined);assert.equal(r.verification.passed,true);
 for(const time of[0,.25,.5,.75,1]){const a=animationSampler(source,'reach').sample(time).findBone('arm')!.appliedPose,b=animationSampler(r.comparable,'reach').sample(time).findBone('arm')!.appliedPose;assert.ok(Math.max(Math.abs(a.a-b.a),Math.abs(a.c-b.c))<.001);}
 assert.equal(JSON.stringify(source),before);
});

test('motion sequence retains an animated inheritance change through full-state baking',()=>{
 const source=productData();(source.animations!.source!.bones as any).head.inherit=[{time:0,inherit:'normal'},{time:.5,inherit:'onlyTranslation'}];
 const args=motionSequenceSchema.parse({requestId:randomUUID(),input:'rig.json',newName:'inheritance',clips:[{animation:'source',duration:1,mix:0}]});const r=composeMotionData(source,args);
 assert.deepEqual(((r.data.animations!.inheritance!.bones as any).head.inherit as any[]).map(k=>k.inherit),['normal','onlyTranslation']);
 for(const time of[0,.25,.5,.75,1]){const a=animationSampler(source,'source').sample(time).findBone('head')!.appliedPose,b=animationSampler(r.data,'inheritance').sample(time).findBone('head')!.appliedPose;assert.equal(b.inherit,a.inherit);}
});

test('Spine4.2 export never silently drops active physics and explicitly captures its integrated pose',()=>{
 const source=parseDocument({skeleton:{spine:'4.3.23',fps:30},bones:[{name:'root'},{name:'arm',parent:'root',length:100},{name:'tip',parent:'arm',x:100}],skins:[{name:'default',attachments:{}}],constraints:[{name:'spring',type:'physics',bone:'arm',rotate:1,strength:20,damping:.8,inertia:1,gravity:40,wind:20}],animations:{move:{bones:{root:{rotate:[{time:0,value:0},{time:1,value:20}]}}}}}),args=runtime42Schema.parse({requestId:randomUUID(),input:'physics.json',animations:['move'],atlas:false,constraintMode:'bake'});
 assert.throws(()=>convert42Data(source,args),/physics:true/);const result=convert42Data(source,{...args,physics:true});assert.equal(result.physicsCaptured,true);assert.equal(result.verification.passed,true);
 const physical=animationSampler(source,'move',undefined,{physics:true,fps:60}).sample(1).findBone('tip')!.appliedPose,plain=animationSampler(source,'move').sample(1).findBone('tip')!.appliedPose,baked=animationSampler(result.comparable,'move').sample(1).findBone('tip')!.appliedPose;
 assert.ok(Math.hypot(physical.worldX-plain.worldX,physical.worldY-plain.worldY)>.1);assert.ok(Math.hypot(physical.worldX-baked.worldX,physical.worldY-baked.worldY)<.01);
});
