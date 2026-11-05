import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import type { SpineService } from './service.js';
import { parseDocument, writeDocument, type SpineDocument } from './document.js';
import { animationSampler } from './animation-sampler.js';
import { attachmentEntries, vertexLayout } from './attachment-data.js';
import { constraintList } from './constraint-data.js';
import { coalesceBakingTimes } from './world-animation.js';
import { comparisonMedia, repairSchema } from './animation-repair.js';
import { meshDeformRepairSchema, meshInverse, activeRepairMesh, meshEdges, measureRepairMesh } from './mesh-deform-repair.js';
import { label, filename, request, operation, captureSource, verifySource, newFolder, writeCandidate } from './character-candidates.js';
import { meshTargetRefSchema,meshSeamSchema,reviewedSeamPlanSchema } from './mesh-seam-schema.js';
import { jointCompatibilitySchema,prepareJointMeshCompatibility } from './joint-mesh-compatibility.js';
import { resolveReviewedMeshSeams,meshRepairIssuePreviews } from './mesh-seams.js';

const finite=z.number().finite();
export const jointMeshRepairSchema=z.object({
 ...request,input:filename,animation:label,newName:label,skin:label.default('default'),
 targets:z.array(meshTargetRefSchema.extend({maxCorrection:finite.positive().max(1000).default(10),pinnedVertices:z.array(z.number().int().min(0).max(1999)).max(2000).default([])}).strict()).min(2).max(8),
 seams:z.array(meshSeamSchema).max(128).default([]),seamPlan:reviewedSeamPlanSchema.optional(),
 compatibility:jointCompatibilitySchema.default({linkedMeshes:'reject',physics:'reject',physicsFps:120,poseTolerance:.001}),
 fps:meshDeformRepairSchema.shape.fps,minAreaRatio:meshDeformRepairSchema.shape.minAreaRatio,maxStretch:meshDeformRepairSchema.shape.maxStretch,
 iterations:z.number().int().min(1).max(160).default(100),tolerance:meshDeformRepairSchema.shape.tolerance,comparison:repairSchema.shape.comparison,
}).strict();
export type JointMeshRepairArgs=z.output<typeof jointMeshRepairSchema>;
type Args=JointMeshRepairArgs;
const area=(p:number[],a:number,b:number,c:number)=>((p[b*2]!-p[a*2]!)*(p[c*2+1]!-p[a*2+1]!)-(p[b*2+1]!-p[a*2+1]!)*(p[c*2]!-p[a*2]!))/2;
const prune=(o:any):any=>o&&typeof o==='object'&&!Array.isArray(o)?Object.fromEntries(Object.entries(o).map(([k,v])=>[k,prune(v)]).filter(([,v])=>!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length>0)):o;

function buildIndependentJointRepair(source:SpineDocument,args:Args,physicsCaptured=false){
 if(!source.animations?.[args.animation]||Object.hasOwn(source.animations,args.newName))throw Error('Choose an existing source clip and a NEW joint repair clip name.');
 if(constraintList(source).some(c=>c.type==='physics')&&!physicsCaptured)throw Error('Joint mesh repair does not evaluate uncaptured physics constraints.');
 if(new Set(args.targets.map(t=>t.id)).size!==args.targets.length||new Set(args.targets.map(t=>t.slot)).size!==args.targets.length)throw Error('Joint targets must have unique IDs and separate active slots.');
 const entries=attachmentEntries(source),setupSkeleton=animationSampler(source,undefined,args.skin).sample(0),sampler=animationSampler(source,args.animation,args.skin),duration=sampler.duration;
 if(duration<=0||duration>30)throw Error('Joint mesh repair requires a clip of 0–30 seconds.');
 const targets=args.targets.map(t=>{
  const entry=entries.find(e=>e.skin===args.skin&&e.slot===t.slot&&e.name===t.attachment);if(!entry||entry.value.type!=='mesh'||entry.value.parent||entry.value.source)throw Error('Joint targets must be independent meshes.');
  if(entries.some(e=>e.value.source===t.attachment&&(e.value.skin??'default')===args.skin&&(e.value.slot??e.slot)===t.slot))throw Error('Joint targets cannot have linked dependents.');
  const layout=vertexLayout(source,entry.value),triangles=entry.value.triangles as number[],edges=meshEdges(triangles),pinned=new Set(t.pinnedVertices);if(layout.count>2000||triangles.length>12000)throw Error('A joint target exceeds 2,000 vertices / 4,000 triangles.');if(pinned.size!==t.pinnedVertices.length||[...pinned].some(v=>v>=layout.count))throw Error('Invalid or duplicated pinned vertices.');
  const single=meshDeformRepairSchema.parse({requestId:args.requestId,input:args.input,animation:args.animation,newName:args.newName,skin:args.skin,slot:t.slot,attachment:t.attachment,maxCorrection:t.maxCorrection,pinnedVertices:t.pinnedVertices,fps:args.fps,minAreaRatio:args.minAreaRatio,maxStretch:args.maxStretch,iterations:Math.min(args.iterations,120),tolerance:args.tolerance,comparison:args.comparison});
  const actualName=String(entry.value.name??t.attachment),setupSlot=setupSkeleton.findSlot(t.slot),setupMesh=setupSlot?setupSkeleton.data.findSkin(args.skin)?.getAttachment(setupSlot.data.index,t.attachment):undefined;if(!setupSlot||!(setupMesh instanceof MeshAttachment))throw Error('Target setup mesh definition is unavailable.');const setupPoints=new Array<number>(setupMesh.worldVerticesLength);setupMesh.computeWorldVertices(setupSkeleton,setupSlot,0,setupPoints.length,setupPoints,0,2);const m=setupSlot.bone.appliedPose,local=Array.from({length:layout.count},(_,i)=>meshInverse(m,setupPoints[i*2]!-m.worldX,setupPoints[i*2+1]!-m.worldY));
  return{...t,entry,layout,triangles,edges,pinned,single,actualName,local,keys:[]as any[]};
 });
 const totalVertices=targets.reduce((n,t)=>n+t.layout.count,0),totalTriangles=targets.reduce((n,t)=>n+t.triangles.length/3,0);if(totalVertices>4000||totalTriangles>8000)throw Error('Joint repair exceeds 4,000 combined vertices / 8,000 triangles.');
 const ids=new Map(targets.map((t,i)=>[t.id,i])),seen=new Set<string>();if(new Set(args.seams.map(s=>s.name)).size!==args.seams.length)throw Error('Seam names must be unique.');
 const seams=args.seams.map(s=>{const a=ids.get(s.a.target),b=ids.get(s.b.target);if(a===undefined||b===undefined||a===b||s.a.vertex>=targets[a]!.layout.count||s.b.vertex>=targets[b]!.layout.count)throw Error('Seams must refer to valid vertices on separate targets.');const key=[s.a.target+':'+s.a.vertex,s.b.target+':'+s.b.vertex].sort().join('|');if(seen.has(key))throw Error('Duplicated seam endpoint pair.');seen.add(key);return{...s,ai:a,bi:b};});
 const times=coalesceBakingTimes(Array.from({length:Math.ceil(duration*args.fps)+1},(_,i)=>Math.min(i/args.fps,duration)));if(times.length>1201||times.length*targets.reduce((n,t)=>n+t.layout.deformLength,0)>2000000)throw Error('Joint repair exceeds frame/deform coordinate budget.');
 function cells(s:ReturnType<typeof sampler.sample>){return targets.map(t=>{const c=activeRepairMesh(s,t.single,t.actualName),p=c.slot.bone.appliedPose,reference=t.local.flatMap(v=>[p.a*v.x+p.b*v.y+p.worldX,p.c*v.x+p.d*v.y+p.worldY]);return{...c,reference};});}
 let visits=0,iterations=0,beforeFolded=0,beforeStretched=0,correctedFrames=0,maxCorrection=0,maxSeamError=0;
 const visit=()=>{if(++visits>8000000)throw Error('Joint repair exceeds eight million constraint projections.');};
 for(const time of times){const s=sampler.sample(time),original=cells(s),positions=original.map(c=>[...c.p]),offsets=seams.map(seam=>seam.mode==='coincident'?{x:0,y:0}:{x:original[seam.bi]!.p[seam.b.vertex*2]!-original[seam.ai]!.p[seam.a.vertex*2]!,y:original[seam.bi]!.p[seam.b.vertex*2+1]!-original[seam.ai]!.p[seam.a.vertex*2+1]!});
  const clamp=(ti:number,v:number)=>{const t=targets[ti]!,p=positions[ti]!,o=original[ti]!.p,dx=p[v*2]!-o[v*2]!,dy=p[v*2+1]!-o[v*2+1]!,d=Math.hypot(dx,dy);if(d>t.maxCorrection){p[v*2]=o[v*2]!+dx*t.maxCorrection/d;p[v*2+1]=o[v*2+1]!+dy*t.maxCorrection/d;}};
  for(let ti=0;ti<targets.length;ti++){const q=measureRepairMesh(positions[ti]!,original[ti]!.reference,targets[ti]!.triangles,targets[ti]!.edges,targets[ti]!.single);beforeFolded+=q.folded;beforeStretched+=q.stretched;}
  for(let it=0;it<args.iterations;it++){
   const geometryGood=targets.every((t,i)=>{const q=measureRepairMesh(positions[i]!,original[i]!.reference,t.triangles,t.edges,t.single);return!q.folded&&!q.stretched;}),seamsGood=seams.every((seam,i)=>Math.hypot(positions[seam.bi]![seam.b.vertex*2]!-positions[seam.ai]![seam.a.vertex*2]!-offsets[i]!.x,positions[seam.bi]![seam.b.vertex*2+1]!-positions[seam.ai]![seam.a.vertex*2+1]!-offsets[i]!.y)<=seam.tolerance*.5);if(geometryGood&&seamsGood)break;iterations=Math.max(iterations,it+1);
   for(let ti=0;ti<targets.length;ti++){const t=targets[ti]!,p=positions[ti]!,ref=original[ti]!.reference;
    for(let i=0;i<t.triangles.length;i+=3){visit();const [a,b,c]=t.triangles.slice(i,i+3)as[number,number,number],r=area(ref,a,b,c),sign=Math.sign(r),missing=Math.abs(r)*(args.minAreaRatio+.002)-area(p,a,b,c)*sign;if(missing<=0)continue;const g=[[p[b*2+1]!-p[c*2+1]!,p[c*2]!-p[b*2]!],[p[c*2+1]!-p[a*2+1]!,p[a*2]!-p[c*2]!],[p[a*2+1]!-p[b*2+1]!,p[b*2]!-p[a*2]!]].map(v=>v.map(x=>x*.5*sign)),vs=[a,b,c],den=g.reduce((n,v,k)=>n+(t.pinned.has(vs[k]!)?0:v[0]!**2+v[1]!**2),0);if(den<1e-16)continue;for(let k=0;k<3;k++){const v=vs[k]!;if(t.pinned.has(v))continue;p[v*2]=p[v*2]!+missing/den*.95*g[k]![0]!;p[v*2+1]=p[v*2+1]!+missing/den*.95*g[k]![1]!;clamp(ti,v);}}
    for(const [a,b]of t.edges){visit();const dx=p[b*2]!-p[a*2]!,dy=p[b*2+1]!-p[a*2+1]!,len=Math.hypot(dx,dy),limit=Math.hypot(ref[b*2]!-ref[a*2]!,ref[b*2+1]!-ref[a*2+1]!)*args.maxStretch,wa=t.pinned.has(a)?0:1,wb=t.pinned.has(b)?0:1;if(len<=limit||!wa&&!wb)continue;const f=(len-limit)/len/(wa+wb);p[a*2]=p[a*2]!+wa*dx*f;p[a*2+1]=p[a*2+1]!+wa*dy*f;p[b*2]=p[b*2]!-wb*dx*f;p[b*2+1]=p[b*2+1]!-wb*dy*f;clamp(ti,a);clamp(ti,b);}
   }
   for(let i=0;i<seams.length;i++){visit();const seam=seams[i]!,a=positions[seam.ai]!,b=positions[seam.bi]!,av=seam.a.vertex,bv=seam.b.vertex,wa=targets[seam.ai]!.pinned.has(av)?0:1,wb=targets[seam.bi]!.pinned.has(bv)?0:1;if(!wa&&!wb)continue;const dx=b[bv*2]!-a[av*2]!-offsets[i]!.x,dy=b[bv*2+1]!-a[av*2+1]!-offsets[i]!.y;a[av*2]=a[av*2]!+dx*wa/(wa+wb);a[av*2+1]=a[av*2+1]!+dy*wa/(wa+wb);b[bv*2]=b[bv*2]!-dx*wb/(wa+wb);b[bv*2+1]=b[bv*2+1]!-dy*wb/(wa+wb);clamp(seam.ai,av);clamp(seam.bi,bv);}
  }
  let changed=false;for(let ti=0;ti<targets.length;ti++){const t=targets[ti]!,c=original[ti]!,p=positions[ti]!,base=c.slot.appliedPose.deform.length?[...c.slot.appliedPose.deform]:new Array<number>(t.layout.deformLength).fill(0);if(!t.layout.weighted&&c.slot.appliedPose.deform.length)for(let i=0;i<base.length;i++)base[i]=base[i]!-c.mesh.vertices[i]!;const raw=t.entry.value.vertices as number[];let cursor=0,at=0;
   for(let v=0;v<t.layout.count;v++){const dx=p[v*2]!-c.p[v*2]!,dy=p[v*2+1]!-c.p[v*2+1]!,d=Math.hypot(dx,dy);maxCorrection=Math.max(maxCorrection,d);changed||=d>args.tolerance;if(!t.layout.weighted){const q=meshInverse(c.slot.bone.appliedPose,dx,dy);base[v*2]=base[v*2]!+q.x;base[v*2+1]=base[v*2+1]!+q.y;}else{const n=raw[cursor++]!,sum=Array.from({length:n},(_,i)=>raw[cursor+i*4+3]!).reduce((a,b)=>a+b,0);for(let k=0;k<n;k++,cursor+=4){const bone=s.findBone(String(source.bones[raw[cursor]!]!.name))!;const q=meshInverse(bone.appliedPose,dx/sum,dy/sum);base[at]=base[at]!+q.x;base[at+1]=base[at+1]!+q.y;at+=2;}}}
   // Spine's JSON exporter sparsifies near-zero deform values up to .01.
   // Remove those values before the geometry/seam verification, so binary
   // readback never has to waive a missing coordinate beyond its rounding bound.
   t.keys.push({time:Math.fround(time),vertices:base.map(v=>Math.abs(v)<.0101?0:Math.fround(v))});
  }if(changed)correctedFrames++;
 }
 const data=structuredClone(source),clip:any=structuredClone(source.animations[args.animation]);data.skeleton.fps=Math.max(Number(data.skeleton.fps??30),240);clip.attachments??={};clip.attachments[args.skin]??={};for(const t of targets){clip.attachments[args.skin][t.slot]??={};clip.attachments[args.skin][t.slot][t.attachment]??={};clip.attachments[args.skin][t.slot][t.attachment].deform=t.keys;}data.animations![args.newName]=clip;parseDocument(data);
 const afterSampler=animationSampler(data,args.newName,args.skin),beforeSampler=animationSampler(source,args.animation,args.skin),steps=Math.ceil(duration*args.fps*2);if((steps+1)*(totalTriangles+targets.reduce((n,t)=>n+t.edges.length,0)+seams.length)>8000000)throw Error('Joint verification exceeds eight million geometry tests.');
 const perTarget=targets.map(t=>({id:t.id,maxCorrection:0,maxPinnedMovement:0,folds:0,stretches:0,limit:t.maxCorrection,peakCorrection:undefined as any,peakPinnedMovement:undefined as any})),perSeam=seams.map(s=>({name:s.name,mode:s.mode,maxError:0,tolerance:s.tolerance,peak:undefined as any})),issues:any[]=[];let issueCount=0;
 const issue=(value:any)=>{issueCount++;if(issues.length<256)issues.push(value);},points=(p:number[],vertices:number[])=>vertices.map(v=>({vertex:v,x:p[v*2]!,y:p[v*2+1]!}));
 for(let i=0;i<=steps;i++){
  const time=Math.min(i/(args.fps*2),duration),after=cells(afterSampler.sample(time)),before=cells(beforeSampler.sample(time));
  for(let ti=0;ti<targets.length;ti++){
   const t=targets[ti]!,p=after[ti]!.p,ref=after[ti]!.reference,q=measureRepairMesh(p,ref,t.triangles,t.edges,t.single),r=perTarget[ti]!;r.folds+=q.folded;r.stretches+=q.stretched;
   for(let v=0;v<t.layout.count;v++){
    const d=Math.hypot(p[v*2]!-before[ti]!.p[v*2]!,p[v*2+1]!-before[ti]!.p[v*2+1]!),detail={time,target:t.id,slot:t.slot,attachment:t.attachment,vertex:v,distance:d,points:points(p,[v])};
    if(!r.peakCorrection||d>r.maxCorrection)r.peakCorrection=detail;r.maxCorrection=Math.max(r.maxCorrection,d);
    if(t.pinned.has(v)){if(!r.peakPinnedMovement||d>r.maxPinnedMovement)r.peakPinnedMovement=detail;r.maxPinnedMovement=Math.max(r.maxPinnedMovement,d);if(d>args.tolerance)issue({type:'pinned_vertex',...detail,limit:args.tolerance});}
    if(d>t.maxCorrection+args.tolerance)issue({type:'movement_budget',...detail,limit:t.maxCorrection});
   }
   if(q.folded)for(let k=0;k<t.triangles.length;k+=3){const vertices=t.triangles.slice(k,k+3)as[number,number,number],ratio=area(p,...vertices)/area(ref,...vertices);if(ratio<args.minAreaRatio-1e-5)issue({type:'triangle_area',time,target:t.id,slot:t.slot,attachment:t.attachment,triangle:k/3,vertices,ratio,limit:args.minAreaRatio,points:points(p,vertices)});}
   if(q.stretched)for(const vertices of t.edges){const[a,b]=vertices,ratio=Math.hypot(p[a*2]!-p[b*2]!,p[a*2+1]!-p[b*2+1]!)/Math.hypot(ref[a*2]!-ref[b*2]!,ref[a*2+1]!-ref[b*2+1]!);if(ratio>args.maxStretch+1e-5)issue({type:'edge_stretch',time,target:t.id,slot:t.slot,attachment:t.attachment,vertices,ratio,limit:args.maxStretch,points:points(p,vertices)});}
  }
  for(let si=0;si<seams.length;si++){
   const seam=seams[si]!,a=after[seam.ai]!.p,b=after[seam.bi]!.p,oa=before[seam.ai]!.p,ob=before[seam.bi]!.p,dx=seam.mode==='coincident'?0:ob[seam.b.vertex*2]!-oa[seam.a.vertex*2]!,dy=seam.mode==='coincident'?0:ob[seam.b.vertex*2+1]!-oa[seam.a.vertex*2+1]!,error=Math.hypot(b[seam.b.vertex*2]!-a[seam.a.vertex*2]!-dx,b[seam.b.vertex*2+1]!-a[seam.a.vertex*2+1]!-dy),detail={time,seam:seam.name,error,tolerance:seam.tolerance,a:{...seam.a,slot:targets[seam.ai]!.slot,attachment:targets[seam.ai]!.attachment,point:points(a,[seam.a.vertex])[0]},b:{...seam.b,slot:targets[seam.bi]!.slot,attachment:targets[seam.bi]!.attachment,point:points(b,[seam.b.vertex])[0]},expectedOffset:{x:dx,y:dy},points:[...points(a,[seam.a.vertex]),...points(b,[seam.b.vertex])]};
   if(!perSeam[si]!.peak||error>perSeam[si]!.maxError)perSeam[si]!.peak=detail;perSeam[si]!.maxError=Math.max(perSeam[si]!.maxError,error);maxSeamError=Math.max(maxSeamError,error);if(error>seam.tolerance)issue({type:'seam_gap',...detail});
  }
 }
 const stripped:any=structuredClone(clip),old:any=structuredClone(source.animations[args.animation]);for(const t of targets){delete stripped.attachments[args.skin][t.slot][t.attachment].deform;if(old.attachments?.[args.skin]?.[t.slot]?.[t.attachment])delete old.attachments[args.skin][t.slot][t.attachment].deform;}const unselectedChannelsUnchanged=JSON.stringify(prune(stripped))===JSON.stringify(prune(old)),originalAnimationsPreserved=Object.keys(source.animations).every(n=>JSON.stringify(source.animations![n])===JSON.stringify(data.animations![n])),checksPassed=unselectedChannelsUnchanged&&originalAnimationsPreserved&&perTarget.every(t=>!t.folds&&!t.stretches&&t.maxCorrection<=t.limit+args.tolerance&&t.maxPinnedMovement<=args.tolerance)&&perSeam.every(s=>s.maxError<=s.tolerance);
 return{data,report:{checksPassed,mode:'coupled_mesh_area_edge_and_seam_projection',animation:args.animation,newName:args.newName,skin:args.skin,totalVertices,totalTriangles,frames:times.length,verificationSamples:steps+1,visits,iterations,beforeFolded,beforeStretched,correctedFrames,maxCorrection,maxSeamError,targets:perTarget,seams:perSeam,diagnostics:{issueCount,issues,truncated:issueCount>issues.length},nativeSparseZeroEpsilon:.0101,postQuantizationVerification:true,unselectedChannelsUnchanged,originalAnimationsPreserved,topologyAndWeightsUnchanged:true,scope:'Explicit vertex seams across always-active independent meshes, no linked dependents or physics. Whole-clip repair is verified at doubled FPS; geometric success is not human motion acceptance.'}};
}
export function buildJointMeshRepair(source:SpineDocument,args:Args){
 if(!source.animations?.[args.animation]||Object.hasOwn(source.animations,args.newName))throw Error('Choose an existing source clip and a NEW joint repair clip name.');
 if(args.seamPlan||!args.seams.length)throw Error('Resolve the explicitly reviewed seam plan or supply explicit seams before building.');
 const prepared=prepareJointMeshCompatibility(source,args),working={...args,animation:prepared.animation,skin:prepared.skin,targets:prepared.targets},built=buildIndependentJointRepair(prepared.data,working,prepared.report.physicsCaptured),comparisonData=prepared.temporaryAnimation?structuredClone(built.data):undefined;
 if(prepared.temporaryAnimation)delete built.data.animations![prepared.temporaryAnimation];
 const originalAnimationsPreserved=Object.entries(source.animations).every(([n,a])=>JSON.stringify(a)===JSON.stringify(built.data.animations![n])),originalSkinsUnchanged=JSON.stringify((built.data.skins as unknown[]??[]).slice(0,(source.skins as unknown[]??[]).length))===JSON.stringify(source.skins??[]),originalBoneAndConstraintDefinitionsUnchanged=JSON.stringify(built.data.bones)===JSON.stringify(source.bones)&&JSON.stringify(constraintList(built.data))===JSON.stringify(constraintList(source));
 const checksPassed=built.report.checksPassed&&originalAnimationsPreserved&&originalSkinsUnchanged&&originalBoneAndConstraintDefinitionsUnchanged;
 return{data:built.data,comparisonData,comparisonAnimation:prepared.animation,report:{...built.report,checksPassed,animation:args.animation,sourceSkin:args.skin,skin:prepared.skin,resolvedTargets:prepared.targets.map(t=>({id:t.id,slot:t.slot,attachment:t.attachment})),referenceTargets:args.targets.map(t=>({id:t.id,slot:t.slot,attachment:t.attachment})),compatibility:prepared.report,originalAnimationsPreserved,originalSkinsUnchanged,originalBoneAndConstraintDefinitionsUnchanged,channelComparisonBasis:prepared.report.used?'Captured/isolation baseline of the source clip in the explicit output skin':'Original source clip',recommendedEditorSelection:{skin:prepared.skin,animation:args.newName},scope:'Explicit finite-sampled joint repair. Linked meshes require a separate output skin; physics requires explicit deterministic sampled capture. All original clips, skins, bones and constraint definitions are retained.'}};
}
export async function createJointMeshRepair(service:SpineService,raw:z.input<typeof jointMeshRepairSchema>){
 const args=jointMeshRepairSchema.parse(raw);if(Boolean(args.seamPlan)===Boolean(args.seams.length))throw Error('Provide either explicit seams or one explicitly reviewed seam plan.');
 return operation(service,args.requestId,'joint_mesh_repair',args,async()=>{
  const source=await captureSource(service,args.input),selected=args.seamPlan?await resolveReviewedMeshSeams(service,source,args.targets,args.skin,args.seamPlan):undefined,resolved={...args,seams:selected?.seams??args.seams,seamPlan:undefined},built=buildJointMeshRepair(source.data,resolved),folder=await newFolder(service,'joint-mesh-repairs'),json=path.join(folder,'skeleton.json');await writeDocument(service.workspace,json,built.data,path.dirname(source.jsonPath));
  const diagnosticPreviews=built.report.diagnostics.issueCount?await meshRepairIssuePreviews(service,parseDocument(JSON.parse(await readFile(json,'utf8'))),json,args.newName,built.report.skin,built.report.resolvedTargets,built.report.diagnostics.issues,Math.max(128,args.comparison.width),Math.max(128,args.comparison.height),folder):[];
  const comparisonJson=built.comparisonData?path.join(folder,'comparison-source.json'):json;if(built.comparisonData)await writeDocument(service.workspace,comparisonJson,built.comparisonData,path.dirname(source.jsonPath));
  const comparison=await comparisonMedia(service,parseDocument(JSON.parse(await readFile(comparisonJson,'utf8'))),comparisonJson,built.comparisonAnimation,args.newName,built.report.skin,args.comparison);await verifySource(service,source.source);
  const candidate=await writeCandidate(service,'joint_mesh_repair',json,source.source,{verification:built.report,reviewedSeams:selected?.selection,diagnosticPreviews,comparison,visualAcceptance:'pending',suggestedPublishQuality:{mode:'enforce',animations:[args.newName],rules:[{animation:args.newName,skin:built.report.skin}]}},built.report.checksPassed,[comparison.manifest,comparison.player,...comparison.files,...(comparison.video?[comparison.video]:[]),...(built.comparisonData?[comparisonJson]:[]),...(selected?.pins.map(p=>p.path)??[]),...diagnosticPreviews.map(p=>p.path)]);return{...candidate,displayArtifacts:diagnosticPreviews.slice(0,2)};
 });
}
