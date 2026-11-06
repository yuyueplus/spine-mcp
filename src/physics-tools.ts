import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { z } from 'zod/v4';
import {Vector2,Inherit} from '@esotericsoftware/spine-core';
import type { SpineService } from './service.js';
import { parseDocument, type SpineDocument } from './document.js';
import { writeDocument } from './document.js';
import { animationSampler } from './animation-sampler.js';
import { VERSION } from './version.js';
import { captureSource, immutableJson, jsonRead, label, filename, sha, request, operation, verifySource, verifyPins, pin, newFolder, writeCandidate } from './character-candidates.js';
import { requireManagedFile } from './product-guards.js';

const n = z.number().finite(), point = z.object({x:n,y:n}).strict();
const filter = {category:z.number().int().min(1).max(65535).default(1),mask:z.number().int().min(1).max(65535).default(65535)};
const material = {friction:n.min(0).max(10).default(.35),restitution:n.min(0).max(1).default(.1)};
export const physicsPlanSchema = z.object({
 ...request,input:filename,animation:label.optional(),newName:label,duration:n.positive().max(120),
 fps:z.union([z.literal(30),z.literal(60),z.literal(120)]).default(60),stepHz:z.union([z.literal(120),z.literal(240),z.literal(480)]).default(120),substeps:z.number().int().min(1).max(32).default(8),
 unitsPerMeter:n.min(1).max(10000).default(100),gravity:point.default({x:0,y:-980}),
 bodies:z.array(z.object({bone:label,radius:n.positive().max(10000),position:point.optional(),rotation:n.optional(),velocity:point.default({x:0,y:0}),angularVelocity:n.default(0),density:n.positive().max(10000).default(1),linearDamping:n.min(0).max(1000).default(.1),angularDamping:n.min(0).max(1000).default(.1),spawn:n.nonnegative().default(0),...material,...filter}).strict()).min(1).max(128),
 rails:z.array(z.object({points:z.array(point).min(2).max(512),radius:n.positive().max(1000).default(.3),...material,...filter}).strict()).max(128).default([])
}).strict();
export const physicsBakeSchema=z.object({...request,plan:filename,expectedSha256:sha}).strict();

function validateBinding(data:SpineDocument,names:string[],animation?:string){
 if(new Set(names).size!==names.length)throw Error('Duplicate physical bone.');
 const skeleton=animationSampler(data,animation).sample(0),selected=new Set(names);
 for(const name of names){
  const bone=skeleton.findBone(name);if(!bone)throw Error('Unknown physical bone: '+name);
  for(let p=bone.parent;p;p=p.parent)if(selected.has(p.data.name))throw Error('Physical bodies cannot be ancestors of other physical bodies.');
  for(let p:typeof bone|null=bone;p;p=p.parent){const a=p.appliedPose,sx=Math.hypot(a.a,a.c),sy=Math.hypot(a.b,a.d);if(a.inherit!==Inherit.Normal||sx<1e-8||a.a*a.d-a.b*a.c<=0||Math.abs(sx-sy)>1e-5*Math.max(1,sx)||Math.abs(a.a*a.b+a.c*a.d)>1e-5*Math.max(1,sx*sy)||Number(a.shearX)!==0||Number(a.shearY)!==0)throw Error('Physics binding requires positive uniform unsheared inherited transforms.');}
 }
 // Constraints targeting a physical body or one of its ancestors can change
 // the written local transform again. Reject, rather than double-applying.
 for(const c of (data.constraints??[]) as any[]){if(c.type==='slider')throw Error('Slider animation is an interacting constraint; capture it explicitly before physical baking.');const affected=new Set<string>([...(c.bones??[]),c.bone,c.target].filter(v=>typeof v==='string'));for(const name of names){let b=skeleton.findBone(name);for(;b;b=b.parent)if(affected.has(b.data.name))throw Error('Physical body/ancestor participates in an interacting constraint: '+name);}}
 return skeleton;
}
async function solver(service:SpineService){
 const cfg=service.config.nativeRenderer;if(!cfg)throw Error('Install/configure the native physics package first.');
 const executable=cfg.physicsExecutable??path.join(path.dirname(cfg.workerExecutable),process.platform==='win32'?'spine-physics.exe':'spine-physics');
 const info=await stat(executable);if(!info.isFile())throw Error('Native physics executable missing.');
 const r=await promisify(execFile)(executable,['-probe'],{windowsHide:true,timeout:10000,maxBuffer:65536}),probe=JSON.parse(r.stdout);
 if(probe.protocol!=='spine-physics/1'||probe.version!=='3.1.1')throw Error('Unsupported physics protocol.');
 return{path:executable,sha256:await (await import('./file-hash.js')).fileSha256(executable),probe};
}
export async function planPhysics(service:SpineService,raw:z.input<typeof physicsPlanSchema>){
 const a=physicsPlanSchema.parse(raw);
 return operation(service,a.requestId,'physics_plan',a,async()=>{
  if(Math.abs(a.duration*a.fps-Math.round(a.duration*a.fps))>1e-6)throw Error('Duration must end on an exact output-frame boundary.');
  if(a.stepHz%a.fps||a.bodies.length*(a.duration*a.fps+1)>250000||a.rails.reduce((s,r)=>s+r.points.length-1,0)>2048)throw Error('Physics pose/segment/timestep budget exceeded.');
  const source=await captureSource(service,a.input);if(source.data.animations?.[a.newName])throw Error('New animation already exists.');
  const sk=validateBinding(source.data,a.bodies.map(b=>b.bone),a.animation),native=await solver(service);
  const bodies=a.bodies.map(b=>{if(b.spawn>=a.duration)throw Error('Spawn must precede simulation end.');const p=sk.findBone(b.bone)!.appliedPose;return{...b,id:b.bone,position:b.position??{x:p.worldX,y:p.worldY},rotation:b.rotation??Math.atan2(p.c,p.a)*180/Math.PI};});
  const scene={duration:a.duration,fps:a.fps,stepHz:a.stepHz,substeps:a.substeps,unitsPerMeter:a.unitsPerMeter,gravity:a.gravity,bodies:bodies.map(({bone,...b})=>b),rails:a.rails};
  const p=await immutableJson(service,'physics-plans',{schema:'spine-physics-plan/1',version:VERSION,source:source.source,solver:native,scene,animation:a.animation,newName:a.newName});
  return{plan:p.path,planSha256:p.sha256,bodies:bodies.map(b=>b.bone),coordinates:'Spine world, x right/y up, degrees',poseBudget:bodies.length*(a.duration*a.fps+1),sourceUnchanged:true,spawnVisibility:'Spawn affects simulation activation only; no artwork visibility keys are added.',pinnedFiles:[p]};
 });
}

export interface PhysicsResult {engine:string;version:string;bodyIds:string[];frames:{time:number;poses:{x:number;y:number;rotation:number;vx:number;vy:number;angularVelocity:number;visible:boolean}[]}[]}
export function applyPhysicsResult(data:SpineDocument,animation:string|undefined,newName:string,result:PhysicsResult){
 validateBinding(data,result.bodyIds,animation);if(data.animations?.[newName])throw Error('New animation already exists.');
 const out=structuredClone(data),clip:any=structuredClone(animation?data.animations![animation]:{});clip.bones??={};
 const sampler=animationSampler(data,animation);const tracks:any={},parentAngles=new Map<string,number>();for(const name of result.bodyIds)tracks[name]={translate:[],rotate:[]};
 let previousTime=-1;
 for(const f of result.frames){if(f.time<=previousTime||f.poses.length!==result.bodyIds.length)throw Error('Invalid physical sample timeline.');previousTime=f.time;const sk=sampler.sample(f.time);
  f.poses.forEach((p,i)=>{if(![p.x,p.y,p.rotation].every(Number.isFinite))throw Error('Non-finite physical pose.');const bone=sk.findBone(result.bodyIds[i]!)!,parent=bone.parent?.appliedPose;
   if(parent&&(parent.a*parent.d-parent.b*parent.c<=0||Math.abs(Math.hypot(parent.a,parent.c)-Math.hypot(parent.b,parent.d))>1e-5))throw Error('Animated physical parent must retain positive uniform scale.');
   const rawParentAngle=parent?Math.atan2(parent.c,parent.a)*180/Math.PI:0,previousParentAngle=parentAngles.get(bone.data.name)??rawParentAngle,parentAngle=rawParentAngle+360*Math.round((previousParentAngle-rawParentAngle)/360);parentAngles.set(bone.data.name,parentAngle);
   const local=parent?parent.worldToLocal(new Vector2(p.x,p.y)):{x:p.x,y:p.y},angle=p.rotation-parentAngle-bone.data.setupPose.rotation;
   tracks[bone.data.name].translate.push({time:f.time,x:local.x-bone.data.setupPose.x,y:local.y-bone.data.setupPose.y});tracks[bone.data.name].rotate.push({time:f.time,value:angle});
  });
 }
 for(const name of result.bodyIds)clip.bones[name]={...(clip.bones[name]??{}),...tracks[name]};out.animations??={};out.animations[newName]=clip;
 return parseDocument(out);
}
export async function bakePhysics(service:SpineService,raw:z.input<typeof physicsBakeSchema>){
 const a=physicsBakeSchema.parse(raw);return operation(service,a.requestId,'physics_bake',a,async()=>{
  const p=await pin(service,a.plan);await requireManagedFile(service,p.path,'physics-plans');if(p.sha256!==a.expectedSha256)throw Error('Physics plan changed.');
  const plan=await jsonRead(service,p.path);if(plan.schema!=='spine-physics-plan/1'||plan.version!==VERSION)throw Error('Incompatible physics plan.');await verifySource(service,plan.source);
  const native=await solver(service);if(native.path!==plan.solver.path||native.sha256!==plan.solver.sha256)throw Error('Physics solver changed; re-plan first.');
  const folder=await newFolder(service,'physics-results'),input=path.join(folder,'scene.json'),output=path.join(folder,'poses.json');await writeFile(input,JSON.stringify(plan.scene),{flag:'wx'});
  await promisify(execFile)(native.path,['-input',input,'-output',output],{windowsHide:true,timeout:90000,maxBuffer:65536});
  if((await stat(output)).size>64*1024*1024)throw Error('Physics result exceeds output budget.');const result:PhysicsResult=JSON.parse(await readFile(output,'utf8'));
  if(result.engine!=='official Box2D'||result.version!=='3.1.1'||JSON.stringify(result.bodyIds)!==JSON.stringify(plan.scene.bodies.map((b:any)=>b.id))||result.frames.length!==Math.round(plan.scene.duration*plan.scene.fps)+1)throw Error('Physics solver result identity mismatch.');
  const source=await captureSource(service,plan.source.input),data=applyPhysicsResult(source.data,plan.animation,plan.newName,result);
  // Independent runtime reconstruction must reproduce the simulated world pose.
  const sampler=animationSampler(data,plan.newName);let maxPositionError=0,maxAngleError=0;
  for(const f of result.frames){const sk=sampler.sample(f.time);f.poses.forEach((p,i)=>{const b=sk.findBone(result.bodyIds[i]!)!.appliedPose;maxPositionError=Math.max(maxPositionError,Math.hypot(b.worldX-p.x,b.worldY-p.y));const delta=Math.atan2(b.c,b.a)*180/Math.PI-p.rotation;maxAngleError=Math.max(maxAngleError,Math.abs(delta-360*Math.round(delta/360)));});}
  if(maxPositionError>1e-3||maxAngleError>1e-3)throw Error('Physical world-to-local reconstruction failed.');
  const json=(await writeDocument(service.workspace,path.join(folder,'skeleton.json'),data,path.dirname(source.jsonPath))).path;await verifySource(service,plan.source);
  return writeCandidate(service,'physics_bake',json,plan.source,{plan:p.path,newName:plan.newName,poses:output,maxPositionError,maxAngleError,engine:result.engine,physicsVersion:result.version,samples:result.frames.length,visualAcceptance:'pending'},true,[input,output]);
 });
}

export const viewAuditSchema=z.object({input:filename,animation:label,times:z.array(n.min(0).max(120)).min(1).max(600),pairs:z.array(z.object({source:label,view:label,scale:n.positive(),offset:point}).strict()).min(1).max(64),positionTolerance:n.nonnegative().default(.01),angleTolerance:n.nonnegative().default(.01)}).strict();
export async function auditViews(service:SpineService,raw:z.input<typeof viewAuditSchema>){const a=viewAuditSchema.parse(raw),s=await captureSource(service,a.input),sample=animationSampler(s.data,a.animation);let maxPositionError=0,maxAngleError=0,maxScaleError=0;for(const t of a.times){const sk=sample.sample(t);for(const pair of a.pairs){const p=sk.findBone(pair.source)?.appliedPose,q=sk.findBone(pair.view)?.appliedPose;if(!p||!q)throw Error('Missing view bone.');maxPositionError=Math.max(maxPositionError,Math.hypot(q.worldX-p.worldX*pair.scale-pair.offset.x,q.worldY-p.worldY*pair.scale-pair.offset.y));const delta=(Math.atan2(q.c,q.a)-Math.atan2(p.c,p.a))*180/Math.PI;maxAngleError=Math.max(maxAngleError,Math.abs(delta-360*Math.round(delta/360)));maxScaleError=Math.max(maxScaleError,Math.abs(Math.hypot(q.a,q.c)-Math.hypot(p.a,p.c)*pair.scale),Math.abs(Math.hypot(q.b,q.d)-Math.hypot(p.b,p.d)*pair.scale));}}await verifySource(service,s.source);return{passed:maxPositionError<=a.positionTolerance&&maxAngleError<=a.angleTolerance&&maxScaleError<=a.positionTolerance,maxPositionError,maxAngleError,maxScaleError,checkedPoses:a.times.length*a.pairs.length,scope:'Explicit uniform affine view-pose comparison, not a comparison of encoded pixels.'};}

export const contactAuditSchema=z.object({candidate:filename,expectedSha256:sha,supports:z.array(z.object({body:label,start:n.nonnegative(),end:n.positive(),points:z.array(point).min(2).max(512),railRadius:n.nonnegative().default(.3),minGap:n.default(-.5),maxGap:n.nonnegative().default(1.5)}).strict()).min(1).max(64)}).strict();
export async function auditPhysicsContacts(service:SpineService,raw:z.input<typeof contactAuditSchema>){const a=contactAuditSchema.parse(raw),{readCandidate}=await import('./character-candidates.js'),candidate=await readCandidate(service,{candidate:a.candidate,expectedSha256:a.expectedSha256});if(candidate.kind!=='physics_bake')throw Error('A physical bake candidate is required.');const plan=await jsonRead(service,candidate.details.plan),result:PhysicsResult=await jsonRead(service,candidate.details.poses,64*1024*1024),findings:any[]=[];let checked=0,maxGap=-Infinity,minGap=Infinity;for(const support of a.supports){const i=result.bodyIds.indexOf(support.body);if(i<0||support.end<support.start||support.end>plan.scene.duration)throw Error('Invalid support interval/body.');const radius=plan.scene.bodies[i].radius;let localCount=0;for(const f of result.frames){if(f.time<support.start||f.time>support.end||!f.poses[i]!.visible)continue;const p=f.poses[i]!;let distance=Infinity;for(let k=1;k<support.points.length;k++){const u=support.points[k-1]!,v=support.points[k]!,dx=v.x-u.x,dy=v.y-u.y,l=dx*dx+dy*dy;if(l<1e-12)throw Error('Degenerate support segment.');const t=Math.max(0,Math.min(1,((p.x-u.x)*dx+(p.y-u.y)*dy)/l));distance=Math.min(distance,Math.hypot(p.x-u.x-t*dx,p.y-u.y-t*dy));}const gap=distance-radius-support.railRadius;maxGap=Math.max(maxGap,gap);minGap=Math.min(minGap,gap);checked++;localCount++;if((gap<support.minGap||gap>support.maxGap)&&findings.length<100)findings.push({body:support.body,time:f.time,gap});}if(!localCount)throw Error('Support interval contains no active samples.');}return{passed:findings.length===0,checked,minGap,maxGap,findings,scope:'Explicit sampled sphere-to-polyline distance; not fluid simulation or automatic image-edge detection.'};}
