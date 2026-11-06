import path from 'node:path';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {projectRoot,loadConfig} from '../src/config.js';
import {VERSION,TOOL_COUNT} from '../src/version.js';
import {extensionToolNames} from '../src/extension-names.js';
import {fileSha256} from '../src/file-hash.js';
import {verifyNativeBridgeBundle} from '../src/native-editor-bridge.js';
import {verifyCoreEvidence} from '../src/product-catalog.js';

// Seals successful current-source receipts; never turns pending hardware or
// engine-editor checks into a pass. Run the complete feature audit first.
const config=await loadConfig();
const read=async(file:string)=>JSON.parse(await readFile(file,'utf8'));
const report=await read(path.join(projectRoot,'VERIFICATION.json'));
const audit=await read(path.join(config.workspaceRoot,`feature-audit-report-${VERSION}.json`));
assert.equal(audit.passed,true,'Complete current-source feature audit is required.');
assert.equal(audit.version,VERSION);assert.equal(audit.tools,TOOL_COUNT);
assert.equal(audit.successfulToolCount,TOOL_COUNT);
assert.equal(await verifyCoreEvidence(projectRoot,audit.coreFiles),true);
assert.ok(audit.coverage.every((t:any)=>t.successfulCalls>0));
const bundle=await verifyNativeBridgeBundle();
assert.equal(audit.nativeBridgeBundle.sha256,bundle.sha256);
assert.equal(audit.nativeBridgeBundle.sourceSha256,bundle.sourceSha256);
const extensions=await read(path.join(config.workspaceRoot,`extensions-report-${VERSION}.json`));
assert.equal(extensions.passed,true);assert.equal(extensions.version,VERSION);
assert.deepEqual([...extensions.successfulNewTools].sort(),[...extensionToolNames].sort());
for(const key of['nativePhysicsRoundtrip','javascriptAdapterPlayed','sourceUnchanged'])assert.equal(extensions[key],true);
for(const key of['passed','playPauseAndSeek','staleRejected','idempotentReplay'])assert.equal(extensions.nativeTimeline[key],true);
for(const key of['passed','survivedMcpDisconnect','stoppedOwnedJob'])assert.equal(extensions.acceptance[key],true);
const native=await read(path.join(config.workspaceRoot,`native-editor-bridge-report-${VERSION}.json`));
assert.equal(native.passed,true);assert.equal(native.agentSha256,bundle.sha256);
assert.equal(native.sourceSha256,bundle.sourceSha256);
const tests=audit.results.find((r:any)=>r.name==='tests'&&r.passed);
assert.ok(tests);const testLog=await readFile(tests.log,'utf8');assert.match(testLog,/# fail 0\b/);
const count=Number(testLog.match(/# pass (\d+)/)?.[1]);assert.ok(count>=830);
if(report.version!==VERSION){
 (report.history??=[]).push({version:report.version,createdAt:report.createdAt,scope:report.scope,verification:report.verification});
}
report.schema='spine-source-verification/3.3';report.version=VERSION;report.tools=TOOL_COUNT;
report.createdAt=new Date().toISOString();report.coreFiles=audit.coreFiles;
report.scope='Current frozen-source Windows authoring/bridge/native acceptance. Linux generic physics, GPU rendering and encoding are recorded separately. No implication of 4.2 editor, Unity/Cocos editor, unlisted native builds, 24h or macOS GPU acceptance.';
const previous=report.verification??{};
report.verification={...previous,implementationComplete:true,localSupportedScopePassed:true,allPassed:false,
 unitTests:{command:'npm test (inside frozen-source audit)',tests:count,passed:count,failed:0,logSha256:await fileSha256(tests.log)},
 registeredTools:{serverVersion:VERSION,tools:TOOL_COUNT,freshSdkConnectionVerified:true,activeChatReloadInferred:false},
 featureAudit:{passed:true,suites:audit.results.length,successfulTools:TOOL_COUNT,coreSha256:audit.coreSha256,reportSha256:await fileSha256(path.join(config.workspaceRoot,`feature-audit-report-${VERSION}.json`)),coverage:audit.coverage.map((t:any)=>({name:t.name,successfulCalls:t.successfulCalls,distinctSuccessfulInputs:t.distinctSuccessfulInputs}))},
 nativeEditorBridge:{passed:true,agentSha256:bundle.sha256,sourceSha256:bundle.sourceSha256,targetVersion:'4.3.23',scope:'NEW pinned-build startup-bridge windows only; full reload resets undo; timeline view controls preserve model/undo.',corruptRefusedWithoutChangingModel:native.corruptRefusedWithoutChangingModel,staleRefused:native.staleRefused,retryAppliedOnce:native.retryAppliedOnce,reconnectReceiptVerified:native.reconnectReceiptVerified,sourceFilesUnchanged:native.sourceFilesUnchanged,cameraStableAfterRepaint:native.cameraStableAfterRepaint,recoveryNativeRoundTripVerified:native.recoveryNativeRoundTripVerified,reportSha256:await fileSha256(path.join(config.workspaceRoot,`native-editor-bridge-report-${VERSION}.json`)),timeline:extensions.nativeTimeline},
 extensions:{passed:true,tools:[...extensionToolNames],sourceUnchanged:true,nativePhysicsRoundtrip:true,visual:extensions.visual,chain:extensions.chain.details,sequence:extensions.sequence.details,runtime42:extensions.runtime42.verification,javascriptAdapterPlayed:true,unityEditorVerified:false,cocosEditorVerified:false,psd:extensions.psd,nativeAcceptance:extensions.acceptance,reportSha256:await fileSha256(path.join(config.workspaceRoot,`extensions-report-${VERSION}.json`))},
 pending:[...new Set([...(previous.pending??[]).filter((p:string)=>!p.startsWith('Physical multi-GPU rendering/encoding isolation and capacity.')),'Physical multi-GPU production capacity and hardware-encoding isolation (short isolated Vulkan rendering is separate).','4.2 native editor and Unity/Cocos editor validation in target projects.','Incremental structural editor edits preserving native undo and unlisted editor build support.'])]
};
const rendererFiles:{path:string;sha256:string}[]=[];
async function walk(dir:string):Promise<void>{for(const e of await readdir(dir,{withFileTypes:true})){if(['build','output','.cache','node_modules','__pycache__'].includes(e.name)||e.name.endsWith('.pyc'))continue;const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Native verification excludes links.');if(e.isDirectory())await walk(f);else rendererFiles.push({path:path.relative(projectRoot,f).replaceAll('\\','/'),sha256:await fileSha256(f)});}}
await walk(path.join(projectRoot,'native-renderer'));rendererFiles.sort((a,b)=>a.path.localeCompare(b.path));report.nativeRendererFiles=rendererFiles;
await writeFile(path.join(projectRoot,'VERIFICATION.json'),JSON.stringify(report,null,2)+'\n');
const plan=await read(path.join(projectRoot,'EXTENSION-PLAN.json'));
plan.status='local_implementation_verified_external_acceptance_pending';plan.evidence='VERIFICATION.json';
plan.items=plan.items.map((i:any)=>({...i,status:['editor','deployment','delivery'].includes(i.id)?'implemented_with_explicit_external_limits':'implemented_and_locally_verified'}));
await writeFile(path.join(projectRoot,'EXTENSION-PLAN.json'),JSON.stringify(plan,null,2)+'\n');
const support=await read(path.join(projectRoot,'SUPPORT.json'));
support.releaseVerification={...support.releaseVerification,version:VERSION,unitTests:count,integrationSuites:audit.results.length,successfulTools:TOOL_COUNT,coreSha256:audit.coreSha256,report:'VERIFICATION.json',allRequestedOutcomesAchieved:false};
await writeFile(path.join(projectRoot,'SUPPORT.json'),JSON.stringify(support,null,2)+'\n');
console.log(JSON.stringify({version:VERSION,tools:TOOL_COUNT,tests:count,suites:audit.results.length,localSupportedScopePassed:true,allPassed:false,report:path.join(projectRoot,'VERIFICATION.json')},null,2));
