import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { SpineService } from './service.js';
import type { WorkControl } from './progress.js';
import { checkpoint } from './progress.js';
import { atomicJson } from './jobs.js';
import { syncLease } from './sync-lock.js';
import { VERSION } from './version.js';
import { filename, label, sha, request, digest, jsonRead, pin, verifyPins, captureSource, verifySource, operation, writeCandidate, readCandidate, promoteCandidate, promoteCandidateSchema, type Pin, type SourcePin } from './character-candidates.js';
import { composeRepaintSchema, composeLayerRepaint } from './repaint-composition.js';
import { readHandoff } from './layer-handoff.js';
import { planBatchReplacementSchema, planBatchImageReplacement, applyBatchImageReplacement } from './batch-image-replacement.js';
import { repairSchema, createAnimationRepair } from './animation-repair.js';
import { ikTargetRepairSchema, createIkTargetRepair } from './ik-target-repair.js';
import { ikContactRepairSchema, createIkContactRepair } from './ik-contact-repair.js';
import { mediaOptionsSchema } from './job-schema.js';
import { collectAssets } from './production-assets.js';
import { readPngAsset } from './image-assets.js';
import { fileSha256 } from './file-hash.js';
import { constructionSchema, constructionSource, constructControls, constructMotions, constructionDigest } from './character-construction.js';
import { prepareCharacterData } from './character-workflow.js';
import { characterSchema } from './stability-schema.js';
import { writeDocument } from './document.js';
import { importPsd } from './psd-import.js';
import { newFolder } from './character-candidates.js';
import { taskAuthoringSchema, taskMeshRepairSchema, reviewTaskStageSchema, rawAuthoringSource, validateStageReviews, getTaskStageGate, runTaskAuthoring, reviewAuthoringStage } from './task-authoring.js';
import { createMeshDeformRepair } from './mesh-deform-repair.js';
import { createJointMeshRepair } from './joint-mesh-repair.js';

const imageRef = z.union([filename, z.object({ asset: label }).strict(), z.object({ repaint: label }).strict()]);
const repaint = composeRepaintSchema.shape.repaints.element.omit({ image: true }).extend({ image: z.union([filename, z.object({ asset: label }).strict()]) });
const replacement = planBatchReplacementSchema.shape.replacements.element.omit({ image: true }).extend({ image: imageRef });
const assets = z.record(label, filename).refine(v => Object.keys(v).length <= 64, 'At most 64 assets.');
export const createCharacterTaskSchema = z.object({ ...request, input: filename, name: label, authoring: taskAuthoringSchema.optional(), construction: constructionSchema.optional(), meshRepair: taskMeshRepairSchema.optional(), assets: assets.default({}), compose: z.object({ handoff: filename, expectedSha256: sha, repaints: z.array(repaint).min(1).max(64) }).strict().optional(), replacements: z.array(replacement).max(64).default([]), repair: repairSchema.omit({ requestId: true, input: true }).optional(), ikRepair: ikTargetRepairSchema.omit({ requestId: true, input: true }).optional(), contactRepair: ikContactRepairSchema.omit({ requestId: true, input: true }).optional(), reviewMedia: z.array(mediaOptionsSchema).max(8).default([]), publication: promoteCandidateSchema.omit({ requestId: true, candidate: true, expectedSha256: true, confirmation: true, note: true }).default({ native: true, openInEditor: false }), waitForPreview: z.boolean().default(true) }).strict().refine(a => a.authoring || a.construction || a.meshRepair || a.replacements.length || a.repair || a.ikRepair || a.contactRepair, 'Provide authoring, construction, replacements or repair.').refine(a=>!a.authoring||!a.construction,'Authoring derives its construction from the reviewed landmark blueprint.').refine(a=>!a.authoring||!a.publication.session,'New PSD authoring cannot publish into an existing source session.');
export const characterTaskSelector = z.object({ id: z.string().uuid(), expectedPlanSha256: sha }).strict();
export const supplyCharacterTaskSchema = characterTaskSelector.extend({ ...request, assets });
export const reviewCharacterTaskSchema = characterTaskSelector.extend({ ...request, candidateSha256: sha, decision: z.enum(['accepted', 'rejected']), note: z.string().min(5).max(4000) });
export type Stage = { requestId: string; completed?: boolean; result?: Pin; pins?: Pin[]; assets?: string[]; inheritedFrom?: { id: string; version: string; step: string } };
interface State { schema: string; id: string; version: string; planSha256: string; phase: string; assets: Record<string, Pin>; steps: Record<string, Stage>; stageReviews?: Record<string, any>; currentStep?: string; jobId?: string; candidate?: { candidate: string; candidateSha256: string }; review?: { decision: string; candidateSha256: string; note: string; requestId: string }; missingAssets?: string[]; error?: string; updatedAt: string }
const stepNames = ['raster', 'raster_import', 'landmarks', 'import', 'prepare', 'controls', 'motion', 'compose', 'plan', 'replace', 'repair', 'ik', 'contact', 'mesh', 'media', 'candidate', 'promote', 'preview'];
export function plannedCharacterTaskStages(c:any){const names:string[]=[];if(c.authoring)names.push('raster','raster_import','landmarks','prepare','controls','motion');else if(c.construction){if(c.construction.psd)names.push('import');names.push('prepare','controls','motion');}if(c.compose)names.push('compose');if(c.replacements.length)names.push('plan','replace');if(c.repair)names.push('repair');if(c.ikRepair)names.push('ik');if(c.contactRepair)names.push('contact');if(c.meshRepair)names.push('mesh');if(c.reviewMedia.length)names.push('media');names.push('candidate','promote');if(c.waitForPreview&&c.publication.session)names.push('preview');return names;}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function folder(service: SpineService, id: string) { z.string().uuid().parse(id); return service.workspace.resolve(path.join('.character-tasks', id)); }
export async function saveCharacterTaskState(directory: string, state: State) { state.updatedAt = new Date().toISOString(); await atomicJson(path.join(directory, 'state.json'), { state, sha256: digest(state) }); }
const saveState = saveCharacterTaskState;
async function load(service: SpineService, raw: z.input<typeof characterTaskSelector>) {
  const args = characterTaskSelector.parse({ id: raw.id, expectedPlanSha256: raw.expectedPlanSha256 }), directory = await folder(service, args.id), file = path.join(directory, 'plan.json'), planPin = await pin(service, file);
  if (planPin.sha256 !== args.expectedPlanSha256) throw new Error('Character task plan changed.');
  const plan = await jsonRead(service, file), saved = await jsonRead(service, path.join(directory, 'state.json')), state = saved.state as State;
  if (plan.schema !== 'spine-character-task/1' || plan.version !== VERSION || state?.schema !== 'spine-character-task-state/1' || state.id !== args.id || state.version !== VERSION || state.planSha256 !== planPin.sha256 || saved.sha256 !== digest(state) || !stepNames.every(n => z.string().uuid().safeParse(state.steps?.[n]?.requestId).success)) throw new Error('Invalid/damaged character task or incompatible build.');
  createCharacterTaskSchema.parse(plan.args); return { directory, plan, state };
}
async function lease(service: SpineService, directory: string, wait = false) {
  for (let i = 0; i < (wait ? 200 : 1); i++) { const release = await syncLease(service.workspace, path.join(directory, 'task.lock')); if (release) return release; await delay(50); }
  throw new Error('Character task is already running. Query its state/job instead.');
}
export async function characterTaskSource(service:SpineService,args:z.output<typeof createCharacterTaskSchema>){return args.authoring?rawAuthoringSource(service,args.input):constructionSource(service,args.input,args.construction);}
async function validateInputs(service: SpineService, plan: any, state: State, replacing = new Set<string>()) { await validateStageReviews(service,state); await verifySource(service, plan.source); await verifyPins(service, plan.pins); await verifyPins(service, Object.entries(state.assets).filter(([name]) => !replacing.has(name)).map(([, p]) => p)); for (const s of Object.values(state.steps)) if (s.completed) await verifyPins(service, [s.result!, ...(s.pins ?? [])]); }
export async function createCharacterTask(service: SpineService, raw: z.input<typeof createCharacterTaskSchema>, seed?: { source: SourcePin; jsonPath: string; provenance: unknown }) {
  const args = createCharacterTaskSchema.parse(raw);
  return operation(service, args.requestId, 'create_character_task', seed ? { args, seed } : args, async () => {
    if (seed) { if (await service.workspace.resolve(args.input) !== await service.workspace.resolve(seed.source.input)) throw new Error('Seed source does not match task input.'); await verifySource(service, seed.source); await service.workspace.resolve(seed.jsonPath); }
    const source = seed ?? await characterTaskSource(service, args), pins = [await pin(service, source.jsonPath)], initialAssets: Record<string, Pin> = {};
    const checkImage = async (image: string) => { await readPngAsset(service.workspace, image); return pin(service, image); };
    for (const [name, image] of Object.entries(args.assets)) initialAssets[name] = await checkImage(image);
    const refs = [...args.replacements.map(r => r.image), ...(args.compose?.repaints.map(r => r.image) ?? [])];
    for (const ref of refs) if (typeof ref === 'string') pins.push(await checkImage(ref));
    if (args.construction?.psd) { await constructionSource(service, args.input, args.construction); pins.push(await pin(service, args.construction.psd.plan)); }
    for (const t of [...(args.construction?.templates ?? []),...(args.authoring?.landmarks.templates ?? [])]) pins.push(await pin(service, t.template));
    if(args.meshRepair?.mode==='joint'&&args.meshRepair.seamPlan){const p=await pin(service,args.meshRepair.seamPlan.plan);if(p.sha256!==args.meshRepair.seamPlan.expectedSha256)throw Error('Task seam plan changed.');const seam=await jsonRead(service,p.path);if(seam.schema!=='spine-mesh-seam-plan/1'||seam.version!==VERSION||!seam.source)throw Error('Invalid/incompatible task seam plan.');await verifySource(service,seam.source);await verifyPins(service,seam.pins);pins.push(p,{path:seam.source.input,sha256:seam.source.sha256},...seam.source.files,...seam.pins);}
    if (args.compose) { const h = await readHandoff(service, args.compose.handoff, args.compose.expectedSha256); pins.push(await pin(service, args.compose.handoff), ...h.files); }
    for (const r of args.replacements) { const ref = r.image; if (typeof ref === 'object' && 'repaint' in ref && !args.compose?.repaints.some(p => p.layer === ref.repaint)) throw new Error('Replacement references an unplanned repaint layer.'); }
    const directory = await service.workspace.resolve(path.join('.character-tasks', args.requestId), false); await mkdir(directory, { recursive: true });
    const plan = { schema: 'spine-character-task/1', version: VERSION, id: args.requestId, args, source: source.source, json: source.jsonPath, pins, initialAssets, provenance: seed?.provenance, createdAt: new Date().toISOString(), imageGeneration: 'Codex supplies generated assets externally; MCP never invokes a model or reads arbitrary instructions.' }, file = path.join(directory, 'plan.json');
    try { await writeFile(file, JSON.stringify(plan, null, 2), { flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; const prior = await jsonRead(service, file); if (digest(prior.args) !== digest(args) || prior.version !== VERSION) throw new Error('Task id belongs to different arguments/build.'); await verifySource(service, prior.source); await verifyPins(service, prior.pins); }
    const p = await pin(service, file), savedPlan = await jsonRead(service, file), stateFile = path.join(directory, 'state.json');
    try { await readFile(stateFile); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await verifyPins(service, Object.values(savedPlan.initialAssets)); await saveState(directory, { schema: 'spine-character-task-state/1', id: args.requestId, version: VERSION, planSha256: p.sha256, phase: 'ready', assets: savedPlan.initialAssets, steps: Object.fromEntries(stepNames.map(n => [n, { requestId: randomUUID() }])), updatedAt: new Date().toISOString() }); }
    return { id: args.requestId, plan: file, planSha256: p.sha256, phase: 'ready', pinnedFiles: [p], note: 'Run with spine_run_character_task. Missing external assets pause the task; explicit candidate review is required before publication.' };
  });
}
export async function getCharacterTask(service: SpineService, raw: z.input<typeof characterTaskSelector>) {
  const { directory, plan, state } = await load(service, raw); let drift: string | undefined;
  try { await validateInputs(service, plan, state); } catch (e) { drift = (e as Error).message; }
  const job = state.jobId ? await service.jobs.get(state.jobId, false) : undefined, results: Record<string, any> = {};
  for (const [name, step] of Object.entries(state.steps)) if (step.completed) { await verifyPins(service, [step.result!]); results[name] = await jsonRead(service, step.result!.path); }
  const stageGate=!drift?await getTaskStageGate(service,state):undefined;
  const planned=plannedCharacterTaskStages(plan.args);
  return { ...state, progress:{completed:planned.filter(n=>state.steps[n]?.completed).length,total:planned.length,planned,current:state.currentStep}, stageGate, displayArtifacts:stageGate?.displayArtifacts, directory, name: plan.args.name, drift, inputsAndCompletedArtifactsValid: !drift, job, results, nativeDisplayAcknowledged: false, guidance: state.phase === 'awaiting_stage_review'||state.phase === 'stage_rejected' ? 'Review the exact raster/landmark stage via spine_review_character_task_stage. Revise landmarks first, then accept their exact plan SHA.' : state.phase === 'awaiting_assets' ? 'Codex generates the listed local PNGs outside MCP; supply their explicit asset names and run again.' : state.phase === 'awaiting_review' ? 'Inspect the exact candidate/media; explicitly accept/reject its SHA before running publication.' : undefined };
}
export async function supplyCharacterTaskAssets(service: SpineService, raw: z.input<typeof supplyCharacterTaskSchema>) {
  const args = supplyCharacterTaskSchema.parse(raw);
  return operation(service, args.requestId, 'supply_character_task_assets', args, async () => {
    const f = await load(service, args), release = await lease(service, f.directory);
    try {
      await validateInputs(service, f.plan, f.state, new Set(Object.keys(args.assets)));
      if (f.state.steps.candidate!.completed) throw new Error('Candidate already frozen. Create a new task to change its assets.');
      const pins = []; let changedExisting = false;
      for (const [name, image] of Object.entries(args.assets)) {
        await readPngAsset(service.workspace, image); const p = await pin(service, image), old = f.state.assets[name];
        if (old && (old.sha256 !== p.sha256 || old.path !== p.path) && Object.values(f.state.steps).some(s => s.completed && s.assets?.includes(name))) throw new Error('A completed stage already used this asset; create a new task.');
        if (old && (old.sha256 !== p.sha256 || old.path !== p.path)) changedExisting = true;
        f.state.assets[name] = p; pins.push(p);
      }
      if (changedExisting) for (const step of Object.values(f.state.steps)) if (!step.completed) step.requestId = randomUUID();
      f.state.phase = 'ready'; delete f.state.error; delete f.state.missingAssets; await saveState(f.directory, f.state);
      return { id: args.id, phase: f.state.phase, supplied: Object.keys(args.assets), pinnedFiles: pins };
    } finally { await release(); }
  });
}
export async function reviewCharacterTask(service: SpineService, raw: z.input<typeof reviewCharacterTaskSchema>) {
  const args = reviewCharacterTaskSchema.parse(raw);
  return operation(service, args.requestId, 'review_character_task', args, async () => {
    const f = await load(service, args), release = await lease(service, f.directory);
    try {
      await validateInputs(service, f.plan, f.state);
      if (f.state.steps.promote!.completed) throw new Error('Task already published; a later review cannot undo publication.');
      if (!f.state.candidate || f.state.candidate.candidateSha256 !== args.candidateSha256) throw new Error('Review must select the exact current task candidate SHA.');
      const c = await readCandidate(service, { candidate: f.state.candidate.candidate, expectedSha256: args.candidateSha256 }); if (!c.checksPassed || c.sourceChanged) throw new Error('Candidate failed checks or its source changed.');
      f.state.review = { decision: args.decision, candidateSha256: args.candidateSha256, note: args.note, requestId: args.requestId }; f.state.phase = args.decision === 'accepted' ? 'reviewed' : 'rejected'; await saveState(f.directory, f.state);
      return { id: args.id, phase: f.state.phase, selection: 'explicit_caller_reported', authenticatedHumanReview: false, pinnedFiles: [await pin(service, c.candidate), ...c.files] };
    } finally { await release(); }
  });
}
async function liveJob(service: SpineService, id: string) {
  for (const s of (await service.jobs.list(1000)).jobs.filter(s => s.operation === 'character_task' && ['queued', 'running'].includes(s.state))) {
    const stored = await jsonRead(service, path.join(await service.jobs.folder(s.id), 'request.json'));
    if (stored.request.args.id === id) { const job = await service.jobs.get(s.id); if (job.state === 'queued' || job.workerAlive) return job; }
  }
}
export async function startCharacterTask(service: SpineService, raw: z.input<typeof characterTaskSelector>) {
  const args = characterTaskSelector.parse(raw); await load(service, args);
  const existing = await liveJob(service, args.id); if (existing) { service.jobs.kick(await service.jobs.root()); return { id: args.id, job: existing, reused: true }; }
  const f = await load(service, args), release = await lease(service, f.directory);
  try {
    const concurrent = await liveJob(service, args.id); if (concurrent) return { id: args.id, job: concurrent, reused: true };
    await validateInputs(service, f.plan, f.state);
    if (f.state.phase === 'completed') return { id: args.id, phase: 'completed', reused: true };
    if (['awaiting_stage_review','stage_rejected'].includes(f.state.phase)) return {id:args.id,phase:f.state.phase,stageGate:await getTaskStageGate(service,f.state),reused:true};
    if (f.state.phase === 'rejected') throw new Error('Candidate was rejected. A new exact review or a new task is required.');
    if (f.state.phase === 'awaiting_review' && f.state.review?.decision !== 'accepted') return { id: args.id, phase: 'awaiting_review', candidate: f.state.candidate, reused: true };
    if (f.state.phase === 'awaiting_assets') return { id: args.id, phase: 'awaiting_assets', missingAssets: f.state.missingAssets, reused: true };
    const job = await service.jobs.submit({ operation: 'character_task', args }); f.state.jobId = job.id; f.state.phase = 'queued'; await saveState(f.directory, f.state); return { id: args.id, job, reused: false };
  } finally { await release(); }
}
class MissingAssets extends Error { constructor(readonly names: string[]) { super('Missing external assets: ' + names.join(', ')); } }
export async function runCharacterTask(service: SpineService, raw: z.input<typeof characterTaskSelector>, control?: WorkControl, jobId?: string) {
  const args = characterTaskSelector.parse(raw), directory = await folder(service, args.id), release = await lease(service, directory, true);
  const f = await load(service, args).catch(async e => { await release(); throw e; }), { plan, state } = f, config = createCharacterTaskSchema.parse(plan.args);
  try {
    await validateInputs(service, plan, state); delete state.error; state.phase = 'running'; if (jobId) state.jobId = jobId; await saveState(directory, state);
    const results: Record<string, any> = {}; let current = plan.json as string, used = new Set<string>();
    const image = async (ref: z.output<typeof imageRef>): Promise<string> => {
      if (typeof ref === 'string') return ref;
      if ('repaint' in ref) { const value = results.compose?.replacements.find((p: any) => p.layer === ref.repaint)?.image; if (!value) throw new Error('Missing composed repaint output.'); return value; }
      const p = state.assets[ref.asset]; if (!p) throw new MissingAssets([ref.asset]); used.add(ref.asset); await verifyPins(service, [p]); return p.path;
    };
    async function stage(name: string, action: (requestId: string) => Promise<any>) {
      const s = state.steps[name]!; state.currentStep = name;
      await checkpoint(control, { phase: 'character_task:' + name, completed: plannedCharacterTaskStages(config).filter(n=>state.steps[n]?.completed).length, total: plannedCharacterTaskStages(config).length });
      if (s.completed) { await verifyPins(service, [s.result!, ...(s.pins ?? [])]); return results[name] = await jsonRead(service, s.result!.path); }
      used = new Set(); await saveState(directory, state); const result = await action(s.requestId), resultPath = path.join(directory, name + '-result.json');
      await atomicJson(resultPath, result); s.result = await pin(service, resultPath); s.pins = result.pinnedFiles ?? []; s.assets = [...used]; s.completed = true; await saveState(directory, state); return results[name] = result;
    }
    const authoring=await runTaskAuthoring(service,config,plan,state,directory,stage,()=>saveState(directory,state));
    if(authoring?.paused)return{id:args.id,phase:state.phase,stageGate:await getTaskStageGate(service,state)};
    if(authoring?.current)current=authoring.current;
    const construction=authoring?.construction??config.construction;
    if (construction) {
      const c = construction;
      if (c.psd) { const r = await stage('import', requestId => importPsd(service, { requestId, plan: c.psd!.plan, expectedSha256: c.psd!.expectedSha256 }, control)); current = r.json; }
      const buildStage = async (name: string, action: (data: any) => Promise<{ data: any; details?: unknown; pins?: Pin[] }>) => {
        const r = await stage(name, requestId => operation(service, requestId, 'character_construction_' + name, { input: current, construction: c }, async () => {
          const loaded = await service.load(current), result = await action(loaded.data), directory = await newFolder(service, 'character-construction'), json = (await writeDocument(service.workspace, path.join(directory, 'skeleton.json'), result.data, path.dirname(loaded.jsonPath))).path;
          return { json, details: result.details, pinnedFiles: [await pin(service, json), ...(result.pins ?? [])] };
        })); current = r.json;
      };
      await buildStage('prepare', async data => ({ data: prepareCharacterData(data, { ...c.preparation, input: current, output: 'construction' }) }));
      await buildStage('controls', async data => { const r = constructControls(data, c.controls); return { data: r.data, details: { createdTargets: r.createdTargets } }; });
      await buildStage('motion', async data => { const r = await constructMotions(service, data, c); if (c.expectedDataSha256 && constructionDigest(r.data) !== c.expectedDataSha256) throw new Error('Construction no longer matches its reviewed build plan.'); return { data: r.data, pins: r.pins, details: { applications: r.applications, reviewedBlueprintMatched: true } }; });
    }
    if (config.compose) await stage('compose', async requestId => {
      const repaints = []; for (const r of config.compose!.repaints) repaints.push({ ...r, image: await image(r.image) });
      const r = await composeLayerRepaint(service, { ...config.compose!, repaints, requestId }); if (!r.checksPassed) throw new Error('Composed handoff failed coverage/protection checks: ' + JSON.stringify(r.audit.findings)); return r;
    });
    if (config.replacements.length) {
      await stage('plan', async requestId => {
        const replacements: z.input<typeof planBatchReplacementSchema>['replacements'] = []; for (const r of config.replacements) replacements.push({ ...r, image: await image(r.image) });
        return operation(service, requestId, 'character_task_batch_plan', { input: current, replacements }, async () => {
        const result = await planBatchImageReplacement(service, { input: current, replacements }); if (!result.checksPassed) throw new Error('Batch plan blocked: ' + JSON.stringify([result.blockers, result.inputErrors])); return { ...result, pinnedFiles: [await pin(service, result.plan), ...result.images] };
        });
      });
      const r = await stage('replace', requestId => applyBatchImageReplacement(service, { requestId, plan: results.plan.plan, expectedSha256: results.plan.planSha256 })); current = r.json;
    }
    if (config.repair) { const r = await stage('repair', requestId => createAnimationRepair(service, { ...config.repair!, requestId, input: current })); if (!r.checksPassed) throw new Error('Animation repair failed its after-audits.'); current = r.json; }
    if (config.ikRepair) { const r = await stage('ik', requestId => createIkTargetRepair(service, { ...config.ikRepair!, requestId, input: current })); current = r.json; }
    if (config.contactRepair) { const r = await stage('contact', requestId => createIkContactRepair(service, { ...config.contactRepair!, requestId, input: current })); current = r.json; }
    if(config.meshRepair){const {mode,...options}=config.meshRepair;const r=await stage('mesh',requestId=>mode==='single'?createMeshDeformRepair(service,{...options,requestId,input:current}as any):createJointMeshRepair(service,{...options,requestId,input:current}as any));if(!r.checksPassed)throw Error('Mesh repair failed geometry/seam verification.');current=r.json;}
    if (config.reviewMedia.length) await stage('media', requestId => operation(service, requestId, 'character_task_media', { input: current, options: config.reviewMedia }, async () => {
      const media = [], pinnedFiles: Pin[] = [];
      for (let i = 0; i < config.reviewMedia.length; i++) {
        await checkpoint(control, { phase: 'character_task:media:' + i, completed: i, total: config.reviewMedia.length });
        const r = await service.exportMedia(current, config.reviewMedia[i]!, undefined, control); media.push(r);
        for (const file of [r.manifestPath, ...r.files, ...(r.outputs ?? []).map((v: any) => typeof v === 'string' ? v : v.path)].filter((v): v is string => typeof v === 'string')) pinnedFiles.push(await pin(service, file));
        const manifest = await jsonRead(service, r.manifestPath), frames = await jsonRead(service, manifest.frameManifest);
        if (!Array.isArray(frames.frames) || frames.frames.length > 301) throw new Error('Invalid or over-budget review frame inventory.');
        pinnedFiles.push(await pin(service, manifest.frameManifest));
        for (const frame of frames.frames) { if (typeof frame !== 'string') throw new Error('Invalid review frame path.'); pinnedFiles.push(await pin(service, path.resolve(path.dirname(manifest.frameManifest), frame))); }
      }
      return { media, pinnedFiles };
    }));
    const candidate = await stage('candidate', requestId => operation(service, requestId, 'character_task_candidate', { input: current, source: plan.source }, async () => {
      const collection = await collectAssets(service.workspace, (await service.load(current)).data, current);
      const sourcePins = [...new Set([...Object.values(state.steps).filter(s => s.completed).flatMap(s => [s.result!.path, ...(s.pins ?? []).map(p => p.path)]),...Object.values(state.stageReviews??{}).flatMap((r:any)=>[r.result.path,...(r.pins??[]).map((p:Pin)=>p.path)])])];
      return writeCandidate(service, 'character_task', collection.output, plan.source as SourcePin, { taskId: args.id, stages: Object.keys(state.steps).filter(n => state.steps[n]!.completed), reviewMedia: results.media?.media, sourceUnchanged: true }, true, sourcePins);
    }));
    state.candidate = { candidate: candidate.candidate, candidateSha256: candidate.candidateSha256 };
    if (state.review?.decision !== 'accepted' || state.review.candidateSha256 !== candidate.candidateSha256) { state.phase = state.review?.decision === 'rejected' ? 'rejected' : 'awaiting_review'; await saveState(directory, state); return { id: args.id, phase: state.phase, candidate: state.candidate }; }
    await stage('promote', requestId => promoteCandidate(service, { ...config.publication, candidate: candidate.candidate, expectedSha256: candidate.candidateSha256, requestId, confirmation: 'use_reviewed_candidate', note: state.review!.note }));
    if (config.waitForPreview && config.publication.session) await stage('preview', async () => {
      const receipt = results.promote.session?.requestReceipt?.preview;
      if (!receipt || ['not_bound', 'not_required'].includes(receipt.state)) return { state: 'unbound', nativeDisplayAcknowledged: false };
      if (receipt.state !== 'requested' || !receipt.previewId || !receipt.input || !receipt.generation) throw new Error('Session was committed but its preview request failed or was superseded. Inspect/rebind that session preview before starting a new task; saved output is retained.');
      const r = await service.nativePreviews.wait(receipt.previewId, { waitMs: 10000, generation: receipt.generation, sourceSha256: await fileSha256(await service.workspace.resolve(receipt.input)) });
      if (r.outcome !== 'published') throw new Error('Publication committed, but preview is not verified yet: ' + r.outcome + '. Resume this task to retry only preview verification.');
      return r;
    });
    state.phase = 'completed'; delete state.currentStep; await saveState(directory, state); return { id: args.id, phase: state.phase, candidate: state.candidate, publication: results.promote, preview: results.preview, nativeDisplayAcknowledged: false };
  } catch (error) {
    state.phase = error instanceof MissingAssets ? 'awaiting_assets' : (error as Error).message === 'MCP_JOB_CANCELLED' ? 'cancelled' : 'failed'; state.error = (error as Error).message;
    if (error instanceof MissingAssets) state.missingAssets = error.names;
    await saveState(directory, state);
    if (error instanceof MissingAssets) return { id: args.id, phase: state.phase, missingAssets: error.names };
    throw error;
  } finally { await release(); }
}

export async function reviewCharacterTaskStage(service:SpineService,raw:z.input<typeof reviewTaskStageSchema>){return reviewAuthoringStage(service,raw,a=>load(service,a),directory=>lease(service,directory),f=>validateInputs(service,f.plan,f.state),f=>saveState(f.directory,f.state));}
export {reviewTaskStageSchema};
