// Runs only against the owned loopback demo, in an isolated headless Chrome.
import {spawn} from 'node:child_process';
import {open,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';

const [url='http://127.0.0.1:8090/',output,mode='full']=process.argv.slice(2);
if(new URL(url).hostname!=='127.0.0.1'||!output)throw Error('Loopback URL and new evidence directory required');
await mkdir(output,{recursive:true});
const profile=path.join(output,'browser-profile');await mkdir(profile,{recursive:true});
const log=await open(path.join(output,'browser.log'),'a');
const chrome=spawn(process.env.CHROME||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
 '--headless=new','--no-first-run','--disable-background-networking','--disable-sync',
 '--disable-default-apps','--disable-gpu','--mute-audio','--disable-background-timer-throttling',
 '--disable-renderer-backgrounding','--autoplay-policy=no-user-gesture-required',
 '--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1510,1060','about:blank'
],{windowsHide:true,stdio:['ignore',log.fd,log.fd]});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let ws,id=0,session;const pending=new Map(),exceptions=[];
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{
 const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},15000);
 pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));
});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function state(){return evaluate(`(()=>{const v=document.querySelector('video');return {time:v?.currentTime,playing:!!v&&!v.paused,ready:v?.readyState,width:v?.videoWidth,height:v?.videoHeight,frames:v?.getVideoPlaybackQuality().totalVideoFrames,dropped:v?.getVideoPlaybackQuality().droppedVideoFrames,message:document.getElementById('message')?.textContent,status:document.querySelector('#status span')?.textContent,latency:window.hls?.latency,results:[...document.querySelectorAll('.result-cell.known .ball')].map(n=>Number(n.textContent))}})()`);}
async function jobs(){const r=await fetch(new URL('/api/rounds',url));if(!r.ok)throw Error('Job list HTTP '+r.status);return r.json();}
async function screenshot(name){const r=await call('Page.captureScreenshot',{format:'png'},session);await writeFile(path.join(output,name+'.png'),Buffer.from(r.data,'base64'));}
async function waitUntil(fn,ms,label){const start=Date.now();while(Date.now()-start<ms){const v=await fn();if(v)return v;await delay(500);}throw Error('Timeout: '+label);}

try{
 let port;await waitUntil(async()=>{try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);return port;}catch{return false;}},15000,'Chrome start');
 const version=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json());
 ws=new WebSocket(version.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);});
 const {targetId}=await call('Target.createTarget',{url:'about:blank'});
 ({sessionId:session}=await call('Target.attachToTarget',{targetId,flatten:true}));
 await call('Page.enable',{},session);await call('Runtime.enable',{},session);
 await call('Page.navigate',{url},session);
 await waitUntil(()=>evaluate(`!!document.getElementById('n5')`),10000,'page ready');
 if(mode==='startup'){
  const first=await waitUntil(async()=>{const s=await state();return s.playing&&s.time>2&&s.width===1280?s:false;},15000,'restored replay');
  const inputs=await evaluate(`[...Array.from({length:6},(_,i)=>Number(document.getElementById('n'+i).value)),Number(document.getElementById('special').value)]`);
  const completed=(await jobs()).find(j=>j.replayReady);
  if(!completed||inputs.join(',')!==completed.numbers.join(','))throw Error('Restored replay inputs disagree');
  await delay(6000);const second=await state();
  if(second.time-first.time<4||exceptions.length)throw Error('Restored replay failed');
  await screenshot('startup');
  const result={passed:true,mode,url,first,second,inputs,jsExceptions:exceptions};
  await writeFile(path.join(output,'startup-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }else{
 if((await jobs()).length)throw Error('Verifier requires a fresh owned demo state directory');
 await screenshot('ready');
 const rounds=[];
 const cases=[['reference',[40,48,10,20,27,11,4],'reference'],['49',[1,12,23,34,45,6,49],'special49']];
 for(const [preset,numbers,label] of mode==='reference'?cases.slice(0,1):cases){
  await evaluate(`document.querySelector('[data-preset="${preset}"]').click();document.getElementById('form').requestSubmit();true`);
  let job=await waitUntil(async()=>{const list=await jobs();return list.find(j=>j.numbers.join(',')===numbers.join(',')&&!['completed','cancelled','failed'].includes(j.state));},10000,'round submission');
  const gates=await evaluate(`(async()=>{const r=${JSON.stringify(job.request)};const post=body=>fetch('/api/rounds',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Key':window.demoKey},body:JSON.stringify(body)});const a=await post(r);const conflict=await post({...r,specialNumber:${numbers[6]===49?48:49}});const duplicate=await post({...r,requestId:crypto.randomUUID(),roundId:r.roundId+'-invalid',specialNumber:r.regularNumbers[0]});const locked=await post({...r,requestId:crypto.randomUUID(),roundId:r.roundId+'-locked'});return {idempotent:a.status,conflict:conflict.status,duplicate:duplicate.status,locked:locked.status}})()`);
  if(JSON.stringify(gates)!==JSON.stringify({idempotent:200,conflict:409,duplicate:400,locked:409}))throw Error('API gates failed '+JSON.stringify(gates));
  const first=await waitUntil(async()=>{const s=await state();return s.playing&&s.time>3&&s.width===1280?s:false;},25000,'HLS playback');
  await delay(6000);const second=await state();
  if(second.time-first.time<4||second.frames-first.frames<90)throw Error('HLS did not advance '+JSON.stringify({first,second}));
  const start=Date.now();let nextLog=0,mixed=false,settled=false;
  while(Date.now()-start<150000){
   job=(await jobs()).find(j=>j.id===job.id);
   if(job.state==='failed')throw Error('Native job failed: '+job.error);
   const s=await state();
   if(s.time>=30&&!mixed){await screenshot(label+'-mixing');mixed=true;}
   if(s.time>=67&&!settled){await screenshot(label+'-settled');settled=true;}
   if(Date.now()-start>=nextLog){console.log(JSON.stringify({label,state:job.state,sourceFrames:job.frames,videoTime:s.time,videoFrames:s.frames}));nextLog+=30000;}
   if(job.state==='completed')break;
   await delay(1000);
  }
  if(job.state!=='completed'||!job.replayReady||job.frames!==3510)throw Error('Incomplete replay '+JSON.stringify(job));
  await waitUntil(()=>evaluate(`!document.getElementById('replay').disabled`),5000,'completed status reached page');
  await evaluate(`document.getElementById('replay').click();true`);
  await waitUntil(()=>evaluate(`(()=>{const v=document.querySelector('video');return v.readyState>=2&&v.currentSrc.includes('replay.mp4')})()`),10000,'MP4 replay');
  await evaluate(`(()=>{const v=document.querySelector('video');v.pause();v.currentTime=70;return true})()`);
  await waitUntil(()=>evaluate(`(()=>{const v=document.querySelector('video');return !v.seeking&&Math.abs(v.currentTime-70)<.1})()`),10000,'seek to final result');
  await delay(300);const replay=await state();
  if(replay.results.join(',')!==numbers.join(','))throw Error('DOM result order differs from input '+JSON.stringify(replay));
  await screenshot(label+'-replay');
  await evaluate(`document.querySelector('video').currentTime=52;true`);
  await waitUntil(()=>evaluate(`(()=>{const v=document.querySelector('video');return !v.seeking&&Math.abs(v.currentTime-52)<.1})()`),10000,'seek to compared52-second view');
  await delay(200);await screenshot(label+'-52-seconds');
  const media=await fetch(new URL(job.replay,url),{headers:{Range:'bytes=0-63'}});await media.arrayBuffer();
  if(media.status!==206)throw Error('MP4 range playback unavailable');
  rounds.push({id:job.id,numbers,gates,first,second,replay,frames:job.frames,replayReady:job.replayReady});
  console.log(JSON.stringify({label,passed:true,jobId:job.id}));
 }
 await evaluate(`document.querySelector('[data-preset="reference"]').click();document.getElementById('form').requestSubmit();true`);
 const cancelJob=await waitUntil(async()=>{const list=await jobs();return list.find(j=>j.state==='playing');},20000,'cancellation round');
 await evaluate(`document.getElementById('stop').click();true`);
 const cancelled=await waitUntil(async()=>{const j=(await jobs()).find(j=>j.id===cancelJob.id);return j.state==='cancelled'?j:false;},25000,'owned worker cleanup');
 await delay(1200);
 if(!await evaluate(`!document.getElementById('submit').disabled`))throw Error('Submit did not unlock after cancellation');
 await screenshot('stopped');
 const result={passed:true,url,rounds,cancellation:{id:cancelled.id,state:cancelled.state,frames:cancelled.frames},jsExceptions:exceptions,headlessProfileIsolated:true};
 if(exceptions.length)throw Error('Browser JS exceptions '+JSON.stringify(exceptions));
 await writeFile(path.join(output,'browser-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,rounds:rounds.length,cancellation:cancelled.state,evidence:output}));
 }
}catch(e){let lastState;try{lastState=await state();await screenshot('failure');}catch{}await writeFile(path.join(output,'failure.json'),JSON.stringify({error:e.stack,lastState,exceptions},null,2));throw e;}
finally{
 if(ws?.readyState===WebSocket.OPEN){try{await call('Browser.close');}catch{}ws.close();}
 if(chrome.exitCode===null)chrome.kill();await log.close();
}
