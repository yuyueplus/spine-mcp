import { Physics, Inherit, IkConstraint } from '@esotericsoftware/spine-core';
import type { z } from 'zod/v4';
import type { ikContactRepairSchema } from './ik-contact-repair.js';
import { animationSampler } from './animation-sampler.js';
import { constraintList, resolveConstraint } from './constraint-data.js';
import { tracks } from './advanced-animation.js';
import { coalesceBakingTimes } from './world-animation.js';
import { influenceClosure } from './ik-target-repair.js';
import { insertBoundary } from './production-keyframes.js';
import { parseDocument, object, type SpineDocument, type JsonObject } from './document.js';
type Args=z.output<typeof ikContactRepairSchema>;
const deg=180/Math.PI,wrap=(v:number)=>Math.atan2(Math.sin(v),Math.cos(v)),smooth=(v:number)=>{v=Math.max(0,Math.min(1,v));return v*v*(3-2*v);};
const point=(p:any,v:{x:number;y:number})=>({x:p.worldX+p.a*v.x+p.b*v.y,y:p.worldY+p.c*v.x+p.d*v.y});
const dist=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y);
export function buildRuntimeIkContactRepair(source:SpineDocument,args:Args){
  if(!source.animations?.[args.animation]||Object.hasOwn(source.animations,args.newName))throw Error('Choose an existing source clip and a NEW name.');
  const defs=constraintList(source);if(defs.some(c=>c.type==='physics'))throw Error('Runtime contact solving does not support physics constraints.');
  const original=animationSampler(source,args.animation,args.skin),duration=original.duration,sourceTimes=tracks(source,source.animations[args.animation]!).flatMap(t=>t.frames.map(f=>Number(f.time??0))),used=new Set<string>();let evaluations=0,maxTransitionProjection=0;
  const windows=args.chains.flatMap(chain=>{
    const c=resolveConstraint(source,chain.constraint,'ik'),names=c.bones as string[],target=String(c.target),foot=source.bones.find(b=>b.name===chain.foot);
    if(names?.length!==2||foot?.parent!==names[1])throw Error('Runtime contact solving needs a two-bone IK chain with a direct, possibly offset, foot child.');
    if(dist(chain.heel,chain.toe)<1e-5)throw Error('Distinct heel/toe landmarks are required.');
    for(const name of [...names,target,chain.foot]){if(used.has(name))throw Error('Contact chains/controllers overlap.');used.add(name);}
    const ancestors=new Set<string>();let b=source.bones.find(b=>b.name===target);while(b){ancestors.add(b.name);b=source.bones.find(p=>p.name===b!.parent);}
    if(names.some(n=>ancestors.has(n))||ancestors.has(chain.foot))throw Error('IK controller must be independent from the constrained chain.');
    for(const other of defs)if(other!==c&&[other.bone,...(Array.isArray(other.bones)?other.bones:[])].some(n=>typeof n==='string'&&([...names,chain.foot].includes(n)||ancestors.has(n))))throw Error('Another constraint writes the selected chain/foot/controller ancestors.');
    return chain.contacts.map(w=>{
      if(w.end<=w.start||w.end>duration)throw Error('Contact windows must be positive and inside the clip.');
      if(w.angles&&(w.angleDegrees!==undefined||w.mode==='sole'||w.angles[0]!.time!==w.start||w.angles.at(-1)!.time!==w.end||w.angles.some((v,i)=>v.time<w.start||v.time>w.end||i>0&&(v.time<=w.angles![i-1]!.time||Math.abs(v.degrees-w.angles![i-1]!.degrees)>180))))throw Error('Rolling angle paths need ordered heel/toe endpoints and increments <=180 degrees.');
      const p=original.sample(w.start).bones.find(b=>b.data.name===chain.foot)!.appliedPose,h=point(p,chain.heel),t=point(p,chain.toe);
      return{...chain,...w,names,target,anchor:w.anchor??(w.mode==='toe'?t:h),angle:Math.atan2(t.y-h.y,t.x-h.x),length:dist(h,t),begin:Math.fround(Math.max(0,w.start-w.transitionSeconds)),finish:Math.fround(Math.min(duration,w.end+w.transitionSeconds)),affected:influenceClosure(source,[target,...names,chain.foot])};
    });
  });
  if(windows.length>16)throw Error('At most 16 contact windows.');
  for(let i=0;i<windows.length;i++)for(let j=i+1;j<windows.length;j++)if(windows[i]!.target===windows[j]!.target&&windows[i]!.begin<=windows[j]!.finish&&windows[j]!.begin<=windows[i]!.finish)throw Error('Contact transitions on a controller overlap or touch.');
  function desired(w:typeof windows[number],time:number){
    const s=original.sample(time),f=s.bones.find(b=>b.data.name===w.foot)!,p=f.appliedPose,ik=s.constraints.find(c=>c instanceof IkConstraint&&c.data.name===w.constraint)as IkConstraint;
    if(!f.active||!ik?.active||ik.appliedPose.compress||ik.appliedPose.stretch)throw Error('Runtime contact requires active non-stretch/compress IK.');
    if(ik.appliedPose.mix<0||ik.appliedPose.mix>1||!Number.isFinite(ik.appliedPose.softness)||ik.appliedPose.softness<0)throw Error('Invalid IK mix/softness.');
    if(ik.appliedPose.mix<0.00001&&!args.allowFk)throw Error('FK-only contact requires explicit allowFk=true to edit selected chain rotations.');
    for(const bone of [f,...w.names.map(n=>s.bones.find(b=>b.data.name===n)!),...(f.parent?.parent?.parent?[f.parent.parent.parent]:[])]){const q=bone.appliedPose,a=Math.hypot(q.a,q.c),b=Math.hypot(q.b,q.d);if(q.inherit!==Inherit.Normal||q.scaleX<=0||q.scaleY<=0||q.a*q.d-q.b*q.c<=0||Math.abs(a-b)>1e-5*Math.max(1,a)||Math.abs(q.a*q.b+q.c*q.d)>1e-5*Math.max(1,a*b)||Math.abs(q.shearX)+Math.abs(q.shearY)>1e-6)throw Error('Runtime contact requires positive uniform scales, normal inheritance, and no shear.');}
    const h=point(p,w.heel),t=point(p,w.toe),angle=Math.atan2(t.y-h.y,t.x-h.x);if(w.mode==='sole'&&time>=w.start&&time<=w.end&&Math.abs(dist(h,t)-w.length)>args.tolerance)throw Error('Planted sole length changes during contact.');
    let goal=w.angleDegrees===undefined?w.angle:w.angleDegrees/deg;if(w.angles){const i=Math.max(0,w.angles.findLastIndex(v=>v.time<=time)),a=w.angles[i]!,b=w.angles[Math.min(i+1,w.angles.length-1)]!,u=a.time===b.time?0:Math.max(0,Math.min(1,(time-a.time)/(b.time-a.time)));goal=(a.degrees+(b.degrees-a.degrees)*u)/deg;}
    const weight=time<w.start?smooth((time-w.begin)/(w.start-w.begin)):time>w.end?smooth((w.finish-time)/(w.finish-w.end)):1,delta=wrap(goal-angle)*weight,cs=Math.cos(delta),sn=Math.sin(delta),a=cs*p.a-sn*p.c,b=cs*p.b-sn*p.d,c=sn*p.a+cs*p.c,d=sn*p.b+cs*p.d,pivot=w.mode==='toe'?w.toe:w.heel;
    let x=p.worldX+(w.anchor.x-a*pivot.x-b*pivot.y-p.worldX)*weight,y=p.worldY+(w.anchor.y-c*pivot.x-d*pivot.y-p.worldY)*weight;
    if(weight>0&&weight<1){const u=s.bones.find(b=>b.data.name===w.names[0])!.appliedPose,l=f.parent!.appliedPose,reach=Math.hypot(l.worldX-u.worldX,l.worldY-u.worldY)+Math.hypot(p.worldX-l.worldX,p.worldY-l.worldY),r=Math.hypot(x-u.worldX,y-u.worldY),limit=reach-args.tolerance*.001*weight;if(r>limit){const px=u.worldX+(x-u.worldX)*limit/r,py=u.worldY+(y-u.worldY)*limit/r;maxTransitionProjection=Math.max(maxTransitionProjection,Math.hypot(px-x,py-y));x=px;y=py;}}
    return{x,y,angle:angle+delta,targetAngle:goal,weight,mix:ik.appliedPose.mix};
  }
  let data=structuredClone(source);data.animations![args.newName]=structuredClone(source.animations[args.animation]!);let keysAdded=0,maxIterations=0;
  function writeTrack(bone:string,channel:'rotate'|'translate'|'translatex'|'translatey',begin:number,finish:number,keys:JsonObject[]){
    const anim=data.animations![args.newName]!;anim.bones??={};const bones=object(anim.bones,'bones');bones[bone]??={};const out=object(bones[bone],'tracks'),zero=channel==='translate'?{x:0,y:0}:{value:0};if(!Array.isArray(out[channel]))out[channel]=[{time:0,...zero},{time:duration,...zero}];
    if(Number((out[channel]as JsonObject[])[0]!.time??0)>0)(out[channel]as JsonObject[]).unshift({time:0,...zero,curve:'stepped'});
    for(const time of [begin,finish])data=insertBoundary(data,args.newName,{kind:'bone',bone,channel},time);
    const current=object(object(data.animations![args.newName]!.bones,'bones')[bone],'tracks'),old=current[channel]as JsonObject[],tail=old.find(k=>Math.abs(Number(k.time??0)-finish)<=1e-6);if(tail?.curve!==undefined)keys.at(-1)!.curve=tail.curve;
    current[channel]=[...old.filter(k=>Number(k.time??0)<begin-1e-6),...keys,...old.filter(k=>Number(k.time??0)>finish+1e-6)];keysAdded+=keys.length;if(keysAdded>20000)throw Error('Runtime contact exceeds 20,000 keys.');
  }
  const samples=windows.map(w=>{
    const times=coalesceBakingTimes([w.begin,w.start,w.end,w.finish,...sourceTimes.filter(t=>t>=w.begin&&t<=w.finish),...(w.angles?.map(v=>v.time)??[]),...Array.from({length:Math.ceil((w.finish-w.begin)*args.fps)+1},(_,i)=>Math.min(w.finish,w.begin+i/args.fps))]);if(times.length>600)throw Error('Contact window exceeds 600 controller samples.');
    const result=times.map(time=>{
      const goal=desired(w,time),s=original.sample(time),target=s.bones.find(b=>b.data.name===w.target)!,upper=s.bones.find(b=>b.data.name===w.names[0])!,lower=s.bones.find(b=>b.data.name===w.names[1])!,foot=s.bones.find(b=>b.data.name===w.foot)!,base={x:target.pose.x,y:target.pose.y,upper:upper.pose.rotation,lower:lower.pose.rotation,foot:foot.pose.rotation};
      const length=Math.max(1,upper.data.length+lower.data.length),parentScale=target.parent?Math.hypot(target.parent.appliedPose.a,target.parent.appliedPose.c):1,scales=[length/Math.max(parentScale,1e-6),length/Math.max(parentScale,1e-6),args.allowFk?deg*(1-goal.mix)**2:0,args.allowFk?deg*(1-goal.mix)**2:0];
      const evaluate=(values:number[])=>{if(++evaluations*source.bones.length>3000000)throw Error('Runtime inverse solve exceeds 3,000,000 bone evaluations.');original.sample(time);target.pose.x=base.x+values[0]!;target.pose.y=base.y+values[1]!;upper.pose.rotation=base.upper+values[2]!;lower.pose.rotation=base.lower+values[3]!;s.updateWorldTransform(Physics.none);
        const p=foot.parent!.appliedPose,q=foot.appliedPose,det=p.a*p.d-p.b*p.c,dx=Math.cos(goal.angle),dy=Math.sin(goal.angle),x=(p.d*dx-p.b*dy)/det,y=(-p.c*dx+p.a*dy)/det,local=Math.atan2((w.toe.y-w.heel.y)*q.scaleY,(w.toe.x-w.heel.x)*q.scaleX),raw=(Math.atan2(y,x)-local)*deg;foot.pose.rotation=base.foot+wrap((raw-base.foot)/deg)*deg;s.updateWorldTransform(Physics.none);
        return{x:foot.appliedPose.worldX,y:foot.appliedPose.worldY,targetX:target.pose.x-target.data.setupPose.x,targetY:target.pose.y-target.data.setupPose.y,upper:upper.pose.rotation-upper.data.setupPose.rotation,lower:lower.pose.rotation-lower.data.setupPose.rotation,foot:foot.pose.rotation-foot.data.setupPose.rotation};};
      let values=[0,0,0,0],pose=evaluate(values),error=dist(pose,goal),iteration=0;
      for(;goal.weight>1e-10&&error>args.tolerance*.01&&iteration<40;iteration++){
        const jac:number[][]=[];for(let i=0;i<4;i++){if(!scales[i]){jac.push([0,0]);continue;}const h=Math.max(1e-4,scales[i]!*1e-4),a=[...values],b=[...values];a[i]!+=h;b[i]!-=h;const pa=evaluate(a),pb=evaluate(b);jac.push([(pa.x-pb.x)/(2*h)*scales[i]!, (pa.y-pb.y)/(2*h)*scales[i]!]);}
        const aa=jac.reduce((v,j)=>v+j[0]!*j[0]!,0)+1e-6,bb=jac.reduce((v,j)=>v+j[0]!*j[1]!,0),dd=jac.reduce((v,j)=>v+j[1]!*j[1]!,0)+1e-6,det=aa*dd-bb*bb,ex=goal.x-pose.x,ey=goal.y-pose.y;if(!Number.isFinite(det)||det<1e-15)break;
        const x=(dd*ex-bb*ey)/det,y=(-bb*ex+aa*ey)/det,step=jac.map((j,i)=>Math.max(i<2?-length:-30,Math.min(i<2?length:30,(j[0]!*x+j[1]!*y)*scales[i]!)));let accepted=false;
        for(const factor of [1,.5,.25,.1,.02]){const next=values.map((v,i)=>v+step[i]!*factor);if(next.slice(0,2).some(v=>Math.abs(v)>1000000))continue;const p=evaluate(next),e=dist(p,goal);if(e<error){values=next;pose=p;error=e;accepted=true;break;}}if(!accepted)break;
      }
      maxIterations=Math.max(maxIterations,iteration);if(error>args.tolerance*.5)throw Error(`Runtime contact target is unreachable/ill-conditioned at ${time.toFixed(6)}s (${error}); iterations=${iteration}; values=${JSON.stringify(values)}; goal=${JSON.stringify(goal)}.`);return{time,...evaluate(values)};
    });
    const originalChannels=object(object(source.animations![args.animation]!.bones??{},'bones')[w.target]??{},'tracks');if(originalChannels.translate&&(originalChannels.translatex||originalChannels.translatey))throw Error('Mixed combined/split controller translation tracks must be normalized.');
    if(originalChannels.translatex||originalChannels.translatey){writeTrack(w.target,'translatex',w.begin,w.finish,result.map(p=>({time:p.time,value:p.targetX})));writeTrack(w.target,'translatey',w.begin,w.finish,result.map(p=>({time:p.time,value:p.targetY})));}else writeTrack(w.target,'translate',w.begin,w.finish,result.map(p=>({time:p.time,x:p.targetX,y:p.targetY})));
    for(const [bone,field]of [[w.foot,'foot'],...(args.allowFk?[[w.names[0]!,'upper'],[w.names[1]!,'lower']]:[])]as [string,'foot'|'upper'|'lower'][]){const keys=result.map(p=>({time:p.time,value:p[field]}));for(let i=1;i<keys.length;i++)if(Math.abs(keys[i]!.value-keys[i-1]!.value)>180)throw Error('Contact rotations cross an ambiguous 360-degree seam.');writeTrack(bone,'rotate',w.begin,w.finish,keys);}
    return{w,times};
  });
  data.skeleton.fps=Math.max(240,args.fps,Number(data.skeleton.fps??30));data=parseDocument(data);const after=animationSampler(data,args.newName,args.skin),times=coalesceBakingTimes([0,duration,...sourceTimes,...samples.flatMap(s=>s.times),...Array.from({length:Math.ceil(duration*args.fps*2)+1},(_,i)=>Math.min(duration,i/(args.fps*2)))]);if(times.length*source.bones.length>300000)throw Error('Runtime contact verification exceeds 300,000 bone poses.');
  let maxAnchorError=0,maxOrientationErrorDegrees=0,maxOutsideWorldError=0,maxUnselectedWorldError=0,maxAnkleGoalError=0,worstTime=0;const changed=new Set(windows.flatMap(w=>[...w.affected]));
  for(const time of times){const a=original.sample(time),b=after.sample(time),active=windows.filter(w=>time>=w.begin&&time<=w.finish),allowed=new Set(active.flatMap(w=>[...w.affected]));for(const w of active){const g=desired(w,time),p=b.bones.find(b=>b.data.name===w.foot)!.appliedPose,h=point(p,w.heel),t=point(p,w.toe);const ankleError=dist({x:p.worldX,y:p.worldY},g);if(ankleError>maxAnkleGoalError){maxAnkleGoalError=ankleError;worstTime=time;}maxOrientationErrorDegrees=Math.max(maxOrientationErrorDegrees,Math.abs(wrap(Math.atan2(t.y-h.y,t.x-h.x)-g.angle))*deg);if(time>=w.start-1e-7&&time<=w.end+1e-7){maxAnchorError=Math.max(maxAnchorError,dist(w.mode==='toe'?t:h,w.anchor));if(w.mode==='sole')maxAnchorError=Math.max(maxAnchorError,dist(t,{x:w.anchor.x+Math.cos(g.targetAngle)*w.length,y:w.anchor.y+Math.sin(g.targetAngle)*w.length}));}}
    for(let i=0;i<a.bones.length;i++){const p=a.bones[i]!,q=b.bones[i]!;if(q.active&&!['worldX','worldY','a','b','c','d'].every(k=>Number.isFinite((q.appliedPose as any)[k])))throw Error('Non-finite runtime contact pose.');if(!p.active||allowed.has(p.data.name))continue;if(!q.active)throw Error('Contact changed unrelated activation.');const error=Math.max(...['worldX','worldY','a','b','c','d'].map(k=>Math.abs((p.appliedPose as any)[k]-(q.appliedPose as any)[k])));if(changed.has(p.data.name))maxOutsideWorldError=Math.max(maxOutsideWorldError,error);else maxUnselectedWorldError=Math.max(maxUnselectedWorldError,error);}
  }
  if(Math.max(maxAnchorError,maxAnkleGoalError,maxOutsideWorldError,maxUnselectedWorldError)>args.tolerance||maxOrientationErrorDegrees>args.orientationToleranceDegrees)throw Error(`Runtime contact verification failed (anchor=${maxAnchorError}, ankle=${maxAnkleGoalError}, angle=${maxOrientationErrorDegrees}, outside=${maxOutsideWorldError}, unrelated=${maxUnselectedWorldError}); worstTime=${worstTime}; increase FPS or revise the windows.`);
  for(const [name,clip]of Object.entries(source.animations))if(JSON.stringify(clip)!==JSON.stringify(data.animations![name]))throw Error('Runtime contact changed an original clip.');
  return{data,report:{solver:'official_runtime_inverse',baked:false,controllersEditable:true,allowFk:args.allowFk,editedTargets:[...new Set(windows.map(w=>w.target))],editedFeet:args.chains.map(c=>c.foot),editedFkBones:args.allowFk?[...new Set(windows.flatMap(w=>w.names))]:[],constraintsPreserved:JSON.stringify(data.constraints)===JSON.stringify(source.constraints),constraintTimelinesPreserved:['constraints','ik','transform','path','physics'].every(k=>JSON.stringify(data.animations![args.newName]![k])===JSON.stringify(source.animations![args.animation]![k])),originalAnimationsPreserved:true,addedKeys:keysAdded,evaluations,maxIterations,maxAnchorError,maxAnkleGoalError,maxOrientationErrorDegrees,maxOutsideWorldError,maxUnselectedWorldError,maxTransitionProjection,transitionPolicy:'Reach projection only during fades; core anchors never projected',checkedContactSamples:times.length,tolerance:args.tolerance,orientationToleranceDegrees:args.orientationToleranceDegrees,scope:'Offset foot, partial IK mix and animated softness are solved through the official runtime. allowFk explicitly permits selected upper/lower rotation tracks for FK/IK transitions, without disabling constraints. Positive uniform scale/no shear or interacting physics. Finite sampling does not infer anatomy or visual acceptance.'}};
}
