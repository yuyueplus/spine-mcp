import { z } from 'zod/v4';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { parseDocument, type SpineDocument, type JsonObject } from './document.js';
import { documentSkins } from './slot-data.js';
import { attachmentEntries, sourceMesh } from './attachment-data.js';
import { constraintList } from './constraint-data.js';
import { animationSampler } from './animation-sampler.js';
import { isolatedAnimation, matrix, prepareBoneChannels, solveWorldKeys, skeletonState, stateDifference } from './animation-baking.js';
import { label,digest } from './character-candidates.js';
import type { JointMeshRepairArgs } from './joint-mesh-repair.js';

export const jointCompatibilitySchema=z.object({
 linkedMeshes:z.enum(['reject','isolated_skin']).default('reject'),
 outputSkin:label.optional(),physics:z.enum(['reject','sampled_capture']).default('reject'),
 physicsFps:z.number().int().refine(n=>n===60||n===120,'Physics integration uses 60 or 120 FPS.').default(120),
 poseTolerance:z.number().finite().min(.00001).max(.05).default(.001),
}).strict();

function materializeSkin(source:SpineDocument,skin:string,name:string,clip:JsonObject,targets:JointMeshRepairArgs['targets']){
 const skins=documentSkins(source),selected=skins.find(s=>s.name===skin);if(!selected)throw Error('Selected source skin does not exist.');if(skins.some(s=>s.name===name))throw Error('Compatibility outputSkin must be a NEW skin.');
 const effective=new Map<string,ReturnType<typeof attachmentEntries>[number]>();
 for(const e of attachmentEntries(source).filter(e=>e.skin===skin&&skin!=='default'||e.skin==='default'&&targets.some(t=>t.slot===e.slot&&t.attachment===e.name)))effective.set(e.slot+'\0'+e.name,e);
 const runtime=animationSampler(source,undefined,skin).skeleton.data,origins=new Map<object,{skin:string;slot:string;name:string}>();
 for(const e of attachmentEntries(source)){const slot=runtime.slots.findIndex(s=>s.name===e.slot),a=runtime.findSkin(e.skin)?.getAttachment(slot,e.name);if(a)origins.set(a,{skin:e.skin,slot:e.slot,name:e.name});}
 const attachments:Record<string,Record<string,JsonObject>>={},remaps:any[]=[];
 for(const e of effective.values()){
  let value=structuredClone(e.value);if(value.source!==undefined){const geometry=sourceMesh(source,e.skin,e.slot,e.name);value={...structuredClone(geometry),...value};for(const key of ['source','skin','slot','timelines','parent'])delete value[key];value.type='mesh';value.path=e.value.path??e.value.name??e.name;if(e.value.name===undefined)delete value.name;remaps.push({slot:e.slot,attachment:e.name,originalSkin:e.skin,originalSource:e.value.source,originalSourceSkin:e.value.skin??'default'});}
  (attachments[e.slot]??={})[e.name]=value;
  const slotIndex=runtime.slots.findIndex(s=>s.name===e.slot),a=runtime.findSkin(e.skin)?.getAttachment(slotIndex,e.name),origin=a instanceof MeshAttachment?origins.get(a.timelineAttachment??a):undefined;
  const own:any=(clip.attachments as any)?.[e.skin]?.[e.slot]?.[e.name],inherited:any=origin?(clip.attachments as any)?.[origin.skin]?.[origin.slot]?.[origin.name]:undefined;
  const channels={...structuredClone(own??{}),...(inherited?.deform?{deform:structuredClone(inherited.deform)}:{})};
  if(Object.keys(channels).length){const all:any=clip.attachments??={};all[name]??={};all[name][e.slot]??={};all[name][e.slot][e.name]=channels;}
 }
 const clone:any={...structuredClone(selected),name,attachments};
 return{skin:clone,remaps,defaultPlaceholders:[...effective.values()].filter(e=>e.skin==='default').map(e=>({slot:e.slot,attachment:e.name})),independentMeshes:Object.values(attachments).flatMap(v=>Object.values(v)).filter(v=>v.type==='mesh').length};
}

export function prepareJointMeshCompatibility(source:SpineDocument,args:JointMeshRepairArgs){
 const options=args.compatibility,physics=constraintList(source).some(c=>c.type==='physics'),entries=attachmentEntries(source),linked=args.targets.some(t=>{const e=entries.find(e=>e.skin===args.skin&&e.slot===t.slot&&e.name===t.attachment);return e?.value.source!==undefined||entries.some(e=>e.value.source===t.attachment&&(e.value.skin??'default')===args.skin&&(e.value.slot??e.slot)===t.slot);});
 if(physics&&options.physics!=='sampled_capture')throw Error('Joint mesh repair requires compatibility.physics=sampled_capture for physics constraints.');
 if(linked&&options.linkedMeshes!=='isolated_skin')throw Error('Linked targets/dependents require compatibility.linkedMeshes=isolated_skin and a NEW outputSkin.');
 if(options.linkedMeshes==='isolated_skin'&&!options.outputSkin)throw Error('Isolated linked-mesh repair requires a NEW outputSkin.');
 if(options.outputSkin&&options.linkedMeshes!=='isolated_skin')throw Error('outputSkin is only used with explicit isolated_skin mode.');
 if(physics&&(args.fps>60||options.physicsFps<args.fps*2))throw Error('Physics capture requires repair FPS 30/60 and integration FPS at least twice repair FPS.');
 if(!linked&&options.linkedMeshes==='reject'&&!physics)return{data:source,skin:args.skin,targets:args.targets,animation:args.animation,temporaryAnimation:undefined,report:{used:false,linkedTargets:false,physicsCaptured:false,originalSkin:args.skin,outputSkin:args.skin,maxPoseError:0,originalDefinitionsPreserved:true}};
 const temporaryAnimation=args.newName+'__capture_source';if(source.animations?.[temporaryAnimation])throw Error('Compatibility capture animation name already exists.');
 for(const t of args.targets){const keys:any=(source.animations?.[args.animation]?.slots as any)?.[t.slot]?.attachment;if(Array.isArray(keys)&&keys.some(k=>k.name!==t.attachment))throw Error('Compatibility repair cannot replace a source target that switches or becomes hidden: '+t.id);}
 const data=structuredClone(source),original=source.animations?.[args.animation];if(!original)throw Error('Source animation missing.');const clip=structuredClone(original);data.animations![temporaryAnimation]=clip;let skin=args.skin,materialized:ReturnType<typeof materializeSkin>|undefined;
 if(options.linkedMeshes==='isolated_skin'){materialized=materializeSkin(source,args.skin,options.outputSkin!,clip,args.targets);(data.skins as JsonObject[]).push(materialized.skin);skin=options.outputSkin!;}
 const fps=physics?options.physicsFps:args.fps*2,duration=animationSampler(source,args.animation,args.skin).duration,count=Math.ceil(duration*fps),times=Array.from({length:count+1},(_,i)=>Math.min(i/fps,duration));
 if(duration<=0||duration>30||times.length>3601)throw Error('Compatibility capture requires a clip of 0–30 seconds and at most 3601 samples.');
 const baseline=animationSampler(source,args.animation,args.skin,{physics,fps:Math.min(120,fps)}),prepared=animationSampler(data,temporaryAnimation,skin,{physics,fps:Math.min(120,fps)});let maxIsolationError=0,coordinates=0;
 for(const time of times){const pose=baseline.sample(time);for(const t of args.targets){const e=entries.find(e=>e.skin===args.skin&&e.slot===t.slot&&e.name===t.attachment)??entries.find(e=>e.skin==='default'&&e.slot===t.slot&&e.name===t.attachment),slot=pose.findSlot(t.slot);if(!e||!slot?.bone.active||!(slot.appliedPose.attachment instanceof MeshAttachment)||slot.appliedPose.attachment.name!==String(e.value.name??e.name))throw Error('Source target must remain active throughout compatibility capture: '+t.id);}const a=skeletonState(pose),b=skeletonState(prepared.sample(time));coordinates+=a.values.length;if(coordinates>5000000)throw Error('Compatibility pose verification exceeds five million coordinates.');const error=stateDifference(a,b);if(error>options.poseTolerance)throw Error('Isolated skin changes the original pose at '+time+'s ('+error+').');maxIsolationError=Math.max(maxIsolationError,error);}
 let output=data,maxCaptureError=0,boneSamples=0;
 if(physics){
  output=isolatedAnimation(data,args.newName+'__physics_bake',clip);const outputName=args.newName+'__physics_bake',baked=output.animations![outputName]!,sourceSampler=animationSampler(data,temporaryAnimation,skin,{physics:true,fps}),driver=animationSampler(output,outputName,skin),active=sourceSampler.sample(0).bones.filter(b=>b.active).map(b=>b.data.name);prepareBoneChannels(baked,active);boneSamples=times.length*active.length;
  if(boneSamples>100000)throw Error('Physics capture exceeds 100,000 active bone samples.');const samples:{time:number;state:ReturnType<typeof skeletonState>}[]=[];
  for(const time of times){const pose=sourceSampler.sample(time),desired=new Map(pose.bones.filter(b=>b.active).map(b=>[b.data.name,matrix(b.appliedPose)]));solveWorldKeys(baked,driver.sample(time),desired,Math.fround(time));samples.push({time,state:skeletonState(pose)});}
  const verified=animationSampler(output,outputName,skin);for(const sample of samples){const error=stateDifference(sample.state,skeletonState(verified.sample(sample.time)));if(error>options.poseTolerance)throw Error('Sampled physics capture changes pose at '+sample.time+'s ('+error+').');maxCaptureError=Math.max(maxCaptureError,error);}
  output.animations![temporaryAnimation]=baked;delete output.animations![outputName];output.skeleton.fps=Math.max(Number(output.skeleton.fps??30),240);
 }
 const actualNameRemaps:any[]=[],placeholderRemaps:any[]=[];let resolvedTargets=args.targets;
 if(materialized){
  const existing=new Set(attachmentEntries(source).map(e=>String(e.value.name??e.name)));
  for(const e of attachmentEntries(output).filter(e=>e.skin===skin)){
   const previous=String(e.value.name??e.name),actual='mcp-'+digest({skin,slot:e.slot,attachment:e.name}).slice(0,16)+'-'+e.name.split('/').at(-1)!.slice(0,60);if(existing.has(actual))throw Error('Isolated attachment name collides with existing data.');existing.add(actual);
   if((e.value.type??'region')==='region'||e.value.type==='mesh')e.value.path=e.value.path||previous;e.value.name=actual;actualNameRemaps.push({slot:e.slot,placeholder:e.name,previous,actual,imagePath:e.value.path});
  }
  const skinObject=documentSkins(output).find(s=>s.name===skin)!,outClip:any=output.animations![temporaryAnimation];
  for(const entry of materialized.defaultPlaceholders){const key='mcp-'+digest({skin,slot:entry.slot,attachment:entry.attachment,placeholder:true}).slice(0,20),slotAttachments:any=(skinObject.attachments as any)[entry.slot];if(slotAttachments[key])throw Error('Compatibility placeholder collision.');slotAttachments[key]=slotAttachments[entry.attachment];delete slotAttachments[entry.attachment];const tracks=outClip.attachments?.[skin]?.[entry.slot];if(tracks?.[entry.attachment]){tracks[key]=tracks[entry.attachment];delete tracks[entry.attachment];}outClip.slots??={};outClip.slots[entry.slot]??={};outClip.slots[entry.slot].attachment=[{time:0,name:key}];placeholderRemaps.push({...entry,placeholder:key});}
  resolvedTargets=args.targets.map(t=>{const r=placeholderRemaps.find(r=>r.slot===t.slot&&r.attachment===t.attachment);return r?{...t,attachment:r.placeholder}:t;});
 }
 parseDocument(output);return{data:output,skin,targets:resolvedTargets,animation:temporaryAnimation,temporaryAnimation,report:{used:true,linkedTargets:linked,linkedMode:options.linkedMeshes,materializedLinks:materialized?.remaps??[],actualNameRemaps,placeholderRemaps,independentMeshes:materialized?.independentMeshes??0,physicsCaptured:physics,physicsMode:physics?'deterministic_runtime_sampled_capture':'not_needed',integrationFps:physics?fps:null,captureSamples:times.length,boneSamples,originalSkin:args.skin,outputSkin:skin,maxPoseError:Math.max(maxIsolationError,maxCaptureError),maxIsolationError,maxCaptureError,poseTolerance:options.poseTolerance,originalDefinitionsPreserved:true,scope:'A new skin is scoped to the repaired clip; all original skins, clips and constraint definitions remain unchanged. Captured physics is finite sampled runtime motion, not a native editor bake or live simulation.'}};
}
