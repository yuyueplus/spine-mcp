import argparse,base64,hashlib,http.server,io,json,os,pathlib,secrets,subprocess,tarfile,threading,time,urllib.request,urllib.parse,uuid

parser=argparse.ArgumentParser(description='Serve a loopback HLS viewer for one owned Spine MCP live room.')
parser.add_argument('--config',type=pathlib.Path,required=True,help='Viewer JSON configuration; relative paths resolve beside this file.')
args=parser.parse_args()
CONFIG=args.config.resolve()
SETUP=json.loads(CONFIG.read_text(encoding='utf-8-sig'))
def local_path(value):
 p=pathlib.Path(value)
 return (CONFIG.parent/p).resolve() if not p.is_absolute() else p.resolve()
ROOT=local_path(SETUP['directory'])
WEB=ROOT/'web'
(WEB/'stream').mkdir(parents=True,exist_ok=True)
FFMPEG=SETUP.get('ffmpeg','ffmpeg')
if pathlib.Path(FFMPEG).is_absolute() or len(pathlib.Path(FFMPEG).parts)>1:FFMPEG=str(local_path(FFMPEG))
DISCOVERY=local_path(SETUP['hubState'])
SETUP.setdefault('durationSeconds',3600)
if not 30<=SETUP['durationSeconds']<=172800:raise ValueError('durationSeconds must be 30..172800')
if not 1<=SETUP['srtPort']<=65535:raise ValueError('srtPort must be 1..65535')
HTTP_PORT=SETUP.get('httpPort',8088)
if not 0<=HTTP_PORT<=65535:raise ValueError('httpPort must be 0..65535')
WIDTH=int(SETUP.get('width',1280));HEIGHT=int(SETUP.get('height',720));FPS=int(SETUP.get('fps',30))
if not 64<=WIDTH<=4096 or not 64<=HEIGHT<=4096 or not 1<=FPS<=120:raise ValueError('Invalid video dimensions or frame rate')
# Pin the same player release used in the verified local browser demo.
if not (WEB/'hls.min.js').is_file() or not (WEB/'HLS-LICENSE.txt').is_file():
 url='https://registry.npmjs.org/hls.js/-/hls.js-1.6.13.tgz'
 integrity='sha512-hNEzjZNHf5bFrUNvdS4/1RjIanuJ6szpWNfTaX5I6WfGynWXGT7K/YQLYtemSvFExzeMdgdE4SsyVLJbd5PcZA=='
 with urllib.request.urlopen(url,timeout=30) as response:data=response.read(32*1024*1024+1)
 if len(data)>32*1024*1024 or integrity!='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode():raise ValueError('HLS player integrity mismatch')
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
  for name,target in [('package/dist/hls.light.min.js','hls.min.js'),('package/LICENSE','HLS-LICENSE.txt')]:
   member=archive.extractfile(name)
   if member is None:raise ValueError('HLS release file missing')
   (WEB/target).write_bytes(member.read())
ID=str(uuid.UUID(SETUP['roomId']))
START=time.time();EXPIRES=START+SETUP['durationSeconds']
STOP_TOKEN=secrets.token_urlsafe(32)
STOP=threading.Event()
STATE={'active':True,'status':'starting','motion':'待机微风','error':None}
LOCK=threading.Lock()
CLIPS=[(c['animation'],c.get('label',c['animation'])) for c in SETUP.get('clips',[{'animation':'idle','label':'当前动作'}])]
if not 1<=len(CLIPS)<=32:raise ValueError('clips requires 1..32 entries')
STATE['motion']=CLIPS[0][1]
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))

def rpc(endpoint,body=None):
 discovery=json.loads(DISCOVERY.read_text())
 url=urllib.parse.urlparse(discovery['url'])
 if url.scheme!='http' or url.hostname!='127.0.0.1':raise ValueError('Unexpected control endpoint')
 request=urllib.request.Request(discovery['url']+endpoint,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+discovery['token'],'Content-Type':'application/json'})
 with OPENER.open(request,timeout=4) as response:return json.load(response)

HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spine 动画直播</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0d1422;color:#eef3ff;font:15px system-ui,"Microsoft YaHei",sans-serif}main{max-width:1320px;margin:auto;padding:28px 24px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}h1{font-size:24px;font-weight:650;letter-spacing:.02em;margin:0 0 8px}p{color:#aab7cf;margin:0;line-height:1.6}.badge{color:#ffb4be;background:#51243180;border:1px solid #a84d6050;border-radius:30px;padding:8px 14px;white-space:nowrap}.dot{display:inline-block;width:7px;height:7px;background:#ff617d;border-radius:50%;margin-right:8px;box-shadow:0 0 14px #ff617d}.stage{background:#1d2434;border:1px solid #384359;border-radius:16px;overflow:hidden;box-shadow:0 16px 60px #0005}video{width:100%;aspect-ratio:16/9;display:block;background:#1d2434;max-height:78vh}footer{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-top:18px;flex-wrap:wrap}.small{font-size:13px;color:#8c9cb9;margin-top:6px}button{color:#cdd9ed;background:#1e2b40;border:1px solid #394b68;padding:10px 16px;border-radius:9px;cursor:pointer}button:hover{background:#2c3c56}button:disabled{opacity:.5;cursor:default}#hint{min-height:24px;color:#8ed7bc;font-size:14px;margin-top:12px}@media(max-width:600px){main{padding:18px 12px}h1{font-size:20px}.badge{padding:6px 10px}header{align-items:flex-start}}</style>
<main><header><div><h1>Spine 动画直播</h1><p>二次元角色 · 五组动作轮播 · 720p / 30 FPS</p></div><span class="badge"><i class="dot"></i><span id="live">连接中</span></span></header>
<section class="stage"><video id="video" controls autoplay muted playsinline></video></section>
<div id="hint">正在连接本机直播…</div><footer><div><div id="motion">当前动作：待机微风</div><div class="small" id="expiry">直播默认持续一小时</div><div class="small">默认静音；暂停播放器后，直播仍会继续。</div></div><button id="stop">结束本机直播</button></footer></main>
<script src="/hls.min.js"></script><script>
const video=document.getElementById('video'),hint=document.getElementById('hint'),badge=document.getElementById('live'),stop=document.getElementById('stop');let ended=false,hls;
function play(){video.play().catch(()=>{hint.textContent='点击播放器中的播放按钮开始观看';});}
if(Hls.isSupported()){hls=new Hls({enableWorker:true,liveSyncDurationCount:2,liveMaxLatencyDurationCount:6,backBufferLength:8,maxBufferLength:10});window.hls=hls;hls.loadSource('/stream/live.m3u8');hls.attachMedia(video);hls.on(Hls.Events.MANIFEST_PARSED,play);hls.on(Hls.Events.ERROR,(_,e)=>{if(ended)return;if(e.fatal){hint.textContent='正在重新连接直播…';if(e.type===Hls.ErrorTypes.NETWORK_ERROR)setTimeout(()=>hls.startLoad(),1200);else if(e.type===Hls.ErrorTypes.MEDIA_ERROR)hls.recoverMediaError();else hint.textContent='播放暂时中断，请刷新页面重试';}});}else if(video.canPlayType('application/vnd.apple.mpegurl')){video.src='/stream/live.m3u8';video.addEventListener('loadedmetadata',play);}else{hint.textContent='请使用支持 H.264 视频的现代浏览器观看';}
video.addEventListener('playing',()=>{if(!ended){badge.textContent='正在直播';hint.textContent='直播画面已连接';}});
video.addEventListener('waiting',()=>{if(!ended)hint.textContent='正在缓冲直播画面…';});
async function status(){try{const s=await fetch('/api/status',{cache:'no-store'}).then(r=>r.json());document.getElementById('motion').textContent='当前动作：'+s.motion;document.getElementById('expiry').textContent='自动结束时间：'+new Date(s.expiresAt*1000).toLocaleTimeString('zh-CN',{hour12:false});if(!s.active){ended=true;badge.textContent='直播已结束';hint.textContent=s.error||'本机直播已结束';stop.disabled=true;if(hls)hls.stopLoad();}else if(video.readyState>=2&&!video.paused){badge.textContent='正在直播';}}catch{hint.textContent='无法连接直播服务';}}
stop.onclick=async()=>{if(!confirm('结束本机直播并释放渲染资源？'))return;stop.disabled=true;await fetch('/api/stop',{method:'POST',headers:{'X-Local-Live-Token':'__TOKEN__'}});await status();};
setInterval(status,2000);status();
</script></html>'''.replace('__TOKEN__',STOP_TOKEN).replace('直播默认持续一小时',f'直播时长：{SETUP["durationSeconds"]//60} 分钟').replace('二次元角色 · 五组动作轮播 · 720p / 30 FPS',f'角色动作预览 · {WIDTH}×{HEIGHT} / {FPS} FPS')
(WEB/'index.html').write_text(HTML,encoding='utf-8')

class Handler(http.server.SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(WEB),**kw)
 def log_message(self,format,*args):pass
 def end_headers(self):
  self.send_header('Cache-Control','no-store')
  self.send_header('X-Content-Type-Options','nosniff')
  super().end_headers()
 def guess_type(self,path):
  if path.endswith('.m3u8'):return 'application/vnd.apple.mpegurl'
  if path.endswith('.ts'):return 'video/mp2t'
  return super().guess_type(path)
 def do_GET(self):
  if urllib.parse.urlparse(self.path).path=='/api/status':
   with LOCK:body=json.dumps({**STATE,'expiresAt':EXPIRES,'resolution':f'{WIDTH}x{HEIGHT}','fps':FPS}).encode()
   self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
  return super().do_GET()
 def do_POST(self):
  if self.path!='/api/stop' or not secrets.compare_digest(self.headers.get('X-Local-Live-Token',''),STOP_TOKEN):self.send_error(403);return
  STOP.set();body=b'{"stopping":true}';self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

try:server=http.server.ThreadingHTTPServer(('127.0.0.1',HTTP_PORT),Handler)
except OSError:server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
log=(ROOT/'relay.log').open('ab')
receiver=subprocess.Popen([FFMPEG,'-hide_banner','-loglevel','warning','-nostdin','-i',f"srt://127.0.0.1:{SETUP['srtPort']}?mode=listener&latency=100000&listen_timeout=60000000",'-map','0:v:0','-c:v','copy','-an','-f','hls','-hls_time','1','-hls_list_size','6','-hls_delete_threshold','2','-hls_flags','delete_segments+independent_segments+omit_endlist+temp_file','-hls_segment_filename',str(WEB/'stream/segment-%08d.ts'),str(WEB/'stream/live.m3u8')],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
public={'url':f'http://127.0.0.1:{server.server_port}/','playlist':f'http://127.0.0.1:{server.server_port}/stream/live.m3u8','pid':os.getpid(),'relayPid':receiver.pid,'roomId':ID,'startedAt':START,'expiresAt':EXPIRES,'webRoot':str(WEB),'status':'starting'}
(ROOT/'watch.json').write_text(json.dumps(public,indent=2),encoding='utf-8')
print(json.dumps({'url':public['url'],'pid':os.getpid(),'relayPid':receiver.pid}),flush=True)
lastSwitch=0;clip=0;seen=False;lastApplied=None
try:
 while not STOP.wait(.5) and time.time()<EXPIRES:
  if receiver.poll() is not None:raise RuntimeError('直播接收连接已断开')
  try:view=rpc('/v1/rooms/'+ID)
  except Exception:
   if time.time()-START>55:raise RuntimeError('直播渲染服务未能启动')
   continue
  if view['state'] in ['failed','expired','cleanup_failed','stopped','completed']:raise RuntimeError('直播渲染已结束：'+view['state'])
  if view['state']!='running':continue
  with LOCK:STATE['status']='running'
  if not seen:
   seen=True;lastSwitch=time.time();public['status']='running';(ROOT/'watch.json').write_text(json.dumps(public,indent=2),encoding='utf-8')
  if lastApplied and view.get('lastResponse',{}).get('id')==lastApplied[0]:
   if not view['lastResponse'].get('error'):
    with LOCK:STATE['motion']=lastApplied[1]
   lastApplied=None
  if len(CLIPS)>1 and time.time()-lastSwitch>=8:
   clip=(clip+1)%len(CLIPS);animation,label=CLIPS[clip];command={'id':uuid.uuid4().hex,'method':'play','params':{'animation':animation,'loop':True,'mix':.25}}
   rpc('/v1/rooms/'+ID+'/control',command);lastApplied=(command['id'],label);lastSwitch=time.time()
except BaseException as error:
 with LOCK:STATE['error']=str(error)
finally:
 try:
  rpc('/v1/rooms/'+ID+'/stop',{})
  for _ in range(80):
   v=rpc('/v1/rooms/'+ID)
   if v['state'] not in ['starting','running','stopping','retrying','queued']:break
   time.sleep(.1)
 except Exception:pass
 if receiver.poll() is None:
  receiver.terminate()
  try:receiver.wait(timeout=5)
  except subprocess.TimeoutExpired:receiver.kill();receiver.wait()
 log.close()
 with LOCK:STATE.update(active=False,status='stopped')
 public.update(status='stopped',endedAt=time.time());(ROOT/'watch.json').write_text(json.dumps(public,indent=2),encoding='utf-8')
 time.sleep(300)
 server.shutdown();server.server_close()
