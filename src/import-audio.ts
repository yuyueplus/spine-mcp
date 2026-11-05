import path from 'node:path';
import type { SpineDocument } from './document.js';

/** Unlike image roots, the 4.3 importer stores the audio string verbatim in the
 * native project. Supply it relative to the final project's directory, even
 * though our prepared JSON lives in a separate background job directory. */
export function nativeImportAudioRoot(data: SpineDocument, sourceDirectory: string, projectDirectory: string) {
  const referenced = Object.values(data.events ?? {}).some(raw => raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).audio === 'string' && Boolean((raw as Record<string, unknown>).audio));
  if (data.skeleton.audio === undefined && !referenced) return undefined;
  const root = path.resolve(sourceDirectory, String(data.skeleton.audio || '.'));
  return (path.relative(projectDirectory, root) || '.').replaceAll('\\', '/');
}
