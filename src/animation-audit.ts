import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { MeshAttachment } from '@esotericsoftware/spine-core';
import { Resvg } from '@resvg/resvg-js';
import type { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { auditSchema } from './stability-schema.js';
import { auditSampleTimes } from './audit-schema.js';
import { animationSampler } from './animation-sampler.js';
import { visibilityFrame, type VisibilityBudget, type PixelCoverage } from './audit-visibility.js';
import { imagesRoot, readPngAsset } from './image-assets.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { renderPreview } from './preview.js';
import { renderArtwork } from './scene-preview.js';
import type { WorkControl } from './progress.js';
import { checkpoint } from './progress.js';

type Point = [number, number];
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const intersects = (a: Point, b: Point, c: Point, d: Point) => cross(a, b, c) * cross(a, b, d) < -1e-10 && cross(c, d, a) * cross(c, d, b) < -1e-10;
export async function auditAnimation(service: SpineService, raw: z.input<typeof auditSchema>, control?: WorkControl) {
  const args = auditSchema.parse(raw), o = args.options, input = await service.workspace.resolve(args.input), sourceSha256 = await fileSha256(input), loaded = await service.load(input, args.skeletonName), data = loaded.data;
  const assets = await auditAssets(service.workspace, data, loaded.jsonPath, false); if (!assets.valid) throw new Error('Animation audit requires complete referenced resources. Run spine_audit_assets to locate missing files.');
  const sampler = animationSampler(data, o.animation, o.skin, { physics: o.physics, fps: o.physicsFps }), rest = animationSampler(data, undefined, o.skin).sample(0), end = o.end ?? sampler.duration;
  if (end < o.start || end > sampler.duration + 1e-6) throw new Error('Audit range must be inside the animation duration.');
  const sampleCount = Math.ceil((end - o.start) * o.fps) + 1;
  if (sampleCount * data.bones.length > 500000) throw new Error('Audit exceeds 500,000 bone samples. Choose a shorter range or lower FPS.');
  const named = new Map(sampler.skeleton.bones.map(b => [b.data.name, b]));
  const required = new Set([...o.contacts.map(r => r.bone), ...o.joints.map(r => r.bone), ...o.separation.flatMap(r => [r.left, r.right]), ...o.limbPairs.flatMap(r => [...r.a, ...r.b]), ...o.stepBones]);
  for (const name of required) if (!named.has(name)) throw new Error(`Audit bone not found: ${name}`);
  for (const r of o.contacts) if (r.end < r.start || r.end > sampler.duration + 1e-6 || r.start > end || r.end < o.start) throw new Error('Contact range is reversed, outside the animation or does not overlap the audit range.');
  for (const r of o.joints) if (r.max < r.min) throw new Error('Joint angle limits are reversed.');
  const pairCost = o.limbPairs.reduce((sum, r) => sum + (r.a.length - 1) * (r.b.length - 1), 0);
  if (sampleCount * pairCost > 2_000_000) throw new Error('Limb intersection budget exceeded.');
  const point = (name: string): Point => { const p = named.get(name)!.appliedPose; return [p.worldX, p.worldY]; };
  if (o.physics && (Math.ceil(end * o.physicsFps) > 6000 || (2 * Math.ceil(end * o.physicsFps) + sampleCount + 4 * o.contacts.length) * data.bones.length > 500000)) throw new Error('Physics audit exceeds 6000 steps from zero or 500,000 combined bone integration steps. Shorten the range or reduce physicsFps.');
  // A separate monotone sampler keeps anchor look-ahead from changing the
  // physics history of the actual audit. Explicit boundaries are integrated.
  const anchorSampler = animationSampler(data, o.animation, o.skin, { physics: o.physics, fps: o.physicsFps }), anchors: Point[] = [];
  for (const { rule: r, index } of o.contacts.map((rule, index) => ({ rule, index })).sort((a, b) => a.rule.start - b.rule.start)) { const p = anchorSampler.sample(r.start).findBone(r.bone)!.appliedPose; anchors[index] = [r.x ?? p.worldX, r.y ?? p.worldY]; }
  const masks = new Map<string, { width: number; height: number; pixels: Uint8Array }>(), baseline = new WeakMap<MeshAttachment, { vertices: number[]; determinant: number }>();
  const root = await imagesRoot(service.workspace, data, loaded.jsonPath);
  let decodedPixels = 0, geometryVisits = 0;
  const mask = async (image: string) => {
    if (masks.has(image)) return masks.get(image)!;
    const a = await readPngAsset(service.workspace, path.resolve(root, image + '.png'));
    decodedPixels += a.width * a.height; if (decodedPixels > 64_000_000 || masks.size >= 128) throw new Error('Audit alpha masks exceed the image budget.');
    const pixels = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${a.width}" height="${a.height}"><image width="${a.width}" height="${a.height}" href="data:image/png;base64,${a.bytes.toString('base64')}"/></svg>`, { font: { loadSystemFonts: false } }).render().pixels;
    const value = { width: a.width, height: a.height, pixels }; masks.set(image, value); return value;
  };
  const findings: { code: string; time: number; subject: string; value?: number; limit?: number; detail?: string; triangleIndex?: number }[] = [], counts: Record<string, number> = {}, worst = new Map<string, typeof findings[number]>();
  const score = (f: typeof findings[number]) => f.value === undefined ? 1 : Math.abs(f.value - (f.limit ?? 0));
  const add = (code: string, time: number, subject: string, value?: number, limit?: number, detail?: string, triangleIndex?: number) => { counts[code] = (counts[code] ?? 0) + 1; const f = { code, time, subject, value, limit, detail, ...(triangleIndex === undefined ? {} : { triangleIndex }) }; if (!worst.has(code) || score(f) > score(worst.get(code)!)) worst.set(code, f); if (findings.length < o.maxFindings) findings.push(f); };
  let maxContactDrift = 0, maxJointExcess = 0, maxStep = 0, maxFlippedArea = 0, geometryFoldCandidates = 0, previous: Map<string, Point> | undefined;
  const coverageFindings: (PixelCoverage & { time: number; subject: string; triangleIndex: number })[] = [];
  const visibilityBudget: VisibilityBudget = { vertices: 0, triangleTests: 0 }, hiddenMeshFoldCandidates = { clipped: 0, occluded: 0, transparent: 0 }, filteredFindings: { time: number; subject: string; triangle: number; reason: 'clipped' | 'occluded' | 'transparent' }[] = [];
  // Exact contact boundaries matter even when they fall between uniform samples.
  const times = auditSampleTimes(o.start, end, o.fps, o.contacts);
  if (times.length * data.bones.length > 500000 || times.length * pairCost > 2_000_000) throw new Error('Audit including contact boundaries exceeds the sampling budget.');
  for (const [index, time] of times.entries()) {
    if (index % 30 === 0) await checkpoint(control, { phase: 'animation-audit', completed: index, total: times.length });
    const skeleton = sampler.sample(time);
    let visibility: ReturnType<typeof visibilityFrame> | undefined;
    for (const b of skeleton.bones) { const p = b.appliedPose; if (b.active && ![p.worldX, p.worldY, p.a, p.b, p.c, p.d].every(Number.isFinite)) add('nonfinite_transform', time, b.data.name); }
    o.contacts.forEach((r, i) => { if (time < r.start || time > r.end) return; const p = point(r.bone), drift = Math.hypot(p[0] - anchors[i]![0], p[1] - anchors[i]![1]); maxContactDrift = Math.max(maxContactDrift, drift); if (drift > r.tolerance) add('foot_slide', time, r.bone, drift, r.tolerance); });
    for (const r of o.joints) { const b = named.get(r.bone)!, angle = b.appliedPose.rotation - b.data.setupPose.rotation, excess = Math.max(r.min - angle, angle - r.max, 0); maxJointExcess = Math.max(maxJointExcess, excess); if (excess > 1e-6) add('joint_limit', time, r.bone, angle, angle < r.min ? r.min : r.max, 'Local rotation offset from setup pose, degrees.'); }
    for (const r of o.separation) { const a = point(r.left), b = point(r.right), distance = r.axis === 'x' ? b[0] - a[0] : r.axis === 'y' ? b[1] - a[1] : Math.hypot(a[0] - b[0], a[1] - b[1]); if (distance < r.minDistance) add('limb_separation', time, `${r.left}/${r.right}`, distance, r.minDistance); }
    for (const r of o.limbPairs) for (let a = 1; a < r.a.length; a++) for (let b = 1; b < r.b.length; b++) if (intersects(point(r.a[a - 1]!), point(r.a[a]!), point(r.b[b - 1]!), point(r.b[b]!))) add('limb_crossing', time, `${r.a[a - 1]}/${r.a[a]} × ${r.b[b - 1]}/${r.b[b]}`);
    if (o.maxStep !== undefined) {
      const current = new Map((o.stepBones.length ? o.stepBones : [...required]).map(name => [name, point(name)]));
      for (const [name, p] of current) { const q = previous?.get(name); if (q) { const step = Math.hypot(p[0] - q[0], p[1] - q[1]); maxStep = Math.max(maxStep, step); if (step > o.maxStep) add('pose_step', time, name, step, o.maxStep, `Distance from previous sample; audit FPS ${o.fps}.`); } }
      previous = current;
    }
    if (o.meshes) for (const slot of skeleton.slots) {
      const m = slot.appliedPose.attachment; if (!(m instanceof MeshAttachment) || !slot.bone.active || !slot.data.visible) continue;
      const opacity = slot.appliedPose.color.a * m.color.a * skeleton.color.a;
      if (o.alphaThreshold && opacity * 255 < o.alphaThreshold) continue;
      geometryVisits += m.worldVerticesLength / 2; if (geometryVisits > 8_000_000) throw new Error('Audit exceeds eight million mesh vertex samples.');
      if (!baseline.has(m)) { const s = rest.slots[slot.data.index]!, v = new Array<number>(m.worldVerticesLength); m.computeWorldVertices(rest, s, 0, v.length, v, 0, 2); const p = s.bone.appliedPose; baseline.set(m, { vertices: v, determinant: p.a * p.d - p.b * p.c }); }
      const base = baseline.get(m)!, v = new Array<number>(m.worldVerticesLength); m.computeWorldVertices(skeleton, slot, 0, v.length, v, 0, 2);
      if (!v.every(Number.isFinite)) { add('nonfinite_mesh', time, slot.data.name); continue; }
      const p = slot.bone.appliedPose, reflection = (p.a * p.d - p.b * p.c) * base.determinant < 0 ? -1 : 1;
      const tex = o.alphaThreshold ? await mask(m.sequence.getPath(m.path ?? m.name, m.sequence.resolveIndex(slot.appliedPose))) : undefined;
      const area = (vertices: number[], a: number, b: number, c: number) => cross([vertices[a * 2]!, vertices[a * 2 + 1]!], [vertices[b * 2]!, vertices[b * 2 + 1]!], [vertices[c * 2]!, vertices[c * 2 + 1]!]);
      for (let j = 0; j < m.triangles.length; j += 3) {
        const a = m.triangles[j]!, b = m.triangles[j + 1]!, c = m.triangles[j + 2]!, current = area(v, a, b, c), setup = area(base.vertices, a, b, c);
        if (current * setup * reflection >= 0 || Math.abs(current) / 2 <= o.minFlippedArea) continue;
        if (tex && o.meshVisibility !== 'pixels') { const uv = m.regionUVs, x = Math.max(0, Math.min(tex.width - 1, Math.floor((uv[a * 2]! + uv[b * 2]! + uv[c * 2]!) * tex.width / 3))), y = Math.max(0, Math.min(tex.height - 1, Math.floor((uv[a * 2 + 1]! + uv[b * 2 + 1]! + uv[c * 2 + 1]!) * tex.height / 3))); if (tex.pixels[(y * tex.width + x) * 4 + 3]! * opacity < o.alphaThreshold) continue; }
        geometryFoldCandidates++;
        if (o.meshVisibility === 'pixels') {
          visibility ??= visibilityFrame(skeleton, mask, visibilityBudget);
          const coverage = await visibility.coverage(slot.data.index, j / 3, o.visibilityPixelSize, o.alphaThreshold, o.maxVisibilityPixels);
          if (coverageFindings.length < o.maxFindings) coverageFindings.push({ ...coverage, time, subject: slot.data.name, triangleIndex: j / 3 });
          if (coverage.reason) { hiddenMeshFoldCandidates[coverage.reason]++; if (filteredFindings.length < o.maxFindings) filteredFindings.push({ time, subject: slot.data.name, triangle: j / 3, reason: coverage.reason }); continue; }
        }
        if (o.meshVisibility === 'centroid') {
          visibility ??= visibilityFrame(skeleton, mask, visibilityBudget);
          const centroid: Point = [(v[a * 2]! + v[b * 2]! + v[c * 2]!) / 3, (v[a * 2 + 1]! + v[b * 2 + 1]! + v[c * 2 + 1]!) / 3], reason = await visibility.hiddenReason(slot.data.index, centroid);
          if (reason) { hiddenMeshFoldCandidates[reason]++; if (filteredFindings.length < o.maxFindings) filteredFindings.push({ time, subject: slot.data.name, triangle: j / 3, reason }); continue; }
        }
        maxFlippedArea = Math.max(maxFlippedArea, Math.abs(current) / 2); add('mesh_fold', time, slot.data.name, Math.abs(current) / 2, o.minFlippedArea, `Triangle ${j / 3}; alpha evaluated at UV centroid; visibility mode ${o.meshVisibility}.`, j / 3);
      }
    }
  }
  await assertSnapshot(assets); if (await fileSha256(input) !== sourceSha256) throw new Error('Audit input changed during sampling.');
  const directory = await service.workspace.resolve(path.join('reports', `animation-audit-${randomUUID()}`), false); await mkdir(directory, { recursive: true });
  const previewTimes = [...new Set([...worst.values(), ...findings].map(f => f.time))].slice(0, o.maxPreviewPoses);
  const previewOptions = { physics: o.physics, fps: o.physicsFps };
  const preview = o.preview !== 'none' && previewTimes.length ? o.preview === 'artwork' ? await renderArtwork(service.workspace, data, loaded.jsonPath, o.animation, previewTimes, o.skin, previewOptions) : await renderPreview(service.workspace, data, o.animation, previewTimes, o.skin, previewOptions) : undefined;
  await assertSnapshot(assets); if (await fileSha256(input) !== sourceSha256) throw new Error('Audit input changed before report publication.');
  let markedRegionsPath: string | null = null;
  if (coverageFindings.length) {
    const regions = coverageFindings.slice(0, o.maxPreviewPoses), panels = regions.map((r, index) => {
      const xs = [r.triangle[0]!, r.triangle[2]!, r.triangle[4]!], ys = [r.triangle[1]!, r.triangle[3]!, r.triangle[5]!], minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), zoom = Math.min(240 / Math.max(maxX - minX, o.visibilityPixelSize), 170 / Math.max(maxY - minY, o.visibilityPixelSize)), px = (x: number) => index * 320 + 160 + (x - (minX + maxX) / 2) * zoom, py = (y: number) => 135 - (y - (minY + maxY) / 2) * zoom;
      const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      return `<g><rect x="${index * 320}" width="320" height="300" fill="#172432"/><text x="${index * 320 + 12}" y="24" fill="#eef5fc" font-size="13">${escape(r.subject)} triangle ${r.triangleIndex} @ ${r.time.toFixed(3)}s</text><polygon points="${[0, 2, 4].map(i => `${px(r.triangle[i]!)},${py(r.triangle[i + 1]!)}`).join(' ')}" fill="#e85b5930" stroke="#f38b80"/>${r.visiblePoints.map(p => `<circle cx="${px(p[0])}" cy="${py(p[1])}" r="2" fill="#ffdf64"/>`).join('')}<text x="${index * 320 + 12}" y="258" fill="#eef5fc" font-size="12">visible ${r.visiblePixels} / alpha ${r.alphaPixels}, clip ${r.clippedPixels}, occluded ${r.occludedPixels}</text><text x="${index * 320 + 12}" y="282" fill="#a8c0da" font-size="11">world pixel size ${r.pixelSize}; yellow = visible samples</text></g>`;
    });
    markedRegionsPath = path.join(directory, 'marked-regions.png'); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${320 * regions.length}" height="300" font-family="Arial">${panels.join('')}</svg>`;
    await writeFile(markedRegionsPath, new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng(), { flag: 'wx' });
  }
  const report = { input, sourceSha256, animation: o.animation, skin: o.skin ?? 'default', start: o.start, end, fps: o.fps, samples: times.length, checksPassed: Object.keys(counts).length === 0, visualAcceptance: 'pending', physicsEvaluated: o.physics, physicsSampling: o.physics ? { fps: o.physicsFps, integrationSteps: sampler.integrationSteps, anchorIntegrationSteps: anchorSampler.integrationSteps, history: 'Reset at zero, monotonically advanced on the physics FPS grid plus exact requested sample/contact boundaries. Previews independently reset; non-grid sampling schedules may produce different integration results. This is not a repeated-loop convergence test.' } : null, meshVisibility: o.meshVisibility, pixelCoverage: o.meshVisibility === 'pixels' ? { pixelSize: o.visibilityPixelSize, visitedGridCells: visibilityBudget.pixels ?? 0, records: coverageFindings, truncated: geometryFoldCandidates > coverageFindings.length, markedRegions: markedRegionsPath, note: 'World-aligned pixel-center samples; finite resolution, not a GPU/continuous coverage proof. Triangles without sampled centers remain unresolved findings.' } : null, geometryFoldCandidates, hiddenMeshFoldCandidates, filteredFindings, filteredFindingsTruncated: hiddenMeshFoldCandidates.clipped + hiddenMeshFoldCandidates.occluded + hiddenMeshFoldCandidates.transparent > filteredFindings.length, allGeometryNoFold: geometryFoldCandidates === 0, metrics: { maxContactDrift, maxJointExcess, maxStep, maxFlippedArea }, findingCounts: counts, findings, findingsTruncated: Object.values(counts).reduce((a, b) => a + b, 0) > findings.length, preview: preview ? { path: preview.path, times: previewTimes, kind: o.preview } : null,
    evaluated: { contacts: o.contacts.length, joints: o.joints.length, separationRules: o.separation.length, limbPairs: o.limbPairs.length, meshes: o.meshes }, note: 'Sampled diagnostics with explicit character-specific rules. No finding is not proof of natural anatomy or native visual acceptance. Alpha is sampled at UV triangle centroids. Default geometry mode retains all candidates. Optional centroid visibility classifies clipping and fully opaque later normal-blend layers at the deformed centroid only; it does not prove the full triangle is hidden and never removes the geometry candidate inventory. Optional pixels mode tests every covered grid-cell center at explicit world resolution, including per-pixel alpha. No sample at subpixel geometry remains a finding; marked region diagrams retain visible sample locations. No self-occlusion evaluation. Sub-frame events may require denser sampling.' };
  const reportPath = path.join(directory, 'audit.json'); await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); return { ...report, reportPath };
}
