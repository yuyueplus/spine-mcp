import path from 'node:path';
import {z} from 'zod/v4';
import {AnimationState,AnimationStateData,SkeletonJson,Skeleton,Physics,Inherit} from '@esotericsoftware/spine-core';
import type {SpineService} from './service.js';
import {parseDocument,writeDocument,type SpineDocument,type JsonObject} from './document.js';
import {boneDiagramLoader} from './runtime.js';
import {isolatedAnimation,prepareBoneChannels,prepareSlotChannels,solveWorldKeys,matrix,appendSlotKeys,finishSlotKeys,skeletonState,validateBaked,mul} from './animation-baking.js';
import {captureSource,filename,label,request,operation,newFolder,verifySource,writeCandidate} from './character-candidates.js';

const n=z.number().finite(),point=z.object({x:n,y:n}).strict();
export const motionSequenceSchema=z.object({...request,input:filename,newName:label,skin:label.optional(),fps:z.number().int().min(15).max(120).default(60),tolerance:n.positive().max(2).default(.05),physics:z.boolean().default(false),eventPolicy:z.enum(['all','incoming_only','drop']).default('all'),
 clips:z.array(z.object({animation:label,duration:n.positive().max(30),mix:n.nonnegative().max(5).default(.2),speed:n.min(.1).max(4).default(1),loop:z.boolean().default(false)}).strict()).min(1).max(32),
 props:z.array(z.object({bone:label,windows:z.array(z.object({start:n.nonnegative(),end:n.positive(),targetBone:label,offset:point.default({x:0,y:0}),rotationOffset:n.default(0),blendIn:n.nonnegative().default(0),blendOut:n.nonnegative().default(0)}).strict()).min(1).max(32)}).strict()).max(32).default([])
}).strict();
type Args=z.output<typeof motionSequenceSchema>;
const smooth=(v:number)=>{v=Math.max(0,Math.min(1,v));return v*v*(3-2*v);};
export function composeMotionData(source:SpineDocument,args:Args){
 if(source.animations?.[args.newName])throw Error('New animation already exists.');
 const parsed=new SkeletonJson(boneDiagramLoader).readSkeletonData(source),sk=new Skeleton(parsed),state=new AnimationState(new AnimationStateData(parsed));if(args.skin)sk.setSkin(args.skin);
 const schedule:any[]=[];for(const [i,c]of args.clips.entries()){const anim=parsed.findAnimation(c.animation);if(!anim)throw Error('Missing sequence animation: '+c.animation);if(i===0&&c.mix!==0)throw Error('First clip mix must be zero.');const prev=schedule.at(-1);if(prev&&(c.mix>prev.duration||c.mix>c.duration))throw Error('Crossfade exceeds adjacent clip duration.');const start=prev?prev.start+prev.duration-c.mix:0;schedule.push({...c,start,end:start+c.duration,sourceDuration:anim.duration});}
 const duration=schedule.at(-1).end;if(duration>60||(Math.ceil(duration*args.fps)+1)*source.bones.length>200000)throw Error('Sequence exceeds60 seconds/200,000 bone poses.');
 const editedProps=new Set(args.props.map(p=>p.bone));if(editedProps.size!==args.props.length)throw Error('Duplicate prop.');
 for(const p of args.props){const b=sk.findBone(p.bone);if(!b||source.bones.some(v=>v.parent===p.bone))throw Error('Props must identify existing leaf bones.');let previous=-1;for(const w of p.windows){if(w.start<previous||w.end<=w.start||w.end>duration||w.blendIn+w.blendOut>w.end-w.start)throw Error('Overlapping/invalid prop handoff window.');if(!sk.findBone(w.targetBone)||editedProps.has(w.targetBone))throw Error('Prop target must be an independent existing bone.');previous=w.end;}}
 let data=isolatedAnimation(source,args.newName),output=data.animations![args.newName]!;prepareBoneChannels(output,source.bones.map(b=>b.name));prepareSlotChannels(output);
 const times=new Set<number>([0,duration]);for(let f=0;f<=Math.ceil(duration*args.fps);f++)times.add(Math.min(duration,f/args.fps));for(const c of schedule){times.add(c.start);times.add(c.end);}for(const p of args.props)for(const w of p.windows)for(const t of [w.start,w.start+w.blendIn,w.end-w.blendOut,w.end])times.add(t);
 // Preserve all source discrete changes and numeric boundary keys, including
 // draw order/attachment/deform/sequence keys, at their exact mapped times.
 for(const c of schedule){const keyTimes=new Set<number>();const visit=(v:any)=>{if(Array.isArray(v))for(const x of v)visit(x);else if(v&&typeof v==='object'){if(Number.isFinite(v.time))keyTimes.add(v.time);for(const x of Object.values(v))visit(x);}};visit(source.animations![c.animation]);const cycles=c.loop&&c.sourceDuration>0?Math.ceil(c.duration*c.speed/c.sourceDuration):1;if(cycles>256)throw Error('Sequence loop budget exceeded.');for(let k=0;k<cycles;k++)for(const key of keyTimes){const t=c.start+(key+k*c.sourceDuration)/c.speed;if(t>=c.start&&t<=c.end)times.add(t);}}
 // Runtime timeline times are Float32. Capture at those same instants so a
 // discrete draw-order/attachment key does not get tested one ULP before it.
 const sorted=[...new Set([...times].filter(t=>t>=0&&t<=duration).map(Math.fround))].sort((a,b)=>a-b);if(sorted.length*source.bones.length>200000)throw Error('Sequence boundary budget exceeded.');
 const orders:{time:number;order:string[]}[]=[],proof:{time:number;state:ReturnType<typeof skeletonState>}[]=[];let current=-1,previous=0,maxPropError=0,proofValues=0;
 for(const time of sorted){
  const dt=time-previous;if(dt>0){state.update(dt);sk.update(dt);}while(current+1<schedule.length&&time>=schedule[current+1].start-1e-10){current++;const c=schedule[current],track=state.setAnimation(0,c.animation,c.loop);track.timeScale=c.speed;track.mixDuration=current?c.mix:0;}
  sk.setupPose();state.apply(sk);sk.updateWorldTransform(args.physics?(time===0?Physics.reset:Physics.update):Physics.none);
  const desired=new Map(sk.bones.filter(b=>b.active).map(b=>[b.data.name,matrix(b.appliedPose)]));
  for(const prop of args.props){const w=prop.windows.find(w=>time>=w.start&&time<=w.end);if(!w)continue;const target=sk.findBone(w.targetBone)!.appliedPose,old=desired.get(prop.bone)!;let alpha=1;if(w.blendIn)alpha=Math.min(alpha,smooth((time-w.start)/w.blendIn));if(w.blendOut)alpha=Math.min(alpha,smooth((w.end-time)/w.blendOut));const r=w.rotationOffset*Math.PI/180,offset={a:Math.cos(r),b:-Math.sin(r),c:Math.sin(r),d:Math.cos(r),x:w.offset.x,y:w.offset.y},follow=mul(matrix(target),offset);const originalAngle=Math.atan2(old.c,old.a),targetAngle=Math.atan2(follow.c,follow.a),delta=Math.atan2(Math.sin(targetAngle-originalAngle),Math.cos(targetAngle-originalAngle)),angle=originalAngle+alpha*delta,sx=Math.hypot(old.a,old.c),sy=Math.hypot(old.b,old.d);
   desired.set(prop.bone,{a:sx*Math.cos(angle),b:-sy*Math.sin(angle),c:sx*Math.sin(angle),d:sy*Math.cos(angle),x:old.x+(follow.x-old.x)*alpha,y:old.y+(follow.y-old.y)*alpha});
  }
  solveWorldKeys(output,sk,desired,time);
  for(const bone of sk.bones)if(bone.active){const channels=(output.bones as any)[bone.data.name],keys=channels.inherit??=[],enumName=Inherit[bone.appliedPose.inherit],inherit=enumName[0]!.toLowerCase()+enumName.slice(1);if(!keys.length||keys.at(-1).inherit!==inherit)keys.push({time,inherit});channels.inherit=keys;}
  appendSlotKeys(data,output,sk,time,orders);const sampled=skeletonState(sk);proofValues+=sampled.values.length;if(proofValues>5000000)throw Error('Sequence geometry/deformation proof exceeds5M coordinates.');proof.push({time,state:sampled});for(const prop of args.props){const w=prop.windows.find(w=>time>=w.start+w.blendIn&&time<=w.end-w.blendOut);if(w){const a=sk.findBone(prop.bone)!.appliedPose,b=sk.findBone(w.targetBone)!.appliedPose;maxPropError=Math.max(maxPropError,Math.hypot(a.worldX-(b.worldX+b.a*w.offset.x+b.b*w.offset.y),a.worldY-(b.worldY+b.c*w.offset.x+b.d*w.offset.y)));}}
  previous=time;
 }
 if(args.eventPolicy!=='drop'){const events:any[]=[];for(const [i,c]of schedule.entries()){const raw=(source.animations![c.animation]!.events??[])as any[],cycles=c.loop&&c.sourceDuration>0?Math.ceil(c.duration*c.speed/c.sourceDuration):1;for(let k=0;k<cycles;k++)for(const e of raw){const t=c.start+(Number(e.time??0)+k*c.sourceDuration)/c.speed,limit=args.eventPolicy==='incoming_only'&&i<schedule.length-1?schedule[i+1].start:c.end;if(t>=c.start&&t<=limit+1e-10)events.push({...structuredClone(e),time:t});}}events.sort((a,b)=>a.time-b.time);if(events.length>10000)throw Error('Event budget exceeded.');if(events.length)output.events=events;}
 data=finishSlotKeys(data,args.newName,orders);data.skeleton.fps=Math.max(Number(data.skeleton.fps??30),args.fps);data=parseDocument(data);const maxSampledStateError=validateBaked(data,args.newName,proof,args.skin,args.tolerance);if(maxPropError>args.tolerance)throw Error('Prop contact reconstruction failed.');
 return{data,duration,schedule,maxSampledStateError,maxPropError,checkedFrames:proof.length,sampledOnly:true};
}
export async function composeMotionSequence(service:SpineService,raw:z.input<typeof motionSequenceSchema>){const a=motionSequenceSchema.parse(raw);return operation(service,a.requestId,'motion_sequence',a,async()=>{const s=await captureSource(service,a.input),built=composeMotionData(s.data,a),folder=await newFolder(service,'motion-sequences'),json=(await writeDocument(service.workspace,path.join(folder,'skeleton.json'),built.data,path.dirname(s.jsonPath))).path;await verifySource(service,s.source);const{data,...details}=built;return writeCandidate(service,'motion_sequence',json,s.source,{...details,newName:a.newName,eventPolicy:a.eventPolicy,visualAcceptance:'pending',scope:'Official runtime crossfades and explicit leaf-prop contacts baked into one NEW clip. Original clips/constraints unchanged; mixes disabled only in the baked clip.'},true);});}
