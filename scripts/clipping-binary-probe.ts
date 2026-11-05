import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { SkeletonBinary, ClippingAttachment } from '@esotericsoftware/spine-core';
import { loadConfig } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { readDocument, writeDocument } from '../src/document.js';
import { boneDiagramLoader } from '../src/runtime.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { verifyRoundTrip } from '../src/project-workflow.js';
const service = new SpineService(await loadConfig()), demo = await service.createDemo(), data = await readDocument(demo.path), id = randomUUID().slice(0, 8);
data.slots!.unshift({ name: 'clip-slot', bone: 'root', attachment: 'clip' }); (data.skins as any[])[0].attachments['clip-slot'] = { clip: { type: 'clipping', convex: false, end: 'arm-slot', vertexCount: 5, vertices: [0, -20, 0, 20, 50, 0, 120, 20, 120, -20] } };
const source = await writeDocument(service.workspace, path.join(demo.directory, 'clip.json'), data), binary = await service.cli.exportData(source.path, 'binary'), bytes = Uint8Array.from(await readFile(binary.files.find(file => file.endsWith('.skel'))!)), reader = new SkeletonBinary(boneDiagramLoader), sites: { offset: number; original: number }[] = [];
// This probe inspects only our newly exported skeleton data, using the pinned
// public-format runtime parser. It does not read or modify editor code.
const internal = reader as any, readAttachment = internal.readAttachment;
internal.readAttachment = function (input: any, ...args: any[]) { const offset = input.index, attachment = readAttachment.call(this, input, ...args); if (attachment instanceof ClippingAttachment) sites.push({ offset, original: bytes[offset]! }); return attachment; };
reader.readSkeletonData(bytes); for (const site of sites) bytes[site.offset] = site.original & ~32;
const patched = path.join(demo.directory, `clip-${id}.skel`), output = path.join(demo.directory, `clip-${id}.spine`); await writeFile(patched, bytes, { flag: 'wx' });
const runtime = new SkeletonBinary(boneDiagramLoader).readSkeletonData(bytes), clip = runtime.defaultSkin!.getAttachment(runtime.slots.findIndex(slot => slot.name === 'clip-slot'), 'clip') as ClippingAttachment;
await (service.cli as any).checked(['-i', patched, '-o', output, '-r', 'clip']); const actual = await service.load(output);
let verification: unknown; try { verification = verifyRoundTrip(data, actual.data, source.path, actual.jsonPath); } catch (error) { verification = { passed: false, error: (error as Error).message }; }
console.log(JSON.stringify({ source: source.path, output, sites, patchedRuntimeConvex: clip.convex, nativeConvex: attachmentEntries(actual.data).find(item => item.value.type === 'clipping')!.value.convex, verification }, null, 2));
