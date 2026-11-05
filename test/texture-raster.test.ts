import test from 'node:test';
import assert from 'node:assert/strict';
import { rasterizeTexture, type RasterTexture } from '../src/texture-raster.js';

const vertices = [0, 0, 4, 0, 4, 4, 0, 4], uvs = [0, 0, 1, 0, 1, 1, 0, 1], triangles = [0, 1, 2, 0, 2, 3];
const texture = (rgba: number[]): RasterTexture => ({ width: 1, height: 1, pixels: Uint8Array.from(rgba) });

test('opaque adjacent mesh triangles cover their shared diagonal without seams in either winding', () => {
  for (const indices of [triangles, [2, 1, 0, 3, 2, 0]]) {
    const p = rasterizeTexture(4, 4, vertices, uvs, indices, texture([200, 100, 50, 255]), { samples: 0 });
    for (let i = 0; i < p.length; i += 4) assert.deepEqual([...p.subarray(i, i + 4)], [200, 100, 50, 255]);
  }
});

test('shared edges preserve translucent coverage without dark or double-blended diagonal pixels', () => {
  const p = rasterizeTexture(4, 4, vertices, uvs, triangles, texture([100, 50, 25, 128]), { samples: 0 });
  for (let i = 0; i < p.length; i += 4) assert.deepEqual([...p.subarray(i, i + 4)], [100, 50, 25, 128]);
});

test('genuinely overlapping triangles retain normal premultiplied blending', () => {
  const p = rasterizeTexture(4, 4, vertices, uvs, [...triangles, ...triangles], texture([100, 50, 25, 128]), { samples: 0 });
  assert.deepEqual([...p.subarray(20, 24)], [150, 75, 37, 192]);
});

test('texture UV orientation and bilinear minification preserve premultiplied color', () => {
  const t = { width: 2, height: 2, pixels: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) };
  const p = rasterizeTexture(4, 4, vertices, uvs, triangles, t, { samples: 0 });
  assert.deepEqual([...p.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...p.subarray(12, 16)], [0, 255, 0, 255]);
  assert.deepEqual([...p.subarray(48, 52)], [0, 0, 255, 255]);
  const small = rasterizeTexture(1, 1, [0, 0, 1, 0, 1, 1, 0, 1], uvs, triangles, t, { samples: 0 });
  assert.deepEqual([...small], [128, 128, 128, 255]);
});

test('offscreen, zero-area and out-of-image UV triangles produce no pixels', () => {
  for (const [v, uv] of [[vertices.map(n => n + 100), uvs], [Array(8).fill(0), uvs], [vertices, uvs.map(n => n - 2)]]) {
    assert.ok(rasterizeTexture(4, 4, v!, uv!, triangles, texture([255, 255, 255, 255]), { samples: 0 }).every(n => n === 0));
  }
});

test('texture sampling rejects invalid geometry and enforces the shared work budget', () => {
  const t = texture([255, 255, 255, 255]);
  assert.throws(() => rasterizeTexture(4, 4, vertices, uvs, [0, 1, 99], t, { samples: 0 }), /geometry/);
  assert.throws(() => rasterizeTexture(4, 4, vertices, uvs, triangles, { ...t, pixels: new Uint8Array() }, { samples: 0 }), /decoded texture/);
  assert.throws(() => rasterizeTexture(4, 4, vertices, uvs, triangles, t, { samples: 0, limit: 1 }), /sampling exceeds/);
});
