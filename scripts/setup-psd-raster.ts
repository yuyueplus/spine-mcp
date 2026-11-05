import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { projectRoot } from '../src/config.js';
import { runProcess } from '../src/cli.js';
import { rasterHelper, rasterRequirements, rasterPython } from '../src/psd-rasterization.js';
import { fileSha256 } from '../src/file-hash.js';
const root=path.join(projectRoot,'.psd-runtime'),python=process.argv.includes('--python')?process.argv[process.argv.indexOf('--python')+1]!:process.platform==='win32'?'python':'python3';
if(!python)throw Error('Provide the Python executable after --python.');
try{await stat(root);await stat(path.join(root,'pyvenv.cfg'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;try{await stat(root);throw Error('Existing .psd-runtime is not a managed Python virtual environment.');}catch(inner){if((inner as NodeJS.ErrnoException).code!=='ENOENT')throw inner;}const r=await runProcess(python,['-m','venv',root],120000,{cwd:projectRoot});if(r.exitCode!==0)throw Error(r.stderr);}
const installed=await runProcess(rasterPython,['-m','pip','install','--disable-pip-version-check','--no-deps','-r',rasterRequirements],300000,{cwd:projectRoot});if(installed.exitCode!==0)throw Error(installed.stderr+'\n'+installed.stdout);
const checked=await runProcess(rasterPython,[rasterHelper,'--check'],30000,{cwd:projectRoot});if(checked.exitCode!==0)throw Error(checked.stdout+'\n'+checked.stderr);const result=JSON.parse(checked.stdout);await writeFile(path.join(root,'receipt.json'),JSON.stringify({...result,helperSha256:await fileSha256(rasterHelper),requirementsSha256:await fileSha256(rasterRequirements),createdAt:new Date().toISOString()},null,2)+'\n');console.log(JSON.stringify({installed:true,runtime:root,python:result.python,versions:result.versions,offlineDuringMcpCalls:true},null,2));
