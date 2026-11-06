import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { readCompletionEvidence } from '../src/product-catalog.js';
test('an installed old seal cannot shadow current-version verification evidence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'spine-evidence-'));
 await mkdir(path.join(root,'work'));
 await writeFile(path.join(root,'VERIFICATION.json'),JSON.stringify({version:'3.1.0',verification:{allPassed:true}}));
 const file=path.join(root,'work','implementation-report-3.2.0.json');
 await writeFile(file,JSON.stringify({version:'3.2.0',verification:{allPassed:false,pending:['target GPU']}}));
 const result=await readCompletionEvidence(root,'3.2.0');assert.equal(result.evidence,file);assert.equal(result.report.verification.allPassed,false);
});
