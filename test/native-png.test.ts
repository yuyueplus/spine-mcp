import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { padPreviewPng } from '../src/native-png.js';
import { encodePng } from '../src/raster.js';

test('constant-size native PNG padding preserves exact decoded pixels and valid PNG chunk CRCs', () => {
  const png = encodePng(2, 2, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 0, 0, 0, 0]));
  const padded = padPreviewPng(png, 4096); assert.equal(padded.length, 4096);
  let offset = 8;
  while (offset < padded.length) { const size = padded.readUInt32BE(offset), end = offset + 12 + size; assert.equal(padded.readUInt32BE(end - 4), crc32(padded.subarray(offset + 4, end - 4))); offset = end; }
  assert.equal(offset, padded.length); assert.equal(padded.toString('ascii', padded.length - 8, padded.length - 4), 'IEND');
  const render = (bytes: Buffer) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><image width="2" height="2" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`).render().pixels;
  assert.deepEqual(render(padded), render(png));
  assert.throws(() => padPreviewPng(png, png.length + 11), /Invalid/); assert.throws(() => padPreviewPng(Buffer.from('bad'), 4096), /complete/);
});
