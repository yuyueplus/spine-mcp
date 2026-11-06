import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { productFixture } from './product-fixture.js';
import { planLiveRoom, startLiveRoom } from '../src/live-rooms.js';
async function fixture(){
 const f=await productFixture(),atlas=path.join(f.root,'images','test.atlas');
 await writeFile(atlas,'art.png\nsize: 8, 8\nformat: RGBA8888\nfilter: Linear, Linear\nrepeat: none\nart\n  bounds: 0, 0, 8, 8\n');
 return {...f,args:{skeleton:f.input,atlas,output:path.join(f.root,'new.mp4'),animation:'source',width:64,height:64}};
}
test('live room planning pins resources and GPU NV12 budget without launching a worker',async()=>{
 const f=await fixture(),p=await planLiveRoom(f.service,f.args);
 assert.equal(p.readbackBytesPerFrame,64*64*1.5);
 assert.equal(p.nativeRenderVerified,false);
 assert.equal(p.networkOutput,false);
 assert.ok(p.pins.some(pin=>pin.path===f.art));
 const config=JSON.parse(await readFile(p.configFile,'utf8'));assert.equal(config.pixelFormat,'nv12');assert.equal(config.queueFrames,2);
 await writeFile(f.art,'changed');
 await assert.rejects(startLiveRoom(f.service,{requestId:randomUUID(),plan:p.plan,expectedSha256:p.planSha256}),/changed/);
});
test('live room output requires explicit SRT opt-in and prevents outside or existing writes',async()=>{
 const f=await fixture();
 await assert.rejects(planLiveRoom(f.service,{...f.args,output:'srt://127.0.0.1:9000'}),/allowNetworkOutput/);
 await assert.rejects(planLiveRoom(f.service,{...f.args,output:'https://example.com/video'}),/NEW local/);
 await assert.rejects(planLiveRoom(f.service,{...f.args,output:path.join(f.root,'..','outside.mp4')}),/outside/);
 await writeFile(f.args.output,'existing');await assert.rejects(planLiveRoom(f.service,f.args),/already exists/);
 const p=await planLiveRoom(f.service,{...f.args,output:'srt://127.0.0.1:9000',allowNetworkOutput:true});assert.equal(p.networkOutput,true);
});
