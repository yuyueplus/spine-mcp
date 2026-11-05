import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace, type Config } from '../src/config.js';
import { EditorProjects, type EditorCommand } from '../src/editor.js';
import { NativeEditorBridge, encodeBridgeRequest, decodeBridgeResponse, bridgeJavaOption, verifyNativeBridgeBundle, type NativeEditorState } from '../src/native-editor-bridge.js';
import { fileSha256 } from '../src/file-hash.js';

const secret='a'.repeat(64),id=randomUUID(),instanceId=randomUUID();
function response(value: object,requestId:string=id,instance:string=instanceId,token=secret){const body=Buffer.from(JSON.stringify({ok:true,...value,protocol:'1',requestId,instanceId:instance})).toString('base64');return `body=${body}\nsignature=${createHmac('sha256',token).update(`response\n${requestId}\n${body}`).digest('hex')}\n`;}
async function fixture(){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'spine-native-bridge-'))),workspace=new Workspace(root),bundleRoot=path.join(root,'bundle 中文 spaces');await mkdir(path.join(bundleRoot,'src'),{recursive:true});
 const executable=path.join(root,'installed','Spine.exe');await mkdir(path.dirname(executable));await writeFile(executable,'existing launcher');const targetJar=path.join(path.dirname(executable),'Pro_4.3.23.jar');await writeFile(targetJar,'fixture native build');
 const builds={schemaVersion:1,protocol:'1',adapters:[{id:'fixture',jarBasename:'Pro_4.3.23.jar',sha256:await fileSha256(targetJar)}]};
 await writeFile(path.join(bundleRoot,'builds.json'),JSON.stringify(builds));await writeFile(path.join(bundleRoot,'MANIFEST.MF'),'Premain-Class: EditorBridgeAgent\n');await writeFile(path.join(bundleRoot,'src/EditorBridgeAgent.java'),'// fixture startup source');await writeFile(path.join(bundleRoot,'src/NativeEditorAccess.java'),'// fixture native API');await writeFile(path.join(bundleRoot,'spine-editor-bridge.jar'),'fixture agent binary');
 const sources=[];for(const file of['MANIFEST.MF','builds.json','src/EditorBridgeAgent.java','src/NativeEditorAccess.java'])sources.push({path:file,sha256:await fileSha256(path.join(bundleRoot,file))});
 await writeFile(path.join(bundleRoot,'bundle.json'),JSON.stringify({protocol:'1',jar:'spine-editor-bridge.jar',sha256:await fileSha256(path.join(bundleRoot,'spine-editor-bridge.jar')),sourceSha256:createHash('sha256').update(JSON.stringify(sources)).digest('hex'),sources}));
 const project=path.join(root,'中文 project.spine');await writeFile(project,'native fixture saved data');const config:Config={targetVersion:'4.3.23',workspaceRoot:root,cliExecutable:null,guiExecutable:executable,cliTimeoutMs:1000};const editors=new EditorProjects(workspace,config),commands:EditorCommand[]=[];
 const deps={bundleRoot,launch:async(c:EditorCommand)=>{commands.push(c);return 12345;}},bridge=new NativeEditorBridge(workspace,editors,deps);
 return{root,workspace,bundleRoot,targetJar,project,editors,commands,deps,bridge};
}
function expected(projectPath:string){return{projectPath,projectIdentity:'123',undoToken:'31',modelSha256:'f'.repeat(64)};}

test('request signatures cover exact Unicode payload, identity and operation',()=>{
 const wire=encodeBridgeRequest(id,{action:'reload',input:'D:\\中文 工程\\a.spine',id,instanceId},secret),lines=Object.fromEntries(wire.trim().split('\n').map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
 assert.equal(lines.signature,createHmac('sha256',secret).update(`request\n${id}\n${lines.body}`).digest('hex'));const decoded=Buffer.from(lines.body!,'base64').toString();assert.ok(decoded.includes('input='+Buffer.from('D:\\中文 工程\\a.spine').toString('base64')));
 assert.notEqual(wire,encodeBridgeRequest(randomUUID(),{action:'reload',id,instanceId},secret));
});
test('native response authentication rejects corruption, replay and cross-instance data',()=>{
 const wire=response({status:{projectPath:'D:\\中文 project.spine'}});assert.equal(decodeBridgeResponse(wire,id,instanceId,secret).ok,true);
 assert.throws(()=>decodeBridgeResponse(wire,id,instanceId,'b'.repeat(64)),/authentication/);
 assert.throws(()=>decodeBridgeResponse(wire,randomUUID(),instanceId,secret),/authentication/);
 assert.throws(()=>decodeBridgeResponse(wire,id,randomUUID(),secret),/another request/);
 assert.throws(()=>decodeBridgeResponse(wire.replace('body=','body=AA'),id,instanceId,secret),/authentication/);
 assert.throws(()=>decodeBridgeResponse(wire+'extra=data\n',id,instanceId,secret),/Malformed/);
});
test('startup option quotes spaces and Unicode without changing global Java settings',()=>{
 const before=process.env.JAVA_TOOL_OPTIONS;const option=bridgeJavaOption('C:\\程序 files\\bridge.jar','D:\\项目\\instance');assert.match(option,/^"-javaagent:C:\/程序 files\/bridge.jar=b64:[A-Za-z0-9_-]+"$/);assert.equal(Buffer.from(option.slice(option.indexOf('=b64:')+5,-1),'base64url').toString('utf8'),'D:/项目/instance');
 assert.throws(()=>bridgeJavaOption('C:/bad"/agent.jar','D:/instance'),/quotes/);assert.equal(process.env.JAVA_TOOL_OPTIONS,before);
});
test('bundle verification pins both Java sources and packaged bytes',async()=>{
 const f=await fixture();await verifyNativeBridgeBundle(f.bundleRoot);await writeFile(path.join(f.bundleRoot,'src/NativeEditorAccess.java'),'changed');await assert.rejects(verifyNativeBridgeBundle(f.bundleRoot),/sources changed/);
 const g=await fixture();await writeFile(path.join(g.bundleRoot,'spine-editor-bridge.jar'),'changed');await assert.rejects(verifyNativeBridgeBundle(g.bundleRoot),/integrity/);
});
test('opening launches once with a scoped startup agent and keeps source and originals intact',async()=>{
 const f=await fixture(),bytes=await readFile(f.project),requestId=randomUUID(),java=process.env.JAVA_TOOL_OPTIONS;
 const opened=await f.bridge.open(f.project,{requestId,waitMs:0});assert.equal(opened.launchAccepted,true);assert.equal(opened.inputInjectionUsed,false);assert.equal(opened.existingEditorsAttached,false);assert.equal(f.commands.length,1);
 assert.equal(f.commands[0]!.options.detached,true);assert.equal(f.commands[0]!.options.shell,false);assert.match(f.commands[0]!.options.env!.JAVA_TOOL_OPTIONS!,/"-javaagent:.*\.editor-bridges.*agent\.jar=b64:/);assert.equal(await fileSha256(opened.agentJar!),opened.agentSha256);assert.deepEqual(f.commands[0]!.args,['--no-reuse-instance',f.project]);
 assert.equal(process.env.JAVA_TOOL_OPTIONS,java);assert.deepEqual(await readFile(f.project),bytes);assert.deepEqual(await readFile(opened.recoveryFile!),bytes);
 const reconnected=new NativeEditorBridge(f.workspace,f.editors,f.deps);const repeated=await reconnected.open(f.project,{requestId,waitMs:0});assert.equal(repeated.reusedRequest,true);assert.equal(f.commands.length,1);assert.ok(!JSON.stringify(opened).includes((await readFile(path.join(f.root,'.editor-bridges',requestId,'secret'),'utf8')).trim()));
 await writeFile(f.project,'different revision');await assert.rejects(reconnected.open(f.project,{requestId,waitMs:0}),/another project/);
});
test('unsupported build, invalid paths and reuse refuse before launch',async()=>{
 const f=await fixture();await assert.rejects(f.bridge.open(f.project,{reuseInstance:true,waitMs:0}),/NEW editor/);await assert.rejects(f.bridge.open('../escape.spine',{waitMs:0}),/outside/);await writeFile(f.targetJar,'another build');await assert.rejects(f.bridge.open(f.project,{waitMs:0}),/no verified native adapter/);assert.equal(f.commands.length,0);
});
test('fresh native state requires a signed receipt; pending is never reported as loaded',async()=>{
 const f=await fixture(),opened=await f.bridge.open(f.project,{waitMs:0}),pending=await f.bridge.state(opened.id,0) as any;
 assert.equal(pending.pending,true);assert.equal(pending.nativeStateVerified,false);const folder=path.join(f.root,'.editor-bridges',opened.id),token=(await readFile(path.join(folder,'secret'),'utf8')).trim();
 const status={instanceId:opened.id,projectPath:f.project,projectIdentity:'123',undoToken:'31',dirty:true,model:{sha256:'f'.repeat(64),skeletons:[],keyCount:0},view:{},nativeThread:'fixture-only',capturedAt:Date.now(),operationPending:false} satisfies NativeEditorState;
 await writeFile(path.join(folder,'responses',pending.requestId+'.properties'),response({status},pending.requestId,opened.id,token));const reconnected=new NativeEditorBridge(f.workspace,f.editors,f.deps),done=await reconnected.requestStatus(opened.id,pending.requestId);
 assert.equal(done.authenticated,true);assert.equal(done.nativeStateVerified,true);assert.equal(done.status?.dirty,true);assert.equal(done.status?.projectPath,f.project);assert.equal(f.commands.length,1);
});
test('reload retries share a durable ID and conflicting intent cannot replace the original',async()=>{
 const f=await fixture(),opened=await f.bridge.open(f.project,{waitMs:0}),requestId=randomUUID(),args={instanceId:opened.id,input:f.project,requestId,expected:expected(f.project),waitMs:0};
 const a=await f.bridge.reload(args),b=await f.bridge.reload(args);assert.equal(a.requestId,requestId);assert.equal(b.requestId,requestId);assert.equal(a.pending,true);
 assert.deepEqual(await readdir(path.join(f.root,'.editor-bridges',opened.id,'requests')),[requestId+'.properties']);
 await assert.rejects(f.bridge.reload({...args,expected:{...args.expected,undoToken:'32'}}),/different native operation/);assert.equal(f.commands.length,1);
});
test('concurrent retries never publish two native operations',async()=>{
 const f=await fixture(),opened=await f.bridge.open(f.project,{waitMs:0}),requestId=randomUUID(),args={instanceId:opened.id,input:f.project,requestId,expected:expected(f.project),waitMs:0};
 const outcomes=await Promise.allSettled([f.bridge.reload(args),f.bridge.reload(args)]);assert.ok(outcomes.some(x=>x.status==='fulfilled'));assert.deepEqual(await readdir(path.join(f.root,'.editor-bridges',opened.id,'requests')),[requestId+'.properties']);assert.equal(f.commands.length,1);
});
test('inventory cannot infer native state from a title and unknown IDs never launch',async()=>{
 const f=await fixture();assert.deepEqual((await f.bridge.list()).instances,[]);await assert.rejects(f.bridge.state(randomUUID(),0),/ENOENT/);assert.equal(f.commands.length,0);
});
test('failed startup remains queryable without an automatic relaunch',async()=>{
 const f=await fixture();let attempts=0;const broken=new NativeEditorBridge(f.workspace,f.editors,{...f.deps,launch:async()=>{attempts++;throw Error('fixture launcher failure');}}),id=randomUUID();
 const first=await broken.open(f.project,{requestId:id,waitMs:0});assert.equal(first.launchAccepted,false);assert.match(first.error!,/failure/);await broken.open(f.project,{requestId:id,waitMs:0});assert.equal(attempts,1);
});
test('out-of-workspace current project and invalid wait cannot submit a reload',async()=>{
 const f=await fixture(),opened=await f.bridge.open(f.project,{waitMs:0});await assert.rejects(f.bridge.reload({instanceId:opened.id,input:f.project,expected:expected(path.join(f.root,'..','other.spine')),waitMs:0}),/outside/);await assert.rejects(f.bridge.state(opened.id,25001),/25000/);assert.deepEqual(await readdir(path.join(f.root,'.editor-bridges',opened.id,'requests')),[]);
});

test('a live instance retains immutable agent bytes when the installation changes',async()=>{
 const f=await fixture(),opened=await f.bridge.open(f.project,{waitMs:0}),original=await readFile(opened.agentJar!);await writeFile(path.join(f.bundleRoot,'spine-editor-bridge.jar'),'upgraded installation bytes');assert.deepEqual(await readFile(opened.agentJar!),original);assert.equal(await fileSha256(opened.agentJar!),opened.agentSha256);
});
