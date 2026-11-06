import { z } from 'zod/v4';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, open, stat } from 'node:fs/promises';
import { TextureAtlas } from '@esotericsoftware/spine-core';
import type { SpineService } from './service.js';
import { VERSION } from './version.js';
import { filename, sha, request, pin, verifyPins, immutableJson, jsonRead, operation, digest } from './character-candidates.js';
import { syncLease } from './sync-lock.js';
import { readPngAsset } from './image-assets.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const liveRoomPlanSchema = z.object({
  skeleton:filename, atlas:filename, output:filename,
  width:z.number().int().min(64).max(4096).default(1920),height:z.number().int().min(64).max(4096).default(1080),
  fps:z.number().min(1).max(120).default(30),frames:z.number().int().min(0).max(100000000).default(0),
  animation:z.string().min(1),renderer:z.enum(['auto','vulkan','d3d12','d3d11','metal','opengl']).default('vulkan'),
  pixelFormat:z.enum(['rgba','nv12']).default('nv12'),codec:z.enum(['libx264','h264_nvenc','h264_amf']).default('libx264'),
  bitrateKbps:z.number().int().min(0).max(200000).default(6000),
  audio:z.array(z.object({file:filename,gain:z.number().min(0).max(4).default(1),loop:z.boolean().default(false),offsetMs:z.number().int().min(0).max(3600000).default(0)}).strict()).max(8).default([]),
  gpu:id.optional(),maxRestarts:z.number().int().min(0).max(3).default(1),leaseSeconds:z.number().int().min(1).max(172800).default(3600),
  allowNetworkOutput:z.boolean().default(false)
}).strict();
export const startLiveRoomSchema=z.object({...request,plan:filename,expectedSha256:sha}).strict();
export const liveRoomIdSchema=z.object({id}).strict();
export const controlLiveRoomSchema=z.object({...request,id,method:z.enum(['play','pause','resume','speed','skin','seek','transform']),params:z.record(z.string().max(64),z.union([z.string().max(512),z.number().finite(),z.boolean()])).refine(v=>Object.keys(v).length<=16).default({})}).strict();
export const listLiveRoomsSchema=z.object({}).strict();

export async function planLiveRoom(service:SpineService,raw:z.input<typeof liveRoomPlanSchema>){
 const a=liveRoomPlanSchema.parse(raw);
 if(a.width%2||a.height%2||a.pixelFormat==='nv12'&&a.width%4)throw Error('H264 requires even dimensions; GPU NV12 width must be divisible by4.');
 const skeleton=await pin(service,a.skeleton),atlas=await pin(service,a.atlas);
 if((await stat(atlas.path)).size>16*1024*1024)throw Error('Atlas exceeds16MiB.');
 const parsed=new TextureAtlas(await readFile(atlas.path,'utf8'));if(!parsed.pages.length||parsed.pages.length>128)throw Error('Atlas requires1–128 pages.');
 const pins=[skeleton,atlas];let atlasBytes=0;
 for(const page of parsed.pages){
  const file=await service.workspace.resolve(path.resolve(path.dirname(atlas.path),page.name)),rel=path.relative(path.dirname(atlas.path),file);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Atlas page escapes its package.');
  const image=await readPngAsset(service.workspace,file);if(image.width!==page.width||image.height!==page.height)throw Error('Atlas page dimensions mismatch.');
  atlasBytes+=image.width*image.height*4;pins.push(await pin(service,file));
 }
 let output:string;
 if(a.output.toLowerCase().startsWith('srt://')){const u=new URL(a.output);if(!a.allowNetworkOutput||!u.hostname||!u.port)throw Error('Explicit allowNetworkOutput and a valid SRT host/port are required.');output=a.output;}
 else{if(a.output.includes('://')||!/\.(mp4|ts)$/i.test(a.output))throw Error('Output must be a NEW local MP4/TS or explicit SRT URL.');output=await service.workspace.resolve(a.output,false);try{await stat(output);throw Error('Live output already exists.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 const audio=[];for(const track of a.audio){const p=await pin(service,track.file);pins.push(p);audio.push({...track,file:p.path});}
 const config={skeleton:skeleton.path,atlas:atlas.path,width:a.width,height:a.height,fps:a.fps,frames:a.frames,warmup:10,paced:true,emitFrames:true,msaa:4,animation:a.animation,renderer:a.renderer,pixelFormat:a.pixelFormat,loop:true,mix:.2,clipFrames:90,queueFrames:2,encoder:{codec:a.codec,bitrateKbps:a.bitrateKbps},audio};
 const cfg=await immutableJson(service,'live-room-configs',config);pins.push(cfg);
 const memoryMB=Math.ceil((atlasBytes+a.width*a.height*4*10)/(1024*1024))+64;
 const report={schema:'spine-live-room-plan/1',version:VERSION,configFile:cfg.path,pins,output,memoryMB,gpu:a.gpu,maxRestarts:a.maxRestarts,leaseSeconds:a.leaseSeconds,readbackBytesPerFrame:a.width*a.height*(a.pixelFormat==='nv12'?1.5:4),hardwareEncoderRequested:a.codec!=='libx264',nativeRenderVerified:false,networkOutput:a.allowNetworkOutput&&output.startsWith('srt://'),scope:'Plan only. Start performs a real hardware-encoder probe and native initialization. Queue acceptance does not acknowledge playback, GPU capacity, audio appearance or CDN delivery.'};
 await verifyPins(service,pins);const p=await immutableJson(service,'live-room-plans',report);
 return {...report,plan:p.path,planSha256:p.sha256};
}

async function hubConfig(service:SpineService){
 const n=service.config.nativeRenderer;if(!n)throw Error('Configure nativeRenderer worker, room server, library and GPU slots first.');
 const root=service.workspace.root,folder=await service.workspace.resolve(path.join(root,'live-room-hub'),false);
 return {folder,config:{root,directory:path.join(folder,'rooms'),worker:n.workerExecutable,library:n.nativeLibrary,ffmpeg:service.config.ffmpegExecutable??'ffmpeg',ffprobe:service.config.ffprobeExecutable??'ffprobe',slots:n.slots,queueLimit:n.queueLimit??16}};
}
async function callHub(discovery:any,endpoint:string,body?:unknown){
 const url=new URL(discovery.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||!url.port)throw Error('Invalid local room-server discovery.');
 const response=await fetch(new URL(endpoint,url),{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+discovery.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000),redirect:'error'});
 const text=await response.text();if(text.length>2*1024*1024)throw Error('Room response exceeds limit.');
 const value=JSON.parse(text);if(!response.ok)throw Error(String(value.error??'Room server request failed.'));return value;
}
async function hub(service:SpineService,start:boolean){
 const {folder,config}=await hubConfig(service),discoveryFile=path.join(folder,'server.json'),configuration=createHash('sha256').update(JSON.stringify(config)).digest('hex');
 if(start)await mkdir(folder,{recursive:true});
 const existing=async()=>{const d=JSON.parse(await readFile(discoveryFile,'utf8'));const h=await callHub(d,'/health');if(h.version!=='0.2.0'||h.pid!==d.pid)throw Error('Room server identity mismatch.');if(start&&h.configSha256!==configuration)throw Error('Room server configuration changed; stop existing rooms and let the idle daemon exit before starting the new configuration.');return d;};
 try{return await existing();}catch(e){if(String(e).includes('configuration changed'))throw e;if(!start)throw Error('Room server is not running; no worker was launched.');}
 let release:Awaited<ReturnType<typeof syncLease>>=null;
 for(let i=0;i<50&&!release;i++){release=await syncLease(service.workspace,path.join(folder,'startup.lock'));if(!release)await new Promise(r=>setTimeout(r,100));}
 if(!release)throw Error('Room server startup is busy.');
 try{
  try{return await existing();}catch(e){if(String(e).includes('configuration changed'))throw e;}
  const n=service.config.nativeRenderer!;
  for(const p of[n.workerExecutable,n.roomServerExecutable,n.nativeLibrary])if(!(await stat(p)).isFile())throw Error('Native renderer executable/library unavailable.');
  const cfg=path.join(folder,'hub-config.json');await writeFile(cfg,JSON.stringify(config),{mode:0o600});
  const log=await open(path.join(folder,'server.log'),'a',0o600);
  try{
   const child=spawn(n.roomServerExecutable,['-config',cfg,'-state',discoveryFile],{detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
   let spawnError:Error|undefined;child.once('error',e=>{spawnError=e;});child.unref();
   for(let i=0;i<80;i++){if(spawnError)throw spawnError;await new Promise(r=>setTimeout(r,100));try{return await existing();}catch{}}
   throw Error('Room server startup timed out; inspect its local log.');
  }finally{await log.close();}
 }finally{await release();}
}
export async function startLiveRoom(service:SpineService,raw:z.input<typeof startLiveRoomSchema>){
 const a=startLiveRoomSchema.parse(raw);
 return operation(service,a.requestId,'start_live_room',a,async()=>{
  const p=await pin(service,a.plan);if(p.sha256!==a.expectedSha256)throw Error('Live room plan changed.');
  const plan=await jsonRead(service,p.path);if(plan.schema!=='spine-live-room-plan/1'||plan.version!==VERSION)throw Error('Incompatible live room plan.');
  await verifyPins(service,plan.pins);
  const d=await hub(service,true);return callHub(d,'/v1/rooms',{id:a.requestId,configFile:plan.configFile,output:plan.output,memoryMB:plan.memoryMB,gpu:plan.gpu,maxRestarts:plan.maxRestarts,leaseSeconds:plan.leaseSeconds,pins:plan.pins});
 });
}
export async function getLiveRoom(service:SpineService,raw:z.input<typeof liveRoomIdSchema>){const a=liveRoomIdSchema.parse(raw);return callHub(await hub(service,false),'/v1/rooms/'+a.id);}
export async function listLiveRooms(service:SpineService){return {rooms:await callHub(await hub(service,false),'/v1/rooms')};}
export async function stopLiveRoom(service:SpineService,raw:z.input<typeof liveRoomIdSchema>){const a=liveRoomIdSchema.parse(raw);return callHub(await hub(service,false),'/v1/rooms/'+a.id+'/stop',{});}
export async function controlLiveRoom(service:SpineService,raw:z.input<typeof controlLiveRoomSchema>){const a=controlLiveRoomSchema.parse(raw);return operation(service,a.requestId,'control_live_room',a,async()=>callHub(await hub(service,false),'/v1/rooms/'+a.id+'/control',{id:a.requestId,method:a.method,params:a.params}));}
