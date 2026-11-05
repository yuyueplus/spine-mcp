import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RegionAttachment, MeshAttachment, ClippingAttachment, TextureRegion, type AttachmentLoader, type Attachment, type Sequence } from '@esotericsoftware/spine-core';
import { Resvg } from '@resvg/resvg-js';
import type { Workspace } from './config.js';
import { object, type SpineDocument } from './document.js';
import { documentSkins } from './slot-data.js';
import { imagesRoot, readPngAsset } from './image-assets.js';
import { boneDiagramLoader, escapeXml, sampleSkeleton, type PreviewOptions } from './runtime.js';
import { encodePng, compositeOpaque, compositeRgba } from './raster.js';
import { rasterizeTexture, type RasterTexture, type RasterBudget } from './texture-raster.js';

export interface RegionSample {
  slot: string; attachment: string | null; attachmentName?: string; image?: string; vertices?: number[]; uvs?: number[]; triangles?: number[]; blend?: string;
  color?: { r: number; g: number; b: number; a: number }; dark?: { r: number; g: number; b: number };
  clip?: { vertices: number[]; end: string | null; inverse: boolean; convex: boolean };
}
type PngAsset = Awaited<ReturnType<typeof readPngAsset>>;
export async function sampleArtwork(workspace: Workspace, data: SpineDocument, jsonPath: string, animation: string | undefined, times: number[], skin?: string, options: PreviewOptions = {}) {
  if (!times.length || times.length > 8) throw new Error('Provide one to eight preview times.');
  if ((data.slots?.length ?? 0) > 500) throw new Error('Artwork preview is limited to 500 slots.');
  if (!skin && !documentSkins(data).some(item => item.name === 'default')) throw new Error(`Select a skin for artwork preview from: ${documentSkins(data).map(item => String(item.name)).join(', ')}`);
  const assets = new Map<string, PngAsset>(), root = await imagesRoot(workspace, data, jsonPath);
  let bytes = 0, pixels = 0;
  // Resolve only images actually used at the requested times. A native long
  // sequence may contain hundreds of frames while one preview needs just a few.
  const needed = new Set<string>();
  for (const time of times) {
    const skeleton = sampleSkeleton(data, animation, time, skin, boneDiagramLoader, options);
    for (const slot of skeleton.drawOrder.appliedPose) {
      const attachment = slot.appliedPose.attachment;
      if (!slot.bone.active || !slot.data.visible || !(attachment instanceof RegionAttachment || attachment instanceof MeshAttachment)) continue;
      needed.add(attachment.sequence.getPath(attachment.path ?? attachment.name, attachment.sequence.resolveIndex(slot.appliedPose)));
    }
  }
  for (const imagePath of needed) {
    if (assets.size >= 128) throw new Error('Artwork preview is limited to 128 active PNG images across the requested times.');
    const asset = await readPngAsset(workspace, path.resolve(root, `${imagePath}.png`));
    bytes += asset.bytes.length; pixels += asset.width * asset.height;
    if (bytes > 64 * 1024 * 1024 || pixels > 64 * 1024 * 1024) throw new Error('Preview images exceed 64 MiB or 64 megapixels.');
    assets.set(imagePath, asset);
  }
  const placeholders = new WeakMap<Attachment, string>();
  function loadRegions(sequence: Sequence, base: string) {
    for (let index = 0; index < sequence.regions.length; index++) {
      const asset = assets.get(sequence.getPath(base, index)), region = new TextureRegion();
      region.width = region.originalWidth = asset?.width ?? 1; region.height = region.originalHeight = asset?.height ?? 1;
      region.u2 = region.v2 = 1; region.texture = asset; sequence.regions[index] = region;
    }
  }
  const loader: AttachmentLoader = { ...boneDiagramLoader,
    newRegionAttachment: (_skin, placeholder, name, imagePath, sequence) => { loadRegions(sequence, imagePath); const attachment = new RegionAttachment(name, sequence); placeholders.set(attachment, placeholder); return attachment; },
    newMeshAttachment: (_skin, placeholder, name, imagePath, sequence) => { loadRegions(sequence, imagePath); const attachment = new MeshAttachment(name, sequence); placeholders.set(attachment, placeholder); return attachment; },
  };
  const frames = times.map(time => {
    const skeleton = sampleSkeleton(data, animation, time, skin, loader, options); let geometry = 0;
    const slots: RegionSample[] = skeleton.drawOrder.appliedPose.map(slot => {
      const pose = slot.appliedPose, attachment = pose.attachment;
      if (!slot.bone.active || !slot.data.visible || !attachment) return { slot: slot.data.name, attachment: null };
      if (attachment instanceof ClippingAttachment) {
        const vertices = new Array<number>(attachment.worldVerticesLength); attachment.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2);
        return { slot: slot.data.name, attachment: attachment.name, clip: { vertices, end: attachment.endSlot?.name ?? null, inverse: attachment.inverse, convex: attachment.convex } };
      }
      if (!(attachment instanceof RegionAttachment) && !(attachment instanceof MeshAttachment)) return { slot: slot.data.name, attachment: null };
      const sequenceIndex = attachment.sequence.resolveIndex(pose), asset = attachment.sequence.regions[sequenceIndex]!.texture as PngAsset | undefined;
      if (!asset) throw new Error(`Missing image for active attachment ${attachment.name}.`);
      const vertices = new Array<number>(attachment instanceof RegionAttachment ? 8 : attachment.worldVerticesLength);
      if (attachment instanceof RegionAttachment) attachment.computeWorldVertices(slot, attachment.getOffsets(pose), vertices, 0, 2);
      else attachment.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2);
      geometry += vertices.length / 2; if (geometry > 50000) throw new Error('Preview geometry exceeds 50000 vertices per frame.');
      const color = { r: pose.color.r * attachment.color.r * skeleton.color.r, g: pose.color.g * attachment.color.g * skeleton.color.g, b: pose.color.b * attachment.color.b * skeleton.color.b, a: pose.color.a * attachment.color.a * skeleton.color.a };
      if (![...vertices, ...Object.values(color)].every(Number.isFinite)) throw new Error(`Non-finite artwork transform for ${slot.data.name}.`);
      return { slot: slot.data.name, attachment: placeholders.get(attachment)!, attachmentName: attachment.name, image: asset.path, vertices, color,
        ...(attachment instanceof MeshAttachment ? { uvs: Array.from(attachment.sequence.getUVs(sequenceIndex)), triangles: Array.from(attachment.triangles) } : {}),
        blend: ['normal', 'additive', 'multiply', 'screen'][slot.data.blendMode], ...(pose.darkColor ? { dark: { r: pose.darkColor.r * skeleton.color.r, g: pose.darkColor.g * skeleton.color.g, b: pose.darkColor.b * skeleton.color.b } } : {}) };
    });
    return { time, slots };
  });
  return { frames, assets };
}
function convexHull(vertices: number[]) {
  const points = Array.from({ length: vertices.length / 2 }, (_v, index) => [vertices[index * 2]!, vertices[index * 2 + 1]!] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
  const lower: (readonly number[])[] = [], upper: (readonly number[])[] = [];
  for (const point of points) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop(); lower.push(point); }
  for (const point of points.toReversed()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop(); upper.push(point); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)].flat();
}
export async function renderArtwork(workspace: Workspace, data: SpineDocument, jsonPath: string, animation: string | undefined, times: number[], skin?: string, options: PreviewOptions & { clean?: boolean; transparent?: boolean; width?: number; height?: number } = {}) {
  const clean = options.clean ?? false, transparent = clean && (options.transparent ?? false), panelWidth = clean ? options.width ?? 320 : 320, height = clean ? options.height ?? 300 : 300;
  if (![panelWidth, height].every(n => Number.isInteger(n) && n >= 16 && n <= 4096) || panelWidth * height > 2_097_152) throw new Error('Artwork output dimensions must be 16–4096 pixels and at most two megapixels.');
  const { frames, assets } = await sampleArtwork(workspace, data, jsonPath, animation, times, skin, options), byPath = new Map([...assets.values()].map(asset => [asset.path, asset]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const frame of frames) for (const slot of frame.slots) if (slot.vertices) for (let index = 0; index < slot.vertices.length; index += 2) { minX = Math.min(minX, slot.vertices[index]!); maxX = Math.max(maxX, slot.vertices[index]!); minY = Math.min(minY, slot.vertices[index + 1]!); maxY = Math.max(maxY, slot.vertices[index + 1]!); }
  if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
  if (options.viewport) ({ minX, maxX, minY, maxY } = options.viewport);
  const zoom = Math.min((clean ? panelWidth - 16 : 256) / Math.max(maxX - minX, 1), (clean ? height - 16 : 200) / Math.max(maxY - minY, 1), clean ? Infinity : 3), cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const px = (x: number) => panelWidth / 2 + (x - cx) * zoom, py = (y: number) => height / 2 + (clean ? 0 : 8) - (y - cy) * zoom;
  const textures = new Map<string, RasterTexture>(), budget: RasterBudget = { samples: 0 };
  const decoded = (asset: PngAsset): RasterTexture => {
    let texture = textures.get(asset.path);
    if (!texture) {
      const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}"><image width="${asset.width}" height="${asset.height}" href="data:image/png;base64,${asset.bytes.toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render();
      texture = { width: asset.width, height: asset.height, pixels: raster.pixels }; textures.set(asset.path, texture);
    }
    return texture;
  };
  const panels = frames.map((frame, frameIndex) => {
    const canvas = new Uint8Array(panelWidth * height * 4); if (!transparent) for (let index = 0; index < canvas.length; index += 4) canvas.set([32, 43, 55, 255], index);
    let clip: RegionSample['clip']; const masks = new Map<NonNullable<RegionSample['clip']>, Uint8Array>();
    for (const slot of frame.slots) {
      if (slot.clip && !clip) clip = slot.clip;
      if (slot.vertices && slot.image && slot.color) {
        const asset = byPath.get(slot.image)!, color = slot.color, dark = slot.dark ?? { r: 0, g: 0, b: 0 };
        let mask: Uint8Array | undefined;
        if (clip) {
          mask = masks.get(clip);
          if (!mask) {
            const v = clip.convex || clip.inverse ? convexHull(clip.vertices) : clip.vertices, points = Array.from({ length: v.length / 2 }, (_item, index) => `${px(v[index * 2]!)},${py(v[index * 2 + 1]!)}`).join(' ');
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${height}"><defs><clipPath id="mask"><path d="${clip.inverse ? `M0,0H${panelWidth}V${height}H0Z ` : ''}M${points.replaceAll(' ', 'L')}Z" clip-rule="evenodd"/></clipPath></defs><rect width="100%" height="100%" fill="white" clip-path="url(#mask)"/></svg>`;
            mask = new Resvg(svg, { font: { loadSystemFonts: false } }).render().pixels; masks.set(clip, mask);
          }
        }
        const vertices = slot.vertices.map((v, i) => i % 2 ? py(v) : px(v)), triangles = slot.triangles ?? [0, 1, 2, 0, 2, 3], uvs = slot.uvs ?? [0, 1, 0, 0, 1, 0, 1, 1];
        const layer = rasterizeTexture(panelWidth, height, vertices, uvs, triangles, decoded(asset), budget);
        const light = [color.r, color.g, color.b], shadow = [dark.r, dark.g, dark.b], opacity = Math.max(0, Math.min(1, color.a));
        for (let index = 0; index < layer.length; index += 4) {
          const alpha = layer[index + 3]!, coverage = opacity * (mask ? mask[index + 3]! / 255 : 1);
          for (let component = 0; component < 3; component++) layer[index + component] = Math.round(Math.max(0, Math.min(alpha, (light[component]! - shadow[component]!) * layer[index + component]! + shadow[component]! * alpha)) * coverage);
          layer[index + 3] = Math.round(alpha * coverage);
        }
        (transparent ? compositeRgba : compositeOpaque)(canvas, layer, slot.blend ?? 'normal');
      }
      if (clip?.end === slot.slot) clip = undefined;
    }
    const png = encodePng(panelWidth, height, canvas);
    if (clean) return `<g transform="translate(${frameIndex * panelWidth},0)"><image width="${panelWidth}" height="${height}" href="data:image/png;base64,${png.toString('base64')}"/></g>`;
    return `<g transform="translate(${frameIndex * panelWidth},0)"><clipPath id="panel-${frameIndex}"><rect x="1" y="1" width="318" height="298" rx="10"/></clipPath><image clip-path="url(#panel-${frameIndex})" width="320" height="300" href="data:image/png;base64,${png.toString('base64')}"/><text x="16" y="28" fill="#eef5fc" font-size="14">${escapeXml(animation ?? 'Setup pose')} · ${frame.time.toFixed(3)} s</text><text x="16" y="280" fill="#b3c3d4" font-size="11">Artwork · ${escapeXml(skin ?? 'default')} · physics ${options.physics ? 'on' : 'off'}</text></g>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth * times.length}" height="${height}" font-family="Arial,sans-serif">${transparent ? '' : '<rect width="100%" height="100%" fill="#121c27"/>'}${panels}</svg>`, png = new Resvg(svg, { font: { loadSystemFonts: !clean } }).render().asPng();
  const directory = await workspace.resolve('previews', false); await mkdir(directory, { recursive: true }); const output = path.join(directory, `artwork-${randomUUID()}.png`); await writeFile(output, png, { flag: 'wx' });
  return { path: output, mimeType: 'image/png', data: png.toString('base64'), animation: animation ?? null, skin: skin ?? 'default', frames, physics: Boolean(options.physics), raster: { decodedTextures: textures.size, subpixelCandidates: budget.samples, samplesPerAxis: 2, sharedEdgeRule: 'top-left' }, previewRuntime: '@esotericsoftware/spine-core 4.3.13', note: 'CPU preview with PNG regions/meshes, weights/deformation, sequence images, clipping, tint and common blend modes. Optional physics starts from reset at zero. Edge antialiasing can differ from game GPU rendering; validate production rendering in the target runtime.' };
}
