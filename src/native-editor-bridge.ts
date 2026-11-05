import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import { projectRoot, type Workspace } from './config.js';
import { editorCommand, type EditorCommand, type EditorProjects } from './editor.js';
import { fileSha256 } from './file-hash.js';
import { replaceFile } from './file-replace.js';

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeEditorReloadOptions = z.object({
  instanceId: uuid, input: z.string().min(1),
  expected: z.object({ projectPath: z.string().min(1), projectIdentity: z.string().regex(/^\d+$/), undoToken: z.string().regex(/^-?\d+$/), modelSha256: sha }).strict(),
  requestId: uuid.optional(), waitMs: z.number().int().min(0).max(25000).default(10000),
}).strict();
export interface NativeEditorState {
  instanceId: string; projectPath: string | null; projectIdentity: string; undoToken: string; dirty: boolean;
  model: { sha256: string; skeletons: unknown[]; keyCount: number }; view: Record<string, unknown>;
  nativeThread: string; capturedAt: number; operationPending: boolean;
}
export interface NativeReply {
  ok: boolean; error?: string; requestId?: string; instanceId?: string; status?: NativeEditorState;
  pending?: boolean; committed?: boolean; nativeModelVerified?: boolean; [key: string]: unknown;
}
interface Instance {
  schemaVersion: 1; id: string; project: string; projectSha256: string; executable: string; targetJar: string;
  targetJarSha256: string; agentSha256: string; requestedAt: string; launcherPid?: number; launchAccepted: boolean; error?: string;
  agentJar?: string;
}
interface Bundle { protocol: string; jar: string; sha256: string; sourceSha256: string; sources: { path: string; sha256: string }[] }
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const signature = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const decode = (value: string) => Buffer.from(value, 'base64').toString('utf8');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const plainProperties = (data: Record<string, string>) => Object.entries(data).map(([k, v]) => `${k}=${v.replaceAll('\\', '\\\\').replaceAll('\r', '\\r').replaceAll('\n', '\\n')}\n`).join('');
export function encodeBridgeRequest(id: string, fields: Record<string, string>, secret: string) {
  const body = b64(Object.keys(fields).sort().map(k => `${k}=${b64(fields[k]!)}\n`).join(''));
  return `body=${body}\nsignature=${signature(secret, `request\n${id}\n${body}`)}\n`;
}
export function decodeBridgeResponse(envelope: string, id: string, instanceId: string, secret: string): NativeReply {
  const lines = Object.fromEntries(envelope.trim().split(/\r?\n/).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (Object.keys(lines).sort().join(',') !== 'body,signature' || !lines.body || !/^[a-f0-9]{64}$/.test(lines.signature ?? '')) throw new Error('Malformed native response.');
  const expected = signature(secret, `response\n${id}\n${lines.body}`);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(lines.signature!, 'hex'))) throw new Error('Native response authentication failed.');
  const value = JSON.parse(decode(lines.body)) as NativeReply;
  if (value.requestId !== id || value.instanceId !== instanceId || value.protocol !== '1' || typeof value.ok !== 'boolean') throw new Error('Native response belongs to another request or protocol.');
  return value;
}
export function bridgeJavaOption(jar: string, folder: string) {
  if (/["\r\n]/.test(jar + folder)) throw new Error('Bridge paths cannot contain quotes or newlines.');
  // Some Windows launchers decode the agent's argument through a legacy code
  // page even though the JAR path itself is Unicode-safe. Keep that argument ASCII.
  return `"-javaagent:${jar.replaceAll('\\', '/')}=b64:${Buffer.from(folder.replaceAll('\\','/'),'utf8').toString('base64url')}"`;
}
async function jsonFile<T>(file: string, max = 128 * 1024): Promise<T> {
  if (!(await stat(file)).isFile() || (await stat(file)).size > max) throw new Error('Invalid or oversized native bridge record.');
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
async function atomic(file: string, data: string) {
  const tmp = `${file}.${randomUUID()}.tmp`;await writeFile(tmp, data, { flag: 'wx', mode: 0o600 });await replaceFile(tmp, file);
}
export async function verifyNativeBridgeBundle(root = path.join(projectRoot, 'native-bridge')) {
  const bundle = await jsonFile<Bundle>(path.join(root, 'bundle.json'));
  if (bundle.protocol !== '1' || bundle.jar !== 'spine-editor-bridge.jar' || !sha.safeParse(bundle.sha256).success || !Array.isArray(bundle.sources) || !bundle.sources.length) throw new Error('Invalid native bridge bundle manifest.');
  if(bundle.sources.map(s=>s.path).sort().join('|')!==['MANIFEST.MF','builds.json','src/EditorBridgeAgent.java','src/NativeEditorAccess.java'].sort().join('|'))throw new Error('Native bridge manifest must cover the complete fixed adapter sources.');
  for (const source of bundle.sources) {
    if (!/^(?:src\/[A-Za-z]+\.java|MANIFEST\.MF|builds\.json)$/.test(source.path) || await fileSha256(path.join(root, source.path)) !== source.sha256) throw new Error('Native bridge sources changed; run npm run build:editor-bridge.');
  }
  if (digest(JSON.stringify(bundle.sources)) !== bundle.sourceSha256 || await fileSha256(path.join(root, bundle.jar)) !== bundle.sha256) throw new Error('Native bridge artifact integrity check failed.');
  return { ...bundle, filename: path.join(root, bundle.jar) };
}
interface Dependencies { launch: (command: EditorCommand) => Promise<number>; bundleRoot: string }
const launch = async (command: EditorCommand) => new Promise<number>((resolve, reject) => {
  const child = spawn(command.executable, command.args, command.options);child.once('error', reject);child.once('spawn', () => { child.unref();resolve(child.pid!); });
});

/** Only processes launched with this startup bridge can receive native commands. */
export class NativeEditorBridge {
  private readonly deps: Dependencies;
  constructor(readonly workspace: Workspace, readonly editors: EditorProjects, deps: Partial<Dependencies> = {}) {
    this.deps = { launch, bundleRoot: path.join(projectRoot, 'native-bridge'), ...deps };
  }
  private async folder(id: string) { uuid.parse(id);return this.workspace.resolve(path.join('.editor-bridges', id), false); }
  private async instance(id: string) {
    const folder = await this.folder(id), record = await jsonFile<Instance>(path.join(folder, 'instance.json'));
    if (record.id !== id || record.schemaVersion !== 1 || typeof record.project !== 'string') throw new Error('Invalid native editor instance.');
    return { folder, record };
  }
  private async secret(folder: string) {
    const secret = (await readFile(path.join(folder, 'secret'), 'ascii')).trim();if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid native bridge credential.');return secret;
  }
  private async observation(folder: string) {
    try {
      const agent = await jsonFile<{ instanceId: string; pid: number; heartbeatAt: number; operationPending: boolean }>(path.join(folder, 'agent.json'));
      let alive = false;if (Number.isSafeInteger(agent.pid) && agent.pid > 0) try { process.kill(agent.pid, 0);alive = true; } catch {}
      return { agentPresent: true, pid: agent.pid, heartbeatAgeMs: Math.max(0, Date.now() - agent.heartbeatAt), agentAlive: alive, operationPending: agent.operationPending };
    } catch { return { agentPresent: false, agentAlive: false, operationPending: false }; }
  }
  async list() {
    const root = await this.workspace.resolve('.editor-bridges', false);let names: string[];
    try { names = await readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { instances: [], ordinaryEditorsSupported: false, note: 'Open a project with spine_open_project(nativeBridge=true) to enable native receipts and reload.' };throw e; }
    const instances = [];
    for (const name of names.filter(x => uuid.safeParse(x).success))try { const { record, folder } = await this.instance(name);instances.push({ ...record, ...await this.observation(folder), nativeStateVerified: false }); } catch (e) { instances.push({ id: name, error: (e as Error).message, nativeStateVerified: false }); }
    return { instances, ordinaryEditorsSupported: false, inputInjectionUsed: false, note: 'Instance inventory is launch/heartbeat evidence. Query an instanceId for a fresh authenticated main-thread state receipt.' };
  }
  async open(input: string, raw: { requestId?: string; waitMs?: number; reuseInstance?: boolean } = {}) {
    const args = z.object({ requestId: uuid.optional(), waitMs: z.number().int().min(0).max(25000).default(10000), reuseInstance: z.boolean().default(false) }).strict().parse(raw);
    if (args.reuseInstance) throw new Error('Native bridge startup requires a NEW editor instance; reuseInstance must be false.');
    const project = await this.workspace.resolve(input), projectSha256 = await fileSha256(project);
    if (path.extname(project).toLowerCase() !== '.spine' || !(await stat(project)).isFile() || !(await stat(project)).size) throw new Error('A nonempty .spine file inside workspace is required.');
    const id = args.requestId ?? randomUUID(), folder = await this.folder(id);
    const existing = await this.instance(id).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;return null; });
    if (existing) {
      if (existing.record.project !== project || existing.record.projectSha256 !== projectSha256) throw new Error('requestId belongs to another project or revision.');
      return { ...existing.record, ...await this.observation(folder), instanceId:id,reusedRequest: true,inputInjectionUsed:false,existingEditorsAttached:false,recoveryFile:path.join(folder,'recovery','initial.spine'), ...(args.waitMs ? { native: await this.state(id, args.waitMs) } : {}) };
    }
    const bundle = await verifyNativeBridgeBundle(this.deps.bundleRoot), executable = await this.editors.resolveExecutable();
    const builds = await jsonFile<{ adapters: { id: string; jarBasename: string; sha256: string }[] }>(path.join(this.deps.bundleRoot, 'builds.json'));
    const adapter = builds.adapters[0];if (!adapter) throw new Error('No native editor adapter is packaged.');
    const targetJar = await realpath(path.join(path.dirname(executable), adapter.jarBasename));
    if (await fileSha256(targetJar) !== adapter.sha256) throw new Error('This installed Spine build has no verified native adapter. Normal project opening remains available.');
    await mkdir(path.dirname(folder), { recursive: true });
    try { await mkdir(folder); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This bridge launch is already reserved; query its instanceId instead of launching again.');throw e; }
    const secret = randomBytes(32).toString('hex');await writeFile(path.join(folder, 'secret'), secret, { mode: 0o600, flag: 'wx' });
    const agentJar=path.join(folder,'agent.jar');await writeFile(agentJar,await readFile(bundle.filename),{flag:'wx',mode:0o600});if(await fileSha256(agentJar)!==bundle.sha256)throw new Error('Instance agent copy failed its integrity check.');
    await mkdir(path.join(folder, 'recovery'));await mkdir(path.join(folder, 'requests'));await mkdir(path.join(folder, 'responses'));await mkdir(path.join(folder, 'client-requests'));
    const bytes = await readFile(project);if (createHash('sha256').update(bytes).digest('hex') !== projectSha256) throw new Error('Project changed while preparing the native bridge.');
    await writeFile(path.join(folder, 'recovery', 'initial.spine'), bytes, { flag: 'wx' });
    await writeFile(path.join(folder, 'config.properties'), plainProperties({ protocol: '1', instanceId: id, secret, workspace: this.workspace.root, targetJar, initialProject: project, initialSha256: projectSha256,agentSha256:bundle.sha256 }), { flag: 'wx', mode: 0o600 });
    const record: Instance = { schemaVersion: 1, id, project, projectSha256, executable, targetJar, targetJarSha256: adapter.sha256, agentSha256: bundle.sha256,agentJar, requestedAt: new Date().toISOString(), launchAccepted: false };
    await atomic(path.join(folder, 'instance.json'), JSON.stringify(record, null, 2));
    try {
      const command = editorCommand(executable, project, false);
      command.options = { ...command.options, env: { ...process.env, JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, bridgeJavaOption(agentJar, folder)].filter(Boolean).join(' ') } };
      record.launcherPid = await this.deps.launch(command);record.launchAccepted = true;
    } catch (e) { record.error = (e as Error).message; }
    await atomic(path.join(folder, 'instance.json'), JSON.stringify(record, null, 2));
    let native: unknown;
    if (record.launchAccepted && args.waitMs) {
      const deadline = Date.now() + args.waitMs;
      do { native = await this.state(id, Math.min(1000, Math.max(0, deadline - Date.now())));if ((native as NativeReply).ok && (native as NativeReply).status?.projectPath) break;await sleep(Math.min(250, Math.max(0, deadline - Date.now()))); } while (Date.now() < deadline);
    }
    return { ...record, instanceId: id, native, reusedRequest: false, inputInjectionUsed: false, existingEditorsAttached: false, startupMayActivateWindow: true, recoveryFile: path.join(folder, 'recovery', 'initial.spine'), note: 'Native commands update this editor in place without mouse/keyboard input. Ordinary editor instances are not attached. Undo history resets on a successful full-project reload.' };
  }
  private async submit(instanceId: string, intent: Record<string, string>, requestId: string = randomUUID(), waitMs = 10000) {
    uuid.parse(requestId);const { folder } = await this.instance(instanceId), secret = await this.secret(folder);
    const intentSha256 = digest(JSON.stringify(Object.fromEntries(Object.entries(intent).sort(([a], [b]) => a.localeCompare(b)))));
    const recordFile = path.join(folder, 'client-requests', requestId + '.json');
    let record = await jsonFile<{ intentSha256: string; envelope: string }>(recordFile).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;return null; });
    if (record && record.intentSha256 !== intentSha256) throw new Error('requestId belongs to a different native operation; query the existing request.');
    if (!record) {
      const now = Date.now();record = { intentSha256, envelope: encodeBridgeRequest(requestId, { ...intent, instanceId, id: requestId, issuedAt: String(now), deadline: String(now + 30000) }, secret) };
      try { await writeFile(recordFile, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;await sleep(50);record = await jsonFile(recordFile);if (record!.intentSha256 !== intentSha256) throw new Error('Concurrent native requestId conflict.'); }
    }
    await atomic(path.join(folder, 'requests', requestId + '.properties'), record!.envelope);
    return this.requestStatus(instanceId, requestId, waitMs);
  }
  async requestStatus(instanceId: string, requestId: string, waitMs = 0): Promise<NativeReply> {
    uuid.parse(requestId);z.number().int().min(0).max(25000).parse(waitMs);
    const { folder } = await this.instance(instanceId), secret = await this.secret(folder), deadline = Date.now() + waitMs;
    await jsonFile(path.join(folder, 'client-requests', requestId + '.json'));
    do {
      const response = path.join(folder, 'responses', requestId + '.properties');
      try { if ((await stat(response)).size > 9 * 1024 * 1024) throw new Error('Oversized native response.');const value=decodeBridgeResponse(await readFile(response, 'ascii'), requestId, instanceId, secret);return { ...value, authenticated: true, nativeStateVerified: value.ok&&Boolean(value.status), inputInjectionUsed: false }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (Date.now() >= deadline) break;await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    let startupError: unknown;try { startupError = await jsonFile(path.join(folder, 'startup-error.json')); } catch {}
    return { ok: false, pending: !startupError, error: startupError ? 'Bridge startup failed.' : undefined, startupError, instanceId, requestId, ...await this.observation(folder), nativeStateVerified: false, note: 'Query this same requestId after reconnect. Do not submit a new reload to retry an uncertain operation.' };
  }
  async state(instanceId?: string, waitMs = 10000) {
    if (!instanceId) return this.list();z.number().int().min(0).max(25000).parse(waitMs);
    return this.submit(instanceId, { action: 'status' }, undefined, waitMs);
  }
  async reload(raw: z.input<typeof nativeEditorReloadOptions>) {
    const args = nativeEditorReloadOptions.parse(raw), input = await this.workspace.resolve(args.input), sha256 = await fileSha256(input);
    const {record}=await this.instance(args.instanceId),bundle=await verifyNativeBridgeBundle(this.deps.bundleRoot);
    if(record.agentSha256!==bundle.sha256)throw new Error('This editor uses an older native bridge. Open a NEW bridge-enabled instance; the existing editor is retained.');
    await this.workspace.resolve(args.expected.projectPath);
    if (path.extname(input).toLowerCase() !== '.spine') throw new Error('Reload requires a saved .spine file.');
    const expected: Record<string, string> = { 'expected.instanceId': args.instanceId };
    for (const [key, value] of Object.entries(args.expected)) expected['expected.' + key] = value;
    const result = await this.submit(args.instanceId, { action: 'reload', input, sha256, ...expected }, args.requestId, args.waitMs);
    return { ...result, focusActivationRequested: false, recovery: { originalFilesWritten: false, initialFile: path.join(await this.folder(args.instanceId), 'recovery', 'initial.spine'), note: 'A failed candidate parse leaves the current model intact. A failed application restores the previous native model and view; inspect the rollback receipt. Reloading resets native undo history.' } };
  }
}
