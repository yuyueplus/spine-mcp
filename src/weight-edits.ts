import { MeshAttachment, Vector2 } from '@esotericsoftware/spine-core';
import { attachmentEntries, sourceMesh, vertexLayout } from './attachment-data.js';
import { parseDocument, type SpineDocument } from './document.js';
import { setWeights, type Influence } from './geometry-edits.js';
import { sampleSkeleton } from './runtime.js';

export interface WeightOptions {
  vertices?: number[];
  maxInfluences?: number;
  minWeight?: number;
  clearDeform?: boolean;
}
function meshWeights(data: SpineDocument, skin: string, slot: string, name: string) {
  const entries = attachmentEntries(data), target = entries.find(item => item.skin === skin && item.slot === slot && item.name === name);
  if (!target || !['mesh', 'linkedmesh'].includes(String(target.value.type))) throw new Error('Select an existing mesh attachment.');
  const mesh = sourceMesh(data, skin, slot, name), source = entries.find(item => item.value === mesh)!, layout = vertexLayout(data, mesh);
  const packed = mesh.vertices as number[], rows: Influence[][] = [];
  let cursor = 0;
  for (let vertex = 0; vertex < layout.count; vertex++) {
    const row: Influence[] = [];
    if (layout.weighted) {
      const count = packed[cursor++]!;
      for (let influence = 0; influence < count; influence++, cursor += 4) row.push({ bone: data.bones[packed[cursor]!]!.name, x: packed[cursor + 1]!, y: packed[cursor + 2]!, weight: packed[cursor + 3]! });
    } else {
      row.push({ bone: data.slots!.find(item => item.name === slot)!.bone, x: packed[cursor++]!, y: packed[cursor++]!, weight: 1 });
    }
    rows.push(row);
  }
  return { target, source, mesh, layout, rows };
}

export function inspectWeights(data: SpineDocument, skin: string, slot: string, name: string, offset = 0, limit = 100) {
  const { source, layout, rows } = meshWeights(data, skin, slot, name);
  if (!Number.isInteger(offset) || offset < 0 || offset > layout.count || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Weight page requires offset within vertex count and limit from 1 to 500.');
  const bones = new Map<string, { bone: string; vertices: number; totalWeight: number }>();
  let zeroWeights = 0, totalInfluences = 0, minSum = Infinity, maxSum = -Infinity, maxInfluences = 0;
  for (const row of rows) {
    const sum = row.reduce((sum, influence) => sum + influence.weight, 0); minSum = Math.min(minSum, sum); maxSum = Math.max(maxSum, sum);
    totalInfluences += row.length; maxInfluences = Math.max(maxInfluences, row.length);
    for (const item of row) {
      if (item.weight === 0) { zeroWeights++; continue; }
      const stat = bones.get(item.bone) ?? { bone: item.bone, vertices: 0, totalWeight: 0 }; stat.vertices++; stat.totalWeight += item.weight; bones.set(item.bone, stat);
    }
  }
  return {
    attachment: { skin, slot, name }, source: { skin: source.skin, slot: source.slot, name: source.name }, weighted: layout.weighted,
    vertexCount: layout.count, totalInfluences, maxInfluences, zeroWeights, weightSumRange: [minSum, maxSum], bones: [...bones.values()],
    offset, limit, nextOffset: offset + limit < layout.count ? offset + limit : null,
    vertices: rows.slice(offset, offset + limit).map((influences, index) => ({ index: offset + index, influences })),
  };
}

function optionsFor(count: number, options: WeightOptions) {
  const maxInfluences = options.maxInfluences ?? 4, minWeight = options.minWeight ?? 0.001;
  if (!Number.isInteger(maxInfluences) || maxInfluences < 1 || maxInfluences > 16 || !Number.isFinite(minWeight) || minWeight < 0 || minWeight > 1) throw new Error('maxInfluences must be 1–16; minWeight must be between 0 and 1.');
  const vertices = options.vertices ?? Array.from({ length: count }, (_, index) => index);
  if (!vertices.length || new Set(vertices).size !== vertices.length || vertices.some(index => !Number.isInteger(index) || index < 0 || index >= count)) throw new Error('vertices must contain distinct valid mesh vertex indices.');
  return { maxInfluences, minWeight, vertices };
}
function normalizedRow(indices: Map<string, number>, values: Map<string, number>, minWeight: number, maxInfluences: number): Influence[] {
  const ranked = [...values].filter(([_bone, weight]) => weight > 0).sort((a, b) => b[1] - a[1] || indices.get(a[0])! - indices.get(b[0])!);
  if (!ranked.length || ranked.some(([_bone, weight]) => !Number.isFinite(weight))) throw new Error('A vertex must retain positive finite weights.');
  const selected = ranked.filter(([_bone, weight]) => weight >= minWeight).slice(0, maxInfluences);
  if (!selected.length) selected.push(ranked[0]!);
  const sum = selected.reduce((sum, [_bone, weight]) => sum + weight, 0);
  return selected.map(([bone, weight]) => ({ bone, weight: weight / sum }));
}

// A common world-space correction preserves the setup vertex while retaining
// the relative bind offsets of existing influences. New bones bind at that
// vertex. Motion can change as a consequence of changing the weight values.
function rebind(source: SpineDocument, skin: string, slotName: string, name: string, original: Influence[][], rows: Influence[][], selected: number[], clearDeform = false) {
  const skeleton = sampleSkeleton(source, undefined, 0, skin), slot = skeleton.slots.find(item => item.data.name === slotName)!;
  const mesh = skeleton.data.findSkin(skin)?.getAttachment(slot.data.index, name);
  if (!(mesh instanceof MeshAttachment)) throw new Error('Runtime could not load the mesh.');
  const world = new Array<number>(mesh.worldVerticesLength); mesh.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2);
  const bones = new Map(skeleton.bones.map(bone => [bone.data.name, bone]));
  for (const vertex of selected) {
    const sum = rows[vertex]!.reduce((total, item) => total + item.weight, 0);
    for (const item of rows[vertex]!) item.weight /= sum;
    if (rows[vertex]!.length === original[vertex]!.length && rows[vertex]!.every(item => original[vertex]!.some(old => old.bone === item.bone && old.weight === item.weight))) {
      rows[vertex] = structuredClone(original[vertex]!); continue;
    }
    const x = world[vertex * 2]!, y = world[vertex * 2 + 1]!, previous = new Map(original[vertex]!.map(item => [item.bone, item]));
    let weightedX = 0, weightedY = 0;
    const positions = rows[vertex]!.map(item => {
      const bone = bones.get(item.bone)!;
      if (!bone.active || Math.abs(bone.appliedPose.a * bone.appliedPose.d - bone.appliedPose.b * bone.appliedPose.c) < 1e-12) throw new Error(`Reweighting requires an active bone with a nonsingular transform: ${item.bone}`);
      const old = previous.get(item.bone), point = old ? bone.appliedPose.localToWorld(new Vector2(old.x!, old.y!)) : new Vector2(x, y);
      weightedX += point.x * item.weight; weightedY += point.y * item.weight;
      return { item, bone, point };
    });
    for (const { item, bone, point } of positions) {
      point.x += x - weightedX; point.y += y - weightedY;
      bone.appliedPose.worldToLocal(point); item.x = point.x; item.y = point.y;
    }
  }
  const output = setWeights(source, skin, slotName, name, rows, clearDeform);
  // setWeights normalizes every row. Restore untouched rows exactly, apart
  // from the canonical influence order required by the editor importer.
  const chosen = new Set(selected), indices = new Map(source.bones.map((bone, index) => [bone.name, index])), packed: number[] = [];
  for (let vertex = 0; vertex < rows.length; vertex++) {
    const row = [...(chosen.has(vertex) ? rows[vertex]! : original[vertex]!)].sort((a, b) => indices.get(a.bone)! - indices.get(b.bone)!);
    packed.push(row.length);
    for (const item of row) packed.push(indices.get(item.bone)!, item.x!, item.y!, item.weight);
  }
  sourceMesh(output, skin, slotName, name).vertices = packed;
  return parseDocument(output);
}

export function cleanWeights(source: SpineDocument, skin: string, slot: string, name: string, options: WeightOptions = {}) {
  const weights = meshWeights(source, skin, slot, name);
  if (!weights.layout.weighted || weights.target.value.source !== undefined) throw new Error('Weight cleanup requires a weighted non-linked mesh; edit the source mesh of a link.');
  const { vertices, minWeight, maxInfluences } = optionsFor(weights.layout.count, options), rows = structuredClone(weights.rows);
  const indices = new Map(source.bones.map((bone, index) => [bone.name, index]));
  for (const vertex of vertices) rows[vertex] = normalizedRow(indices, new Map(rows[vertex]!.map(item => [item.bone, item.weight])), minWeight, maxInfluences);
  return rebind(source, skin, slot, name, weights.rows, rows, vertices, options.clearDeform);
}

export function smoothWeights(source: SpineDocument, skin: string, slot: string, name: string, options: WeightOptions & { strength?: number; iterations?: number } = {}) {
  const weights = meshWeights(source, skin, slot, name);
  if (!weights.layout.weighted || weights.target.value.source !== undefined) throw new Error('Weight smoothing requires a weighted non-linked mesh; edit the source mesh of a link.');
  const { vertices, minWeight, maxInfluences } = optionsFor(weights.layout.count, options), strength = options.strength ?? 0.5, iterations = options.iterations ?? 2;
  if (!Number.isFinite(strength) || strength < 0 || strength > 1 || !Number.isInteger(iterations) || iterations < 1 || iterations > 20) throw new Error('strength must be between 0 and 1; iterations must be 1–20.');
  const adjacent = Array.from({ length: weights.layout.count }, () => new Set<number>()), triangles = weights.mesh.triangles as number[];
  if (triangles.length > 600_000) throw new Error('Weight smoothing accepts at most 200,000 triangles.');
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const face = triangles.slice(offset, offset + 3);
    for (const a of face) for (const b of face) if (a !== b) adjacent[a]!.add(b);
  }
  let rows = weights.rows, work = 0; const indices = new Map(source.bones.map((bone, index) => [bone.name, index]));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = structuredClone(rows);
    for (const vertex of vertices) {
      const neighbors = adjacent[vertex]!;
      if (!neighbors.size || strength === 0) continue;
      const values = new Map(rows[vertex]!.map(item => [item.bone, item.weight * (1 - strength)]));
      for (const neighbor of neighbors) for (const item of rows[neighbor]!) {
        if (++work > 5_000_000) throw new Error('Weight smoothing exceeds the 5,000,000-influence work limit; select fewer vertices or iterations.');
        values.set(item.bone, (values.get(item.bone) ?? 0) + item.weight * strength / neighbors.size);
      }
      next[vertex] = normalizedRow(indices, values, minWeight, maxInfluences);
    }
    rows = next;
  }
  return rebind(source, skin, slot, name, weights.rows, structuredClone(rows), vertices, options.clearDeform);
}
