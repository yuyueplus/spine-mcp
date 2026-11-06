import path from 'node:path';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { proofHarness, inventory, stage } from './product-proof-helpers.js';
import { projectRoot } from '../src/config.js';
import { previewConstruction } from '../src/character-construction.js';
import { writeDocument } from '../src/document.js';
import { animationSampler } from '../src/animation-sampler.js';
import { skeletonState, stateDifference } from '../src/animation-baking.js';

const h=await proofHarness('live-capabilities'),{directory,service,call}=h;
const report:any={passed:false,editorOpened:false,inputAutomation:false,remoteNetworkUsed:false,visualAcceptance:'pending',cases:[]};
const officialRoles={root:'root',pelvis:'hip',chest:'torso',head:'head',arm_L_upper:'rear-upper-arm',arm_L_lower:'rear-bracer',hand_L:'gun',arm_R_upper:'front-upper-arm',arm_R_lower:'front-bracer',hand_R:'front-fist',leg_L_upper:'rear-thigh',leg_L_lower:'rear-shin',foot_L:'rear-foot',leg_R_upper:'front-thigh',leg_R_lower:'front-shin',foot_R:'front-foot'};
const girlRoles={root:'root',pelvis:'hips',chest:'chest',head:'head',arm_L_upper:'arm_L_upper',arm_L_lower:'arm_L_fore',hand_L:'hand_L',arm_R_upper:'arm_R_upper',arm_R_lower:'arm_R_fore',hand_R:'hand_R',leg_L_upper:'leg_back_upper',leg_L_lower:'leg_back_lower',foot_L:'foot_back',leg_R_upper:'leg_front_upper',leg_R_lower:'leg_front_lower',foot_R:'foot_front'};
async function roomUntil(id:string,states:string[]){
 for(let i=0;i<500;i++){const v=await call('spine_get_live_room',{id});if(states.includes(v.state))return v;if(['failed','expired','interrupted'].includes(v.state))throw Error(JSON.stringify(v));await new Promise(r=>setTimeout(r,100));}
 throw Error('Room timeout '+id);
}
try{
 for(const actor of[
  {name:'official-spineboy',folder:'work/production-motion-3.0.0/spineboy-source',file:'spineboy-ess.spine',roles:officialRoles,intensity:.5},
  {name:'illustrated-girl',folder:'work/production-motion-3.0.0/anime-girl-source',file:'skeleton.json',roles:girlRoles,intensity:.1}
 ]){
  stage(actor.name);
  const source=path.join(projectRoot,actor.folder),before=await inventory(source),copied=path.join(directory,actor.name);
  await cp(source,copied,{recursive:true,errorOnExist:true,force:false});
  const loaded=await service.load(path.join(copied,actor.file)),roles:Record<string,string>=actor.roles;
  const input=(await writeDocument(service.workspace,path.join(copied,'current.json'),loaded.data,path.dirname(loaded.jsonPath))).path;
  const definition={kind:'humanoid_full',roles,limbs:['L','R'].map(side=>({name:side,upper:'leg_'+side+'_upper',lower:'leg_'+side+'_lower',end:'foot_'+side,direct:true,bend:'any'})),limits:[],parts:[],secondary:[],seamPlans:[]};
  const rig=await call('spine_create_rig_profile',{requestId:randomUUID(),input,name:actor.name,definition});
  const plan=await call('spine_plan_motion_pack',{input,profile:rig.profile,expectedSha256:rig.profileSha256,name:actor.name+' live IK',driver:'ik',intensity:actor.intensity,motions:['walk','run','jump','attack','hit'].map(preset=>({preset,name:'new_'+preset})),reviewVideo:false,qualityVisibilityPixelSize:.5});
  const built=await previewConstruction(service,loaded.data,plan.construction);
  let maxOldPoseError=0;
  for(const clip of Object.keys(loaded.data.animations??{})){
   assert.deepEqual(built.data.animations![clip],loaded.data.animations![clip]);
   const old=animationSampler(loaded.data,clip),current=animationSampler(built.data,clip);
   for(let i=0;i<=6;i++){
    const time=old.duration*i/6,a=skeletonState(old.sample(time)),sample=current.sample(time),b=skeletonState(sample);
    // New independent controller bones have no old counterpart.
    const active=sample.bones.filter(b=>b.active),keep=new Set(loaded.data.bones.map(b=>b.name)),n=active.length;
    b.values=[...active.flatMap((bone,index)=>keep.has(bone.data.name)?b.values.slice(index*6,index*6+6):[]),...b.values.slice(n*6)];b.signature=[...b.signature.slice(0,n).filter(name=>keep.has(name.slice(5))),...b.signature.slice(n)];
    const error=stateDifference(a,b);maxOldPoseError=Math.max(maxOldPoseError,error);
   }
  }
  assert.ok(maxOldPoseError<.0001,'old animation world state changed');
  const candidate=(await writeDocument(service.workspace,path.join(copied,'live-ik.json'),built.data,path.dirname(loaded.jsonPath))).path;
  const native=path.join(copied,'Live-IK.spine');await call('spine_build_project',{entries:[{input:candidate,name:'Live-IK'}],output:native});
  const round=await service.load(native);assert.equal((round.data.constraints as any[])?.length,2);
  await call('spine_verify_runtime_delivery',{input:round.jsonPath,animations:['new_walk','new_run','new_jump','new_attack','new_hit'],skins:['default']});
  const recipe=await call('spine_save_character_build_recipe',{requestId:randomUUID(),name:actor.name+' reusable parameters',plan:plan.plan,expectedSha256:plan.planSha256});
  const reuse=await call('spine_plan_character_build_from_recipe',{input,name:actor.name+' repeated build',recipe:recipe.recipe,expectedSha256:recipe.recipeSha256,confirmation:'recheck_landmarks_for_current_character',publication:{native:false,openInEditor:false}});
  assert.equal(reuse.inheritedVisualAcceptance,false);assert.equal(reuse.dataSha256,built.dataSha256);
  assert.deepEqual(await inventory(source),before);
  report.cases.push({actor:actor.name,source,native,plan:plan.plan,recipe:recipe.recipe,maxOldPoseError,contactVerification:plan.contactVerification,originalFilesUnchanged:true,naturalness:'pending new review'});
 }
 stage('native_live_room_mcp');
 const runtimeSource=path.join(projectRoot,'work/production-delivery-2.11.0-pKZhyz/Anime-Girl-Delivery/Spine/runtime'),runtime=path.join(directory,'runtime');
 await cp(runtimeSource,runtime,{recursive:true,errorOnExist:true,force:false});const runtimeBefore=await inventory(runtimeSource);
 const wav=Buffer.alloc(44+48000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(48000,40);for(let i=0;i<24000;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*2000),44+i*2);
 const audio=path.join(directory,'test-tone.wav');await writeFile(audio,wav);
 const base={skeleton:path.join(runtime,'skeleton.skel'),atlas:path.join(runtime,'skeleton.atlas'),width:640,height:360,frames:180,animation:'01_idle_breeze',pixelFormat:'nv12',audio:[{file:audio,loop:true,gain:.3}],leaseSeconds:60};
 const first=await call('spine_plan_live_room',{...base,output:path.join(directory,'first.mp4')}),second=await call('spine_plan_live_room',{...base,output:path.join(directory,'second.mp4')});
 const a=await call('spine_start_live_room',{requestId:randomUUID(),plan:first.plan,expectedSha256:first.planSha256}),b=await call('spine_start_live_room',{requestId:randomUUID(),plan:second.plan,expectedSha256:second.planSha256});
 await roomUntil(a.id,['running']);
 const controlId=randomUUID();await call('spine_control_live_room',{requestId:controlId,id:a.id,method:'pause'});
 let applied:any;for(let i=0;i<100;i++){const v=await call('spine_get_live_room',{id:a.id});if(v.lastResponse?.id===controlId){applied=v.lastResponse;break;}await new Promise(r=>setTimeout(r,50));}assert.equal(applied?.id,controlId);assert.ok(applied.appliedAtFrame>=0);
 await call('spine_stop_live_room',{id:a.id});await roomUntil(a.id,['stopped']);const complete=await roomUntil(b.id,['completed']);
 const encoded=JSON.parse(await readFile(complete.report,'utf8'));assert.equal(encoded.passed,true);assert.equal(encoded.frames,180);assert.equal(encoded.encoding.audioProbe.codec_name,'aac');assert.equal(encoded.encoding.probe.mode,'decoded_frames');
 const listed=await call('spine_list_live_rooms',{});assert.equal(listed.rooms.length,2);
 assert.deepEqual(await inventory(runtimeSource),runtimeBefore);
 report.live={first:a.id,second:b.id,controlApplied:applied,completed:complete,encoding:encoded.encoding,readbackBytesPerFrame:first.readbackBytesPerFrame};
 report.passed=true;
}catch(e){report.error=(e as Error).stack;throw e;}
finally{await h.save(report);await h.client.close();console.log(JSON.stringify({passed:report.passed,directory,error:report.error}));}
