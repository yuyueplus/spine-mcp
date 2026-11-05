import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import type { Workspace } from './config.js';
export const processAlive = (pid: number | undefined) => { if (!Number.isInteger(pid) || !pid || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
export async function syncLease(workspace: Workspace, folder: string): Promise<(() => Promise<void>) | null> {
  folder = await workspace.resolve(folder, false); const marker = path.join(folder, 'owner.json'), token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await mkdir(folder); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { const owner = JSON.parse(await readFile(marker, 'utf8')); if (processAlive(owner.pid)) return null; }
      catch { try { if (Date.now() - (await stat(folder)).mtimeMs < 5000) return null; } catch { return null; } }
      const retired = await workspace.resolve(path.join(path.dirname(folder), `retired-${path.basename(folder)}-${randomUUID()}`), false);
      // Both absolute paths are checked inside workspace before this directory move.
      await workspace.resolve(folder); try { await rename(folder, retired); } catch (error) { if (['ENOENT', 'EEXIST', 'EPERM', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) return null; throw error; } continue;
    }
    await writeFile(marker, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
    return async () => { const owner = JSON.parse(await readFile(marker, 'utf8')); if (owner.token !== token) throw new Error('Synchronization lease ownership changed.'); await unlink(marker); await rmdir(folder); };
  }
  return null;
}
