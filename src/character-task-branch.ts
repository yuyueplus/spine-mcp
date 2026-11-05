import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { VERSION } from './version.js';
import { syncLease } from './sync-lock.js';
import { createCharacterTaskSchema, createCharacterTask, saveCharacterTaskState, characterTaskSource } from './character-task.js';
import { digest, pin, sha, label, filename, request, jsonRead, verifyPins, verifySource, captureSource, immutableJson, operation, readCandidate, type Pin, type SourcePin } from './character-candidates.js';
import { readHandoff } from './layer-handoff.js';
import { readPngAsset } from './image-assets.js';
import { constructionSource } from './character-construction.js';
import { authoringLandmarkSchema, validateStageReviews } from './task-authoring.js';

const stages = ['raster', 'raster_import', 'landmarks', 'import', 'prepare', 'controls', 'motion', 'compose', 'plan', 'replace', 'repair', 'ik', 'contact', 'mesh', 'media', 'candidate', 'promote', 'preview'];
const patch = z.object({ name: label.optional(), input: filename.optional(), assets: createCharacterTaskSchema.shape.assets.removeDefault().optional(), authoring: createCharacterTaskSchema.shape.authoring.optional(), meshRepair: createCharacterTaskSchema.shape.meshRepair.optional(), construction: createCharacterTaskSchema.shape.construction.optional(), compose: createCharacterTaskSchema.shape.compose.optional(), replacements: createCharacterTaskSchema.shape.replacements.removeDefault().optional(), repair: createCharacterTaskSchema.shape.repair.optional(), ikRepair: createCharacterTaskSchema.shape.ikRepair.optional(), contactRepair: createCharacterTaskSchema.shape.contactRepair.optional(), reviewMedia: createCharacterTaskSchema.shape.reviewMedia.removeDefault().optional(), publication: createCharacterTaskSchema.shape.publication.removeDefault().optional(), waitForPreview: z.boolean().optional(), removeStages: z.array(z.enum(['authoring','construction','meshRepair', 'compose', 'repair', 'ikRepair', 'contactRepair', 'reviewMedia'])).max(8).default([]) }).strict();
export const planTaskBranchSchema = z.object({ id: z.string().uuid(), expectedPlanSha256: sha, patch: patch.default({ removeStages: [] }), allowVersionMigration: z.boolean().default(false), acceptSourceDrift: z.boolean().default(false) }).strict();
export const applyTaskBranchSchema = z.object({ ...request, plan: filename, expectedSha256: sha }).strict();
async function readParent(service: SpineService, id: string, expected: string) {
  z.string().uuid().parse(id); const directory = await service.workspace.resolve(path.join('.character-tasks', id)), planPin = await pin(service, path.join(directory, 'plan.json')), statePin = await pin(service, path.join(directory, 'state.json'));
  if (planPin.sha256 !== expected) throw new Error('Parent task plan changed.');
  const plan = await jsonRead(service, planPin.path), saved = await jsonRead(service, statePin.path), state = saved.state;
  if (plan.schema !== 'spine-character-task/1' || saved.sha256 !== digest(state) || state?.schema !== 'spine-character-task-state/1' || state.id !== id || plan.id !== id || state.version !== plan.version || state.planSha256 !== expected) throw new Error('Invalid or damaged parent task.');
  return { directory, plan, state, planPin, statePin };
}
const uniquePins = (pins: Pin[]) => { const map = new Map<string, Pin>(); for (const p of pins) { const old = map.get(p.path); if (old && old.sha256 !== p.sha256) throw new Error('Conflicting pinned input revisions.'); map.set(p.path, p); } return [...map.values()]; };
function fingerprints(root: string, args: any, source: SourcePin, json: Pin, assets: Record<string, Pin>, files: Pin[]) {
  const canonical = (v: string) => path.resolve(root, v), lookup = new Map(files.map(p => [canonical(p.path), p.sha256])), keys: Record<string, string | undefined> = {}, sourceKey = digest({ source, jsonSha256: json.sha256 }); let current = sourceKey;
  if(args.authoring){keys.raster=digest({input:current,args:args.authoring.raster});keys.raster_import=digest({raster:keys.raster});current=keys.raster_import;keys.landmarks=digest({input:current,args:args.authoring.landmarks});keys.prepare=digest({review:keys.landmarks,stage:'prepare'});keys.controls=digest({input:keys.prepare,stage:'controls'});keys.motion=digest({input:keys.controls,stage:'motion'});current=keys.motion;}
  if (args.construction) { const c=args.construction;if(c.psd){keys.import=digest({input:current,psd:c.psd});current=keys.import;}keys.prepare=digest({input:current,preparation:c.preparation});current=keys.prepare;keys.controls=digest({input:current,controls:c.controls});current=keys.controls;keys.motion=digest({input:current,expectedDataSha256:c.expectedDataSha256,motions:c.motions,templates:c.templates.map((t:any)=>({...t,sha256:lookup.get(canonical(t.template))}))});current=keys.motion; }
  const ref = (v: any): unknown => typeof v === 'string' ? { path: canonical(v), sha256: lookup.get(canonical(v)) } : v.asset ? { asset: v.asset, pin: assets[v.asset] ?? null } : { repaint: v.repaint, compose: keys.compose };
  if (args.compose) keys.compose = digest({ args: { ...args.compose, repaints: args.compose.repaints.map((r: any) => ({ ...r, image: ref(r.image) })) }, handoff: lookup.get(canonical(args.compose.handoff)) ?? args.compose.expectedSha256 });
  if (args.replacements?.length) { keys.plan = digest({ input: current, replacements: args.replacements.map((r: any) => ({ ...r, image: ref(r.image) })) }); keys.replace = digest({ plan: keys.plan }); current = keys.replace; }
  for (const [stage, field] of [['repair', 'repair'], ['ik', 'ikRepair'], ['contact', 'contactRepair'],['mesh','meshRepair']] as const) if (args[field]) { keys[stage] = digest({ input: current, args: args[field] }); current = keys[stage]!; }
  if (args.reviewMedia?.length) keys.media = digest({ input: current, options: args.reviewMedia }); return keys;
}
export async function planCharacterTaskBranch(service: SpineService, raw: z.input<typeof planTaskBranchSchema>) {
  const args = planTaskBranchSchema.parse(raw), f = await readParent(service, args.id, args.expectedPlanSha256), release = await syncLease(service.workspace, path.join(f.directory, 'task.lock'));
  if (!release) throw new Error('Parent task is running. Wait/cancel it before planning a branch.');
  try {
    const parent = await readParent(service, args.id, args.expectedPlanSha256);await validateStageReviews(service,parent.state);const blockers: string[] = [], warnings: string[] = [];
    if (!['2.16.0', '2.17.0', '2.18.0', '2.19.0', '2.20.0', '2.21.0', VERSION].includes(parent.plan.version)) throw new Error('Unsupported task version. Only this build and reviewed 2.16/2.17/2.18/2.19/2.20/2.21 task formats can be migrated.');
    if (parent.plan.version !== VERSION && !args.allowVersionMigration) blockers.push('Cross-version reuse requires explicit allowVersionMigration=true.');
    let sourceDrift = false; try { await verifySource(service, parent.plan.source); } catch { sourceDrift = true; }
    if (sourceDrift && !args.acceptSourceDrift) blockers.push('Parent source/resources changed. Explicit acceptSourceDrift is required and invalidates prior source-dependent stages.');
    const p = args.patch, oldArgs = parent.plan.args, childArgs: any = { ...oldArgs, ...p, requestId: randomUUID(), name: p.name ?? `${oldArgs.name} branch`, assets: { ...Object.fromEntries(Object.entries(parent.state.assets).map(([name, value]) => [name, (value as Pin).path])), ...p.assets } }; delete childArgs.removeStages;
    for (const name of p.removeStages) { if (name === 'reviewMedia') childArgs.reviewMedia = []; else delete childArgs[name]; }
    if (!p.publication) { childArgs.publication = { ...oldArgs.publication, openInEditor: false }; if (childArgs.publication.session) { delete childArgs.publication.session; warnings.push('The parent session binding is not inherited. Select an explicit current source/revision to publish a new branch into a session.'); } }
    if(childArgs.authoring&&!p.authoring&&parent.state.stageReviews?.landmarks?.decision==='accepted'){const reviewed=await jsonRead(service,parent.state.stageReviews.landmarks.result.path),raw=reviewed.landmarks?.args;if(raw)childArgs.authoring={...childArgs.authoring,landmarks:authoringLandmarkSchema.parse(Object.fromEntries(Object.keys(authoringLandmarkSchema.shape).filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]])))};}
    const validated = createCharacterTaskSchema.parse(childArgs), inheritedSource = !sourceDrift && await service.workspace.resolve(validated.input) === await service.workspace.resolve(parent.plan.source.input), snapshot = inheritedSource ? { source: parent.plan.source as SourcePin, jsonPath: parent.plan.json as string } : await characterTaskSource(service, validated);
    const jsonPin = await pin(service, snapshot.jsonPath), pins: Pin[] = [parent.planPin, parent.statePin, jsonPin, { path: snapshot.source.input, sha256: snapshot.source.sha256 }, ...snapshot.source.files], newAssets: Record<string, Pin> = {};
    for (const [name, image] of Object.entries(validated.assets)) { await readPngAsset(service.workspace, image); newAssets[name] = await pin(service, image); pins.push(newAssets[name]!); }
    for (const v of [...validated.replacements.map(r => r.image), ...(validated.compose?.repaints.map(r => r.image) ?? [])]) if (typeof v === 'string') { const asset = await readPngAsset(service.workspace, v), q = await pin(service, asset.path); pins.push(q, { path: v, sha256: q.sha256 }); }
    if (validated.construction?.psd) { await constructionSource(service, validated.input, validated.construction); pins.push(await pin(service, validated.construction.psd.plan)); }
    for (const template of [...(validated.construction?.templates ?? []),...(validated.authoring?.landmarks.templates ?? [])]) pins.push(await pin(service, template.template));
    if (validated.compose) { const h = await readHandoff(service, validated.compose.handoff, validated.compose.expectedSha256); pins.push(await pin(service, validated.compose.handoff), ...h.files); }
    const oldJson = parent.plan.pins.find((p: Pin) => p.path === parent.plan.json); if (!oldJson) throw new Error('Parent JSON snapshot is not pinned.');
    const oldKeys = fingerprints(service.workspace.root, oldArgs, parent.plan.source, oldJson, parent.state.assets, parent.plan.pins), newKeys = fingerprints(service.workspace.root, validated, snapshot.source, jsonPin, newAssets, pins), decisions: any[] = [], reused: Record<string, any> = {};
    const rebuilt = new Set<string>(); let previousOutput: string | undefined;
    for (const name of stages) {
      const previous = parent.state.steps[name], enabled = newKeys[name] !== undefined;
      const usesRepaint = validated.replacements.some(r => typeof r.image === 'object' && 'repaint' in r.image);
      const dependencies = name === 'raster_import' ? ['raster'] : name === 'landmarks' ? ['raster_import'] : name === 'plan' ? [...(usesRepaint ? ['compose'] : []), ...(previousOutput ? [previousOutput] : [])] : name === 'replace' ? ['plan'] : ['prepare', 'controls', 'motion', 'repair', 'ik', 'contact','mesh', 'media'].includes(name) && previousOutput ? [previousOutput] : [];
      let reason = !enabled ? 'stage_not_enabled' : !previous?.completed ? 'no_completed_parent_stage' : oldKeys[name] !== newKeys[name] ? 'arguments_or_input_dependencies_changed' : dependencies.some(d => rebuilt.has(d)) ? 'upstream_output_will_be_rebuilt' : undefined;
      if(validated.authoring&&enabled&&['prepare','controls','motion','plan','replace','repair','ik','contact','mesh','media'].includes(name))reason='interactive_landmark_review_requires_new_downstream_blueprint';
      if (parent.plan.version !== VERSION && name !== 'compose' && enabled && !reason) reason = 'cross_version_stage_requires_revalidation';
      if (['candidate', 'promote', 'preview'].includes(name)) reason = 'new_candidate_review_and_publication_identity_required';
      if (!reason) try {
        await verifyPins(service, [previous.result, ...(previous.pins ?? [])]); const result = await jsonRead(service, previous.result.path);
        if (result.candidate) { const c = await readCandidate(service, { candidate: result.candidate, expectedSha256: result.candidateSha256 }); if (!c.checksPassed || c.sourceChanged) throw new Error('Parent candidate/source is not valid.'); }
        pins.push(previous.result, ...(previous.pins ?? [])); reused[name] = previous;
      } catch (e) { reason = 'parent_artifact_changed: ' + (e as Error).message; }
      decisions.push({ stage: name, action: reason ? enabled || ['candidate', 'promote', 'preview'].includes(name) ? 'recompute' : 'skip' : 'reuse', reason: reason ?? 'same_stage_arguments_inputs_and_verified_artifacts', oldKey: oldKeys[name], newKey: newKeys[name] });
      if (enabled && reason) rebuilt.add(name);
      if (enabled && ['raster_import','import', 'prepare', 'controls', 'motion', 'replace', 'repair', 'ik', 'contact','mesh'].includes(name)) previousOutput = name;
    }
    const report = { schema: 'spine-character-task-branch/1', version: VERSION, parentId: args.id, parentVersion: parent.plan.version, parentPlanSha256: args.expectedPlanSha256, mode: parent.plan.version === VERSION ? 'branch' : 'migration_branch', checksPassed: blockers.length === 0, blockers, warnings, sourceDrift, childArgs: validated, snapshot: { source: snapshot.source, jsonPath: snapshot.jsonPath }, reused, decisions, pins: uniquePins(pins), resetReview: true, parentUnchanged: true };
    await verifyPins(service, report.pins); const out = await immutableJson(service, 'character-task-branch-plans', report); return { ...report, plan: out.path, planSha256: out.sha256 };
  } finally { await release(); }
}
export async function applyCharacterTaskBranch(service: SpineService, raw: z.input<typeof applyTaskBranchSchema>) {
  const args = applyTaskBranchSchema.parse(raw);
  return operation(service, args.requestId, 'apply_character_task_branch', args, async () => {
    const p = await pin(service, args.plan); if (p.sha256 !== args.expectedSha256) throw new Error('Branch plan changed.'); const plan = await jsonRead(service, p.path);
    if (plan.schema !== 'spine-character-task-branch/1' || plan.version !== VERSION || !plan.checksPassed) throw new Error('Blocked or incompatible branch plan.');
    if (args.requestId === plan.childArgs.requestId) throw new Error('Use a separate apply requestId from the planned child task id.');
    const parent = await readParent(service, plan.parentId, plan.parentPlanSha256), parentRelease = await syncLease(service.workspace, path.join(parent.directory, 'task.lock')); if (!parentRelease) throw new Error('Parent task is busy.');
    let childRelease: (() => Promise<void>) | null = null;
    try {
      await verifyPins(service, plan.pins); const childArgs = createCharacterTaskSchema.parse(plan.childArgs), childDir = await service.workspace.resolve(path.join('.character-tasks', childArgs.requestId), false); await mkdir(childDir, { recursive: true });
      childRelease = await syncLease(service.workspace, path.join(childDir, 'task.lock')); if (!childRelease) throw new Error('Child branch is busy.');
      const child = await createCharacterTask(service, childArgs, { ...plan.snapshot, provenance: { parentId: plan.parentId, parentVersion: plan.parentVersion, branchPlan: p, decisions: plan.decisions, explicitMigration: plan.mode === 'migration_branch' } });
      const saved = await jsonRead(service, path.join(childDir, 'state.json'));
      if (saved.sha256 !== digest(saved.state)) throw new Error('Child task state is damaged.');
      if (!saved.state.branchInitialized) {
        if (saved.state.jobId || saved.state.phase !== 'ready' || Object.values(saved.state.steps).some((s: any) => s.completed)) throw new Error('Child already started before branch initialization.');
        for (const [name, previous] of Object.entries(plan.reused) as [string, any][]) saved.state.steps[name] = { ...previous, requestId: saved.state.steps[name].requestId, inheritedFrom: { id: plan.parentId, version: plan.parentVersion, step: name } };
        saved.state.branchInitialized = true; saved.state.phase = 'ready'; delete saved.state.review; delete saved.state.candidate; await saveCharacterTaskState(childDir, saved.state);
      }
      await verifyPins(service, plan.pins);
      return { ...child, reusedStages: Object.keys(plan.reused), resetReview: true, parentUnchanged: true, pinnedFiles: [p, await pin(service, child.plan)], note: 'Run the NEW task. Only inherited stages reuse old artifacts; review and publication always have new identities.' };
    } finally { if (childRelease) await childRelease(); await parentRelease(); }
  });
}
