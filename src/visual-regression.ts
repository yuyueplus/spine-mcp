import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { renderArtwork } from './scene-preview.js';
import { encodePng } from './raster.js';
import { VERSION } from './version.js';
import { captureSource, immutableJson, newFolder, operation, request, filename, label, sha, pin, verifyPins, verifySource, jsonRead } from './character-candidates.js';
import { requireManagedFile } from './product-guards.js';

const n=z.number().finite();
const viewport=z.object({minX:n,maxX:n,minY:n,maxY:n}).strict().refine(v=>v.maxX>v.minX&&v.maxY>v.minY,'Nonempty viewport required.');
const frame=z.object({animation:label.optional(),time:n.min(0).max(120),skin:label.optional()}).strict();
export const visualBaselineSchema=z.object({...request,input:filename,name:label,frames:z.array(frame).min(1).max(64),width:z.number().int().min(32).max(1024).default(512),height:z.number().int().min(32).max(1024).default(512),viewport,physics:z.boolean().default(false),fps:z.number().int().min(15).max(120).default(60)}).strict();
export const visualCompareSchema=z.object({...request,baseline:filename,expectedSha256:sha,input:filename,animationMap:z.record(z.string(),z.string()).default({}),skinMap:z.record(z.string(),z.string()).default({}),pixelTolerance:n.min(0).max(255).default(2),maxChangedRatio:n.min(0).max(1).default(.001),maxMeanError:n.min(0).max(255).default(.1),ignore:z.array(z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive(),height:z.number().int().positive()}).strict()).max(64).default([])}).strict();
async function rendered(service:SpineService,source:Awaited<ReturnType<typeof captureSource>>,f:z.output<typeof frame>,options:any){
 const r=await renderArtwork(service.workspace,source.data,source.jsonPath,f.animation,[f.time],f.skin,{...options,clean:true,transparent:true});return pin(service,r.path);
}
export async function createVisualBaseline(service:SpineService,raw:z.input<typeof visualBaselineSchema>){
 const a=visualBaselineSchema.parse(raw);return operation(service,a.requestId,'visual_baseline',a,async()=>{
  if(a.width*a.height*a.frames.length>16777216)throw Error('Visual baseline exceeds16MP rendered-pixel budget.');
  const source=await captureSource(service,a.input),frames=[];
  for(const f of a.frames)frames.push({...f,image:await rendered(service,source,f,a)});
  await verifySource(service,source.source);const p=await immutableJson(service,'visual-baselines',{schema:'spine-visual-baseline/1',version:VERSION,name:a.name,source:source.source,settings:{width:a.width,height:a.height,viewport:a.viewport,physics:a.physics,fps:a.fps},frames,renderer:'CPU artwork, official Spine4.3.13 + deterministic texture rasterizer',meaning:'A visual reference, not an aesthetic approval.'});
  return{baseline:p.path,baselineSha256:p.sha256,frames:frames.length,viewport:a.viewport,pinnedFiles:[p,...frames.map(f=>f.image)]};
 });
}
export function comparePixels(before:{width:number;height:number;data:Uint8Array},after:{width:number;height:number;data:Uint8Array},options:{pixelTolerance:number;maxChangedRatio:number;maxMeanError:number;ignore:{x:number;y:number;width:number;height:number}[]}){
 if(before.width!==after.width||before.height!==after.height)throw Error('Visual image dimensions changed.');
 const {width,height}=before,difference=new Uint8Array(width*height*4);let changed=0,compared=0,sum=0,max=0,minX=width,minY=height,maxX=-1,maxY=-1;
 for(const r of options.ignore)if(r.x+r.width>width||r.y+r.height>height)throw Error('Ignore rectangle exceeds baseline canvas.');
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const at=(y*width+x)*4;if(options.ignore.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height))continue;compared++;
  let peak=0;for(let c=0;c<4;c++){const delta=Math.abs(before.data[at+c]!-after.data[at+c]!);sum+=delta;max=Math.max(max,delta);peak=Math.max(peak,delta);}
  difference.set([peak,0,peak?32:0,peak?255:0],at);
  if(peak>options.pixelTolerance){changed++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
 }
 if(!compared)throw Error('All pixels were masked; visual comparison would be meaningless.');
 const meanError=sum/(compared*4),changedRatio=changed/compared;
 return{passed:changedRatio<=options.maxChangedRatio&&meanError<=options.maxMeanError,changedPixels:changed,comparedPixels:compared,changedRatio,meanError,maxComponentError:max,bounds:changed?{minX,minY,maxX,maxY}:null,difference};
}
export async function compareVisualBaseline(service:SpineService,raw:z.input<typeof visualCompareSchema>){
 const a=visualCompareSchema.parse(raw);return operation(service,a.requestId,'visual_compare',a,async()=>{
  const p=await pin(service,a.baseline);await requireManagedFile(service,p.path,'visual-baselines');if(p.sha256!==a.expectedSha256)throw Error('Visual baseline manifest changed.');const baseline=await jsonRead(service,p.path);
  if(baseline.schema!=='spine-visual-baseline/1'||baseline.version!==VERSION||baseline.frames.length>64)throw Error('Incompatible visual baseline.');await verifyPins(service,baseline.frames.map((f:any)=>f.image));
  const source=await captureSource(service,a.input),folder=await newFolder(service,'visual-comparisons'),frames:any[]=[],files:any[]=[];
  for(const [i,f]of baseline.frames.entries()){
   const current={...f,animation:f.animation?(a.animationMap[f.animation]??f.animation):undefined,skin:f.skin?(a.skinMap[f.skin]??f.skin):undefined};
   const image=await rendered(service,source,current,baseline.settings),before=PNG.sync.read(await readFile(f.image.path)),after=PNG.sync.read(await readFile(image.path)),{difference,...metrics}=comparePixels(before,after,a),diff=path.join(folder,`difference-${i}.png`);
   await writeFile(diff,encodePng(before.width,before.height,difference),{flag:'wx'});files.push(image,await pin(service,diff));frames.push({time:f.time,animation:current.animation,skin:current.skin,before:f.image,after:image,difference:diff,...metrics});
  }
  await verifySource(service,source.source);await verifyPins(service,baseline.frames.map((f:any)=>f.image));
  const report=await immutableJson(service,'visual-comparison-reports',{schema:'spine-visual-comparison/1',baseline:p,source:source.source,settings:baseline.settings,thresholds:{pixelTolerance:a.pixelTolerance,maxChangedRatio:a.maxChangedRatio,maxMeanError:a.maxMeanError,ignore:a.ignore},passed:frames.every(f=>f.passed),frames,meaning:'Detects image differences under an explicit shared camera; no automatic anatomy or aesthetic judgment.'});
  return{passed:frames.every(f=>f.passed),report:report.path,reportSha256:report.sha256,frames,displayArtifacts:files.filter(f=>f.path.endsWith('difference-0.png')).map(f=>({path:f.path,sha256:f.sha256})),pinnedFiles:[report,...files]};
 });
}
