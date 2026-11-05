import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './config.js';

export async function resolveLauncher(config: Config, kind: 'cli' | 'gui') {
  const discovery = kind === 'cli' ? config.cliRuntimeDiscovery : config.guiRuntimeDiscovery;
  const pinned = kind === 'cli' ? config.cliExecutable : config.guiExecutable;
  // GUI discovery deliberately overrides a wrapper executable: not every
  // wrapper forwards project arguments. Never silently switch launch methods.
  const mode = kind === 'gui' && discovery ? 'runtime' : pinned ? 'pinned' : discovery ? 'runtime' : 'none';
  const candidates: { path: string; modified: number }[] = [], errors: string[] = [];
  async function localFile(filename: string) {
    if (/^[\\/]{2}/.test(filename)) throw new Error('Launchers must be on a local disk.');
    const resolved = await realpath(filename);
    if (/^[\\/]{2}/.test(resolved) || !(await stat(resolved)).isFile()) throw new Error('Launcher must be a local file.');
    return resolved;
  }
  if (mode === 'pinned') {
    try { candidates.push({ path: await localFile(pinned!), modified: 0 }); }
    catch { errors.push('Configured launcher is missing or is not a local file. Correct the pinned path; no other application was selected.'); }
  } else if (mode === 'runtime' && discovery) {
    try {
      const root = await realpath(discovery.root);
      if (/^[\\/]{2}/.test(root)) throw new Error('Runtime discovery root must be local.');
      for (const folder of await readdir(root, { withFileTypes: true })) {
        if (!folder.isDirectory() || folder.isSymbolicLink() || !folder.name.startsWith(discovery.directoryPrefix)) continue;
        try {
          const directory = path.join(root, folder.name), filename = await localFile(path.join(directory, discovery.entrypoint));
          const relative = path.relative(directory, filename);
          if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
          candidates.push({ path: filename, modified: (await stat(directory)).mtimeMs });
        } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) errors.push(`Runtime candidate unavailable: ${folder.name}`); }
      }
    } catch { errors.push('Runtime discovery directory is missing or unavailable.'); }
    candidates.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
  }
  const executable = candidates[0]?.path ?? null;
  const temp = executable ? path.relative(os.tmpdir(), executable) : '..';
  const temporary = Boolean(executable && temp !== '..' && !temp.startsWith(`..${path.sep}`) && !path.isAbsolute(temp));
  return { mode, executable, temporary, candidates: candidates.map(item => item.path), errors,
    recovery: mode === 'runtime' ? 'Trusted runtime candidates are rescanned immediately before every operation. A missing entrypoint never falls back to an unverified wrapper.' : 'Configure a persistent standard installed launcher for a stable entrypoint.' };
}
