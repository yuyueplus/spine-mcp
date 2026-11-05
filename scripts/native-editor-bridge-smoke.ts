import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig, projectRoot } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { fileSha256 } from '../src/file-hash.js';
import { verifyNativeBridgeBundle, type NativeEditorState } from '../src/native-editor-bridge.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';

const config=await loadConfig(),service=new SpineService(config),bundle=await verifyNativeBridgeBundle();
const recordPath=path.join(config.workspaceRoot,'native-editor-bridge-3.1.0','acceptance-instance.json');
let record:{id:string;inputs:{a:string;b:string};agentSha256:string};
if(process.argv.includes('--open')){
 const folder=path.join(config.workspaceRoot,'native-editor-bridge-'+randomUUID().slice(0,8));await mkdir(folder);
 const demo=await service.createDemo(),loaded=await service.load(demo.path);const inputs:Record<string,string>={};
 for(const label of['a','b']){
  const dir=path.join(folder,label==='a'?'同名 工程 A':'同名 工程 B');await mkdir(dir);const data=structuredClone(loaded.data);
  data.bones.push({name:'native-bridge-marker',parent:'root',x:22,y:28,length:label==='a'?79:209});if(label==='b')data.slots!.push({name:'native-bridge-added-slot',bone:'native-bridge-marker'});
  data.skeleton!.images=path.resolve(path.dirname(loaded.jsonPath),String(data.skeleton!.images??'images'));
  data.animations!['native-bridge-motion']={bones:{'native-bridge-marker':{rotate:[{time:0,value:0},{time:label==='a'?1:2,value:label==='a'?35:105}]}}};
  const json=path.join(dir,'skeleton.json');await writeFile(json,JSON.stringify(data));inputs[label]=path.join(dir,'Same-Name.spine');await service.buildProject([{input:json,name:'Native-Bridge-Fixture'}],inputs[label]!);
 }
 const opened=await service.openProject(inputs.a!,{nativeBridge:true,waitMs:10000});assert.equal(opened.launchAccepted,true);record={id:opened.id,inputs:{a:inputs.a!,b:inputs.b!},agentSha256:bundle.sha256};await mkdir(path.dirname(recordPath),{recursive:true});await writeFile(recordPath,JSON.stringify(record,null,2));
}else record=JSON.parse(await readFile(recordPath,'utf8'));
assert.equal(record.agentSha256,bundle.sha256,'Native acceptance instance is from an older agent; run --open explicitly.');
let connection=await connectSpine({local:process.argv.includes('--local')});
const call=async(name:string,args:Record<string,unknown>,reject=false)=>{
 const r=await connection.client.callTool({name,arguments:args},{timeout:connection.timeoutMs});const text=r.content.find(c=>c.type==='text');assert.ok(text?.type==='text');const value=JSON.parse(text.text);
 if(reject)assert.equal(r.isError,true,JSON.stringify(value));else assert.ok(!r.isError,JSON.stringify(value));return value;
};
const expected=(s:NativeEditorState)=>({projectPath:s.projectPath,projectIdentity:s.projectIdentity,undoToken:s.undoToken,modelSha256:s.model.sha256});
const report:any={version:VERSION,tools:TOOL_COUNT,instanceId:record.id,agentSha256:bundle.sha256,sourceSha256:bundle.sourceSha256,at:new Date().toISOString(),inputInjectionUsed:false};
try{
 assert.equal((await connection.client.listTools()).tools.length,TOOL_COUNT);assert.equal(connection.client.getServerVersion()?.version,VERSION);
 const inputHashes=await Promise.all([fileSha256(record.inputs.a),fileSha256(record.inputs.b)]);
 const inventory=await call('spine_editor_state',{});assert.ok(inventory.instances.some((i:any)=>i.id===record.id));
 let before=(await call('spine_editor_state',{instanceId:record.id})).status as NativeEditorState;assert.equal(before.dirty,false);assert.equal(before.nativeThread,'AWT-EventQueue-0');
 const bad=path.join(path.dirname(record.inputs.a),'corrupt.spine');await writeFile(bad,'invalid native candidate');
 const corrupt=await call('spine_reload_editor_project',{instanceId:record.id,input:bad,expected:expected(before),requestId:randomUUID()},true);assert.match(corrupt.error,/damaged|read|project/i);
 let after=(await call('spine_editor_state',{instanceId:record.id})).status as NativeEditorState;assert.equal(after.projectIdentity,before.projectIdentity);assert.equal(after.model.sha256,before.model.sha256);
 await call('spine_reload_editor_project',{instanceId:record.id,input:record.inputs.b,expected:{...expected(after),projectIdentity:'999999999'},requestId:randomUUID()},true);
 const requestId=randomUUID(),args={instanceId:record.id,input:record.inputs.b,expected:expected(after),requestId,waitMs:0};report.pending=await call('spine_reload_editor_project',args);
 await connection.client.close();connection=await connectSpine({local:process.argv.includes('--local')});
 const receipt=await call('spine_editor_request_status',{instanceId:record.id,requestId,waitMs:10000});assert.equal(receipt.ok,true);assert.equal(receipt.nativeModelVerified,true);assert.ok(receipt.nativeFramesAdvanced>=3);assert.equal(receipt.status.instanceId,record.id);assert.equal(receipt.status.dirty,false);
 const s=receipt.status.model.skeletons[0],marker=s.bones.find((b:any)=>b.name==='native-bridge-marker');assert.equal(marker.length,209);assert.ok(s.slots.some((s:any)=>s.name==='native-bridge-added-slot'));assert.equal(s.animations.find((a:any)=>a.name==='native-bridge-motion').durationFrames,60);
 assert.equal(await fileSha256(receipt.recoverySnapshot.nativeFile),receipt.recoverySnapshot.sha256);
 const repeated=await call('spine_reload_editor_project',args);assert.equal(repeated.completedAt,receipt.completedAt);assert.equal(repeated.status.projectIdentity,receipt.status.projectIdentity);
 await call('spine_reload_editor_project',{...args,expected:{...args.expected,undoToken:'99999'}},true);
 const context=await call('spine_editor_context',{instanceId:record.id});assert.equal(context.loadedProjectPathAvailable,true);assert.equal(context.unsavedStateAvailable,true);
 after=(await call('spine_editor_state',{instanceId:record.id})).status;
 const unified=await call('spine_refresh_editor_view',{input:record.inputs.a,mode:'editable_in_place',instanceId:record.id,expectedNativeState:expected(after),requestId:randomUUID(),waitMs:10000});assert.equal(unified.editableRigReloaded,true);assert.equal(unified.status,'reloaded');
 await new Promise(resolve=>setTimeout(resolve,1200));const late=(await call('spine_editor_state',{instanceId:record.id})).status;assert.deepEqual(late.view.cameras,unified.receipt.status.view.cameras);assert.equal(late.projectIdentity,unified.receipt.status.projectIdentity);
 assert.deepEqual(await Promise.all([fileSha256(record.inputs.a),fileSha256(record.inputs.b)]),inputHashes);
 report.passed=true;report.receipt=receipt;report.unified=unified;report.late=late;report.corruptRefusedWithoutChangingModel=true;report.staleRefused=true;report.retryAppliedOnce=true;report.reconnectReceiptVerified=true;report.sourceFilesUnchanged=true;report.cameraStableAfterRepaint=true;report.recoveryNativeRoundTripVerified=true;
 const target=path.join(config.workspaceRoot,'native-editor-bridge-report-'+VERSION+'.json');await writeFile(target,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,version:VERSION,tools:TOOL_COUNT,report:target,instanceId:record.id,agentSha256:bundle.sha256,nativeFramesAdvanced:receipt.nativeFramesAdvanced},null,2));
}finally{await connection.client.close();}
