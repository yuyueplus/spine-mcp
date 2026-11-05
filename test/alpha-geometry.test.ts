import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VertexAttachment } from '@esotericsoftware/spine-core';
import { alphaHull, meshFromAlpha, polygonFromRegion, traceRegion } from '../src/alpha-geometry.js';
import { Workspace } from '../src/config.js';
import { parseDocument, readDocument, writeDocument, type SpineDocument } from '../src/document.js';
import { attachmentEntries } from '../src/attachment-data.js';
import { encodePng } from '../src/raster.js';
import { sampleArtwork } from '../src/artwork-preview.js';
import { sampleSkeleton } from '../src/runtime.js';
import { applyEdits, editSchema } from '../src/edits.js';
import { SpineService } from '../src/service.js';

function pixels(width: number, height: number, alpha: (x: number, y: number) => number) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([40, 210, 155, alpha(x, y)], (y * width + x) * 4);
  return rgba;
}
function inside(hull: number[], x: number, y: number) {
  for (let index = 0; index < hull.length; index += 2) {
    const next = (index + 2) % hull.length;
    if ((hull[next]! - hull[index]!) * (y - hull[index + 1]!) - (hull[next + 1]! - hull[index + 1]!) * (x - hull[index]!) < -1e-6) return false;
  }
  return true;
}
async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-alpha-'))), workspace = new Workspace(root);
  await mkdir(path.join(root, 'images'));
  const image = path.join(root, 'images/sprite.png'), rgba = pixels(32, 24, (x, y) => Math.abs(x - 16) / 14 + Math.abs(y - 12) / 9 <= 1 && Math.hypot(x - 16, y - 12) > 3 ? 220 : 0);
  await writeFile(image, encodePng(32, 24, rgba));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: './images' }, bones: [{ name: 'root', rotation: 17, shearY: 11, x: 7, y: -3 }, { name: 'art-bone', parent: 'root', x: 12, y: 4, rotation: -13, scaleX: 1.2, scaleY: 0.8 }, { name: 'other', parent: 'root', x: -14, y: 6, rotation: 33, scaleX: -0.75, scaleY: 1.3 }], slots: [{ name: 'mask', bone: 'art-bone' }, { name: 'art', bone: 'art-bone', attachment: 'visual' }, { name: 'bounds', bone: 'other' }], skins: [{ name: 'default', attachments: { art: { visual: { path: 'sprite', width: 32, height: 24, x: 15, y: 4, rotation: 21, scaleX: -1.25, scaleY: 0.7, color: 'aabbccdd' } } } }], animations: {} });
  return { root, workspace, image, data, jsonPath: path.join(root, 'source.json') };
}
function worldVertices(data: SpineDocument, slotName: string, name: string, skin = 'default') {
  const skeleton = sampleSkeleton(data, undefined, 0, skin), slot = skeleton.slots.find(item => item.data.name === slotName)!, attachment = skeleton.data.findSkin(skin)!.getAttachment(slot.data.index, name) as VertexAttachment;
  const vertices = new Array<number>(attachment.worldVerticesLength); attachment.computeWorldVertices(skeleton, slot, 0, vertices.length, vertices, 0, 2); return vertices;
}
function close(a: number[], b: number[]) { assert.equal(a.length, b.length); assert.ok(a.every((value, index) => Math.abs(value - b[index]!) < 0.00002), JSON.stringify({ a, b })); }

test('alpha hull uses thresholded pixel edges and exact bounds instead of image rectangle', () => {
  const result = alphaHull(8, 8, pixels(8, 8, (x, y) => x >= 2 && x < 6 && y >= 1 && y < 5 ? 128 : 0), { padding: 0, alphaThreshold: 128 });
  assert.deepEqual(result.hull, [2, 1, 6, 1, 6, 5, 2, 5]); assert.equal(result.alphaPixels, 16); assert.equal(result.alphaFraction, 0.25);
  assert.deepEqual(result.alphaBounds, { minX: 2, minY: 1, maxX: 6, maxY: 5 }); assert.equal(result.approximated, false);
});
test('one-pixel regions form a polygon, and padding stays inside image bounds', () => {
  const rgba = pixels(3, 3, (x, y) => x === 1 && y === 1 ? 255 : 0);
  assert.deepEqual(alphaHull(3, 3, rgba, { padding: 0 }).hull, [1, 1, 2, 1, 2, 2, 1, 2]);
  assert.deepEqual(alphaHull(3, 3, rgba, { padding: 64 }).hull, [0, 0, 3, 0, 3, 3, 0, 3]);
});
test('convex alpha envelope covers concavities, holes and separated opaque islands', () => {
  const rgba = pixels(12, 12, (x, y) => ((x >= 1 && x <= 4 && y >= 1 && y <= 4 && !(x === 3 && y === 3)) || (x >= 9 && y >= 9)) ? 255 : 0), result = alphaHull(12, 12, rgba, { padding: 0 });
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) if (rgba[(y * 12 + x) * 4 + 3]) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) assert.ok(inside(result.hull, x + dx!, y + dy!));
  assert.ok(inside(result.hull, 3.5, 3.5));
});
test('limited hull remains conservative at several vertex budgets', () => {
  const rgba = pixels(80, 64, (x, y) => ((x - 40) / 33) ** 2 + ((y - 32) / 25) ** 2 < 1 ? 255 : 0);
  for (const limit of [4, 5, 7, 8, 12, 16, 64]) {
    const result = alphaHull(80, 64, rgba, { padding: 0, maxVertices: limit }); assert.ok(result.hull.length / 2 <= limit);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 80; x++) if (rgba[(y * 80 + x) * 4 + 3]) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) assert.ok(inside(result.hull, x + dx!, y + dy!), `budget ${limit}, pixel ${x}/${y}`);
  }
});
test('alpha analysis rejects empty rasters, invalid thresholds and size/vertex limits', () => {
  assert.throws(() => alphaHull(2, 2, new Uint8Array(16)), /No PNG pixels/);
  for (const options of [{ alphaThreshold: 0 }, { alphaThreshold: 256 }, { padding: -1 }, { maxVertices: 3 }]) assert.throws(() => alphaHull(2, 2, pixels(2, 2, () => 255), options), /alphaThreshold/);
  assert.throws(() => alphaHull(8192, 8192, new Uint8Array()), /size limits/);
});
test('PNG tracing matches actual artwork UV coordinates through rotation, shear and reflection', async () => {
  const { workspace, data, jsonPath } = await setup(), result = await traceRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { padding: 0 });
  const sampled = await sampleArtwork(workspace, data, jsonPath, undefined, [0]), corners = sampled.frames[0]!.slots.find(item => item.slot === 'art')!.vertices!;
  for (let index = 0; index < result.uvs.length; index += 2) {
    const u = result.uvs[index]!, v = result.uvs[index + 1]!;
    for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(result.worldVertices[index + axis]! - ((1 - v) * (corners[2 + axis]! + u * (corners[4 + axis]! - corners[2 + axis]!)) + v * (corners[axis]! + u * (corners[6 + axis]! - corners[axis]!)))) < 0.00002);
  }
  assert.equal(result.width, 32); assert.equal(result.height, 24); assert.equal(result.shape, 'convex'); assert.ok(result.alphaPixels > 0);
});
test('alpha mesh keeps path, tint and world boundary, with hull-first triangles and a center', async () => {
  const { workspace, data, jsonPath, image } = await setup(), snapshot = structuredClone(data), bytes = await readFile(image), options = { padding: 0 };
  const trace = await traceRegion(workspace, data, jsonPath, 'default', 'art', 'visual', options), result = await meshFromAlpha(workspace, data, jsonPath, 'default', 'art', 'visual', options), mesh = attachmentEntries(result)[0]!.value;
  assert.equal(mesh.path, 'sprite'); assert.equal(mesh.color, 'aabbccdd'); assert.equal(mesh.hull, trace.vertexCount); assert.equal((mesh.uvs as number[]).length, (trace.vertexCount + 1) * 2); assert.equal((mesh.triangles as number[]).length, trace.vertexCount * 3);
  close(worldVertices(result, 'art', 'visual').slice(0, trace.worldVertices.length), trace.worldVertices);
  assert.equal(mesh.rotation, undefined); assert.deepEqual(data, snapshot); assert.deepEqual(await readFile(image), bytes);
});
test('bounding box on another reflected bone preserves the source setup-world boundary', async () => {
  const { workspace, data, jsonPath } = await setup(), trace = await traceRegion(workspace, data, jsonPath, 'default', 'art', 'visual');
  const result = await polygonFromRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { kind: 'boundingbox', targetSlot: 'bounds', targetName: 'hit' });
  close(worldVertices(result, 'bounds', 'hit'), trace.worldVertices); assert.equal(result.slots![2]!.attachment, 'hit'); assert.equal(data.slots![2]!.attachment, undefined);
});
test('clipping generation sets convex geometry and verifies active setup draw order', async () => {
  const { workspace, data, jsonPath } = await setup(), result = await polygonFromRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { kind: 'clipping', targetSlot: 'mask', targetName: 'clip', endSlot: 'art' });
  const clip = attachmentEntries(result).find(item => item.name === 'clip')!.value; assert.equal(clip.convex, true); assert.equal(clip.end, 'art');
  await assert.rejects(polygonFromRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { kind: 'clipping', targetSlot: 'bounds', targetName: 'bad' }), /draw order/);
  await assert.rejects(polygonFromRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { kind: 'clipping', targetSlot: 'mask', targetName: 'bad', endSlot: 'mask' }), /draw order/);
});
test('named skins keep image paths and generate independent internal attachment names', async () => {
  const { workspace, data, jsonPath } = await setup(); const skin = (data.skins as any[])[0]; skin.name = 'variant'; skin.attachments.art.visual.name = 'variant/visual';
  const result = await polygonFromRegion(workspace, data, jsonPath, 'variant', 'art', 'visual', { kind: 'boundingbox', targetSlot: 'bounds', targetName: 'hit' });
  assert.equal(attachmentEntries(result).find(item => item.name === 'hit')!.value.name, 'variant/hit');
  const mesh = await meshFromAlpha(workspace, result, jsonPath, 'variant', 'art', 'visual'); assert.equal(attachmentEntries(mesh)[0]!.value.path, 'sprite');
});
test('alpha asset access rejects relative escapes and junctions leaving the image directory', async () => {
  const { workspace, data, jsonPath, root, image } = await setup(); await mkdir(path.join(root, 'other')); await writeFile(path.join(root, 'other/sprite.png'), await readFile(image));
  (data.skins as any)[0].attachments.art.visual.path = '../other/sprite';
  await assert.rejects(traceRegion(workspace, data, jsonPath, 'default', 'art', 'visual'), /inside skeleton.images/);
  await symlink(path.join(root, 'other'), path.join(root, 'images/link'), process.platform === 'win32' ? 'junction' : 'dir');
  (data.skins as any)[0].attachments.art.visual.path = 'link/sprite';
  await assert.rejects(traceRegion(workspace, data, jsonPath, 'default', 'art', 'visual'), /link points outside/);
});
test('alpha tracing rejects sequences, missing regions and collapsed display transforms', async () => {
  const { workspace, data, jsonPath } = await setup();
  await assert.rejects(traceRegion(workspace, data, jsonPath, 'default', 'art', 'missing'), /static region/);
  const animated = structuredClone(data); (animated.skins as any)[0].attachments.art.visual.sequence = { count: 1 };
  await assert.rejects(traceRegion(workspace, animated, jsonPath, 'default', 'art', 'visual'), /static region/);
  (data.skins as any)[0].attachments.art.visual.scaleX = 0;
  await assert.rejects(traceRegion(workspace, data, jsonPath, 'default', 'art', 'visual'), /zero display area/);
});
test('polygon generation guards occupied source slots, missing targets and singular transforms', async () => {
  const { workspace, data, jsonPath } = await setup();
  await assert.rejects(polygonFromRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { kind: 'boundingbox', targetSlot: 'art', targetName: 'hit' }), /separate targetSlot/);
  assert.ok(await polygonFromRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { kind: 'boundingbox', targetSlot: 'art', targetName: 'hit', setAsSetup: false }));
  await assert.rejects(polygonFromRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { kind: 'boundingbox', targetSlot: 'missing', targetName: 'hit' }), /target slot/);
  data.bones[2]!.scaleX = 0;
  await assert.rejects(polygonFromRegion(workspace, data, jsonPath, 'default', 'art', 'visual', { kind: 'boundingbox', targetSlot: 'bounds', targetName: 'hit' }), /singular/);
});
test('ordered alpha edits combine polygon, mesh and automatic weights without a CLI', async () => {
  const { workspace, data, jsonPath } = await setup();
  const edits = [
    { type: 'polygon_from_region', skin: 'default', slot: 'art', name: 'visual', targetSlot: 'bounds', targetName: 'hit', kind: 'boundingbox' },
    { type: 'mesh_from_alpha', skin: 'default', slot: 'art', name: 'visual', maxVertices: 8 },
    { type: 'auto_weights', skin: 'default', slot: 'art', name: 'visual', bones: ['art-bone', 'other'], influences: 2 },
  ].map(raw => editSchema.parse(raw));
  const result = await applyEdits(data, edits, { workspace, jsonPath }); assert.equal(attachmentEntries(result).length, 2); assert.ok(worldVertices(result, 'art', 'visual').every(Number.isFinite));
});
test('a failed alpha edit publishes no partial file and preserves source JSON and PNG bytes', async () => {
  const { workspace, data, jsonPath, image, root } = await setup(); await writeDocument(workspace, jsonPath, data);
  const before = await readFile(jsonPath), png = await readFile(image), output = path.join(root, 'failed.json');
  const service = new SpineService({ workspaceRoot: root, targetVersion: '4.3.23', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 1000 });
  await assert.rejects(service.editFile(jsonPath, output, [
    editSchema.parse({ type: 'polygon_from_region', skin: 'default', slot: 'art', name: 'visual', targetSlot: 'bounds', targetName: 'hit', kind: 'boundingbox' }),
    editSchema.parse({ type: 'mesh_from_alpha', skin: 'default', slot: 'art', name: 'visual', alphaThreshold: 255 }),
  ]), /No PNG pixels/);
  await assert.rejects(stat(output), /ENOENT/); assert.deepEqual(await readFile(jsonPath), before); assert.deepEqual(await readFile(image), png); assert.equal((await readDocument(jsonPath)).skeleton.spine, '4.3.23');
});
