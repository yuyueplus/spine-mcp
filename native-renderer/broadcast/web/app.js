const $=id=>document.getElementById(id);
const video=$('video'),reference=[40,48,10,20,27,11,4],times=[36,41,45,50,55,59,64];
let job=null,hls=null,attached='',viewMode='live',polling=false,attaching=false,pending=false;
const colors={red:[1,2,7,8,12,13,18,19,23,24,29,30,34,35,40,45,46],blue:[3,4,9,10,14,15,20,25,26,31,36,37,41,42,47,48],green:[5,6,11,16,17,21,22,27,28,32,33,38,39,43,44,49]};
const color=n=>Object.keys(colors).find(k=>colors[k].includes(n))||'';
const terminal=s=>['completed','failed','cancelled','interrupted'].includes(s);
const clock=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;
const labels=['正码一','正码二','正码三','正码四','正码五','正码六','特码'];
for(let i=0;i<6;i++){$('numbers').insertAdjacentHTML('beforeend',`<input id="n${i}" aria-label="正码${i+1}" type="number" min="1" max="49" value="${reference[i]}" required inputmode="numeric">`);}
for(let i=0;i<7;i++){if(i===6)$('results').insertAdjacentHTML('beforeend','<span class="plus">+</span>');$('results').insertAdjacentHTML('beforeend',`<div class="result-cell ${i===6?'special':''}" id="r${i}"><span class="ball">--</span><small>${labels[i]}</small></div>`);}
function setNumbers(values){for(let i=0;i<6;i++)$('n'+i).value=values[i];$('special').value=values[6];}
function message(s){$('message').textContent=s;}
function controls(){const busy=!!job&&!terminal(job.state);$('submit').disabled=busy||pending;$('submit').innerHTML=busy?'本期演出已锁定':pending?'正在提交…':'生成并播放 <span>→</span>';$('stop').disabled=!busy||job?.state==='stopping';$('replay').disabled=!job?.replayReady;}
async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Demo-Key':window.demoKey},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||`HTTP ${r.status}`);return data;}
function dispose(){if(hls){hls.destroy();hls=null;}video.pause();video.removeAttribute('src');video.classList.remove('attached');video.load();attached='';}
function cover(title,hint){$('cover').classList.remove('hidden');$('coverTitle').textContent=title;$('coverHint').textContent=hint;}
async function attach(force=false){
 if(!job||attaching)return;if(!force&&attached===job.id+':'+viewMode)return;
 attaching=true;
 try{
  if(viewMode==='replay'){
   if(!job.replayReady)return;dispose();attached=job.id+':replay';video.src=job.replay;video.classList.add('attached');video.play().catch(()=>{});return;
  }
  const response=await fetch(job.playlist,{cache:'no-store'});if(!response.ok)return;const playlist=await response.text();if(!playlist.includes('#EXTINF'))return;
  dispose();attached=job.id+':live';video.classList.add('attached');
  if(window.Hls?.isSupported()){
   hls=new Hls({liveSyncDurationCount:3,liveMaxLatencyDurationCount:8,maxBufferLength:12,backBufferLength:8,enableWorker:true});window.hls=hls;hls.loadSource(job.playlist);hls.attachMedia(video);hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));hls.on(Hls.Events.ERROR,(_,e)=>{if(!e.fatal)return;message('播放连接中断，可以点击“重新连接画面”。');});
  }else if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=job.playlist;video.play().catch(()=>{});}else message('当前浏览器不支持此H.264直播，请使用Chrome或Edge。');
 }catch(e){message(e.message);}finally{attaching=false;}
}
function updateState(){
 if(!job)return;const names={preparing:'正在准备',playing:'正在输出',completed:'本期完成',failed:'任务失败',cancelled:'已停止',stopping:'正在停止',interrupted:'任务已中断'};
 $('status').className='status '+(job.state==='playing'?'active':job.state==='failed'?'error':'');$('status').querySelector('span').textContent=names[job.state]||job.state;
 $('roundLabel').textContent=`${job.request.roundId} · ${viewMode==='replay'?'本期回放':'指定结果演示'}`;
 $('statusHint').textContent=job.error||(job.state==='preparing'?'号码已锁定，正在准备场景和视频连接。':job.state==='playing'?'服务器正在输出画面；观看端有正常缓冲延迟。':job.state==='stopping'?'正在停止输出并等待视频进程退出。':job.replayReady?'回放已完成完整解码帧数检查，可从头观看。':'任务已结束，可提交新的一轮。');
 if(job.state==='failed'){cover('本次生成未完成',job.error||'请查看后台任务记录');message(job.error||'任务失败');}
 else if(job.state==='cancelled')cover('本期演示已停止','可以修改号码，再生成新的一轮。');
 controls();
}
function render(){
 const t=Number.isFinite(video.currentTime)?Math.max(0,Math.min(117,video.currentTime)):0;
 let count=0;for(let i=0;i<7;i++){const known=!!job&&t>=(job.settledAt||times)[i],el=$('r'+i);if(known)count++;el.className='result-cell '+(i===6?'special ':'')+(known?'known '+color(job.numbers[i]):'');el.querySelector('.ball').textContent=known?String(job.numbers[i]).padStart(2,'0'):'--';}
 $('revealed').textContent=`${count} / 7`;$('clock').textContent=clock(t)+' / 01:57';$('progress').style.width=`${t/117*100}%`;
 const phase=t<24?'准备与开场':t<34.6?'球舱搅拌':t<65?'依次出球':t<69?'彩球落定':t<99?'结果展示':t<102?'演出收尾':'最终结果';$('phase').textContent=job?phase:'等待提交';
 if(video.readyState>=2&&!video.paused){$('cover').classList.add('hidden');$('badge').className='badge playing';$('badge').textContent=viewMode==='replay'?'本期回放':'演示播放中';}
 if(video.ended){$('badge').className='badge';$('badge').textContent='本期演示结束';}
 requestAnimationFrame(render);
}
async function select(j,initial=false){dispose();job=j;if(initial)setNumbers(j.numbers);viewMode=initial&&j.replayReady?'replay':'live';message('');cover('正在准备本期演出','场景与声音由后台生成，请稍候。');$('badge').textContent='准备中';updateState();await attach();}
async function poll(){if(polling)return;polling=true;try{if(job){job=await api('/api/rounds/'+job.id);updateState();await attach();}else{const list=await api('/api/rounds');if(list.length)await select(list.find(j=>!terminal(j.state))||list.find(j=>j.replayReady)||list[0],true);}$('connection').textContent='本机服务已连接';}catch(e){$('connection').textContent='服务连接中断';message(e.message);}finally{polling=false;}}
$('form').addEventListener('submit',async event=>{event.preventDefault();message('');const nums=[...Array.from({length:6},(_,i)=>Number($('n'+i).value)),Number($('special').value)];if(nums.some(n=>!Number.isInteger(n)||n<1||n>49)||new Set(nums).size!==7){message('请输入七个不同的1–49整数。');return;}pending=true;controls();try{const id=crypto.randomUUID();const request={mode:'scripted_demo',roundId:'demo-'+new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+id.slice(0,4),requestId:id,regularNumbers:nums.slice(0,6),specialNumber:nums[6]};const j=await api('/api/rounds',request);await select(j);}catch(e){const translations={ROUND_LOCKED:'当前演出尚未结束，请先停止或等待完成。',ROUND_EXISTS:'该期号已经存在。',HISTORY_LIMIT:'演示记录已达上限，请使用新的运行目录。'};message(translations[e.message]||e.message);}finally{pending=false;controls();}});
document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{let numbers;if(button.dataset.preset==='reference')numbers=reference;else if(button.dataset.preset==='49')numbers=[1,12,23,34,45,6,49];else{const all=Array.from({length:49},(_,i)=>i+1);for(let i=all.length-1;i>0;i--){const b=new Uint32Array(1);crypto.getRandomValues(b);const j=b[0]%(i+1);[all[i],all[j]]=[all[j],all[i]];}numbers=all.slice(0,7);}setNumbers(numbers);message('号码已填入；点击“生成并播放”后生效。');}));
$('stop').addEventListener('click',async()=>{if(!job)return;$('stop').disabled=true;try{job=await api('/api/rounds/'+job.id+'/stop',{});updateState();dispose();}catch(e){message(e.message);}});
$('replay').addEventListener('click',async()=>{viewMode='replay';updateState();await attach(true);});
$('retry').addEventListener('click',()=>attach(true));
video.addEventListener('playing',()=>{message('');$('cover').classList.add('hidden');});
video.addEventListener('error',()=>{if(attached)message('视频尚未连接或已中断，请重试连接。');});
requestAnimationFrame(render);poll();setInterval(poll,1000);
