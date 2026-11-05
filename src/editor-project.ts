import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod/v4';
import type { Workspace } from './config.js';
import type { SpineCli } from './cli.js';
import { safeName, writeDocument, type SpineDocument } from './document.js';
import { buildProject } from './multi-project.js';

export const editorOpenOptions = z.object({
  nativeBridge: z.boolean().default(false).describe('true starts a NEW fixed-build editor with authenticated native state/reload support. Requires reuseInstance=false; startup may activate a window.'),
  reuseInstance: z.boolean().default(false).describe('false requests a NEW editor instance; true may show a save prompt in an existing instance. No prompts are dismissed.'),
  requestId: z.string().uuid().optional().describe('Reuse the same ID on a retry to avoid launching another editor.'),
  waitMs: z.number().int().min(0).max(10000).default(1500).describe('Bounded wait for process/window evidence, not an editor data receipt.'),
}).strict();
export const createProjectOptions = z.object({
  output: z.string().min(1).describe('NEW .spine path inside workspaceRoot. Existing files are never replaced.'),
  skeletonName: z.string().min(1).max(256).regex(/^[^\\/:*?"<>|\x00-\x1f]+$/, 'Use a skeleton name without filename separators or control characters.').optional(),
  fps: z.number().int().min(1).max(240).default(30),
  openInEditor: z.boolean().default(false),
  openOptions: editorOpenOptions.optional(),
}).strict();
export type CreateProjectOptions = z.input<typeof createProjectOptions>;

/** Build a real editable, root-only project through the existing verified
 * import/export workflow. The image directory is beside the native project. */
export async function createProject(workspace: Workspace, cli: SpineCli, raw: CreateProjectOptions) {
  const args = createProjectOptions.parse(raw), output = await workspace.resolve(args.output, false);
  if (path.extname(output).toLowerCase() !== '.spine') throw new Error('Output must end in .spine.');
  try { await stat(output); throw new Error('Output exists; choose a new project name.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const skeletonName = args.skeletonName ?? path.basename(output, path.extname(output)); safeName(skeletonName);
  if (args.openOptions && !args.openInEditor) throw new Error('openOptions requires openInEditor=true.');
  const images = await workspace.resolve(path.join(path.dirname(output), 'images'), false);
  await mkdir(images, { recursive: true });
  const jobs = await workspace.resolve('.jobs', false); await mkdir(jobs, { recursive: true });
  const directory = await mkdtemp(path.join(jobs, 'create-project-'));
  const data: SpineDocument = { skeleton: { spine: '4.3.23', images, fps: args.fps }, bones: [{ name: 'root' }], slots: [], animations: {} };
  const source = await writeDocument(workspace, path.join(directory, 'empty.json'), data);
  const result = await buildProject(workspace, cli, [{ input: source.path, name: skeletonName }], output);
  return { ...result, path: output, skeletonName, verification: result.checks[0]!.verification, created: true, images, fps: args.fps };
}
