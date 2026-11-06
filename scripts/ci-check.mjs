import {spawn} from 'node:child_process';
import {writeFileSync,appendFileSync} from 'node:fs';

const mode=process.argv[2],plans={
 'npm-test':process.platform==='win32'?[process.env.ComSpec??'cmd.exe',['/d','/s','/c','npm test']]:['npm',['test']],
 'go-test':['go',['test','./...']],
 'go-vet':['go',['vet','./...']],
 'native-build':['go',['run','./cmd/buildnative','-jobs','4']],
 'native-package':['go',['run','./cmd/package']]
};
if(!Object.hasOwn(plans,mode))throw Error('Unknown CI check mode.');
const [command,args]=plans[mode],child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
let captured='';
const consume=(stream,chunk)=>{stream.write(chunk);captured=(captured+chunk.toString()).slice(-10*1024*1024);};
child.stdout.on('data',chunk=>consume(process.stdout,chunk));child.stderr.on('data',chunk=>consume(process.stderr,chunk));
const result=await new Promise(resolve=>{child.once('error',e=>{captured+='\n'+e.stack;resolve(1);});child.once('close',code=>resolve(code??1));});
writeFileSync(`ci-check-${mode}.log`,captured);
if(result!==0){
 const lines=captured.split(/\r?\n/),failures=[];
 for(let i=0;i<lines.length;i++)if(/^not ok\b|^--- FAIL:|^FAIL\b/.test(lines[i])){let end=i+1;while(end<lines.length&&end<i+100&&!/^# Subtest:|^ok \d|^not ok\b|^--- FAIL:/.test(lines[end]))end++;failures.push(lines.slice(i,end).join('\n'));}
 const details=(failures.length?failures.slice(0,5).join('\n\n'):lines.slice(-80).join('\n')).slice(0,22000);
 const escape=s=>s.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
 console.log(`::error title=${mode} failed::${escape(details)}`);
 if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\n### ${mode} failure\n\n${details.split('\n').map(l=>'    '+l).join('\n')}\n`);
}
process.exitCode=Number(result);
