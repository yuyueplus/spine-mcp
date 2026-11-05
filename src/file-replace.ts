import { rename } from 'node:fs/promises';

/** Windows readers (including image watchers and antivirus) may temporarily
 * deny replacement. Retry the rename without deleting the last good target. */
export async function replaceFile(source: string, destination: string, renameFile: typeof rename = rename) {
  for (let attempt = 0; ; attempt++) {
    try { await renameFile(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(String((error as NodeJS.ErrnoException).code)) || attempt >= 10) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(200, 20 * 2 ** attempt)));
    }
  }
}
