import { loadConfig } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { readDocument, writeDocument } from '../src/document.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { randomUUID } from 'node:crypto';
const service = new SpineService(await loadConfig()), demo = await service.createDemo(), source = await readDocument(demo.path);
source.slots!.unshift({ name: 'clip-slot', bone: 'root', attachment: 'clip' }); (source.skins as any[])[0].attachments['clip-slot'] = { clip: { type: 'clipping', convex: false, end: 'arm-slot', vertexCount: 5, vertices: [0, -20, 0, 20, 50, 0, 120, 20, 120, -20] } };
for (const flags of [{ concave: true }, { convexHull: false }, { concave: false }]) { const data = structuredClone(source), clip = attachmentEntries(data).find(item => item.value.type === 'clipping')!; Object.assign(clip.value, flags); const id = randomUUID().slice(0, 8), input = await writeDocument(service.workspace, `${demo.directory}/clip-${id}.json`, data); try { const built = await service.buildProject([{ input: input.path, name: 'clip' }], `${demo.directory}/clip-${id}.spine`); console.log(JSON.stringify({ flags, passed: true, output: built.output })); } catch (error) { console.log(JSON.stringify({ flags, passed: false, error: (error as Error).message })); } }
