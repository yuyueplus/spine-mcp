import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { connectSpine } from '../src/mcp-client.js';
import { projectRoot } from '../src/config.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { fileSha256 } from '../src/file-hash.js';
import { atomicJson } from '../src/jobs.js';
import { verifyNativeBridgeBundle } from '../src/native-editor-bridge.js';

const argv = process.argv.slice(2), value = (key: string) => { const index = argv.indexOf(key); return index < 0 ? undefined : argv[index + 1]; };
const parallel = Number(value('--parallel') ?? 2); if (!Number.isInteger(parallel) || parallel < 1 || parallel > 4) throw new Error('Audit --parallel must be 1–4. Native preview suites are always limited to two.');
const directory = path.resolve(value('--directory') ?? path.join(projectRoot, 'work/audits', `features-${VERSION}-${randomUUID().slice(0, 8)}`));
const relative = path.relative(path.join(projectRoot, 'work/audits'), directory); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Audit directory must be below work/audits.');
await mkdir(directory, { recursive: true }); await writeFile(path.join(projectRoot, 'work/current-feature-audit.json'), JSON.stringify({ directory }, null, 2));
const connection = await connectSpine(); let tools;
try { tools = (await connection.client.listTools()).tools; if (tools.length !== TOOL_COUNT) throw new Error('Registered tool count differs.'); if (connection.client.getServerVersion()?.version !== VERSION) throw new Error('Registered build is stale.'); } finally { await connection.client.close(); }
await writeFile(path.join(directory, 'current-tools.json'), JSON.stringify(tools, null, 2));
const coreFiles: { path: string; sha256: string }[] = [], walk = async (folder: string, target = coreFiles): Promise<void> => { for (const entry of await readdir(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isDirectory()) await walk(file, target); else target.push({ path: path.relative(projectRoot, file), sha256: await fileSha256(file) }); } }; await walk(path.join(projectRoot, 'src')); coreFiles.sort((a, b) => a.path.localeCompare(b.path));
const coreSha256 = createHash('sha256').update(JSON.stringify(coreFiles)).digest('hex');
const nativeBridgeBundle=await verifyNativeBridgeBundle();
interface SuiteResult { name: string; passed: boolean; exitCode: number | null; elapsedMs: number; coreSha256: string; log: string; calls: string }
const resultsFile = path.join(directory, 'suite-results.json'); let results: SuiteResult[] = [];
try { results = JSON.parse(await readFile(resultsFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const testFiles = (await readdir(path.join(projectRoot, 'dist/test'))).filter(file => file.endsWith('.test.js')).sort().map(file => path.join(projectRoot, 'dist/test', file));
const definitions: Record<string, string[]> = { tests: ['--test', '--test-concurrency=4', ...testFiles] };
for (const name of ['stability-smoke', 'smoke', 'workflow-smoke', 'artwork-smoke', 'animation-smoke', 'features-smoke', 'rigging-smoke', 'weights-smoke', 'alpha-smoke', 'reuse-smoke', 'mesh-smoke', 'timelines-smoke', 'production-smoke', 'official-regression', 'surface-smoke', 'complete-smoke', 'media-smoke', 'saved-sync-smoke', 'native-preview-smoke', 'native-playback-smoke', 'native-sequence-smoke', 'native-preview-recovery-smoke', 'native-preview-stability-smoke', 'advanced-official-smoke', 'cross-project-smoke', 'entrypoints-smoke', 'user-project-smoke', 'verify-registered', 'benchmark', 'productization-smoke']) definitions[name] = [path.join(projectRoot, 'dist/scripts', `${name}.js`)];
const order = ['tests', 'smoke', 'stability-smoke', 'workflow-smoke', 'artwork-smoke', 'animation-smoke', 'features-smoke', 'rigging-smoke', 'weights-smoke', 'alpha-smoke', 'reuse-smoke', 'mesh-smoke', 'timelines-smoke', 'production-smoke', 'official-regression', 'surface-smoke', 'complete-smoke', 'media-smoke', 'saved-sync-smoke', 'native-preview-smoke', 'native-playback-smoke', 'native-sequence-smoke', 'native-preview-recovery-smoke', 'native-preview-stability-smoke', 'advanced-official-smoke', 'cross-project-smoke', 'entrypoints-smoke', 'user-project-smoke', 'verify-registered', 'benchmark', 'productization-smoke'];
definitions['editor-project-smoke'] = [path.join(projectRoot, 'dist/scripts/editor-project-smoke.js')];
order.push('editor-project-smoke');
definitions['quality-smoke'] = [path.join(projectRoot, 'dist/scripts/quality-smoke.js')]; order.push('quality-smoke');
definitions['native-publication-smoke'] = [path.join(projectRoot, 'dist/scripts/native-publication-smoke.js')]; order.push('native-publication-smoke');
definitions['preview-requests-smoke'] = [path.join(projectRoot, 'dist/scripts/preview-requests-smoke.js')]; order.push('preview-requests-smoke');
for (const name of ['session-smoke', 'character-assistance-smoke', 'complex-project-smoke', 'session-lifecycle-smoke', 'maintenance-upgrade-smoke', 'character-pipeline-smoke', 'character-refinement-smoke', 'character-tasks-smoke', 'branch-contact-psd-smoke', 'construction-runtime-psd-smoke', 'visual-rig-deform-raster-smoke', 'unified-joint-smoke', 'seam-compatibility-smoke', 'production-character-smoke', 'product-workflow-smoke', 'production-motion-pack-smoke', 'psd-section-smoke']) { definitions[name] = [path.join(projectRoot, 'dist/scripts', `${name}.js`)]; order.push(name); }
definitions['extensions-smoke']=[path.join(projectRoot,'dist/scripts/extensions-smoke.js')];order.push('extensions-smoke');
definitions['live-capabilities-smoke']=[path.join(projectRoot,'dist/scripts/live-capabilities-smoke.js')];order.push('live-capabilities-smoke');
definitions['native-editor-bridge-smoke']=[path.join(projectRoot,'dist/scripts/native-editor-bridge-smoke.js')];order.push('native-editor-bridge-smoke');
const only = value('--only')?.split(','); for (const name of only ?? []) if (!(name in definitions)) throw new Error(`Unknown suite: ${name}`);
let persistence = Promise.resolve();
const run = async (name: string) => {
  const prior = results.find(result => result.name === name && result.passed && result.coreSha256 === coreSha256);
  if (argv.includes('--resume') && prior) { console.log(JSON.stringify({ event: 'suite-reused', name, coreSha256 })); return prior; }
  const log = path.join(directory, `${name}.log`), calls = path.join(directory, `${name}.calls.jsonl`); await writeFile(calls, '');
  const started = Date.now(), output = createWriteStream(log); console.log(JSON.stringify({ event: 'suite-start', name, at: new Date().toISOString() }));
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(projectRoot, 'dist/scripts/audit-observer.js')).href, ...definitions[name]!], { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPINE_AUDIT_CALLS: calls } }); child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); await new Promise<void>(resolve => output.end(resolve));
  const result = { name, passed: exitCode === 0, exitCode, elapsedMs: Date.now() - started, coreSha256, log, calls }; results = results.filter(item => item.name !== name); results.push(result); await (persistence = persistence.then(() => atomicJson(resultsFile, results)));
  if (name === 'tests' && result.passed) await copyFile(log, path.join(projectRoot, `work/test-${VERSION}.log`));
  console.log(JSON.stringify({ event: 'suite-complete', ...result })); return result;
};
if (only) { for (const name of only) await run(name); }
else if ((await run('tests')).passed && (await run('smoke')).passed) {
  const rest = order.slice(2), native = (name: string) => /extensions-smoke|native-editor|native-preview|native-playback|native-sequence|native-publication|preview-requests|character-pipeline|character-refinement|character-tasks|branch-contact-psd|construction-runtime-psd|visual-rig-deform-raster|unified-joint|seam-compatibility|production-character|product-workflow|production-motion-pack|psd-section|^session/.test(name);
  for (const [suites, size] of [[rest.filter(name => !native(name)), parallel], [rest.filter(name => native(name) && name !== 'preview-requests-smoke'), Math.min(2, parallel)], [['preview-requests-smoke'], 1]] as [string[], number][]) {
    let index=0;
    await Promise.all(Array.from({length:Math.min(size,suites.length)},async()=>{while(index<suites.length){const name=suites[index++]!;await run(name);}}));
  }
}
const coverage = tools.map(tool => ({ name: tool.name, successfulSuites: [] as string[], successfulCalls: 0, rejectedCalls: 0, distinctSuccessfulInputs: new Set<string>() }));
for (const result of results.filter(result => result.passed && result.coreSha256 === coreSha256)) {
  for (const line of (await readFile(result.calls, 'utf8')).split('\n').filter(Boolean)) { const call = JSON.parse(line); if (call.event !== 'result' || call.serverVersion !== VERSION) continue; const entry = coverage.find(item => item.name === call.name); if (!entry) continue; if (call.outcome === 'success') { entry.successfulCalls++; entry.distinctSuccessfulInputs.add(call.argsSha256); if (!entry.successfulSuites.includes(result.name)) entry.successfulSuites.push(result.name); } else entry.rejectedCalls++; }
}
const missing = coverage.filter(tool => !tool.successfulCalls).map(tool => tool.name), unfinished = order.filter(name => !results.some(result => result.name === name && result.passed && result.coreSha256 === coreSha256));
const endFiles: { path: string; sha256: string }[] = [];
await walk(path.join(projectRoot, 'src'), endFiles); endFiles.sort((a, b) => a.path.localeCompare(b.path));
const finalCoreSha256 = createHash('sha256').update(JSON.stringify(endFiles)).digest('hex'), coreChangedDuringRun = finalCoreSha256 !== coreSha256;
const finalNativeBundle=await verifyNativeBridgeBundle(),nativeBundleChanged=nativeBridgeBundle.sha256!==finalNativeBundle.sha256||nativeBridgeBundle.sourceSha256!==finalNativeBundle.sourceSha256;
const report = { version: VERSION, tools: TOOL_COUNT, createdAt: new Date().toISOString(), coreSha256, coreFiles, nativeBridgeBundle:{sha256:nativeBridgeBundle.sha256,sourceSha256:nativeBridgeBundle.sourceSha256},nativeBundleChanged,passed: !nativeBundleChanged&&!coreChangedDuringRun && missing.length === 0 && unfinished.length === 0, coreChangedDuringRun, finalCoreSha256, successfulToolCount: coverage.length - missing.length, missingSuccessfulToolCalls: missing, failedOrUnrunSuites: unfinished, meaning: 'One or more successful MCP requests in a current-build suite whose assertions passed. Rejections are recorded separately. This does not prove all argument combinations or all editor-only semantics.', results, coverage: coverage.map(entry => ({ ...entry, distinctSuccessfulInputs: entry.distinctSuccessfulInputs.size })) };
const reportPath = path.join(projectRoot, `work/feature-audit-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, version: VERSION, covered: report.successfulToolCount, total: TOOL_COUNT, missing, unfinished, reportPath }, null, 2)); if (coreChangedDuringRun || (only ? only.some(name => !results.find(result => result.name === name)?.passed) : !report.passed)) process.exitCode = 1;
