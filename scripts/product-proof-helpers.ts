import path from 'node:path';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {loadConfig,projectRoot} from '../src/config.js';
import {SpineService} from '../src/service.js';
import {VERSION,TOOL_COUNT} from '../src/version.js';
import {fileSha256} from '../src/file-hash.js';

export async function proofHarness(prefix:string){
 const config=await loadConfig(),directory=path.join(config.workspaceRoot,prefix+'-'+randomUUID().slice(0,8)+' spaces 中文');await mkdir(directory);
 const isolated={...config,workspaceRoot:directory},configFile=path.join(directory,'config.json');await writeFile(configFile,JSON.stringify(isolated));
 const service=new SpineService(isolated),client=new Client({name:prefix,version:VERSION});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(projectRoot,'dist/src/index.js')],env:{SPINE_MCP_CONFIG:configFile},stderr:'pipe'}));
 if((await client.listTools()).tools.length!==TOOL_COUNT||client.getServerVersion()?.version!==VERSION)throw Error('Unexpected proof server build.');
 const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args},{timeout:300000});if(r.isError)throw Error(name+': '+JSON.stringify(r.content));return JSON.parse(r.content.find(c=>c.type==='text')!.text as string);};
 const reject=async(name:string,args:Record<string,unknown>,pattern:RegExp)=>{const r=await client.callTool({name,arguments:args},{timeout:300000});if(!r.isError||!pattern.test(JSON.stringify(r.content)))throw Error('Expected rejection missing: '+name);};
 const waitTask=async(selector:any,phase:string)=>{for(let i=0;i<2400;i++){const s=await call('spine_get_character_task',selector);if(s.phase===phase)return s;if(['failed','cancelled','completed'].includes(s.phase))throw Error('Unexpected task phase: '+JSON.stringify({id:s.id,phase:s.phase,error:s.error,currentStep:s.currentStep,publication:s.results?.promote?.publication}));await new Promise(r=>setTimeout(r,100));}throw Error('Timed out awaiting task '+phase);};
 const save=async(report:any)=>{await writeFile(path.join(config.workspaceRoot,prefix+'-report-'+VERSION+'.json'),JSON.stringify({...report,directory,version:VERSION},null,2)+'\n');};
 return{config,directory,configFile,isolated,service,client,call,reject,waitTask,save};
}
export async function inventory(root:string){const files:{path:string;sha256:string;bytes:number}[]=[];async function walk(dir:string):Promise<void>{for(const e of await readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Fixture must not contain symlinks.');const file=path.join(dir,e.name);if(e.isDirectory())await walk(file);else{const b=await readFile(file);files.push({path:path.relative(root,file).replaceAll('\\','/'),sha256:await fileSha256(file),bytes:b.length});}}}await walk(root);return files.sort((a,b)=>a.path.localeCompare(b.path));}
export const stage=(name:string)=>console.log(JSON.stringify({stage:name,at:new Date().toISOString()}));
