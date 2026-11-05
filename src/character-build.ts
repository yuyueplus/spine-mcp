import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { VERSION } from './version.js';
import { constructionSchema, constructionSource, previewConstruction } from './character-construction.js';
import { mediaOptionsSchema } from './job-schema.js';
import { promoteCandidateSchema } from './character-candidates.js';
import { animationSampler } from './animation-sampler.js';
import { label, filename, request, sha, digest, pin, verifyPins, verifySource, jsonRead, immutableJson, operation } from './character-candidates.js';
export const planCharacterBuildSchema=z.object({input:filename,name:label,construction:z.object(constructionSchema.shape).omit({landmarkConfirmation:true,expectedDataSha256:true}),reviewMedia:z.array(mediaOptionsSchema).max(8).default([]),publication:promoteCandidateSchema.omit({requestId:true,candidate:true,expectedSha256:true,confirmation:true,note:true}).default({native:true,openInEditor:false}),waitForPreview:z.boolean().default(true)}).strict();
export const createCharacterBuildTaskSchema=z.object({...request,plan:filename,expectedSha256:sha,landmarkConfirmation:z.literal('use_reviewed_landmarks')}).strict();
export async function planCharacterBuild(service:SpineService,raw:z.input<typeof planCharacterBuildSchema>){
  const args=planCharacterBuildSchema.parse(raw),construction=constructionSchema.parse({...args.construction,landmarkConfirmation:'use_reviewed_landmarks'}),source=await constructionSource(service,args.input,construction);
  if(construction.psd&&args.publication.session)throw Error('A new PSD character has no existing source session. Publish it independently, then create a session for its saved project.');
  const preview=await previewConstruction(service,source.data,construction),pins=[await pin(service,source.jsonPath),...preview.pins];
  const reviewMedia=args.reviewMedia.length?args.reviewMedia:preview.animations.slice(0,4).map(animation=>({animation,skin:'suggestedSkin'in source?source.suggestedSkin:undefined,end:Math.min(2,animationSampler(preview.data,animation).duration),fps:6,width:256,height:320,formats:['apng']}));
  const taskArgs={...args,reviewMedia,construction:{...construction,expectedDataSha256:preview.dataSha256}};
  const report={schema:'spine-character-build/1',version:VERSION,checksPassed:true,args:taskArgs,source:source.source,pins,joints:preview.joints,createdTargets:preview.createdTargets,animations:preview.animations,dataSha256:preview.dataSha256,landmarkReviewRequired:true,finalCandidateReviewRequired:true,sourceUnchanged:true,note:'Review explicit world joints and blueprint. Preparation/controls can affect existing clips in the NEW candidate. No anatomy inference or source modification. PSD generation stays outside MCP.'};
  await verifySource(service,source.source);await verifyPins(service,pins);const p=await immutableJson(service,'character-build-plans',report);return{...report,plan:p.path,planSha256:p.sha256};
}
export async function createCharacterBuildTask(service:SpineService,raw:z.input<typeof createCharacterBuildTaskSchema>){
  const args=createCharacterBuildTaskSchema.parse(raw);
  return operation(service,args.requestId,'create_character_build_task',args,async()=>{
    const p=await pin(service,args.plan);if(p.sha256!==args.expectedSha256)throw Error('Character build plan changed.');const plan=await jsonRead(service,p.path);
    if(plan.schema!=='spine-character-build/1'||plan.version!==VERSION||!plan.checksPassed)throw Error('Invalid/incompatible character build plan.');await verifySource(service,plan.source);await verifyPins(service,plan.pins);
    // The outer operation and task use distinct request IDs so retry locks never nest on one receipt.
    const {createCharacterTask}=await import('./character-task.js');
    const hex=digest({kind:'character-build-task',requestId:args.requestId}),taskId=hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);const task=await createCharacterTask(service,{...plan.args,requestId:taskId,construction:{...plan.args.construction,landmarkConfirmation:args.landmarkConfirmation}});
    return{...task,buildPlan:p.path,reviewedWorldJoints:plan.joints,newCandidateReviewRequired:true,pinnedFiles:[p,...task.pinnedFiles]};
  });
}
