import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from '../src/document.js';
import { addSkin } from '../src/slot-edits.js';
import { attachmentEntries, attachmentTracks, sourceMesh } from '../src/attachment-data.js';

function fixture() {
  return parseDocument({ skeleton: { spine: '4.3.23' }, bones: [{ name: 'root' }], slots: [{ name: 'art', bone: 'root', attachment: 'mesh' }, { name: 'linked', bone: 'root', attachment: 'link' }], skins: [
    { name: 'default', attachments: { art: { mesh: { type: 'mesh', path: 'art', uvs: [0, 1, 0, 0, 1, 0], vertices: [0, 0, 0, 10, 10, 10], triangles: [0, 1, 2], hull: 3 } }, linked: { link: { type: 'linkedmesh', path: 'art', source: 'mesh', slot: 'art' } } } },
    { name: 'external', attachments: { linked: { external: { type: 'linkedmesh', path: 'art', source: 'mesh', slot: 'art' } } } },
  ], animations: { motion: { attachments: { default: { art: { mesh: { deform: [{ time: 0, vertices: [0, 0] }, { time: 1, vertices: [3, 1] }] } } } } } } });
}

test('promoting default attachments migrates deformation namespaces and every implicit linked-mesh source', () => {
  const source = fixture(), original = JSON.stringify(source), copied = addSkin(source, 'night', 'default', 'base');
  const timeline = copied.animations!.motion!.attachments as any;
  assert.equal(timeline.default, undefined); assert.deepEqual(timeline.base, timeline.night);
  assert.deepEqual(attachmentTracks(copied, copied.animations!.motion!).map(track => track.skin).sort(), ['base', 'night']);
  const entries = attachmentEntries(copied);
  assert.equal(entries.find(item => item.skin === 'base' && item.name === 'link')!.value.skin, 'base');
  assert.equal(entries.find(item => item.skin === 'night' && item.name === 'link')!.value.skin, 'night');
  assert.equal(entries.find(item => item.skin === 'external')!.value.skin, 'base');
  assert.equal(sourceMesh(copied, 'night', 'linked', 'link'), entries.find(item => item.skin === 'night' && item.name === 'mesh')!.value);
  assert.equal(JSON.stringify(source), original);
});

test('copying a named skin preserves its animation and makes mesh, linked-source and keyframe payloads independent', () => {
  const promoted = addSkin(fixture(), 'night', 'default', 'base'), output = addSkin(promoted, 'third', 'base');
  const tracks = output.animations!.motion!.attachments as any;
  assert.deepEqual(tracks.third, tracks.base); assert.notEqual(tracks.third, tracks.base);
  tracks.third.art.mesh.deform[1].vertices[0] = 99;
  const thirdMesh = sourceMesh(output, 'third', 'linked', 'link'); (thirdMesh.vertices as number[])[0] = 88;
  assert.equal(tracks.base.art.mesh.deform[1].vertices[0], 3);
  assert.equal((sourceMesh(output, 'base', 'linked', 'link').vertices as number[])[0], 0);
  assert.equal((promoted.animations!.motion!.attachments as any).base.art.mesh.deform[1].vertices[0], 3);
});
