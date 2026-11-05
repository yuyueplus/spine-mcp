import { MeshAttachment, Vector2 } from '@esotericsoftware/spine-core';
import { attachmentEntries, attachmentTracks, sourceMesh, vertexLayout } from './attachment-data.js';
import type { AttachmentRef } from './attachment-reuse.js';
import { parseDocument, type SpineDocument } from './document.js';
import { sampleSkeleton } from './runtime.js';
import { surfaceSampler } from './surface-sampling.js';

export interface MeshTopology { vertices: number[]; uvs: number[]; triangles: number[]; hull: number }
type Mix = { pair: number; factor: number };
type Bind = { bone: number; x: number; y: number; weight: number; mixes: Mix[] };

// UV correspondence transports the original piecewise-linear surface. This is
// an explicit interpolation policy, not a promise of lossless arbitrary edits.
export function retopologizeSurface(source: SpineDocument, ref: AttachmentRef, topology: MeshTopology) {
  const data = structuredClone(source), selected = attachmentEntries(data).find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name);
  if (!selected || selected.value.type !== 'mesh' || selected.value.source !== undefined) throw new Error('Surface retopology requires a source mesh.');
  const mesh = selected.value, layout = vertexLayout(data, mesh), count = topology.uvs.length / 2;
  if (!Number.isInteger(count) || count < 3 || count > 10000 || topology.vertices.length !== count * 2 || topology.vertices.some(n => !Number.isFinite(n))) throw new Error('Interpolated retopology requires unweighted new setup slot-local positions, one XY pair per UV. Weights are derived from the old surface.');
  const sampler = surfaceSampler(mesh.uvs as number[], mesh.triangles as number[], count), raw = mesh.vertices as number[], rows: Bind[][] = [];
  let cursor = 0, pair = 0;
  for (let vertex = 0; vertex < layout.count; vertex++) {
    const row: Bind[] = [], influences = layout.weighted ? raw[cursor++]! : 1;
    for (let j = 0; j < influences; j++) {
      const bone = layout.weighted ? raw[cursor++]! : -1, x = raw[cursor++]!, y = raw[cursor++]!, weight = layout.weighted ? raw[cursor++]! : 1;
      row.push({ bone, x, y, weight, mixes: [{ pair: pair++, factor: 1 }] });
    }
    rows.push(row);
  }
  const skeleton = layout.weighted ? sampleSkeleton(source, undefined, 0, ref.skin) : undefined, slot = skeleton?.slots.find(item => item.data.name === ref.slot);
  if (skeleton && (!slot?.bone.active || !(skeleton.data.findSkin(ref.skin)?.getAttachment(slot.data.index, ref.name) instanceof MeshAttachment))) throw new Error('Surface retopology requires an active source mesh in the selected skin.');
  const next: Bind[][] = [];
  for (let vertex = 0; vertex < count; vertex++) {
    const sample = sampler.locate(topology.uvs[vertex * 2]!, topology.uvs[vertex * 2 + 1]!);
    if (sample.distance > 1e-7) throw new Error(`New vertex ${vertex} lies outside the original UV surface. Interpolated retopology does not extrapolate.`);
    if (sample.ambiguous) throw new Error(`New vertex ${vertex} has ambiguous overlapping UV correspondence. Resolve the UV overlap before interpolating deformation.`);
    const merged = new Map<number, Bind>();
    sample.vertices.forEach((index, corner) => {
      for (const old of rows[index]!) {
        const weight = old.weight * sample.factors[corner]!; if (weight <= 0) continue;
        const bind = merged.get(old.bone) ?? { bone: old.bone, x: 0, y: 0, weight: 0, mixes: [] };
        bind.x += old.x * weight; bind.y += old.y * weight; bind.weight += weight; bind.mixes.push(...old.mixes.map(mix => ({ pair: mix.pair, factor: mix.factor * weight }))); merged.set(old.bone, bind);
      }
    });
    if (!merged.size || merged.size > 16) throw new Error(`Interpolated vertex ${vertex} requires 1–16 positive influences. No influence pruning is performed.`);
    const binds = [...merged.values()].sort((a, b) => a.bone - b.bone).map(bind => ({ ...bind, x: bind.x / bind.weight, y: bind.y / bind.weight, mixes: bind.mixes.map(mix => ({ pair: mix.pair, factor: mix.factor / bind.weight })) }));
    if (!layout.weighted) { binds[0]!.x = topology.vertices[vertex * 2]!; binds[0]!.y = topology.vertices[vertex * 2 + 1]!; }
    else {
      const desired = slot!.bone.appliedPose.localToWorld(new Vector2(topology.vertices[vertex * 2]!, topology.vertices[vertex * 2 + 1]!)); let x = 0, y = 0, total = 0;
      for (const bind of binds) {
        const bone = skeleton!.bones[bind.bone]!, pose = bone.appliedPose;
        if (!bone.active || Math.abs(pose.a * pose.d - pose.b * pose.c) < 1e-12) throw new Error('Interpolated retopology requires active, nonsingular influence bones.');
        const point = pose.localToWorld(new Vector2(bind.x, bind.y)); x += point.x * bind.weight; y += point.y * bind.weight; total += bind.weight;
      }
      const dx = (desired.x - x) / total, dy = (desired.y - y) / total;
      for (const bind of binds) { const p = skeleton!.bones[bind.bone]!.appliedPose, det = p.a * p.d - p.b * p.c; bind.x += (p.d * dx - p.b * dy) / det; bind.y += (-p.c * dx + p.a * dy) / det; }
    }
    next.push(binds);
  }
  const tracks = Object.values(data.animations ?? {}).flatMap(animation => attachmentTracks(data, animation).filter(track => track.channel === 'deform' && sourceMesh(data, track.skin, track.slot, track.name) === mesh)), nextLength = next.reduce((sum, binds) => sum + binds.length * 2, 0);
  if (tracks.reduce((sum, track) => sum + track.frames.length * (layout.deformLength + nextLength), 0) > 5_000_000) throw new Error('Interpolated retopology exceeds five million deformation coordinates.');
  for (const track of tracks) for (const key of track.frames) {
    const values = new Array<number>(layout.deformLength).fill(0), old = (key.vertices ?? []) as number[], offset = Number(key.offset ?? 0);
    old.forEach((value, index) => { values[offset + index] = value; });
    const result = next.flatMap(binds => binds.flatMap(bind => [0, 1].map(axis => bind.mixes.reduce((sum, mix) => sum + values[mix.pair * 2 + axis]! * mix.factor, 0))));
    if (result.some(n => !Number.isFinite(n))) throw new Error('Interpolated retopology produced non-finite deformation.');
    let first = 0, last = result.length; while (first < last && result[first] === 0) first++; while (last > first && result[last - 1] === 0) last--;
    delete key.vertices; delete key.offset; if (first < last) { if (first) key.offset = first; key.vertices = result.slice(first, last); }
  }
  Object.assign(mesh, structuredClone(topology)); delete mesh.edges;
  mesh.vertices = next.flatMap(binds => layout.weighted ? [binds.length, ...binds.flatMap(bind => [bind.bone, bind.x, bind.y, bind.weight])] : [binds[0]!.x, binds[0]!.y]);
  return parseDocument(data);
}
