import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { connectSpine } from '../src/mcp-client.js';
import { VERSION, TOOL_COUNT } from '../src/version.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { setConstraint } from '../src/constraint-edits.js';
import { parseDocument, setTimeline } from '../src/document.js';

const config = await loadConfig(), local = !process.argv.includes('--registered');
let connection = await connectSpine({ local });
const directory = path.join(config.workspaceRoot, `stability-smoke-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const reportPath = path.join(directory, 'report.json'), report: Record<string, any> = { version: VERSION, passed: false, startedAt: new Date().toISOString(), directory, inputAutomationUsed: false, editorOpened: false };
const save = async () => writeFile(reportPath, JSON.stringify(report, null, 2));
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await connection.client.callTool({ name, arguments: args }, { timeout: connection.timeoutMs }), block = result.content.find(c => c.type === 'text');
  assert.ok(!result.isError && block?.type === 'text', `${name}: ${JSON.stringify(result.content)}`); return JSON.parse(block.text);
};
const json = async (name: string, value: unknown) => { const filename = path.join(directory, name); await writeFile(filename, JSON.stringify(value, null, 2), { flag: 'wx' }); return filename; };
try {
  const tools = (await connection.client.listTools()).tools;
  assert.equal(tools.length, TOOL_COUNT);
  for (const name of ['recover_job', 'check_environment', 'publish_and_open', 'get_publication', 'audit_animation', 'prepare_character', 'build_pose_animation', 'bake_foot_contacts', 'run_regression_suite', 'record_visual_review', 'get_acceptance']) assert.ok(tools.some(t => t.name === `spine_${name}`), name);
  const status = await call('spine_status', {}); assert.equal(status.serverVersion, VERSION); report.tools = tools.length;
  report.environment = await call('spine_check_environment', { probeCli: true }); assert.equal(report.environment.cli.available, true); await save();
  const image = path.join(directory, 'art.png'); await writeFile(image, encodePng(8, 8, new Uint8Array(256).fill(255)));
  const input = await json('layers.json', { skeleton: { spine: '4.3.23', images: './', fps: 60 }, bones: [{ name: 'root' }, { name: 'tail', parent: 'root', x: 1 }], slots: [{ name: 'art', bone: 'root', attachment: 'open' }], skins: [{ name: 'default', attachments: { art: { open: { path: 'art', width: 8, height: 8 }, closed: { path: 'art', width: 8, height: 8 } } } }] });
  const imageHash = await fileSha256(image), sourceHash = await fileSha256(input);
  report.rig = await call('spine_prepare_character', { input, output: path.join(directory, 'rig.json'), bones: [{ name: 'upper', parent: 'root', transform: { length: 2 } }, { name: 'lower', parent: 'upper', transform: { x: 2, length: 2 } }], bindings: [{ slot: 'art', attachment: 'open', bones: ['upper', 'lower'], columns: 2, rows: 2 }] });
  report.poses = await call('spine_build_pose_animation', { input: report.rig.path, output: path.join(directory, 'poses.json'), name: 'gesture', poses: [{ time: 0, bones: { root: { rotation: 0 } } }, { time: 0.5, bones: { root: { rotation: 12 } } }, { time: 1, bones: { root: { rotation: 0 } } }], secondary: [{ bones: ['tail'], driver: 'root', maxAngle: 5 }], blinks: [{ slot: 'art', open: 'open', closed: 'closed', times: [0.5] }] });
  report.recipeNative = await call('spine_publish_and_open', { requestId: randomUUID(), input: report.poses.path, output: path.join(directory, 'Recipe-Verified.spine'), edits: [{ type: 'set_bone', bone: 'tail', transform: { x: 1.5 } }], openInEditor: false }); assert.equal(report.recipeNative.structuralAndNativeRoundTrip, 'passed');
  report.nativeSourceCopy = await call('spine_publish_and_open', { input: report.recipeNative.project, output: path.join(directory, 'Recipe-Native-Source.spine'), openInEditor: false }); assert.equal(report.nativeSourceCopy.structuralAndNativeRoundTrip, 'passed');
  const leg = await json('leg.json', { skeleton: { spine: '4.3.23', fps: 60 }, bones: [{ name: 'root' }, { name: 'hips', parent: 'root', y: 4 }, { name: 'upper', parent: 'hips', rotation: -70, length: 2 }, { name: 'lower', parent: 'upper', x: 2, rotation: -35, length: 2 }, { name: 'foot', parent: 'lower', x: 2, length: 1 }], animations: { walk: { bones: { hips: { translate: [{ time: 0 }, { time: 0.5, x: 0.2, y: -0.2 }, { time: 1 }] } } } } });
  report.contacts = await call('spine_bake_foot_contacts', { input: leg, output: path.join(directory, 'planted.json'), animation: 'walk', newName: 'planted', tolerance: 0.01, chains: [{ upper: 'upper', lower: 'lower', foot: 'foot', contacts: [{ start: 0, end: 1 }] }] });
  report.badMotion = await call('spine_audit_animation', { input: leg, options: { animation: 'walk', meshes: false, contacts: [{ bone: 'foot', start: 0, end: 1, tolerance: 0.01 }] } }); assert.ok(report.badMotion.findingCounts.foot_slide > 0); assert.ok(report.badMotion.preview?.path);
  report.fixedMotion = await call('spine_audit_animation', { input: report.contacts.path, options: { animation: 'planted', fps: 120, preview: 'none', contacts: [{ bone: 'foot', start: 0, end: 1, tolerance: 0.01 }] } }); assert.equal(report.fixedMotion.checksPassed, true);
  await call('spine_record_visual_review', { input: leg, decision: 'rejected', reviewer: 'synthetic-smoke-caller', note: 'Synthetic API regression fixture: deliberately drifting foot. This record is not a human review of the anime character.' });
  report.review = await call('spine_get_acceptance', { input: leg }); assert.equal(report.review.visualAcceptance, 'rejected');
  await call('spine_record_visual_review', { input: report.contacts.path, animations: ['planted'], decision: 'accepted', reviewer: 'synthetic-smoke-caller', note: 'Synthetic scoped API fixture, not a human review.' });
  report.scopedReview = await call('spine_get_acceptance', { input: report.contacts.path }); assert.equal(report.scopedReview.visualAcceptance, 'partial');
  assert.equal((await call('spine_get_acceptance', { input: report.contacts.path, animations: ['planted'] })).visualAcceptance, 'accepted');
  let physicsData = setConstraint(parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 100 }, { name: 'tip', parent: 'arm', x: 100 }], animations: {} }), { name: 'spring', type: 'physics', bone: 'arm', rotate: 1, gravity: 40, wind: 20, strength: 20, damping: 0.8 });
  physicsData = setTimeline(physicsData, 'move', 'root', 'translate', [{ time: 0, x: 0, y: 0 }, { time: 0.5, x: 80, y: 60 }, { time: 1, x: 0, y: 0 }]);
  const physicsInput = await json('physics.json', physicsData);
  report.physicsAudit = await call('spine_audit_animation', { input: physicsInput, options: { animation: 'move', physics: true, physicsFps: 60, preview: 'bones', contacts: [{ bone: 'tip', start: 0, end: 1, tolerance: 0.01 }] } });
  assert.equal(report.physicsAudit.physicsEvaluated, true); assert.equal(report.physicsAudit.physicsSampling.integrationSteps, 60); assert.ok(report.physicsAudit.preview?.path);
  const cases: Record<string, unknown>[] = [{ name: 'planted synthetic chain', input: report.contacts.path, expectedSha256: await fileSha256(report.contacts.path), expectedResourceHashes: [], audits: [{ animation: 'planted', fps: 120, preview: 'none', contacts: [{ bone: 'foot', start: 0, end: 1, tolerance: 0.01 }] }] }];
  report.directRegression = await call('spine_run_regression_suite', { cases }); assert.equal(report.directRegression.checksPassed, true);
  // The existing saved animation is optional: the smoke remains portable on a
  // clean installation, but records explicitly when the real character is absent.
  const character = path.join(config.workspaceRoot, 'anime-girl-mvkf8mq7', 'animations-final', 'Anime-Girl-Animations.json');
  const hasCharacter = await access(character).then(() => true).catch(() => false); report.characterPresent = hasCharacter;
  if (hasCharacter) {
    const characterHash = await fileSha256(character), requestId = randomUUID(), args = { requestId, input: character, output: path.join(directory, 'Anime-Girl-Verified.spine'), openInEditor: false };
    report.character = await call('spine_publish_and_open', args); assert.equal(report.character.structuralAndNativeRoundTrip, 'passed');
    const nativeHash = await fileSha256(report.character.project);
    await connection.client.close(); connection = await connectSpine({ local });
    const repeated = await call('spine_publish_and_open', args); assert.equal(repeated.project, report.character.project); assert.equal(await fileSha256(repeated.project), nativeHash);
    report.publicationStatus = await call('spine_get_publication', { id: requestId }); assert.equal(report.publicationStatus.projectUnchanged, true); report.idempotentAfterReconnect = true;
    const contacts = (end: number) => ['foot_back', 'foot_front'].map(bone => ({ bone, start: 0, end, tolerance: 0.1 }));
    const audits = [['01_idle_breeze', 4], ['02_greeting_wave', 5], ['03_charge_release', 5.5], ['04_jump_land', 4]].map(([animation, end]) => ({ animation, fps: 120, preview: 'none', contacts: animation === '04_jump_land' ? [...contacts(0.85), ...['foot_back', 'foot_front'].map(bone => ({ bone, start: 1.4, end, tolerance: 0.1 }))] : contacts(Number(end)), limbPairs: [{ a: ['leg_back_upper', 'leg_back_lower', 'foot_back'], b: ['leg_front_upper', 'leg_front_lower', 'foot_front'] }] }));
    cases.push({ name: 'current anime character, four clips', input: character, expectedSha256: characterHash, audits });
    report.characterSourceUnchanged = await fileSha256(character) === characterHash; assert.equal(report.characterSourceUnchanged, true);
  }
  const official = path.join(config.workspaceRoot, 'official-examples', 'examples', 'spineboy', 'spineboy-pro.spine');
  report.officialSpineboyPresent = await access(official).then(() => true).catch(() => false);
  if (report.officialSpineboyPresent) {
    const expectedSha256 = await fileSha256(official);
    report.officialNativeCompatibility = await call('spine_run_regression_suite', { cases: [{ name: 'official clipping native compatibility', input: official, expectedSha256, nativeRoundTrip: true }] });
    // This installed editor changes a concave clipping flag on import. The
    // safety guard MUST reject that change instead of declaring preservation.
    if (!report.officialNativeCompatibility.checksPassed) assert.match(report.officialNativeCompatibility.cases[0]?.error ?? '', /Clipping convexity differs/);
    report.officialNativeCompatibility.expectedSafetyRejection = !report.officialNativeCompatibility.checksPassed;
    report.officialMotionDiagnostics = await call('spine_audit_animation', { input: official, options: { animation: 'run', fps: 60, preview: 'none' } });
    report.officialMotionDiagnostics.reviewRequired = !report.officialMotionDiagnostics.checksPassed;
    report.officialVisibleCentroidDiagnostics = await call('spine_audit_animation', { input: official, options: { animation: 'run', fps: 60, preview: 'none', meshVisibility: 'centroid' } });
    assert.equal(report.officialVisibleCentroidDiagnostics.geometryFoldCandidates, report.officialMotionDiagnostics.geometryFoldCandidates);
    // Official artwork can contain intentionally folded or occluded triangles.
    // Keep those findings for visual review, never turn them into a quality pass.
    cases.push({ name: 'official spineboy source integrity and resources', input: official, expectedSha256 });
  }
  const submitted = await call('spine_start_job', { operation: 'regression_suite', args: { cases } }); report.backgroundJob = submitted.id; await save();
  await connection.client.close(); connection = await connectSpine({ local });
  report.liveRecovery = await call('spine_recover_job', { id: submitted.id }); assert.equal(report.liveRecovery.id, submitted.id);
  const deadline = Date.now() + 300000;
  while (true) {
    const job = await call('spine_get_job', { id: submitted.id, includeResult: true });
    if (['failed', 'cancelled', 'succeeded'].includes(job.state)) { assert.equal(job.state, 'succeeded', JSON.stringify(job)); report.regression = job.result; break; }
    if (Date.now() > deadline) throw new Error(`Background job timeout; inspect ${submitted.id}.`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(report.regression.checksPassed, true, JSON.stringify(report.regression)); assert.equal(report.regression.visualAcceptance, 'pending'); assert.equal(report.regression.releaseReady, false); report.detachedJobSurvivedDisconnect = true;
  report.completedRecovery = await call('spine_recover_job', { id: submitted.id }); assert.equal(report.completedRecovery.action, 'already_completed'); assert.equal(report.completedRecovery.resultRevalidated, false);
  const failedInput = path.join(directory, 'recover-input.json'), failed = await call('spine_start_job', { operation: 'audit_animation', args: { input: failedInput, options: { animation: 'rest', preview: 'none' } } });
  const waitJob = async (id: string) => { const until = Date.now() + 60000; while (Date.now() < until) { const job = await call('spine_get_job', { id, includeResult: true }); if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job; await new Promise(resolve => setTimeout(resolve, 200)); } throw new Error(`Recovery smoke timeout: ${id}`); };
  assert.equal((await waitJob(failed.id)).state, 'failed');
  await json('recover-input.json', { skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], animations: { rest: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 0 }] } } } } });
  report.failedRecovery = await call('spine_recover_job', { id: failed.id }); assert.equal(report.failedRecovery.action, 'retried');
  await connection.client.close(); connection = await connectSpine({ local });
  const repeatedRecovery = await call('spine_recover_job', { id: failed.id }); assert.equal(repeatedRecovery.action, 'existing_recovery'); assert.equal(repeatedRecovery.id, report.failedRecovery.id);
  report.recoveredJob = await waitJob(report.failedRecovery.id); assert.equal(report.recoveredJob.state, 'succeeded'); assert.equal(report.recoveredJob.result.checksPassed, true);
  assert.equal(await fileSha256(image), imageHash); assert.equal(await fileSha256(input), sourceHash); report.originalResourcesUnchanged = true;
  report.passed = true; report.completedAt = new Date().toISOString(); await save();
  const pointer = path.join(config.workspaceRoot, `stability-report-${VERSION}.json`); await writeFile(pointer, JSON.stringify({ passed: true, version: VERSION, reportPath, directory, project: report.character?.project ?? report.recipeNative.project, tools: TOOL_COUNT, nativeVisualAcceptance: 'pending', editorOpened: false }, null, 2));
  console.log(JSON.stringify({ passed: true, version: VERSION, tools: TOOL_COUNT, reportPath, nativeProject: report.character?.project, detachedJobSurvivedDisconnect: true, visualAcceptance: 'pending', editorOpened: false }, null, 2));
} catch (error) { report.error = (error as Error).message; await save(); throw error; }
finally { await connection.client.close(); }
