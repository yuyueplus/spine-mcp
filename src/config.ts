import { readFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const runtimeDiscoverySchema = z.object({
  root: z.string(),
  directoryPrefix: z.string().regex(/^[A-Za-z0-9_-]+$/),
  entrypoint: z.string().regex(/^[A-Za-z0-9_.-]+\.(?:bat|cmd|exe|com)$/i),
});
export const configSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  targetVersion: z.literal('4.3.23').default('4.3.23'),
  workspaceRoot: z.string().default(path.join(projectRoot, 'work')),
  cliExecutable: z.string().nullable().default(null),
  cliRuntimeDiscovery: runtimeDiscoverySchema.optional(),
  guiExecutable: z.string().nullable().default(null),
  guiRuntimeDiscovery: runtimeDiscoverySchema.optional(),
  ffmpegExecutable: z.string().nullable().optional(),
  ffprobeExecutable: z.string().nullable().optional(),
  nativeRenderer: z.object({
    workerExecutable: z.string().min(1), roomServerExecutable: z.string().min(1), nativeLibrary: z.string().min(1),
    slots: z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),capacity:z.number().int().min(1).max(64),memoryMB:z.number().int().min(64),dockerGpu:z.string().optional(),dockerImage:z.string().optional()}).strict()).min(1).max(32),
    queueLimit:z.number().int().min(0).max(256).default(16)
  }).strict().optional(),
  cliTimeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
});
export type Config = z.infer<typeof configSchema>;

export async function loadConfig(): Promise<Config> {
  const filename = process.env.SPINE_MCP_CONFIG ?? path.join(projectRoot, 'spine.local.json');
  let raw: unknown = {};
  try { raw = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const config = configSchema.parse(raw);
  if (process.env.SPINE_MCP_ROOT) config.workspaceRoot = process.env.SPINE_MCP_ROOT;
  if (process.env.SPINE_MCP_EXE) config.cliExecutable = process.env.SPINE_MCP_EXE;
  const configDirectory = path.dirname(path.resolve(filename));
  config.workspaceRoot = path.resolve(configDirectory, config.workspaceRoot);
  if (config.cliExecutable) config.cliExecutable = path.resolve(configDirectory, config.cliExecutable);
  if (config.guiExecutable) config.guiExecutable = path.resolve(configDirectory, config.guiExecutable);
  if (config.ffmpegExecutable) config.ffmpegExecutable = path.resolve(configDirectory, config.ffmpegExecutable);
  if (config.ffprobeExecutable) config.ffprobeExecutable = path.resolve(configDirectory, config.ffprobeExecutable);
  if (config.nativeRenderer) for (const field of ['workerExecutable','roomServerExecutable','nativeLibrary'] as const)
    config.nativeRenderer[field] = path.resolve(configDirectory, config.nativeRenderer[field]);
  if (config.cliRuntimeDiscovery) config.cliRuntimeDiscovery.root = path.resolve(configDirectory, config.cliRuntimeDiscovery.root);
  if (config.guiRuntimeDiscovery) config.guiRuntimeDiscovery.root = path.resolve(configDirectory, config.guiRuntimeDiscovery.root);
  if (/^[\\/]{2}/.test(config.workspaceRoot)) throw new Error('Workspace must be on a local disk.');
  await mkdir(config.workspaceRoot, { recursive: true });
  config.workspaceRoot = await realpath(config.workspaceRoot);
  return config;
}

export class Workspace {
  constructor(readonly root: string) {}

  async resolve(input: string, existing = true): Promise<string> {
    if (!input || /^[\\/]{2}/.test(input)) throw new Error('Use a local path inside the configured workspace.');
    const filename = path.resolve(this.root, input);
    const inside = (candidate: string) => {
      const relative = path.relative(this.root, candidate);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    };
    if (!inside(filename)) throw new Error('Path is outside the configured workspace.');
    let ancestor = filename;
    for (;;) {
      try {
        const canonical = await realpath(ancestor);
        if (!inside(canonical)) throw new Error('A symbolic link or junction points outside the workspace.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (existing || parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    if (existing) await stat(filename);
    return filename;
  }
}
