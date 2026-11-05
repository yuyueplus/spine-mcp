import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/config.js';
import { nativeSequenceDocument } from '../src/native-sequence.js';
import { nativePreviewOptions } from '../src/native-preview.js';
import { parseDocument } from '../src/document.js';
import { sampleArtwork } from '../src/scene-preview.js';
import { encodePng } from '../src/raster.js';
test('long native sequences decode only the PNGs active at requested times', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'spine-long-assets-'))), workspace = new Workspace(root); await mkdir(path.join(root, 'images'));
  const png = encodePng(16, 16, new Uint8Array(16 * 16 * 4).fill(255));
  for (let i = 0; i < 150; i++) await writeFile(path.join(root, 'images', `frame-${String(i).padStart(4, '0')}.png`), png);
  const data = parseDocument(nativeSequenceDocument(nativePreviewOptions.parse({ width: 128, height: 128 }), { start: 0, end: 5, nativeFps: 30, frameCount: 150, maxFrames: 600, chunkFrames: 30 }));
  const sampled = await sampleArtwork(workspace, data, path.join(root, 'input.json'), 'MCP-playback', [0, 4.9]); assert.equal(sampled.assets.size, 2); assert.equal(new Set(sampled.frames.map(f => f.slots[0]!.image)).size, 2);
});
