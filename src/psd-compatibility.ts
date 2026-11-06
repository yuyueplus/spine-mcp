import path from 'node:path';
import {writeFile,stat} from 'node:fs/promises';
import {z} from 'zod/v4';
import type {SpineService} from './service.js';
import {projectRoot} from './config.js';
import {rasterRuntime} from './psd-rasterization.js';
import {runProcess} from './cli.js';
import {filename,pin,verifyPins,newFolder} from './character-candidates.js';
import {fileSha256} from './file-hash.js';
export const psdCompatibilitySchema=z.object({input:filename}).strict();
export async function inspectPsdCompatibility(service:SpineService,raw:z.input<typeof psdCompatibilitySchema>){const a=psdCompatibilitySchema.parse(raw),source=await pin(service,a.input);if((await stat(source.path)).size>128*1024**2)throw Error('PSD exceeds128MiB.');const runtime=await rasterRuntime(),helper=path.join(projectRoot,'src/psd-sections.py'),hash=await fileSha256(helper),folder=await newFolder(service,'psd-compatibility'),request=path.join(folder,'request.json');await writeFile(request,JSON.stringify({input:source.path,sourceSha256:source.sha256,operation:'inspect'}),{flag:'wx'});const r=await runProcess(runtime.python,[helper,request],120000);let report:any;try{report=JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!);}catch{throw Error('Invalid PSD compatibility response.');}if(r.exitCode!==0||report.error)throw Error(report.error??r.stderr.slice(0,500));await verifyPins(service,[source]);if(await fileSha256(helper)!==hash)throw Error('PSD helper changed.');return{...report,source,helperSha256:hash};}
