import { decodeDrawOrder, folderTracks } from './animation-data.js';
import { type SpineDocument, type JsonObject } from './document.js';

// The installed editor omits folder keys during JSON import. Compile their
// discrete runtime effect to global permutations before importing new data.
export function compileFolderDrawOrder(source: SpineDocument): SpineDocument {
  if (!Object.values(source.animations ?? {}).some(animation => Array.isArray(animation.drawOrderFolder) && animation.drawOrderFolder.length)) return source;
  const data = structuredClone(source), setup = (data.slots ?? []).map(slot => slot.name);
  for (const animation of Object.values(data.animations ?? {})) {
    const folders = folderTracks(data, animation); if (!folders.length) continue;
    const global = (animation.drawOrder ?? []) as JsonObject[], times = [...new Set([0, ...global.map(key => Number(key.time ?? 0)), ...folders.flatMap(folder => folder.frames.map(key => Number(key.time ?? 0)))])].sort((a, b) => a - b);
    if (times.length > 10000 || times.length * setup.length * folders.length > 2000000) throw new Error('Folder draw-order compilation exceeds its work budget. Split the animation or reduce groups/keys.');
    let globalCursor = -1;
    const states = folders.map(folder => ({ ...folder, members: new Set(folder.slots), cursor: -1 }));
    animation.drawOrder = times.map(time => {
      while (globalCursor + 1 < global.length && Number(global[globalCursor + 1]!.time ?? 0) <= time) globalCursor++;
      const globalKey = global[globalCursor], order = globalKey ? decodeDrawOrder(data, globalKey) : [...setup];
      for (const folder of states) {
        while (folder.cursor + 1 < folder.frames.length && Number(folder.frames[folder.cursor + 1]!.time ?? 0) <= time) folder.cursor++;
        const key = folder.frames[folder.cursor], desired = key ? decodeDrawOrder(folder.data, key) : folder.slots;
        let index = 0;
        for (let position = 0; position < order.length; position++) if (folder.members.has(order[position]!)) order[position] = desired[index++]!;
        if (index !== folder.slots.length) throw new Error('Draw-order folder member count changed during compilation.');
      }
      const positions = new Map(order.map((name, index) => [name, index]));
      const offsets = setup.map((slot, index) => ({ slot, offset: positions.get(slot)! - index })).filter(item => item.offset);
      return offsets.length ? { time, offsets } : { time };
    });
    delete animation.drawOrderFolder;
  }
  return data;
}
