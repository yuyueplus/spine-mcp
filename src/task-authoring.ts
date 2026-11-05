import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { atomicJson } from './jobs.js';
import { VERSION } from './version.js';
import { rigLandmarkSchema, correctRigLandmarkSchema, planRigLandmarks, correctRigLandmarks } from './rig-landmarks.js';
import { planPsdRasterSchema, planPsdRasterization, applyPsdRasterization, validateRasterSource } from './psd-rasterization.js';
import { constructionSchema } from './character-construction.js';
import { meshDeformRepairSchema } from './mesh-deform-repair.js';
import { jointMeshRepairSchema } from './joint-mesh-repair.js';
import { request, sha, label, pin, verifyPins, verifySource, jsonRead, operation, type Pin } from './character-candidates.js';

export const authoringLandmarkSchema=rigLandmarkSchema.omit({input:true,psd:true,name:true,reviewMedia:true,publication:true,waitForPreview:true});
export const taskAuthoringSchema=z.object({raster:planPsdRasterSchema.omit({input:true,name:true}),landmarks:authoringLandmarkSchema}).strict();
export const taskMeshRepairSchema=z.union([
 meshDeformRepairSchema.omit({requestId:true,input:true}).extend({mode:z.literal('single')}),
 jointMeshRepairSchema.omit({requestId:true,input:true}).extend({mode:z.literal('joint')}),
]);
export const reviewTaskStageSchema=z.object({...request,id:z.string().uuid(),expectedPlanSha256:sha,stage:z.enum(['raster','landmarks']),expectedArtifactSha256:sha,confirmation:z.literal('use_reviewed_stage'),decision:z.enum(['accepted','rejected','revise']),expectedLandmarkPlanSha256:sha.optional(),note:z.string().min(5).max(4000),landmarkPatch:correctRigLandmarkSchema.shape.patch.optional()}).strict().refine(a=>!a.landmarkPatch||a.stage==='landmarks'&&a.decision==='revise','Use decision=revise to create a corrected landmark proposal.').refine(a=>a.decision!=='revise'||a.stage==='landmarks'&&!!a.landmarkPatch,'A revision requires a landmark patch.').refine(a=>a.stage!=='landmarks'||!!a.expectedLandmarkPlanSha256,'Landmark review requires the exact currently displayed plan SHA.');
export async function rawAuthoringSource(service:SpineService,input:string){const p=await pin(service,input);if((await stat(p.path)).size>32*1024**2)throw Error('Authoring PSD exceeds 32 MiB.');validateRasterSource(await readFile(p.path));return{source:{input:p.path,sha256:p.sha256,files:[]as Pin[]},jsonPath:p.path};}
export async function validateStageReviews(service:SpineService,state:any){for(const review of Object.values(state.stageReviews??{})as any[])await verifyPins(service,[review.result,...(review.pins??[])]);}
export async function getTaskStageGate(service:SpineService,state:any){
 if(!['awaiting_stage_review','stage_rejected'].includes(state.phase)||!['raster','landmarks'].includes(state.currentStep))return;
 const stage=state.currentStep,step=state.steps[stage];if(!step?.completed||!step.result)throw Error('Stage review lacks a frozen result.');let r=await jsonRead(service,step.result.path);if(stage==='landmarks'&&state.stageReviews?.landmarks?.result){const review=await jsonRead(service,state.stageReviews.landmarks.result.path);r=review.landmarks??r;}const paths=stage==='raster'?[r.reference,r.rendered]:[r.files?.annotated],pins=(r.pinnedFiles??r.pins??[])as Pin[],displayArtifacts=paths.filter(Boolean).map((f:string)=>pins.find(p=>p.path===f)).filter(Boolean);
 return{stage,expectedArtifactSha256:step.result.sha256,plan:r.plan,planSha256:r.planSha256,expectedLandmarkPlanSha256:stage==='landmarks'?r.planSha256:undefined,camera:r.camera,blueprint:r.blueprint,files:r.files,blockers:r.blockers,semanticPolicy:r.semanticPolicy,semanticLoss:r.backend?.semanticLoss,displayArtifacts,confirmation:'use_reviewed_stage',reviewTool:'spine_review_character_task_stage',note:'Select this exact stage artifact SHA. Landmark coordinates can be corrected before acceptance. Final candidate review is separate.'};
}
export async function runTaskAuthoring(service:SpineService,config:any,plan:any,state:any,directory:string,stage:(name:string,action:(requestId:string)=>Promise<any>)=>Promise<any>,save:()=>Promise<void>){
 if(!config.authoring)return;
 const raster=await stage('raster',requestId=>operation(service,requestId,'task_raster_proof',{input:config.input,...config.authoring.raster,name:config.name},async()=>{const r=await planPsdRasterization(service,{input:config.input,...config.authoring.raster,name:config.name});if(!r.checksPassed)throw Error('Rasterization proof failed: '+JSON.stringify(r.blockers));return{...r,pinnedFiles:[await pin(service,r.plan),...r.pins]};}));
 const gate=async(name:string)=>{const review=state.stageReviews?.[name];if(review?.decision==='accepted'&&review.artifactSha256===state.steps[name].result.sha256){review.consumed=true;await save();return true;}state.currentStep=name;state.phase=review?.decision==='rejected'?'stage_rejected':'awaiting_stage_review';await save();return false;};
 if(!await gate('raster'))return{paused:true};
 const imported=await stage('raster_import',requestId=>applyPsdRasterization(service,{requestId,plan:raster.plan,expectedSha256:raster.planSha256,confirmation:'use_rasterized_layers'}));
 const landmarks=await stage('landmarks',requestId=>operation(service,requestId,'task_landmark_proposal',{input:imported.json,args:config.authoring.landmarks},async()=>{const r=await planRigLandmarks(service,{...config.authoring.landmarks,input:imported.json,name:config.name,reviewMedia:[],publication:{native:false},waitForPreview:false});return{...r,pinnedFiles:[await pin(service,r.plan),...r.pins]};}));
 if(!await gate('landmarks'))return{paused:true};
 const approved=await jsonRead(service,state.stageReviews.landmarks.result.path),effective=approved.landmarks??landmarks;
 if(!effective.blueprint)throw Error('Accepted landmark review has no construction blueprint.');const b=await pin(service,effective.blueprint.plan);if(b.sha256!==effective.blueprint.planSha256)throw Error('Reviewed construction blueprint changed.');const blueprint=await jsonRead(service,b.path);if(blueprint.schema!=='spine-character-build/1'||blueprint.version!==VERSION||!blueprint.checksPassed||blueprint.source.input!==imported.json)throw Error('Authoring requires a current blueprint for its exact imported JSON.');await verifySource(service,blueprint.source);await verifyPins(service,blueprint.pins);const construction=constructionSchema.parse(blueprint.args.construction);if(construction.psd)throw Error('Authoring blueprint must use the reviewed imported JSON.');return{paused:false,current:imported.json,construction};
}
export async function reviewAuthoringStage(service:SpineService,raw:z.input<typeof reviewTaskStageSchema>,load:(a:any)=>Promise<any>,acquire:(directory:string)=>Promise<()=>Promise<void>>,validate:(f:any)=>Promise<void>,save:(f:any)=>Promise<void>){
 const args=reviewTaskStageSchema.parse(raw);return operation(service,args.requestId,'review_character_task_stage',args,async()=>{const f=await load(args),release=await acquire(f.directory);try{
  await validate(f);if(!f.plan.args.authoring)throw Error('This task has no intermediate authoring reviews.');const step=f.state.steps[args.stage];if(!step?.completed||!step.result||step.result.sha256!==args.expectedArtifactSha256)throw Error('Stage review must select the exact completed stage artifact SHA.');
  if(['prepare','controls','motion','compose','plan','replace','repair','ik','contact','mesh','media','candidate','promote','preview'].some(n=>f.state.steps[n]?.completed)||args.stage==='raster'&&(f.state.stageReviews?.raster?.consumed||f.state.steps.raster_import.completed&&!f.state.steps.raster_import.inheritedFrom))throw Error('This stage was already consumed. Create a branch to change its review.');
  const result=await jsonRead(service,step.result.path);let landmarks:any;
  if(args.stage==='landmarks'){
   if(f.state.stageReviews?.raster?.decision!=='accepted')throw Error('Accept the raster proof before landmark review.');
   const oldReview=f.state.stageReviews?.landmarks?.result?await jsonRead(service,f.state.stageReviews.landmarks.result.path):undefined,base=oldReview?.landmarks??result;if(args.expectedLandmarkPlanSha256!==base.planSha256)throw Error('Landmark plan changed after it was displayed. Review the current plan SHA.');
   landmarks=args.landmarkPatch?await correctRigLandmarks(service,{plan:base.plan,expectedSha256:base.planSha256,patch:args.landmarkPatch}):base;
   if(args.decision==='accepted'&&!landmarks.blueprint)throw Error('Supply a complete landmark/binding/motion patch before accepting this draft.');
  }else if(!result.checksPassed)throw Error('Cannot accept a failed raster proof.');
  const file=path.join(f.directory,args.stage+'-review-'+args.requestId+'.json'),pins:Pin[]=[await pin(service,f.plan.source.input),step.result,...(step.pins??[]),...(landmarks?.pins??[]),...(landmarks?.plan?[await pin(service,landmarks.plan)]:[])];
  await atomicJson(file,{schema:'spine-character-task-stage-review/1',version:VERSION,stage:args.stage,artifactSha256:args.expectedArtifactSha256,decision:args.decision,note:args.note,landmarks,selection:'explicit_caller_reported',authenticatedHumanReview:false});
  f.state.stageReviews??={};f.state.stageReviews[args.stage]={requestId:args.requestId,artifactSha256:args.expectedArtifactSha256,decision:args.decision,result:await pin(service,file),pins};f.state.phase=args.decision==='accepted'?'ready':args.decision==='revise'?'awaiting_stage_review':'stage_rejected';f.state.currentStep=args.stage;
  for(const name of ['prepare','controls','motion','compose','plan','replace','repair','ik','contact','mesh','media','candidate','promote','preview'])if(!f.state.steps[name]?.completed)f.state.steps[name]={requestId:randomUUID()};
  await save(f);return{id:args.id,stage:args.stage,phase:f.state.phase,selection:'explicit_caller_reported',authenticatedHumanReview:false,pinnedFiles:[f.state.stageReviews[args.stage].result,...pins],displayArtifacts:landmarks?.pins?.filter((p:Pin)=>p.path===landmarks.files.annotated)};
 }finally{await release();}});
}
