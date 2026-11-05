import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, mkdir, writeFile, readFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
import { compositeOpaque, compositeRgba, encodePng, unpremultiplyRgba } from '../src/raster.js';
import { Workspace } from '../src/config.js';
import { parseDocument, writeDocument } from '../src/document.js';
import { exportFrames } from '../src/frames.js';
import { jobSchema, mediaOptionsSchema } from '../src/job-schema.js';

test('transparent CPU compositing preserves straight color and matches opaque blend results', () => {
  for (const blend of ['normal', 'additive', 'multiply', 'screen']) {
    const opaque = new Uint8Array([50, 100, 150, 255]), rgba = opaque.slice(), source = new Uint8Array([100, 50, 25, 128]);
    compositeOpaque(opaque, source, blend); compositeRgba(rgba, source, blend); assert.deepEqual(rgba, opaque);
    const transparent = new Uint8Array(4); compositeRgba(transparent, source, blend); assert.deepEqual([...transparent], [199, 100, 50, 128]);
  }
  assert.deepEqual([...unpremultiplyRgba(new Uint8Array([100, 50, 25, 128, 20, 0, 0, 0]))], [199, 100, 50, 128, 0, 0, 0, 0]);
});

test('clean custom-size frames omit preview chrome and preserve semitransparent PNG colors', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-clean-media-'))), workspace = new Workspace(root); await mkdir(path.join(root, 'images'));
  const pixels = new Uint8Array(8 * 8 * 4); for (let i = 0; i < pixels.length; i += 4) pixels.set([200, 100, 50, 128], i); await writeFile(path.join(root, 'images/art.png'), encodePng(8, 8, pixels));
  const data = parseDocument({ skeleton: { spine: '4.3.23', images: './images/' }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'art' }], skins: [{ name: 'default', attachments: { art: { art: { width: 10, height: 10 } } } }] }), saved = await writeDocument(workspace, 'source.json', data);
  const frames = await exportFrames(workspace, data, saved.path, { start: 0, end: 0.2, fps: 5, kind: 'artwork', clean: true, transparent: true, width: 96, height: 64 }); assert.equal(frames.width, 96); assert.equal(frames.height, 64);
  const bytes = await readFile(frames.files[0]!), raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><image width="96" height="64" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`).render(), straight = unpremultiplyRgba(raster.pixels);
  assert.equal(straight[3], 0); assert.equal(straight[(10 * 96 + 10) * 4 + 3], 0);
  const inside = [...straight.slice((30 * 96 + 40) * 4, (30 * 96 + 40) * 4 + 4)]; [200, 100, 50, 128].forEach((value, index) => assert.ok(Math.abs(inside[index]! - value) <= 3, JSON.stringify(inside)));
});

test('documented background-media example parses through the actual job schema', async () => {
  const example = JSON.parse(await readFile(new URL('../../examples/background-media.json', import.meta.url), 'utf8'));
  assert.equal(jobSchema.parse(example.arguments).operation, 'export_media');
  const options = mediaOptionsSchema.parse({ end: 1 }); assert.equal(options.transparent, true); assert.equal(options.width, 320);
});
