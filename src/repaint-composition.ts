import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import { PNG } from 'pngjs';
import { inflateSync } from 'node:zlib';
import type { SpineService } from './service.js';
import { readPngAsset } from './image-assets.js';
import { encodePng } from './raster.js';
import { readHandoff, auditLayerHandoff } from './layer-handoff.js';
import { filename, label, sha, request, operation, newFolder, pin, verifyPins, type Pin } from './character-candidates.js';

const finite = z.number().finite(), point = z.object({ x: finite.min(-65536).max(65536), y: finite.min(-65536).max(65536) }).strict();
const rectangle = z.object({ x: finite.min(0), y: finite.min(0), width: finite.positive(), height: finite.positive() }).strict();
const alignmentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('bounds'), from: rectangle, to: rectangle }).strict(),
  z.object({ mode: z.literal('canvas'), fit: z.enum(['contain', 'cover', 'stretch', 'exact']).default('contain'), offsetX: finite.min(-16384).max(16384).default(0), offsetY: finite.min(-16384).max(16384).default(0) }).strict(),
  z.object({ mode: z.literal('anchors'), from: point, to: point.optional(), from2: point.optional(), to2: point.optional(), scale: finite.min(0.001).max(100).default(1), rotation: finite.min(-360).max(360).default(0) }).strict()
]);
export const composeRepaintSchema = z.object({ ...request, handoff: filename, expectedSha256: sha, repaints: z.array(z.object({ layer: label, image: filename, alignment: alignmentSchema.default({ mode: 'canvas', fit: 'contain', offsetX: 0, offsetY: 0 }), sampling: z.enum(['nearest', 'bilinear']).default('bilinear'), blend: z.enum(['replace', 'over']).default('replace') }).strict()).min(1).max(64) }).strict();
export interface ExactPng { path: string; width: number; height: number; pixels: Uint8Array; bytes: Buffer; sha256: string }
export async function exactPng(service: SpineService, image: string): Promise<ExactPng> {
  const asset = await readPngAsset(service.workspace, image);
  if (asset.bytes[24] !== 8) throw new Error('Exact protected-pixel composition requires 8-bit PNGs; convert higher/lower bit depths explicitly first.');
  const compressed: Buffer[] = []; let offset = 8;
  while (offset + 12 <= asset.bytes.length) { const length = asset.bytes.readUInt32BE(offset), type = asset.bytes.toString('ascii', offset + 4, offset + 8); if (offset + length + 12 > asset.bytes.length) throw new Error('Invalid PNG chunk length.'); if (type === 'acTL') throw new Error('Animated PNGs require an explicit static frame before repaint composition.'); if (type === 'IDAT') compressed.push(asset.bytes.subarray(offset + 8, offset + 8 + length)); offset += length + 12; }
  if (asset.bytes[28] === 1) inflateSync(Buffer.concat(compressed), { maxOutputLength: asset.width * asset.height * 8 + (asset.width + asset.height) * 8 + 1024 });
  const decoded = PNG.sync.read(asset.bytes, { checkCRC: true }), sha256 = createHash('sha256').update(asset.bytes).digest('hex');
  if (decoded.width !== asset.width || decoded.height !== asset.height || decoded.data.length !== asset.width * asset.height * 4) throw new Error('Invalid decoded PNG geometry.');
  await verifyPins(service, [{ path: asset.path, sha256 }]); return { ...asset, pixels: new Uint8Array(decoded.data), sha256 };
}
export function alignmentMatrix(source: { width: number; height: number }, target: { width: number; height: number; pivot: { x: number; y: number } }, a: z.output<typeof alignmentSchema>) {
  let sx: number, sy: number, dx: number, dy: number, r = 0;
  if (a.mode === 'bounds') {
    const inside = (rect: z.output<typeof rectangle>, canvas: { width: number; height: number }) => rect.x + rect.width <= canvas.width && rect.y + rect.height <= canvas.height;
    if (!inside(a.from, source) || !inside(a.to, target)) throw new Error('Alignment bounds must lie inside both canvases.');
    sx = a.to.width / a.from.width; sy = a.to.height / a.from.height;
    if (Math.min(sx, sy) < 0.001 || Math.max(sx, sy) > 100) throw new Error('Bounds alignment scale exceeds 0.001–100.');
    dx = a.to.x - a.from.x * sx; dy = a.to.y - a.from.y * sy;
  } else if (a.mode === 'canvas') {
    if (a.fit === 'exact' && (source.width !== target.width || source.height !== target.height)) throw new Error('Exact canvas alignment requires equal dimensions.');
    const rx = target.width / source.width, ry = target.height / source.height;
    sx = a.fit === 'exact' ? 1 : a.fit === 'stretch' ? rx : a.fit === 'cover' ? Math.max(rx, ry) : Math.min(rx, ry); sy = a.fit === 'stretch' ? ry : sx;
    dx = (target.width - source.width * sx) / 2 + a.offsetX; dy = (target.height - source.height * sy) / 2 + a.offsetY;
  } else {
    if (Boolean(a.from2) !== Boolean(a.to2)) throw new Error('Two-point alignment needs both from2 and to2.');
    const to = a.to ?? target.pivot, inside = (p: { x: number; y: number }, d: { width: number; height: number }) => p.x >= 0 && p.y >= 0 && p.x <= d.width && p.y <= d.height;
    if (!inside(a.from, source) || !inside(to, target) || a.from2 && (!inside(a.from2, source) || !inside(a.to2!, target))) throw new Error('Alignment anchors must lie inside their canvases.');
    sx = sy = a.scale; r = a.rotation * Math.PI / 180;
    if (a.from2) {
      const ux = a.from2.x - a.from.x, uy = a.from2.y - a.from.y, vx = a.to2!.x - to.x, vy = a.to2!.y - to.y;
      if (Math.min(Math.hypot(ux, uy), Math.hypot(vx, vy)) < 1e-6) throw new Error('Two-point alignment anchors are degenerate.');
      sx = sy = Math.hypot(vx, vy) / Math.hypot(ux, uy); if (sx < 0.001 || sx > 100) throw new Error('Derived alignment scale exceeds 0.001–100.'); r = Math.atan2(vy, vx) - Math.atan2(uy, ux);
    }
    dx = to.x - sx * (Math.cos(r) * a.from.x - Math.sin(r) * a.from.y); dy = to.y - sy * (Math.sin(r) * a.from.x + Math.cos(r) * a.from.y);
  }
  const matrix = { a: sx * Math.cos(r), b: sy * Math.sin(r), c: -sx * Math.sin(r), d: sy * Math.cos(r), x: dx, y: dy };
  if (!Object.values(matrix).every(Number.isFinite)) throw new Error('Alignment matrix is not finite.'); return matrix;
}
function texturePixel(image: ExactPng, x: number, y: number, sampling: 'nearest' | 'bilinear') {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return [0, 0, 0, 0];
  const get = (x: number, y: number) => { const i = (Math.max(0, Math.min(image.height - 1, y)) * image.width + Math.max(0, Math.min(image.width - 1, x))) * 4, a = image.pixels[i + 3]! / 255; return [image.pixels[i]! * a, image.pixels[i + 1]! * a, image.pixels[i + 2]! * a, a]; };
  if (sampling === 'nearest') return get(Math.floor(x), Math.floor(y));
  const px = x - 0.5, py = y - 0.5, ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy, values = [get(ix, iy), get(ix + 1, iy), get(ix, iy + 1), get(ix + 1, iy + 1)], weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  return [0, 1, 2, 3].map(c => values.reduce((n, p, j) => n + p[c]! * weights[j]!, 0));
}
export function compositeRepaintPixels(base: ExactPng, generated: ExactPng, mask: ExactPng, protectedMask: ExactPng | undefined, matrix: ReturnType<typeof alignmentMatrix>, sampling: 'nearest' | 'bilinear', blend: 'replace' | 'over') {
  if (mask.width !== base.width || mask.height !== base.height || protectedMask && (protectedMask.width !== base.width || protectedMask.height !== base.height)) throw new Error('Repaint/protection masks must match the destination canvas.');
  const result = new Uint8Array(base.pixels), det = matrix.a * matrix.d - matrix.b * matrix.c; if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('Alignment matrix is singular.');
  let editablePixels = 0, protectedPixels = 0, sampledTransparentPixels = 0, changedPixels = 0, clippedMaskPixels = 0;
  for (let y = 0; y < base.height; y++) for (let x = 0; x < base.width; x++) {
    const i = (y * base.width + x) * 4, m = mask.pixels[i + 3]! / 255;
    if (protectedMask?.pixels[i + 3]) { protectedPixels++; continue; } if (!m) continue; editablePixels++;
    const tx = x + 0.5 - matrix.x, ty = y + 0.5 - matrix.y, sx = (matrix.d * tx - matrix.c * ty) / det, sy = (-matrix.b * tx + matrix.a * ty) / det;
    if (sx < 0 || sy < 0 || sx >= generated.width || sy >= generated.height) clippedMaskPixels++;
    const g = texturePixel(generated, sx, sy, sampling), ba = base.pixels[i + 3]! / 255, a = blend === 'over' ? g[3]! * m + ba * (1 - g[3]! * m) : ba * (1 - m) + g[3]! * m;
    if (g[3]! < 1 / 255) sampledTransparentPixels++;
    for (let c = 0; c < 3; c++) { const b = base.pixels[i + c]! * ba, p = blend === 'over' ? g[c]! * m + b * (1 - g[3]! * m) : b * (1 - m) + g[c]! * m; result[i + c] = a > 0 ? Math.round(Math.max(0, Math.min(255, p / a))) : 0; }
    result[i + 3] = Math.round(a * 255); if ([0, 1, 2, 3].some(c => result[i + c] !== base.pixels[i + c])) changedPixels++;
  }
  return { pixels: result, metrics: { editablePixels, protectedPixels, sampledTransparentPixels, changedPixels, clippedMaskPixels, protectedPixelChanges: 0, outsideMaskPixelChanges: 0 } };
}
function encodeWithBaseProfile(base: ExactPng, pixels: Uint8Array) {
  const encoded = encodePng(base.width, base.height, pixels), chunks: Buffer[] = []; let offset = 8;
  while (offset + 12 <= base.bytes.length) { const n = base.bytes.readUInt32BE(offset), type = base.bytes.toString('ascii', offset + 4, offset + 8); if (offset + n + 12 > base.bytes.length) throw new Error('Invalid PNG chunk size.'); if (['sRGB', 'gAMA', 'cHRM', 'iCCP'].includes(type)) chunks.push(base.bytes.subarray(offset, offset + n + 12)); offset += n + 12; }
  return Buffer.concat([encoded.subarray(0, 33), ...chunks, encoded.subarray(33)]);
}
export async function composeLayerRepaint(service: SpineService, raw: z.input<typeof composeRepaintSchema>) {
  const args = composeRepaintSchema.parse(raw);
  return operation(service, args.requestId, 'compose_layer_repaint', args, async () => {
    const h = await readHandoff(service, args.handoff, args.expectedSha256), selected = new Set<string>();
    const folder = await newFolder(service, 'layer-repaints'), layers = [], files: Pin[] = [], replacements = []; let pixels = 0;
    for (const [index, edit] of args.repaints.entries()) {
      if (selected.has(edit.layer)) throw new Error('Repeated repaint layer.'); selected.add(edit.layer);
      const l = h.layers.find((l: any) => l.name === edit.layer); if (!l?.repaintMask) throw new Error('Select a handoff layer with an explicit repaintMask.');
      const base = await exactPng(service, l.image), generated = await exactPng(service, edit.image), mask = await exactPng(service, l.repaintMask), protectedMask = l.protectedMask ? await exactPng(service, l.protectedMask) : undefined;
      pixels += base.width * base.height * 2 + generated.width * generated.height + mask.width * mask.height + (protectedMask ? protectedMask.width * protectedMask.height : 0); if (pixels > 64_000_000) throw new Error('Repaint composition exceeds 64 million decoded/output pixels.');
      const matrix = alignmentMatrix(generated, { ...base, pivot: l.pivot }, edit.alignment), combined = compositeRepaintPixels(base, generated, mask, protectedMask, matrix, edit.sampling, edit.blend), output = path.join(folder, `layer-${index}.png`);
      await writeFile(output, encodeWithBaseProfile(base, combined.pixels), { flag: 'wx' });
      const decoded = await exactPng(service, output); for (let i = 0; i < base.pixels.length; i += 4) if (!mask.pixels[i + 3] || protectedMask?.pixels[i + 3]) for (let c = 0; c < 4; c++) if (decoded.pixels[i + c] !== base.pixels[i + c]) throw new Error('Protected or outside-mask pixel verification failed.');
      files.push(...[base, generated, mask, ...(protectedMask ? [protectedMask] : [])].map(p => ({ path: p.path, sha256: p.sha256 })), await pin(service, output)); replacements.push({ layer: edit.layer, image: output });
      layers.push({ layer: edit.layer, output, matrix, sampling: edit.sampling, blend: edit.blend, originalDimensions: [base.width, base.height], generatedDimensions: [generated.width, generated.height], ...combined.metrics });
    }
    await verifyPins(service, [...h.files, ...files, { path: args.handoff, sha256: args.expectedSha256 }]);
    const audit = await auditLayerHandoff(service, { handoff: args.handoff, expectedSha256: args.expectedSha256, replacements });
    const report = { schema: 'spine-layer-repaint/1', handoff: args.handoff, layers, replacements, checksPassed: audit.checksPassed, audit, visualAcceptance: 'pending', originalUnchanged: true, exactPixelScope: '8-bit decoded RGBA, including transparent RGB. Any nonzero protected-mask alpha locks the entire pixel. Base PNG color profile chunks retained; generated colors are interpreted in that encoded color space. Geometry is explicit; no anatomy/semantic alignment inference.' }, reportPath = path.join(folder, 'composition.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); return { ...report, reportPath, pinnedFiles: [...h.files, ...files, await pin(service, args.handoff), await pin(service, reportPath), await pin(service, audit.reportPath), await pin(service, audit.compositePath), await pin(service, audit.differencePath)] };
  });
}
