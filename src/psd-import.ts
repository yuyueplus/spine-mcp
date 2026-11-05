import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readPsd, getLayerImageData, initializeCanvas, type Psd, type Layer } from 'ag-psd';
import type { z } from 'zod/v4';
import type { SpineService } from './service.js';
import type { WorkControl } from './progress.js';
import { checkpoint } from './progress.js';
import { VERSION } from './version.js';
import { preparePsdPixels, type PsdComposition } from './psd-compositor.js';
import { planPsdImportSchema, importPsdSchema } from './psd-schema.js';
import { parseDocument, type SpineDocument } from './document.js';
import { encodePng } from './raster.js';
import { digest, pin, jsonRead, verifyPins, immutableJson, operation, writeCandidate, label, type Pin } from './character-candidates.js';
export { planPsdImportSchema, importPsdSchema } from './psd-schema.js';

type Options = z.output<typeof planPsdImportSchema>;
type Tags = Record<string, string>;
type Row = { id: string; sourceName: string; layer: Layer; name: string; bone: string; slot: string; skin: string; folder: string; logicalPath: string; visible: boolean; trim: boolean; padding: number; blend: string; ancestry: string[] };
const limits = { sourceBytes: 32 * 1024 ** 2, dimension: 8192, canvasPixels: 16_777_216, layers: 256, totalLayerPixels: 64_000_000, depth: 24, decodeMemoryBytes: 256 * 1024 ** 2 };
initializeCanvas(() => { throw new Error('Canvas rendering is disabled; provide saved pixel layers.'); }, (width, height) => { if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > limits.dimension || height > limits.dimension || width * height > limits.canvasPixels) throw new Error('PSD bitmap exceeds raster budget.'); return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }; });
const supportedTags = new Set(['bone', 'slot', 'skin', 'folder', 'ignore', 'origin', 'path', 'pad', 'trim', 'bones', 'slots']);
const blends: Record<string, string> = { normal: 'normal', multiply: 'multiply', screen: 'screen', 'linear dodge': 'additive' };
function logicalName(v: string) { if (!v || v.length > 200 || /[\u0000-\u001f\\:]/.test(v) || v.replace(/^\//, '').split('/').some(n => !n || n === '.' || n === '..' || !label.safeParse(n).success)) throw new Error('Unsafe/empty PSD logical name: ' + v.slice(0, 220)); return v.replace(/^\//, ''); }
const join = (prefix: string, name: string) => logicalName(name.startsWith('/') || !prefix ? name : `${prefix}/${name}`);
function tagsFor(name: string) {
  const tags: Tags = {}, base = name.replace(/\[([^\]]+)\]/g, (_, raw: string) => { const i = raw.indexOf(':'), key = i < 0 ? raw : raw.slice(0, i), value = i < 0 ? '' : raw.slice(i + 1); if (Object.hasOwn(tags, key)) throw new Error('Duplicate PSD tag: ' + key); tags[key] = value; return ''; }).trim();
  if (/[\[\]]/.test(base)) throw new Error('Malformed PSD layer tags.'); return { tags, base };
}
async function readBounded(service: SpineService, input: string, ignoreHidden = true) {
  const p = await pin(service, input); if ((await stat(p.path)).size > limits.sourceBytes) throw new Error('PSD exceeds 32 MiB source limit.'); const bytes = await readFile(p.path);
  if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== '8BPS' || bytes.readUInt16BE(4) !== 1) throw new Error('Only standard PSD version 1 is supported (no PSB).');
  if (bytes.readUInt16BE(22) !== 8 || bytes.readUInt16BE(24) !== 3) throw new Error('PSD import requires RGB, 8 bits/channel; rasterize/convert other formats first.');
  const width = bytes.readUInt32BE(18), height = bytes.readUInt32BE(14);
  if (!width || !height || width > limits.dimension || height > limits.dimension || width * height > limits.canvasPixels) throw new Error('PSD canvas exceeds dimension/pixel budget.');
  const psd = readPsd(bytes, { useImageData: true, useRawData: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true, totalMemoryLimit: limits.decodeMemoryBytes, throwForMissingFeatures: true }); await verifyPins(service, [p]);
  const prepared = preparePsdPixels(psd, ignoreHidden); return { psd: prepared.psd, p, composition: prepared.report, sourceLayers: prepared.sourceLayers };
}
function structure(psd: Psd, options: Options) {
  const blockers: { layer: string; reason: string }[] = [], warnings: string[] = [], rows: Row[] = [], bones = new Map<string, { name: string; parent: string; group: string }>(), origins: { x: number; y: number }[] = [];
  let count = 0, pixels = 0;
  let allLayers = 0; const guardTree = (layers: Layer[], depth = 0) => { if (depth > limits.depth) throw new Error('PSD nesting exceeds 24 groups.'); for (const layer of layers) { if (++allLayers > limits.layers) throw new Error('PSD exceeds 256 layers/groups, including ignored layers.'); if (layer.children) guardTree(layer.children, depth + 1); } }; guardTree(psd.children ?? []);
  type Context = { bone: string; slot?: string; skin: string; folder: string; visible: boolean; ancestry: string[]; autoBones?: boolean; autoSlots?: boolean; isolated?: boolean; trim: boolean; padding: number };
  function visit(layers: Layer[], context: Context, parentId = '') {
    if (context.ancestry.length > limits.depth) throw new Error('PSD nesting exceeds 24 groups.');
    layers.forEach((layer, index) => {
      const id = parentId ? `${parentId}.${index}` : String(index), sourceName = layer.name ?? '', location = `${id}: ${sourceName}`;
      if (++count > limits.layers) throw new Error('PSD exceeds 256 layers/groups.');
      const width = (layer.right ?? 0) - (layer.left ?? 0), height = (layer.bottom ?? 0) - (layer.top ?? 0);
      if (![layer.left ?? 0, layer.top ?? 0, width, height].every(Number.isSafeInteger) || Math.abs(layer.left ?? 0) > 1000000 || Math.abs(layer.top ?? 0) > 1000000 || width < 0 || height < 0 || width > limits.dimension || height > limits.dimension || width * height > limits.canvasPixels) throw new Error('PSD layer geometry exceeds its budget: ' + location);
      pixels += width * height; if (pixels > limits.totalLayerPixels) throw new Error('PSD exceeds 64 million total layer pixels.');
      let tags: Tags, base: string; try { ({ tags, base } = tagsFor(sourceName)); } catch (e) { blockers.push({ layer: location, reason: (e as Error).message }); return; }
      const visible = context.visible && !layer.hidden;
      if (Object.hasOwn(tags, 'ignore') || options.ignoreHidden && !visible) return;
      for (const tag of Object.keys(tags)) if (!supportedTags.has(tag)) blockers.push({ layer: location, reason: 'Unsupported tag [' + tag + ']; rasterize/rename it or explicitly ignore this layer.' });
      for (const key of ['mask', 'realMask', 'vectorMask', 'effects', 'adjustment', 'vectorFill', 'vectorStroke', 'filterEffectsMasks', 'artboard'] as const) if (layer[key] && !(key === 'effects' && layer.effects?.disabled)) blockers.push({ layer: location, reason: 'Unsupported ' + key + '; rasterize its result before importing.' });
      if (layer.clipping || layer.knockout || layer.fillOpacity !== undefined && Math.abs(layer.fillOpacity - 1) > 1e-6) blockers.push({ layer: location, reason: 'Clipping, knockout or partial fill requires a flattened pixel result.' });
      if (layer.opacity !== undefined && (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1)) blockers.push({ layer: location, reason: 'Invalid opacity.' });
      if (Object.hasOwn(tags, 'origin')) { if (layer.children || !width || !height) blockers.push({ layer: location, reason: '[origin] requires one nonempty pixel layer.' }); else origins.push({ x: (layer.left ?? 0) + width / 2, y: (layer.top ?? 0) + height / 2 }); return; }
      try {
        if (!base && !layer.children) throw new Error('Pixel layer needs an attachment name.');
        const value = (key: string) => logicalName(tags[key] || base), next: Context = { ...context, visible, ancestry: [...context.ancestry, id], autoBones: Object.hasOwn(tags, 'bones'), autoSlots: Object.hasOwn(tags, 'slots') };
        if (context.autoBones && !Object.hasOwn(tags, 'bone')) tags.bone = base;
        if (context.autoSlots && !Object.hasOwn(tags, 'slot')) tags.slot = base;
        if (Object.hasOwn(tags, 'bone')) { const name = value('bone'); if (name === 'root' || name === context.bone) throw new Error('Bone tag collides with root/ancestor.'); const prior = bones.get(name); if (prior && (prior.parent !== context.bone || prior.group !== id)) throw new Error('Duplicate bone name across separate layers/groups: ' + name); bones.set(name, { name, parent: context.bone, group: id }); next.bone = name; }
        if (Object.hasOwn(tags, 'slot')) next.slot = value('slot');
        if (Object.hasOwn(tags, 'skin')) next.skin = value('skin');
        if (Object.hasOwn(tags, 'folder') && !Object.hasOwn(tags, 'skin')) next.folder = join(context.folder, tags.folder || base);
        if (Object.hasOwn(tags, 'pad')) { const v = Number(tags.pad); if (!Number.isInteger(v) || v < 0 || v > 64) throw new Error('[pad] must be an integer from 0 to 64.'); next.padding = v; }
        if (Object.hasOwn(tags, 'trim')) { const v = tags.trim; if (!['', 'true', 'ws', 'false', 'canvas'].includes(v!)) throw new Error('Only whitespace/canvas trim tags are supported.'); next.trim = !['false', 'canvas'].includes(v!); }
        if (layer.children) {
          if (Object.hasOwn(tags, 'path')) throw new Error('Group [path:pattern] is not supported in this backend.');
          if (Math.abs((layer.opacity ?? 1) - 1) > 1e-6 || !['normal', 'pass through'].includes(layer.blendMode ?? 'pass through')) throw new Error('Group opacity/blend isolation requires a flattened pixel group.');
          next.isolated = context.isolated || layer.blendMode === 'normal'; visit(layer.children, next, id); return;
        }
        if (Object.hasOwn(tags, 'bones') || Object.hasOwn(tags, 'slots')) throw new Error('[bones]/[slots] only apply to groups.');
        const blend = blends[layer.blendMode ?? 'normal']; if (!blend) throw new Error('Unsupported layer blend mode: ' + layer.blendMode);
        if (context.isolated && blend !== 'normal') throw new Error('A non-normal blend inside an isolated normal group needs flattening.');
        if (!width || !height || !layer.imageData && (!layer.rawData || ![0, 1, 2].every(id => layer.rawData!.channels.some(c => c.id === id && c.data)) || layer.rawData.channels.some(c => c.id < -1 || c.id > 2))) throw new Error('Layer requires saved RGB raster pixels with an optional alpha channel.');
        if (layer.text || layer.placedLayer) warnings.push(location + ': imports the saved raster only; text/smart-object editability is not retained.');
        const name = join(next.folder, base), slot = next.slot ?? logicalName(base), logicalPath = join(next.folder, tags.path || base);
        rows.push({ id, sourceName, layer, name, bone: next.bone, slot, skin: next.skin, folder: next.folder, logicalPath, visible, trim: next.trim, padding: next.padding, blend, ancestry: next.ancestry });
      } catch (e) { blockers.push({ layer: location, reason: (e as Error).message }); }
    });
  }
  visit(psd.children ?? [], { bone: 'root', skin: 'default', folder: '', visible: true, ancestry: [], trim: options.trimWhitespace, padding: options.padding });
  if (origins.length > 1 && !options.origin) blockers.push({ layer: 'document', reason: 'Multiple [origin] layers require an explicit origin option.' });
  const guides = psd.imageResources?.gridAndGuidesInformation?.guides ?? [], origin = options.origin ?? origins[0] ?? { x: guides.find(g => g.direction === 'vertical')?.location ?? psd.width / 2, y: guides.find(g => g.direction === 'horizontal')?.location ?? psd.height / 2 };
  if (![origin.x, origin.y].every(Number.isFinite)) blockers.push({ layer: 'document', reason: 'Invalid origin/guide coordinates.' });
  if (psd.imageResources?.iccProfile) warnings.push('PSD ICC profile is retained as an artifact; raster RGB values are unchanged. Spine texture output performs no ICC color conversion.');
  if (!rows.length) blockers.push({ layer: 'document', reason: 'No supported non-ignored raster layers.' });
  return { rows, bones, origin, blockers, warnings, layers: allLayers, layerPixels: pixels };
}
function checkRle(bytes: Uint8Array, width: number, height: number) {
  if (bytes.length < height * 2) throw new Error('Truncated PSD RLE row table.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = height * 2;
  for (let y = 0; y < height; y++) {
    const end = offset + view.getUint16(y * 2); let decoded = 0; if (end > bytes.length) throw new Error('Truncated PSD RLE row.');
    while (offset < end) { const n = bytes[offset++]!; if (n < 128) { offset += n + 1; decoded += n + 1; } else if (n > 128) { offset++; decoded += 257 - n; } if (offset > end || decoded > width) throw new Error('Invalid PSD RLE run length.'); }
    if (decoded !== width) throw new Error('PSD RLE row has an incorrect decoded width.');
  }
  if (offset !== bytes.length) throw new Error('PSD RLE channel has trailing bytes.');
}
function raster(row: Row, psd: Psd) {
  const layer = row.layer, width = (layer.right ?? 0) - (layer.left ?? 0), height = (layer.bottom ?? 0) - (layer.top ?? 0), size = width * height;
  // Check compressed channel lengths before the lazy helper, which otherwise permits truncated ZIP output.
  for (const c of layer.rawData?.channels ?? []) if (c.id >= -1) { if (!c.data) throw new Error('Missing PSD channel data.'); if (c.compression === 0 && c.data.length !== size) throw new Error('Invalid raw channel length.'); if (c.compression === 1) checkRle(c.data, width, height); if (c.compression === 2 || c.compression === 3) { const data = inflateSync(c.data, { maxOutputLength: size }); if (data.length !== size) throw new Error('Invalid ZIP channel length.'); } if (c.compression < 0 || c.compression > 3) throw new Error('Unsupported PSD channel compression.'); }
  const image = layer.imageData ?? getLayerImageData(layer); if (!image || image.width !== width || image.height !== height || !(image.data instanceof Uint8ClampedArray || image.data instanceof Uint8Array)) throw new Error('PSD layer did not decode to 8-bit RGBA.');
  let left = 0, top = 0, right = width, bottom = height;
  if (row.trim) { left = width; top = height; right = bottom = 0; for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (image.data[(y * width + x) * 4 + 3]) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); } if (right <= left || bottom <= top) return null; }
  else { left = -(layer.left ?? 0); top = -(layer.top ?? 0); right = left + psd.width; bottom = top + psd.height; }
  const w = right - left + row.padding * 2, h = bottom - top + row.padding * 2; if (w > limits.dimension || h > limits.dimension || w * h > limits.canvasPixels) throw new Error('Padded PNG exceeds its raster budget.');
  const pixels = new Uint8Array(w * h * 4);
  for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) for (let x = Math.max(0, left); x < Math.min(width, right); x++) { const from = (y * width + x) * 4, to = ((y - top + row.padding) * w + x - left + row.padding) * 4; pixels.set(image.data.subarray(from, from + 4), to); pixels[to + 3] = Math.round(pixels[to + 3]! * (layer.opacity ?? 1)); }
  return { width: w, height: h, center: { x: (layer.left ?? 0) + (left + right) / 2, y: (layer.top ?? 0) + (top + bottom) / 2 }, bytes: encodePng(w, h, pixels) };
}
async function assemble(service: SpineService, psd: Psd, options: Options, directory?: string, control?: WorkControl, composition?: PsdComposition) {
  const s = structure(psd, options); if (composition) { s.blockers.push(...composition.blockers); s.warnings.push(...composition.warnings); } const records: any[] = [], data: SpineDocument = parseDocument({ skeleton: { spine: '4.3.23', name: options.name, images: './images', fps: 30 }, bones: [{ name: 'root' }], slots: [], skins: [], animations: {} }), positions = new Map<string, { x: number; y: number }>([['root', { x: 0, y: 0 }]]);
  for (const b of s.bones.values()) { const first = s.rows.findLast(r => r.visible && r.ancestry.includes(b.group)), layer = first?.layer, center = layer ? { x: ((layer.left ?? 0) + (layer.right ?? 0)) / 2, y: ((layer.top ?? 0) + (layer.bottom ?? 0)) / 2 } : { x: s.origin.x, y: s.origin.y }; positions.set(b.name, { x: (center.x - s.origin.x) * options.unitsPerPixel, y: (s.origin.y - center.y) * options.unitsPerPixel }); const p = positions.get(b.parent)!; data.bones.push({ name: b.name, parent: b.parent, x: positions.get(b.name)!.x - p.x, y: positions.get(b.name)!.y - p.y }); }
  const skins = new Map<string, any>(), slots = new Map<string, any>();
  for (const [index, row] of s.rows.entries()) {
    await checkpoint(control, { phase: 'psd:rasterize', completed: index, total: s.rows.length });
    if (s.blockers.length) break;
    try {
      const output = raster(row, psd); if (!output) { s.warnings.push(row.id + ': empty transparent layer skipped.'); continue; }
      const imagePath = `asset-${digest({ id: row.id, name: row.name }).slice(0, 24)}`, existing = slots.get(row.slot);
      if (existing && (existing.bone !== row.bone || existing.blend !== row.blend)) throw new Error('Attachments sharing a slot require the same bone and blend mode.');
      if (!existing) { const slot: any = { name: row.slot, bone: row.bone, blend: row.blend }; slots.set(row.slot, slot); data.slots!.push(slot); }
      if (!skins.has(row.skin)) skins.set(row.skin, { name: row.skin, attachments: {} }); const skin = skins.get(row.skin), attachments = skin.attachments[row.slot] ??= {};
      if (Object.hasOwn(attachments, row.name)) throw new Error('Duplicate attachment/placeholder within this skin and slot.');
      const bone = positions.get(row.bone)!; attachments[row.name] = { path: imagePath, x: (output.center.x - s.origin.x) * options.unitsPerPixel - bone.x, y: (s.origin.y - output.center.y) * options.unitsPerPixel - bone.y, width: output.width * options.unitsPerPixel, height: output.height * options.unitsPerPixel };
      const record = { id: row.id, sourceName: row.sourceName, slot: row.slot, skin: row.skin, attachment: row.name, bone: row.bone, logicalPath: row.logicalPath, image: `images/${imagePath}.png`, width: output.width, height: output.height, center: output.center, visible: row.visible, pngSha256: createHash('sha256').update(output.bytes).digest('hex') }; records.push(record);
      if (directory) { const filename = await service.workspace.resolve(path.join(directory, record.image), false); try { await writeFile(filename, output.bytes, { flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if ((await pin(service, filename)).sha256 !== record.pngSha256) throw new Error('Partial PSD output changed; choose a new requestId.'); } }
    } catch (e) { s.blockers.push({ layer: row.id + ': ' + row.sourceName, reason: (e as Error).message }); }
  }
  if (!records.length && !s.blockers.length) s.blockers.push({ layer: 'document', reason: 'All selected layers are transparent.' });
  if (options.reviewSkin && !skins.has(options.reviewSkin)) s.blockers.push({ layer: 'document', reason: 'reviewSkin does not name an imported skin.' });
  const suggestedSkin = options.reviewSkin ?? (skins.has('default') ? 'default' : skins.keys().next().value);
  if (!skins.has('default') && suggestedSkin) s.warnings.push('All layers belong to named skins: select ' + suggestedSkin + ' in Spine or pass that skin to rendering. No default copy is injected.');
  for (const slot of data.slots!) { const visible = records.findLast(r => r.visible && r.slot === slot.name && r.skin === suggestedSkin) ?? records.findLast(r => r.visible && r.slot === slot.name && r.skin === 'default'); if (visible) slot.attachment = visible.attachment; const count = records.filter(r => r.visible && r.slot === slot.name && r.skin === suggestedSkin).length; if (count > 1) s.warnings.push(slot.name + ': multiple visible attachments in one slot are alternatives; only the topmost is active.'); }
  data.skins = [...(skins.has('default') ? [skins.get('default')] : []), ...[...skins.values()].filter(s => s.name !== 'default')];
  // JSON keys are placeholders. The native editor requires distinct actual attachment names
  // when multiple skins provide the same slot/placeholder. Default-skin keys are actual names,
  // so default attachments retain the key name rather than an alias. A default attachment
  // cannot also be a named-skin placeholder in the same slot in the native editor.
  const attachmentNames = new Set<string>();
  for (const skin of data.skins as any[]) for (const [slot, entries] of Object.entries(skin.attachments)) for (const [placeholder, attachment] of Object.entries(entries as object)) {
    const name = skin.name === 'default' ? placeholder : `${skin.name}/${placeholder}`, key = JSON.stringify([slot, name]);
    if (attachmentNames.has(key)) s.blockers.push({ layer: `${skin.name}/${slot}/${placeholder}`, reason: 'Skin/folder names produce a duplicate actual attachment name; rename the conflicting skin or folder.' });
    attachmentNames.add(key); (attachment as any).name = name;
    if (skin.name !== 'default' && Object.hasOwn(skins.get('default')?.attachments?.[slot] ?? {}, placeholder)) s.blockers.push({ layer: `${skin.name}/${slot}/${placeholder}`, reason: 'Default attachment conflicts with a named-skin placeholder in this slot; move the default layer into a named skin or rename its slot/attachment.' });
  }
  return { data: parseDocument(data), records, origin: s.origin, suggestedSkin, requiresSkinSelection: !skins.has('default') || records.some(r => r.skin !== 'default'), composition, blockers: s.blockers, warnings: s.warnings, layerCount: s.layers, layerPixels: s.layerPixels, checksPassed: !s.blockers.length };
}
export async function planPsdImport(service: SpineService, raw: z.input<typeof planPsdImportSchema>, control?: WorkControl) {
  const options = planPsdImportSchema.parse(raw); await checkpoint(control, { phase: 'psd:preflight', completed: 0, total: 1 }); const { psd, p, composition } = await readBounded(service, options.input, options.ignoreHidden), built = await assemble(service, psd, options, undefined, control, composition);
  const report = { schema: 'spine-psd-import-plan/1', version: VERSION, options, source: p, ...built, limits, parser: 'ag-psd 33.0.0', pixels: 'RGB values and layer opacity preserved; no ICC conversion. PNG filenames are safe generated identifiers; logical PSD paths remain metadata.', supportedTags: [...supportedTags], drawOrder: 'Pinned ag-psd 33 reader order verified against authored PSD composites: bottom-to-top, matching Spine slot draw order.' };
  await verifyPins(service, [p]); const out = await immutableJson(service, 'psd-import-plans', report); return { ...report, plan: out.path, planSha256: out.sha256 };
}
export async function importPsd(service: SpineService, raw: z.input<typeof importPsdSchema>, control?: WorkControl) {
  const args = importPsdSchema.parse(raw);
  const preflight = await pin(service, args.plan); if (preflight.sha256 !== args.expectedSha256) throw new Error('PSD import plan changed.'); const saved = await jsonRead(service, preflight.path); if (saved.schema !== 'spine-psd-import-plan/1' || saved.version !== VERSION || !saved.checksPassed) throw new Error('PSD plan is blocked or from another build. Replan explicitly.'); await verifyPins(service, [saved.source]);
  return operation(service, args.requestId, 'psd_import', args, async () => {
    const p = await pin(service, args.plan); if (p.sha256 !== args.expectedSha256) throw new Error('PSD import plan changed.'); const plan = await jsonRead(service, p.path);
    if (plan.schema !== 'spine-psd-import-plan/1' || plan.version !== VERSION || !plan.checksPassed) throw new Error('PSD plan is blocked or from another build. Replan explicitly.'); await verifyPins(service, [plan.source]);
    const options = planPsdImportSchema.parse(plan.options), { psd, p: source, composition } = await readBounded(service, options.input, options.ignoreHidden); if (source.sha256 !== plan.source.sha256 || source.path !== plan.source.path) throw new Error('PSD source changed.');
    const directory = await service.workspace.resolve(path.join('psd-imports', args.requestId), false), images = await service.workspace.resolve(path.join(directory, 'images'), false); await mkdir(images, { recursive: true }); const built = await assemble(service, psd, options, directory, control, composition);
    if (!built.checksPassed || digest(built.data) !== digest(plan.data) || digest(built.records) !== digest(plan.records)) throw new Error('PSD output no longer matches its passing plan.');
    const json = await service.workspace.resolve(path.join(directory, 'skeleton.json'), false), manifest = await service.workspace.resolve(path.join(directory, 'import.json'), false), writeExact = async (file: string, value: unknown) => { const bytes = JSON.stringify(value, null, 2) + '\n'; try { await writeFile(file, bytes, { flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== bytes) throw e; } };
    await writeExact(json, built.data); await writeExact(manifest, { schema: 'spine-psd-import/1', version: VERSION, source, plan: p, ...built }); const extra: string[] = [manifest, p.path];
    if (psd.imageResources?.iccProfile) { const profile = await service.workspace.resolve(path.join(directory, 'source.icc'), false); try { await writeFile(profile, psd.imageResources.iccProfile, { flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(psd.imageResources.iccProfile).equals(await readFile(profile))) throw e; } extra.push(profile); }
    await checkpoint(control, { phase: 'psd:verify', completed: built.records.length, total: built.records.length }); await verifyPins(service, [source]);
    return writeCandidate(service, 'psd_import', json, { input: source.path, sha256: source.sha256, files: [] }, { importManifest: manifest, origin: built.origin, suggestedSkin: built.suggestedSkin, requiresSkinSelection: built.requiresSkinSelection, layers: built.records.length, bones: built.data.bones.length, slots: built.data.slots!.length, skins: (built.data.skins as any[]).map(s => s.name), warnings: built.warnings, sourceUnchanged: true, nativePublication: 'Review this portable candidate; promote_character_candidate(native=true) creates and verifies a NEW .spine.' }, true, extra);
  });
}
