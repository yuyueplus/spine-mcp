import path from 'node:path';
import {spawn} from 'node:child_process';
import {readFile,writeFile,open,stat,readdir} from 'node:fs/promises';
import {fileSha256} from './file-hash.js';
import {atomicJson} from './jobs.js';
const[file,expected]=process.argv.slice(2);if(!file||!expected||await fileSha256(file)!==expected)throw Error('Acceptance metadata changed.');
const job=JSON.parse(await readFile(file,'utf8'));if(job.schema!=='spine-native-acceptance/1'||job.folder!==path.dirname(file)||job.output!==path.join(job.folder,'run'))throw Error('Invalid owned acceptance metadata.');
let stopped=false,budgetExceeded=false,child:ReturnType<typeof spawn>|undefined,state:any={state:'starting',controllerPid:process.pid,heartbeatAt:new Date().toISOString()};const stateFile=path.join(job.folder,'state.json');
const save=async()=>{state.heartbeatAt=new Date().toISOString();await atomicJson(stateFile,state);};
const log=await open(path.join(job.folder,'native.log'),'ax');
try{
 for(const p of job.pins)if(await fileSha256(p.path)!==p.sha256)throw Error('Acceptance source changed.');if(await fileSha256(job.executable)!==job.executableSha256)throw Error('Acceptance executable changed.');
 child=spawn(job.executable,['-hub',job.hub,'-session',job.session,'-output',job.output,'-rooms',String(job.rooms),'-seconds',String(job.seconds),'-require-hardware='+String(job.requireHardware),'-stop-on-stdin-eof=true'],{windowsHide:true,stdio:['pipe',log.fd,log.fd]});await new Promise<void>((resolve,reject)=>{child!.once('spawn',()=>resolve());child!.once('error',reject);});state={...state,state:'running',nativePid:child.pid,startedAt:new Date().toISOString()};await save();
 const exists=async(f:string)=>{try{await stat(f);return true;}catch{return false;}};
 let busy=false;const timer=setInterval(()=>{if(busy)return;busy=true;void(async()=>{if(await exists(path.join(job.folder,'stop.requested'))){stopped=true;child?.stdin?.end();}let bytes=0;for(const f of await readdir(job.output).catch(()=>[]))if(/\.ts$/.test(f))bytes+=(await stat(path.join(job.output,f))).size;if(bytes>job.maximumOutputMiB*1024**2){budgetExceeded=true;child?.stdin?.end();}state.outputBytes=bytes;await save();})().catch(e=>{state.supervisorError=String(e);child?.stdin?.end();}).finally(()=>{busy=false;});},2000);
 const code=await new Promise<number|null>((resolve,reject)=>{child!.once('exit',c=>resolve(c));child!.once('error',reject);});clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,20));
 const report=await readFile(path.join(job.output,'acceptance.json'),'utf8').then(s=>JSON.parse(s)).catch(()=>undefined);
 state={...state,state:stopped?'stopped':budgetExceeded?'failed':code===0&&report?.passed?'passed':'failed',exitCode:code,endedAt:new Date().toISOString(),acceptanceSha256:report?await fileSha256(path.join(job.output,'acceptance.json')):undefined,error:budgetExceeded?'Explicit output budget exceeded.':code!==0&&!stopped?'Native acceptance failed; inspect native.log.':undefined};await save();
}catch(e){child?.stdin?.end();state={...state,state:'failed',error:String(e),endedAt:new Date().toISOString()};await save();process.exitCode=1;}finally{await log.close();}
