import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { Resvg } from '@resvg/resvg-js';
import type { SpineService } from './service.js';
import { sampleArtwork, renderArtwork, type RegionSample } from './scene-preview.js';
import { sampleSkeleton } from './runtime.js';
import { layerAlpha } from './character-assistance.js';
import { animationDuration } from './advanced-animation.js';
import { auditAssets, assertSnapshot, saveReport } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { checkpoint, type WorkControl } from './progress.js';

const name = z.string().min(1).max(256), finite = z.number().finite(), time = finite.min(0).max(300), layer = z.object({ slot: name, attachment: name.optional() }).strict();
export const animatedSeamsSchema = z.object({ input: name, skeletonName: name.optional(), animation: name, skin: name.optional(), start: time.default(0), end: time.optional(), fps: z.number().int().min(1).max(120).default(12), maxSamples: z.number().int().min(1).max(300).default(300), physics: z.boolean().default(false), physicsFps: z.number().int().min(1).max(120).default(60), alphaThreshold: z.number().int().min(1).max(255).default(128), samplesPerAxis: z.number().int().min(5).max(33).refine(n => n % 2 === 1).default(9), maxPreviewPoses: z.number().int().min(0).max(8).default(3), seams: z.array(z.object({ name, a: layer, b: layer, bone: name, point: z.object({ x: finite, y: finite }).strict().default({ x: 0, y: 0 }), radius: finite.positive().max(10000), start: time.optional(), end: time.optional(), minOverlapFraction: finite.min(0).max(1).default(0.2), minUnionFraction: finite.min(0).max(1).default(0.85) }).strict()).min(1).max(20) }).strict();

export async function auditAnimatedSeams(service: SpineService, raw: z.input<typeof animatedSeamsSchema>, control?: WorkControl) {
  const o = animatedSeamsSchema.parse(raw), source = await service.workspace.resolve(o.input), sourceSha256 = await fileSha256(source), loaded = await service.load(source, o.skeletonName), assets = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  if (!assets.valid) throw new Error('Animated seams require complete resources.');
  const duration = loaded.data.animations?.[o.animation] && animationDuration(loaded.data.animations[o.animation]!); if (duration === undefined) throw new Error('Animation missing.');
  const end = o.end ?? duration; if (end < o.start || end > duration + 1e-6) throw new Error('Seam range must be inside the animation.');
  const count = Math.ceil((end - o.start) * o.fps) + 1; if (count > o.maxSamples) throw new Error('Animated seam sample budget exceeded.');
  const times = [...new Set([...Array.from({ length: count }, (_, i) => Math.min(end, o.start + i / o.fps)), ...o.seams.flatMap(s => [s.start, s.end]).filter((t): t is number => t !== undefined && t >= o.start && t <= end)])].sort((a, b) => a - b);
  if (times.length > o.maxSamples || o.physics && times.reduce((n, t) => n + 3 * (Math.ceil(t * o.physicsFps) + 1) * loaded.data.bones.length, 0) > 500000) throw new Error('Animated seam boundary/physics budget exceeded.');
  for (const s of o.seams) { if (!loaded.data.bones.some(b => b.name === s.bone)) throw new Error(`Seam anchor bone missing: ${s.bone}`); if (s.a.slot === s.b.slot) throw new Error('A seam requires two different slots.'); if ((s.end ?? end) < (s.start ?? o.start) || (s.start ?? o.start) > end || (s.end ?? end) < o.start) throw new Error('Seam interval is reversed or does not overlap the audit.'); }
  const textures = new Map<string, { width: number; height: number; pixels: Uint8Array }>(), rows: { time: number; seam: string; center: { x: number; y: number }; radius: number; passed: boolean; overlapFraction: number; unionFraction: number; missingLayer: boolean; missingPoints: { x: number; y: number }[] }[] = [], budget = { tests: 0 }; let tested = 0, decoded = 0;
  const options = { physics: o.physics, fps: o.physicsFps };
  for (let offset = 0; offset < times.length; offset += 8) {
    await checkpoint(control, { phase: 'animated-seams', completed: offset, total: times.length });
    const group = times.slice(offset, offset + 8), artwork = await sampleArtwork(service.workspace, loaded.data, loaded.jsonPath, o.animation, group, o.skin, options);
    for (const asset of artwork.assets.values()) if (!textures.has(asset.path)) {
      decoded += asset.width * asset.height; if (decoded > 64_000_000 || textures.size >= 128) throw new Error('Animated seam textures exceed the decoding budget.');
      textures.set(asset.path, { width: asset.width, height: asset.height, pixels: new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}"><image width="100%" height="100%" href="data:image/png;base64,${asset.bytes.toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render().pixels });
    }
    for (const frame of artwork.frames) {
      const skeleton = sampleSkeleton(loaded.data, o.animation, frame.time, o.skin, undefined, options);
      for (const seam of o.seams) {
        if (frame.time < (seam.start ?? o.start) || frame.time > (seam.end ?? end)) continue;
        const p = skeleton.findBone(seam.bone)!.appliedPose, center = { x: p.worldX + p.a * seam.point.x + p.b * seam.point.y, y: p.worldY + p.c * seam.point.x + p.d * seam.point.y };
        const find = (r: z.infer<typeof layer>) => frame.slots.find(s => s.slot === r.slot && s.image && s.vertices && (r.attachment === undefined || s.attachment === r.attachment));
        const a = find(seam.a), b = find(seam.b), missingPoints: { x: number; y: number }[] = []; let points = 0, overlap = 0, union = 0;
        const alpha = (s: RegionSample | undefined, point: { x: number; y: number }) => s ? layerAlpha({ sample: s, texture: textures.get(s.image!)! }, point, budget) >= o.alphaThreshold : false;
        for (let y = 0; y < o.samplesPerAxis; y++) for (let x = 0; x < o.samplesPerAxis; x++) {
          const dx = 2 * x / (o.samplesPerAxis - 1) - 1, dy = 2 * y / (o.samplesPerAxis - 1) - 1; if (dx * dx + dy * dy > 1 + 1e-9) continue;
          if (++tested > 200000) throw new Error('Animated seam circular samples exceed 200,000.');
          const point = { x: center.x + dx * seam.radius, y: center.y + dy * seam.radius }, av = alpha(a, point), bv = alpha(b, point); points++; if (av && bv) overlap++; if (av || bv) union++; else if (missingPoints.length < 128) missingPoints.push(point);
        }
        rows.push({ time: frame.time, seam: seam.name, center, radius: seam.radius, passed: Boolean(a && b) && overlap / points >= seam.minOverlapFraction && union / points >= seam.minUnionFraction, overlapFraction: overlap / points, unionFraction: union / points, missingLayer: !a || !b, missingPoints });
      }
    }
  }
  const verify = async () => { await assertSnapshot(assets); if (await fileSha256(source) !== sourceSha256) throw new Error('Seam source changed during sampling.'); }; await verify();
  const findings = rows.filter(r => !r.passed), previews = [];
  for (const r of findings.slice(0, o.maxPreviewPoses)) {
    const radius = r.radius * 2, viewport = { minX: r.center.x - radius, maxX: r.center.x + radius, minY: r.center.y - radius, maxY: r.center.y + radius }, crop = await renderArtwork(service.workspace, loaded.data, loaded.jsonPath, o.animation, [r.time], o.skin, { ...options, viewport, clean: true, width: 256, height: 256 });
    const px = (x: number) => (x - viewport.minX) / (2 * radius) * 256, py = (y: number) => 256 - (y - viewport.minY) / (2 * radius) * 256;
    const markedPath = path.join(path.dirname(crop.path), path.basename(crop.path, '.png') + '-seam.png'), svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><image width="256" height="256" href="data:image/png;base64,${(await readFile(crop.path)).toString('base64')}"/><circle cx="128" cy="128" r="64" fill="none" stroke="#ffdf64" stroke-width="2"/>${r.missingPoints.map(p => `<circle cx="${px(p.x)}" cy="${py(p.y)}" r="2" fill="#ff455f"/>`).join('')}</svg>`; await writeFile(markedPath, new Resvg(svg).render().asPng(), { flag: 'wx' }); previews.push({ time: r.time, seam: r.seam, crop: crop.path, marked: markedPath });
  }
  await verify(); const report = { source, sourceSha256, resourceHashes: assets.files, options: o, samples: times.length, seamSamples: tested, triangleTests: budget.tests, checksPassed: !findings.length, findings, rows, previews, coverageScope: 'Explicit bone-local anchors and world-radius raw alpha samples before clipping/occlusion. Physics independently resets at zero per requested frame. Finite samples do not certify continuous coverage, anatomy or native display.', visualAcceptance: 'pending', originalUnchanged: true };
  return { ...report, rows: rows.slice(0, 500), findings: findings.slice(0, 1000), totalRows: rows.length, totalFindings: findings.length, rowsTruncated: rows.length > 500, findingsTruncated: findings.length > 1000, reportPath: await saveReport(service.workspace, 'animated-seams', report) };
}
