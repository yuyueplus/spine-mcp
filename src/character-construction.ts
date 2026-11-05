import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { VERSION } from './version.js';
import { characterSchema, poseAnimationSchema, footBakeSchema } from './stability-schema.js';
import { applyTemplateSchema, characterTemplateFileSchema, resolveTemplate } from './character-template.js';
import { prepareCharacterData, buildPoseData } from './character-workflow.js';
import { bakeFootContactData } from './foot-contacts.js';
import { animationSampler } from './animation-sampler.js';
import { addBone, parseDocument, type SpineDocument } from './document.js';
import { setConstraint } from './constraint-edits.js';
import { constraintList } from './constraint-data.js';
import { filename, sha, label, digest, jsonRead, pin, verifyPins, captureSource, type Pin } from './character-candidates.js';
const finite=z.number().finite();
export const constructionSchema=z.object({
  psd:z.object({plan:filename,expectedSha256:sha}).strict().optional(),
  landmarkConfirmation:z.literal('use_reviewed_landmarks'),
  preparation:z.object({bones:z.array(characterSchema.shape.bones.element).max(200).default([]),bindings:z.array(characterSchema.shape.bindings.element).max(100).default([])}).strict().default({bones:[],bindings:[]}),
  controls:z.array(z.object({name:label,bones:z.tuple([label,label]),target:label,createTargetParent:label.optional(),bendPositive:z.boolean().optional(),mix:finite.min(0).max(1).default(1),softness:finite.min(0).max(10000).default(0)}).strict()).max(16).default([]),
  motions:z.array(poseAnimationSchema.omit({input:true,output:true})).max(8).default([]),
  templates:z.array(applyTemplateSchema.omit({input:true,output:true})).max(8).default([]),
  expectedDataSha256:sha.optional(),
}).strict().refine(a=>a.motions.length+a.templates.length>0,'Construction requires at least one motion or saved template.');
export type Construction=z.output<typeof constructionSchema>;
export const constructionDigest=(data:SpineDocument)=>digest({...data,skeleton:{spine:data.skeleton.spine,fps:data.skeleton.fps}});
export async function constructionSource(service:SpineService,input:string,config?:Construction){
  if(!config?.psd)return captureSource(service,input);
  const p=await pin(service,config.psd.plan);if(p.sha256!==config.psd.expectedSha256)throw Error('PSD construction plan changed.');const plan=await jsonRead(service,p.path);
  if(plan.schema!=='spine-psd-import-plan/1'||plan.version!==VERSION||!plan.checksPassed)throw Error('Construction needs a passing current-build PSD plan.');
  if(await service.workspace.resolve(input)!==await service.workspace.resolve(plan.source.path))throw Error('PSD plan belongs to another source.');await verifyPins(service,[plan.source]);
  return{source:{input:plan.source.path,sha256:plan.source.sha256,files:[]as Pin[]},jsonPath:p.path,data:parseDocument(plan.data),suggestedSkin:plan.suggestedSkin};
}
export function constructControls(source:SpineDocument,controls:Construction['controls']){
  let data=structuredClone(source);const createdTargets:string[]=[];
  for(const c of controls){const [upper,lower]=c.bones;if(data.bones.find(b=>b.name===lower)?.parent!==upper)throw Error('Construction IK requires a direct upper/lower chain.');
    const ancestors=new Set<string>();let parent=data.bones.find(b=>b.name===c.target)?.parent??c.createTargetParent;if(c.bones.includes(c.target))throw Error('IK target must be independent from its chain.');while(parent){ancestors.add(parent);parent=data.bones.find(b=>b.name===parent)?.parent;}if(c.bones.some(b=>ancestors.has(b)))throw Error('IK target must be independent from its chain.');if(constraintList(data).some(other=>other.name!==c.name&&[other.bone,...(Array.isArray(other.bones)?other.bones:[])].some(b=>typeof b==='string'&&ancestors.has(b))))throw Error('IK target ancestors are constrained; choose an independent controller parent.');
    const sampler=animationSampler(data),s=sampler.sample(0),u=s.bones.find(b=>b.data.name===upper),l=s.bones.find(b=>b.data.name===lower);if(!u||!l||l.data.length<=0)throw Error('IK construction needs positive bone lengths.');
    const tip=l.appliedPose.localToWorld({x:l.data.length,y:0}as any),cross=(l.appliedPose.worldX-u.appliedPose.worldX)*(tip.y-l.appliedPose.worldY)-(l.appliedPose.worldY-u.appliedPose.worldY)*(tip.x-l.appliedPose.worldX);
    if(!data.bones.some(b=>b.name===c.target)){if(!c.createTargetParent)throw Error('Missing IK target: provide createTargetParent or an existing target.');const parent=s.bones.find(b=>b.data.name===c.createTargetParent);if(!parent)throw Error('IK target parent not found.');const p=parent.appliedPose.worldToLocal({...tip}as any);if(![p.x,p.y].every(Number.isFinite))throw Error('IK target parent is singular.');data=addBone(data,c.target,c.createTargetParent,{x:p.x,y:p.y});createdTargets.push(c.target);}
    data=setConstraint(data,{type:'ik',name:c.name,bones:c.bones,target:c.target,bendPositive:c.bendPositive??cross>=0,mix:c.mix,softness:c.softness});
  }
  animationSampler(data).sample(0);return{data,createdTargets};
}
export async function constructMotions(service:SpineService,source:SpineDocument,config:Construction){
  let data=structuredClone(source);const pins:Pin[]=[],applications:any[]=[];
  for(const motion of config.motions)data=buildPoseData(data,poseAnimationSchema.parse({...motion,input:'construction',output:'construction'}));
  for(const raw of config.templates){const p=await pin(service,raw.template),template=characterTemplateFileSchema.parse(await jsonRead(service,p.path,8*1024**2)),args=applyTemplateSchema.parse({...raw,input:'construction',output:'construction'}),mapped=resolveTemplate(template,data,args),name=args.bakeContacts?'__construction_'+randomUUID().replaceAll('-',''):args.animation;
    data=buildPoseData(data,poseAnimationSchema.parse({...mapped.recipe,input:'construction',output:'construction',name}));let contactVerification;
    if(args.bakeContacts){if(!mapped.contacts?.length)throw Error('Selected template has no contacts.');const baked=bakeFootContactData(data,footBakeSchema.parse({input:'construction',output:'construction',animation:name,newName:args.animation,fps:mapped.recipe.fps,skin:args.skin,chains:mapped.contacts,constraintMode:args.constraintMode,physics:args.physics}));data=baked.data;contactVerification=baked.diagnostics;delete data.animations![name];}
    pins.push(p);applications.push({template:p,animation:args.animation,mapping:mapped.mapping,...(contactVerification?{contactVerification}:{})});
  }
  await verifyPins(service,pins);return{data:parseDocument(data),pins,applications};
}
export async function previewConstruction(service:SpineService,source:SpineDocument,config:Construction){
  const prepared=prepareCharacterData(source,{...config.preparation,input:'construction',output:'construction'}),controls=constructControls(prepared,config.controls),motions=await constructMotions(service,controls.data,config),s=animationSampler(controls.data).sample(0);
  return{data:motions.data,dataSha256:constructionDigest(motions.data),pins:motions.pins,createdTargets:controls.createdTargets,joints:s.bones.map(b=>({name:b.data.name,parent:b.parent?.data.name??null,x:b.appliedPose.worldX,y:b.appliedPose.worldY})),animations:[...config.motions.map(m=>m.name),...config.templates.map(t=>t.animation)],applications:motions.applications};
}
