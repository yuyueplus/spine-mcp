import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SpineService } from '../src/service.js';
import { parseDocument, writeDocument, setTimeline } from '../src/document.js';
import { auditAnimation } from '../src/animation-audit.js';
import { encodePng } from '../src/raster.js';
import { animationSampler } from '../src/animation-sampler.js';
import { sampleSkeleton } from '../src/runtime.js';
import { setConstraint } from '../src/constraint-edits.js';
import { visibilityFrame } from '../src/audit-visibility.js';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-visibility-'))), service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  await writeFile(path.join(root, 'art.png'), encodePng(4, 4, new Uint8Array(64).fill(255)));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: '.' }, bones: [{ name: 'root' }, { name: 'corner', parent: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }, { name: 'cover', bone: 'root', attachment: 'cover' }], skins: [{ name: 'default', attachments: { art: { art: { type: 'mesh', path: 'art', uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 0, 2, 3], hull: 4, vertices: [1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, -1, 1, 1, 1, 0, -1, 1] } }, cover: { cover: { path: 'art', width: 10, height: 10 } } } }], animations: { fold: { bones: { corner: { translate: [{ x: 0 }, { time: 1, x: 2 }] } } } } });
  let next = 0;
  const audit = async (doc = data, meshVisibility: 'centroid' | 'geometry' | 'pixels' = 'centroid', extra = {}) => auditAnimation(service, { input: (await writeDocument(service.workspace, `input-${next++}.json`, doc)).path, options: { animation: 'fold', fps: 2, preview: 'none', meshVisibility, ...extra } });
  return { data, service, audit };
}
test('centroid visibility reports opaque later-layer occlusion without losing geometric fold inventory', async () => {
  const f = await fixture(), geometry = await f.audit(f.data, 'geometry'), visible = await f.audit();
  assert.ok(geometry.findingCounts.mesh_fold); assert.equal(visible.findingCounts.mesh_fold, undefined); assert.ok(visible.hiddenMeshFoldCandidates.occluded); assert.equal(visible.geometryFoldCandidates, geometry.geometryFoldCandidates); assert.equal(visible.allGeometryNoFold, false); assert.ok(visible.filteredFindings.every(f => f.reason === 'occluded')); assert.equal(visible.visualAcceptance, 'pending');
});
test('translucent, additive, hidden and earlier layers never hide a fold in visibility classification', async () => {
  const f = await fixture();
  for (const properties of [{ color: 'ffffff80' }, { blend: 'additive' }, { visible: false }]) { const d = structuredClone(f.data); Object.assign(d.slots![1]!, properties); assert.ok((await f.audit(d)).findingCounts.mesh_fold, JSON.stringify(properties)); }
  const behind = structuredClone(f.data); behind.slots!.reverse(); assert.ok((await f.audit(behind)).findingCounts.mesh_fold);
  const transparent = structuredClone(f.data); (transparent.skins as any)[0].attachments.cover.cover.path = 'clear'; await writeFile(path.join(f.service.workspace.root, 'clear.png'), encodePng(4, 4, new Uint8Array(64))); assert.ok((await f.audit(transparent)).findingCounts.mesh_fold);
});
test('clipping, inverse clipping and clipping end-slot semantics classify the actual posed centroid', async () => {
  const f = await fixture(), d = structuredClone(f.data); d.slots!.pop(); d.slots!.unshift({ name: 'mask', bone: 'root', attachment: 'clip' });
  const attachments = (d.skins as any)[0].attachments; attachments.mask = { clip: { type: 'clipping', vertexCount: 4, vertices: [10, 10, 20, 10, 20, 20, 10, 20], end: 'art', convex: false } }; delete attachments.cover;
  const clipped = await f.audit(d); assert.equal(clipped.findingCounts.mesh_fold, undefined); assert.ok(clipped.hiddenMeshFoldCandidates.clipped);
  const inverse = structuredClone(d); (inverse.skins as any)[0].attachments.mask.clip.inverse = true; assert.ok((await f.audit(inverse)).findingCounts.mesh_fold);
  const ended = structuredClone(d); ended.slots!.splice(1, 0, { name: 'empty', bone: 'root' }); (ended.skins as any)[0].attachments.mask.clip.end = 'empty'; assert.ok((await f.audit(ended)).findingCounts.mesh_fold);
});
function physicsFixture() {
  let data = setConstraint(parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 100 }, { name: 'tip', parent: 'arm', x: 100 }], animations: {} }), { name: 'spring', type: 'physics', bone: 'arm', rotate: 1, strength: 20, damping: 0.8, inertia: 1, gravity: 40, wind: 20 });
  data = setTimeline(data, 'move', 'root', 'translate', [{ time: 0, x: 0, y: 0 }, { time: 0.5, x: 80, y: 60 }, { time: 1, x: 0, y: 0 }]); return data;
}
const world = (skeleton: ReturnType<typeof sampleSkeleton>) => skeleton.bones.map(b => { const p = b.appliedPose; return [p.worldX, p.worldY, p.a, p.b, p.c, p.d]; });
test('incremental physics matches official runtime at aligned samples and resets on backward seek', () => {
  const data = physicsFixture(), sampler = animationSampler(data, 'move', undefined, { physics: true, fps: 60 });
  for (const time of [0, 0.25, 0.5, 0.75, 1, 0.25]) {
    const actual = world(sampler.sample(time)), expected = world(sampleSkeleton(data, 'move', time, undefined, undefined, { physics: true, fps: 60 }));
    actual.forEach((values, i) => values.forEach((v, j) => assert.ok(Math.abs(v - expected[i]![j]!) < 1e-7, `${time}/${i}/${j}: ${v} != ${expected[i]![j]}`)));
  }
  assert.notDeepEqual(world(sampler.sample(0.75)), world(sampleSkeleton(data, 'move', 0.75)));
  assert.throws(() => sampler.sample(101), /6000/); assert.throws(() => animationSampler(data, 'move', undefined, { physics: true, fps: 0 }), /FPS/);
});
test('physics audit includes actual integration history and independent contact anchors', async () => {
  const f = await fixture(), data = physicsFixture(), input = (await writeDocument(f.service.workspace, 'physics.json', data)).path;
  const common = { input, options: { animation: 'move', fps: 60, preview: 'none' as const, maxStep: 1000, stepBones: ['tip'], contacts: [{ bone: 'tip', start: 0.75, end: 1, tolerance: 1000 }, { bone: 'tip', start: 0.25, end: 0.5, tolerance: 1000 }] } };
  const without = await auditAnimation(f.service, common), withPhysics = await auditAnimation(f.service, { ...common, options: { ...common.options, physics: true } });
  assert.equal(withPhysics.physicsEvaluated, true); assert.equal(withPhysics.physicsSampling!.integrationSteps, 60); assert.equal(withPhysics.physicsSampling!.anchorIntegrationSteps, 45); assert.notEqual(withPhysics.metrics.maxStep, without.metrics.maxStep); assert.equal(withPhysics.visualAcceptance, 'pending');
  const reordered = await auditAnimation(f.service, { ...common, options: { ...common.options, physics: true, contacts: common.options.contacts.toReversed() } }); assert.equal(reordered.metrics.maxContactDrift, withPhysics.metrics.maxContactDrift); assert.equal(reordered.metrics.maxStep, withPhysics.metrics.maxStep);
});

test('pixel coverage retains an exposed fold edge even when its centroid is fully occluded', async () => {
  const f = await fixture(), d = structuredClone(f.data); Object.assign((d.skins as any)[0].attachments.cover.cover, { width: 0.3, height: 0.3, x: 1, y: -2 / 3 });
  const centroid = await f.audit(d, 'centroid', { fps: 1 }), pixels = await f.audit(d, 'pixels', { fps: 1, visibilityPixelSize: 0.05 });
  assert.equal(centroid.findingCounts.mesh_fold, undefined); assert.ok(centroid.hiddenMeshFoldCandidates.occluded);
  assert.ok(pixels.findingCounts.mesh_fold); const record = pixels.pixelCoverage!.records[0]!; assert.ok(record.visiblePixels > 0); assert.ok(record.occludedPixels > 0); assert.equal(record.reason, null); assert.ok((await stat(pixels.pixelCoverage!.markedRegions!)).size > 100);
});
test('pixel coverage filters only sampled fully hidden/transparent regions and keeps unresolved subpixel folds', async () => {
  const f = await fixture(), hidden = await f.audit(f.data, 'pixels', { fps: 1, visibilityPixelSize: 0.1 }); assert.equal(hidden.findingCounts.mesh_fold, undefined); assert.ok(hidden.hiddenMeshFoldCandidates.occluded);
  const unoccluded = structuredClone(f.data); unoccluded.slots!.pop(); delete (unoccluded.skins as any)[0].attachments.cover;
  const unresolved = await f.audit(unoccluded, 'pixels', { fps: 1, visibilityPixelSize: 1000 }); assert.ok(unresolved.findingCounts.mesh_fold); assert.equal(unresolved.pixelCoverage!.records[0]!.coveredPixels, 0);
  await writeFile(path.join(f.service.workspace.root, 'art.png'), encodePng(4, 4, new Uint8Array(64)));
  const transparent = await f.audit(unoccluded, 'pixels', { fps: 1, visibilityPixelSize: 0.1 }); assert.equal(transparent.findingCounts.mesh_fold, undefined); assert.ok(transparent.hiddenMeshFoldCandidates.transparent);
});
test('pixel coverage budget exhaustion never becomes a clean diagnostic pass', async () => {
  const f = await fixture(); await assert.rejects(f.audit(f.data, 'pixels', { visibilityPixelSize: 0.01, maxVisibilityPixels: 1 }), /pixel budget exceeded/);
});

test('pixel coverage rejects unsafe world-grid indices before entering the raster loop', async () => {
  const f = await fixture(), data = structuredClone(f.data); data.bones[0]!.x = 2 ** 54; data.bones[0]!.scaleX = 16;
  const skeleton = animationSampler(data, 'fold').sample(1), frame = visibilityFrame(skeleton, async () => ({ width: 1, height: 1, pixels: new Uint8Array([255, 255, 255, 255]) }), { vertices: 0, triangleTests: 0 });
  await assert.rejects(frame.coverage(0, 1, 1, 0, 50000), /safe integer precision/);
});

