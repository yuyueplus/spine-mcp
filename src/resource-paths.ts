import path from 'node:path';
import type { Workspace } from './config.js';
import { object, type SpineDocument } from './document.js';
import { attachmentEntries } from './attachment-data.js';

export async function validateResourcePaths(workspace: Workspace, data: SpineDocument, jsonPath: string) {
  const roots = new Map<string, string>();
  for (const field of ['images', 'audio']) roots.set(field, await workspace.resolve(path.resolve(path.dirname(jsonPath), String(data.skeleton[field] ?? '.')), false));
  for (const item of attachmentEntries(data)) {
    if (!['region', 'mesh', 'linkedmesh'].includes(String(item.value.type ?? 'region'))) continue;
    const base = String(item.value.path ?? item.value.name ?? item.name), sequence = item.value.sequence === undefined ? undefined : object(item.value.sequence, 'sequence');
    const count = Number(sequence?.count ?? 1);
    for (let index = 0; index < count; index++) {
      const suffix = sequence ? String(index + Number(sequence.start ?? 1)).padStart(Number(sequence.digits ?? 0), '0') : '';
      await workspace.resolve(path.resolve(roots.get('images')!, `${base}${suffix}.png`), false);
    }
  }
  for (const value of Object.values(object(data.events ?? {}, 'events'))) {
    const event = object(value, 'event');
    if (typeof event.audio === 'string' && event.audio) await workspace.resolve(path.resolve(roots.get('audio')!, event.audio), false);
  }
}
