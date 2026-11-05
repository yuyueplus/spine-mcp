import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { Workspace } from '../src/config.js';
import { createDemo } from '../src/demo.js';
import { readDocument, parseDocument, summarize, type SpineDocument } from '../src/document.js';
import { addSlot, addSkin, setSlot, setAttachmentTimeline, setColorTimeline } from '../src/slot-edits.js';
import { attachImage, readPngAsset } from '../src/image-assets.js';
import { sampleArtwork, renderArtwork } from '../src/artwork-preview.js';
import { verifyRoundTrip } from '../src/project-workflow.js';
import { applyEdits, editSchema } from '../src/edits.js';
import { SpineService } from '../src/service.js';

function fixture(): SpineDocument {
  return { skeleton: { spine: '4.3.23', images: './images' }, bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 120 }], slots: [{ name: 'art', bone: 'arm', attachment: 'arm' }], skins: [{ name: 'default', attachments: { art: { arm: { x: 60, width: 120, height: 24 } } } }], animations: {}, customMetadata: { keep: true } };
}
async function setup() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-mcp-art-'))), workspace = new Workspace(root);
  const demo = await createDemo(workspace), data = await readDocument(demo.path);
  return { root, workspace, demo, data, image: path.join(demo.images, 'arm.png') };
}

test('slot creation preserves existing draw indices; setup editing and clearing are immutable', () => {
  const source = fixture(), snapshot = JSON.stringify(source);
  const added = addSlot(source, 'badge', 'arm', { color: 'ff8800', blend: 'normal' });
  assert.deepEqual(added.slots!.map(slot => slot.name), ['art', 'badge']);
  assert.equal(added.slots![1]!.color, 'ff8800ff');
  const cleared = setSlot(added, 'art', { attachment: null, dark: '336699' });
  assert.equal(cleared.slots![0]!.attachment, undefined);
  assert.equal(setSlot(cleared, 'art', { dark: null }).slots![0]!.dark, undefined);
  assert.equal(JSON.stringify(source), snapshot);
  assert.throws(() => addSlot(source, 'art', 'arm'), /already exists/);
  assert.throws(() => setSlot(source, 'art', { bone: 'missing' }), /reference/);
});

test('skin copy preserves membership and produces independent attachment data', () => {
  const source = fixture(); (source.skins as any)[0].bones = ['arm'];
  const copied = addSkin(source, 'night', 'default', 'base');
  assert.deepEqual((copied.skins as any)[1].bones, ['arm']);
  assert.equal((copied.skins as any)[1].attachments.art.arm.name, 'night/arm');
  assert.equal((copied.skins as any)[1].attachments.art.arm.path, 'arm');
  const inspection = summarize(copied).attachments.find(attachment => attachment.skin === 'night')!;
  assert.equal(inspection.name, 'arm'); assert.equal(inspection.attachmentName, 'night/arm');
  (copied.skins as any)[1].attachments.art.arm.x = 99;
  assert.equal((copied.skins as any)[0].attachments.art.arm.x, 60);
  assert.equal((source.skins as any)[0].attachments.art.arm.x, 60);
  assert.throws(() => addSkin(source, 'default'), /already exists/);
  assert.throws(() => addSkin(source, 'night', 'default'), /baseSkin/);
  assert.throws(() => addSkin(source, 'night', 'missing'), /not found/);
  assert.throws(() => addSkin(source, '__proto__'), /reserved/);
});

test('validation rejects dangling skin, setup attachment and slot timeline references', () => {
  const skin = fixture(); (skin.skins as any)[0].attachments.missing = { art: {} };
  assert.throws(() => parseDocument(skin), /missing slot/);
  assert.throws(() => setSlot(fixture(), 'art', { attachment: 'missing' }), /Missing setup attachment/);
  assert.throws(() => setAttachmentTimeline(fixture(), 'blink', 'art', [{ time: 0, name: 'missing' }]), /Missing timeline attachment/);
  const reserved = fixture(); reserved.slots![0]!.name = '__proto__';
  assert.throws(() => parseDocument(reserved), /reserved/);
});

test('PNG attachment reads dimensions and preserves bytes and relative image targets', async () => {
  const { workspace, demo, data, image } = await setup();
  const before = await readFile(image);
  const next = await attachImage(workspace, data, demo.path, 'default', 'arm-slot', 'second', image, { x: 32, color: '88aacc' }, false, true);
  const attachment = (next.skins as any)[0].attachments['arm-slot'].second;
  assert.equal(attachment.path, 'arm'); assert.equal(attachment.width, 120); assert.equal(attachment.height, 24);
  assert.equal(attachment.x, 32); assert.equal(attachment.color, '88aaccff');
  assert.equal(next.slots![0]!.attachment, 'second');
  assert.equal(data.slots![0]!.attachment, 'arm');
  assert.deepEqual(await readFile(image), before);
  await assert.rejects(attachImage(workspace, next, demo.path, 'default', 'arm-slot', 'second', image), /already exists/);
  const replaced = await attachImage(workspace, next, demo.path, 'default', 'arm-slot', 'second', image, { width: 60 }, true);
  assert.equal((replaced.skins as any)[0].attachments['arm-slot'].second.width, 120);
  assert.equal((replaced.skins as any)[0].attachments['arm-slot'].second.scaleX, 0.5);
});

test('image access rejects assets outside images/workspace and malformed PNG data', async () => {
  const { workspace, demo, data, root, image } = await setup();
  const outsideImages = path.join(root, 'outside.png'); await writeFile(outsideImages, await readFile(image));
  await assert.rejects(attachImage(workspace, data, demo.path, 'default', 'arm-slot', 'second', outsideImages), /inside the skeleton images/);
  await assert.rejects(readPngAsset(workspace, '../outside.png'), /outside/);
  const invalid = path.join(demo.images, 'broken.png'); await writeFile(invalid, 'not a PNG');
  await assert.rejects(readPngAsset(workspace, invalid), /Invalid PNG/);
});

test('skin variants reject default placeholder collisions before generating incompatible JSON', async () => {
  const { workspace, demo, data, image } = await setup();
  const next = addSkin(data, 'night');
  await assert.rejects(attachImage(workspace, next, demo.path, 'night', 'arm-slot', 'arm', image), /collides/);
  const promoted = addSkin(data, 'night', 'default', 'base');
  assert.deepEqual((promoted.skins as any[]).map(skin => skin.name), ['base', 'night']);
  const variant = await attachImage(workspace, promoted, demo.path, 'night', 'arm-slot', 'arm', image, { color: '8899aaff' }, true);
  assert.equal((variant.skins as any)[1].attachments['arm-slot'].arm.name, 'night/arm');
  await assert.rejects(sampleArtwork(workspace, variant, demo.path, undefined, [0]), /Select a skin/);
  const sampled = await sampleArtwork(workspace, variant, demo.path, undefined, [0], 'night');
  assert.equal(sampled.frames[0]!.slots[0]!.attachment, 'arm');
  assert.equal(sampled.frames[0]!.slots[0]!.attachmentName, 'night/arm');
});

test('slot timelines preserve other channels and reject ambiguous colors or key times', () => {
  let data = setAttachmentTimeline(fixture(), 'blink', 'art', [{ time: 0, name: 'arm' }, { time: 0.5, name: null }, { time: 1, name: 'arm' }]);
  data = setColorTimeline(data, 'blink', 'art', [{ time: 0, color: 'ffffff' }, { time: 1, color: 'ff000000' }]);
  const channels = (data.animations!.blink!.slots as any).art;
  assert.deepEqual(channels.attachment[1], { time: 0.5 });
  assert.equal(channels.rgba[0].color, 'ffffffff');
  assert.throws(() => setAttachmentTimeline(data, 'blink', 'art', [{ time: 1, name: null }, { time: 1, name: null }]), /increasing/);
  assert.throws(() => setColorTimeline(data, 'blink', 'art', [{ time: 0, color: 'bad' }]), /hex/);
  assert.throws(() => setColorTimeline(data, 'blink', 'art', [{ time: 0, color: 'ffffffff', curve: [0, 1, 1, 0] }, { time: 1, color: 'ffffffff' }]), /16/);
  channels.alpha = [{ time: 0, value: 1 }];
  assert.throws(() => setColorTimeline(data, 'blink', 'art', [{ time: 0, color: 'ffffffff' }]), /overlap/);
});

test('official runtime quantitatively samples PNG corners, skin fallback, swaps and fades', async () => {
  const { workspace, demo, data } = await setup();
  let animated = setAttachmentTimeline(data, 'blink', 'arm-slot', [{ time: 0, name: 'arm' }, { time: 0.6, name: null }, { time: 1, name: 'arm' }]);
  animated = setColorTimeline(animated, 'blink', 'arm-slot', [{ time: 0, color: 'ffffffff' }, { time: 1, color: 'ff000000' }]);
  animated = addSkin(animated, 'empty');
  const { frames } = await sampleArtwork(workspace, animated, demo.path, 'blink', [0, 0.5, 0.75, 1], 'empty');
  const expected = [0, -12, 0, 12, 120, 12, 120, -12];
  assert.ok(frames[0]!.slots[0]!.vertices!.every((value, index) => Math.abs(value - expected[index]!) < 0.00001));
  assert.equal(frames[1]!.slots[0]!.color!.r, 1);
  assert.ok(Math.abs(frames[1]!.slots[0]!.color!.g - 0.5) < 0.00001);
  assert.ok(Math.abs(frames[1]!.slots[0]!.color!.a - 0.5) < 0.00001);
  assert.equal(frames[2]!.slots[0]!.attachment, null);
  assert.equal(frames[3]!.slots[0]!.attachment, 'arm');
});

test('rendered PNG contains image pixels, correct orientation and multiplied tint', async () => {
  const { workspace, demo, data } = await setup();
  const image = path.join(demo.images, 'asymmetric.png');
  await writeFile(image, new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="24"><rect width="120" height="12" fill="#ffffff"/><rect y="12" width="120" height="12" fill="#0000ff"/></svg>').render().asPng());
  const next = await attachImage(workspace, data, demo.path, 'default', 'arm-slot', 'asymmetric', image, { x: 60 }, false, true);
  const tinted = setSlot(next, 'arm-slot', { color: 'ff0000ff' });
  const preview = await renderArtwork(workspace, tinted, demo.path, undefined, [0]);
  const bytes = await readFile(preview.path);
  const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="300"><image width="320" height="300" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`).render();
  const pixels = raster.pixels;
  const pixel = (x: number, y: number) => [...pixels.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)];
  assert.deepEqual(pixel(160, 150), [255, 0, 0, 255]); // White upper image half becomes red.
  assert.deepEqual(pixel(160, 170), [0, 0, 0, 255]); // Blue lower half multiplied by red.
  assert.ok((await stat(preview.path)).size > 100);
});

test('invalid geometry and image path escapes fail while additive artwork is supported', async () => {
  const { workspace, demo, data } = await setup();
  const mesh = structuredClone(data); (mesh.skins as any)[0].attachments['arm-slot'].arm.type = 'mesh';
  assert.throws(() => parseDocument(mesh), /UV/);
  const escaped = structuredClone(data); (escaped.skins as any)[0].attachments['arm-slot'].arm.path = '../../../../escape';
  await assert.rejects(sampleArtwork(workspace, escaped, demo.path, undefined, [0]), /outside/);
  const additive = await sampleArtwork(workspace, setSlot(data, 'arm-slot', { blend: 'additive' }), demo.path, undefined, [0]);
  assert.equal(additive.frames[0]!.slots[0]!.blend, 'additive');
});

test('verification catches slot order, region size/path, tint and attachment timeline corruption', () => {
  let source = addSlot(fixture(), 'second', 'root');
  source = setAttachmentTimeline(source, 'blink', 'art', [{ time: 0, name: 'arm' }, { time: 1, name: null }]);
  source = setColorTimeline(source, 'blink', 'art', [{ time: 0, color: 'ffffffff' }, { time: 1, color: 'ffffff00' }]);
  for (const tamper of [
    (data: SpineDocument) => data.slots!.reverse(),
    (data: SpineDocument) => { (data.skins as any)[0].attachments.art.arm.width = 99; },
    (data: SpineDocument) => { (data.skins as any)[0].attachments.art.arm.path = 'other'; },
    (data: SpineDocument) => { data.slots![0]!.color = '000000ff'; },
    (data: SpineDocument) => { (data.animations!.blink!.slots as any).art.attachment[1].name = 'arm'; },
    (data: SpineDocument) => { (data.animations!.blink!.slots as any).art.rgba[1].color = 'ffffffff'; },
  ]) {
    const actual = structuredClone(source); tamper(actual);
    assert.throws(() => verifyRoundTrip(source, actual, 'source.json', 'source.json'), /verification failed/);
  }
});

test('batch JSON editing is ordered, needs no CLI and never publishes partial failures', async () => {
  const { workspace, demo, data, root, image } = await setup();
  const edits = [
    { type: 'add_slot', name: 'badge', bone: 'arm' },
    { type: 'attach_image', skin: 'default', slot: 'badge', name: 'badge', image, setAsSetup: true, transform: { x: 120, width: 24 } },
  ].map(raw => editSchema.parse(raw));
  const next = await applyEdits(data, edits, { workspace, jsonPath: demo.path });
  assert.equal(next.slots![1]!.attachment, 'badge');
  const service = new SpineService({ targetVersion: '4.3.23', workspaceRoot: root, cliExecutable: null, guiExecutable: null, cliTimeoutMs: 3000 });
  const output = path.join(root, 'nested/batch.json');
  const saved = await service.editFile(demo.path, output, edits);
  const received = await readDocument(saved.path);
  assert.equal(path.resolve(path.dirname(saved.path), String(received.skeleton.images)), demo.images);
  const before = await readFile(demo.path, 'utf8');
  const broken = [...edits, editSchema.parse({ type: 'set_slot', slot: 'badge', setup: { attachment: 'missing' } })];
  const failedOutput = path.join(root, 'failed.json');
  await assert.rejects(service.editFile(demo.path, failedOutput, broken), /Missing setup/);
  await assert.rejects(stat(failedOutput), /ENOENT/);
  assert.equal(await readFile(demo.path, 'utf8'), before);
});
