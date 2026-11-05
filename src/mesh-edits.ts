import { MeshAttachment } from '@esotericsoftware/spine-core';
import { attachmentEntries, attachmentTracks, sourceMesh, vertexLayout } from './attachment-data.js';
import { parseDocument, type JsonObject, type SpineDocument } from './document.js';
import { sampleSkeleton } from './runtime.js';
import type { AttachmentRef } from './attachment-reuse.js';

const maxTriangles = 200_000, maxDeformWork = 5_000_000;
type Matrix = { a: number; b: number; c: number; d: number; x: number; y: number };
type Mix = { index: number; factor: number };
type Bind = { bone: number; x: number; y: number; weight: number; mixes: Mix[] };
type Vertex = { u: number; v: number; binds: Bind[] };
export interface MeshTransform { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number; pivotX?: number; pivotY?: number }
export interface MeshPage { offset?: number; limit?: number; triangleOffset?: number; triangleLimit?: number }

function selectedMesh(data: SpineDocument, ref: AttachmentRef, edit = false) {
  const entries = attachmentEntries(data), target = entries.find(item => item.skin === ref.skin && item.slot === ref.slot && item.name === ref.name);
  if (!target || !['mesh', 'linkedmesh'].includes(String(target.value.type))) throw new Error('Select an existing mesh attachment.');
  if (edit && target.value.source !== undefined) throw new Error('Edit the original source mesh, or use unlink_mesh first for an independent edit.');
  const mesh = sourceMesh(data, ref.skin, ref.slot, ref.name), source = entries.find(item => item.value === mesh)!, layout = vertexLayout(data, mesh);
  const links = entries.filter(item => item.value.source !== undefined && sourceMesh(data, item.skin, item.slot, item.name) === mesh).map(({ skin, slot, name }) => ({ skin, slot, name }));
  if ((mesh.triangles as number[]).length / 3 > maxTriangles) throw new Error('Mesh editing/inspection accepts at most 200,000 triangles.');
  return { mesh, source, target, layout, links };
}
const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
function topology(mesh: JsonObject, count: number) {
  const triangles = mesh.triangles as number[], uvs = mesh.uvs as number[], hull = Number(mesh.hull ?? 0);
  const edges = new Map<string, { a: number; b: number; count: number; direction: number }>(), used = new Set<number>(), faces = new Set<string>();
  const repeatedVertexTriangles: number[] = [], duplicateTriangles: number[] = [], degenerateUvTriangles: number[] = [];
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const [a, b, c] = triangles.slice(offset, offset + 3) as [number, number, number], index = offset / 3;
    if (new Set([a, b, c]).size !== 3) repeatedVertexTriangles.push(index);
    const key = [a, b, c].sort((x, y) => x - y).join(':'); if (faces.has(key)) duplicateTriangles.push(index); faces.add(key);
    const area = (uvs[b * 2]! - uvs[a * 2]!) * (uvs[c * 2 + 1]! - uvs[a * 2 + 1]!) - (uvs[b * 2 + 1]! - uvs[a * 2 + 1]!) * (uvs[c * 2]! - uvs[a * 2]!);
    if (Math.abs(area) < 1e-12) degenerateUvTriangles.push(index);
    for (const [x, y] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      used.add(x); const key = edgeKey(x, y), edge = edges.get(key) ?? { a: Math.min(x, y), b: Math.max(x, y), count: 0, direction: 0 };
      edge.count++; edge.direction += x < y ? 1 : -1; edges.set(key, edge);
    }
  }
  const boundary = [...edges.values()].filter(edge => edge.count === 1), nonManifold = [...edges.values()].filter(edge => edge.count > 2), inconsistentWinding = [...edges.values()].filter(edge => edge.count === 2 && edge.direction !== 0);
  const completeHull = hull >= 3 && boundary.length === hull && Array.from({ length: hull }, (_, index) => edges.get(edgeKey(index, (index + 1) % hull))?.count === 1).every(Boolean);
  const manual = mesh.edges, invalidManualEdges: number[] = [];
  if (manual !== undefined) {
    if (!Array.isArray(manual) || manual.length % 2) invalidManualEdges.push(-1);
    else for (let index = 0; index < manual.length; index += 2) {
      const a = manual[index], b = manual[index + 1];
      if (![a, b].every(value => Number.isInteger(value) && value >= 0 && value % 2 === 0 && value / 2 < count) || !edges.has(edgeKey(a / 2, b / 2))) invalidManualEdges.push(index / 2);
    }
  }
  const unusedVertices = Array.from({ length: count }, (_, index) => index).filter(index => !used.has(index));
  const refinable = completeHull && triangles.length / 3 === count * 2 - hull - 2 && ![repeatedVertexTriangles, duplicateTriangles, degenerateUvTriangles, unusedVertices, nonManifold, inconsistentWinding, invalidManualEdges].some(items => items.length);
  return { edges, boundary, nonManifold, inconsistentWinding, repeatedVertexTriangles, duplicateTriangles, degenerateUvTriangles, unusedVertices, invalidManualEdges, completeHull, refinable };
}
function decode(data: SpineDocument, mesh: JsonObject): Vertex[] {
  const layout = vertexLayout(data, mesh), raw = mesh.vertices as number[], uv = mesh.uvs as number[]; let cursor = 0, pair = 0;
  return Array.from({ length: layout.count }, (_, index) => {
    const binds: Bind[] = [], count = layout.weighted ? raw[cursor++]! : 1;
    for (let influence = 0; influence < count; influence++) {
      const bone = layout.weighted ? raw[cursor++]! : -1, x = raw[cursor++]!, y = raw[cursor++]!, weight = layout.weighted ? raw[cursor++]! : 1;
      binds.push({ bone, x, y, weight, mixes: [{ index: pair++, factor: 1 }] });
    }
    return { u: uv[index * 2]!, v: uv[index * 2 + 1]!, binds };
  });
}
function packed(vertices: Vertex[], weighted: boolean) {
  const result: number[] = [];
  for (const vertex of vertices) {
    if (weighted) result.push(vertex.binds.length);
    for (const bind of vertex.binds) { if (weighted) result.push(bind.bone); result.push(bind.x, bind.y); if (weighted) result.push(bind.weight); }
  }
  if (result.some(value => !Number.isFinite(value))) throw new Error('Mesh operation produced non-finite coordinates. Use smaller transforms.');
  return result;
}
function mul(a: Matrix, b: Matrix): Matrix {
  return { a: a.a * b.a + a.b * b.c, b: a.a * b.b + a.b * b.d, c: a.c * b.a + a.d * b.c, d: a.c * b.b + a.d * b.d, x: a.a * b.x + a.b * b.y + a.x, y: a.c * b.x + a.d * b.y + a.y };
}
function inverse(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('Mesh coordinate conversion requires nonsingular setup bone transforms.');
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, x: (m.b * m.y - m.d * m.x) / det, y: (m.c * m.x - m.a * m.y) / det };
}
const point = (m: Matrix, x: number, y: number, vector = false): [number, number] => [m.a * x + m.b * y + (vector ? 0 : m.x), m.c * x + m.d * y + (vector ? 0 : m.y)];
function affine(transform: MeshTransform): Matrix {
  const { x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, pivotX = 0, pivotY = 0 } = transform;
  if ([x, y, rotation, scaleX, scaleY, pivotX, pivotY].some(value => !Number.isFinite(value))) throw new Error('Mesh transform values must be finite.');
  const radians = rotation * Math.PI / 180, a = Math.cos(radians) * scaleX, b = -Math.sin(radians) * scaleY, c = Math.sin(radians) * scaleX, d = Math.cos(radians) * scaleY;
  return { a, b, c, d, x: x + pivotX - a * pivotX - b * pivotY, y: y + pivotY - c * pivotX - d * pivotY };
}
function deformTracks(data: SpineDocument, mesh: JsonObject) {
  return Object.values(data.animations ?? {}).flatMap(animation => attachmentTracks(data, animation).filter(track => track.channel === 'deform' && sourceMesh(data, track.skin, track.slot, track.name) === mesh));
}
function rewriteDeform(key: JsonObject, oldLength: number, nextLength: number, map: (values: number[]) => number[]) {
  const values = new Array<number>(oldLength).fill(0), raw = (key.vertices ?? []) as number[], offset = Number(key.offset ?? 0);
  raw.forEach((value, index) => { values[offset + index] = value; });
  const next = map(values); if (next.length !== nextLength || next.some(value => !Number.isFinite(value))) throw new Error('Mesh operation produced invalid deformation coordinates.');
  let first = 0, last = next.length; while (first < last && next[first] === 0) first++; while (last > first && next[last - 1] === 0) last--;
  delete key.offset; delete key.vertices;
  if (first < last) { if (first) key.offset = first; key.vertices = next.slice(first, last); }
}

export function inspectMesh(data: SpineDocument, ref: AttachmentRef, options: MeshPage = {}) {
  const { mesh, source, layout, links } = selectedMesh(data, ref), info = topology(mesh, layout.count), vertices = decode(data, mesh);
  const offset = options.offset ?? 0, limit = options.limit ?? 100, triangleOffset = options.triangleOffset ?? 0, triangleLimit = options.triangleLimit ?? 100, triangles = mesh.triangles as number[];
  if (!Number.isInteger(offset) || offset < 0 || offset > layout.count || !Number.isInteger(triangleOffset) || triangleOffset < 0 || triangleOffset > triangles.length / 3 || ![limit, triangleLimit].every(value => Number.isInteger(value) && value >= 1 && value <= 500)) throw new Error('Mesh pages require offsets within their counts and limits from 1 to 500.');
  const skeleton = sampleSkeleton(data, undefined, 0, ref.skin), slot = skeleton.slots.find(item => item.data.name === ref.slot)!, runtime = skeleton.data.findSkin(ref.skin)!.getAttachment(slot.data.index, ref.name);
  if (!(runtime instanceof MeshAttachment)) throw new Error('Runtime could not load the mesh.');
  const active = slot.bone.active && (!layout.weighted || vertices.every(vertex => vertex.binds.every(bind => skeleton.bones[bind.bone]!.active)));
  const world = new Array<number>(layout.count * 2); slot.appliedPose.deform.length = 0;
  if (active) { runtime.computeWorldVertices(skeleton, slot, 0, world.length, world, 0, 2); if (world.some(value => !Number.isFinite(value))) throw new Error('Mesh has non-finite setup world vertices.'); }
  const pose = slot.bone.appliedPose, matrix = { a: pose.a, b: pose.b, c: pose.c, d: pose.d, x: pose.worldX, y: pose.worldY }, toLocal = Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12 ? undefined : inverse(matrix);
  const issue = (items: unknown[]) => ({ count: items.length, first: items.slice(0, 20) });
  return {
    attachment: ref, source: { skin: source.skin, slot: source.slot, name: source.name }, weighted: layout.weighted,
    vertexCount: layout.count, hullVertices: Number(mesh.hull ?? 0), triangleCount: triangles.length / 3, edgeCount: info.edges.size, boundaryEdges: info.boundary.length,
    linkedMeshCount: links.length, linkedMeshes: links.slice(0, 100), linkedMeshesTruncated: links.length > 100, relatedDeformTracks: deformTracks(data, mesh).length,
    setupGeometryAvailable: active, refinable: info.refinable, completeHull: info.completeHull,
    issues: { repeatedVertexTriangles: issue(info.repeatedVertexTriangles), duplicateTriangles: issue(info.duplicateTriangles), degenerateUvTriangles: issue(info.degenerateUvTriangles), unusedVertices: issue(info.unusedVertices), nonManifoldEdges: issue(info.nonManifold), inconsistentWinding: issue(info.inconsistentWinding), invalidManualEdges: issue(info.invalidManualEdges) },
    offset, limit, nextOffset: offset + limit < layout.count ? offset + limit : null,
    vertices: vertices.slice(offset, offset + limit).map((vertex, index) => ({ index: offset + index, uv: [vertex.u, vertex.v], influenceCount: vertex.binds.length, world: active ? world.slice((offset + index) * 2, (offset + index) * 2 + 2) : null, local: !layout.weighted ? [vertex.binds[0]!.x, vertex.binds[0]!.y] : active && toLocal ? point(toLocal, world[(offset + index) * 2]!, world[(offset + index) * 2 + 1]!) : null })),
    triangleOffset, triangleLimit, nextTriangleOffset: triangleOffset + triangleLimit < triangles.length / 3 ? triangleOffset + triangleLimit : null,
    triangles: Array.from({ length: Math.min(triangleLimit, triangles.length / 3 - triangleOffset) }, (_, index) => ({ index: triangleOffset + index, vertices: triangles.slice((triangleOffset + index) * 3, (triangleOffset + index + 1) * 3) })),
    note: 'Positions use the selected skin setup pose. Topology checks do not detect intersecting triangles or prove visual correctness. Source edits affect every link; refined vertex indices change.',
  };
}

export function transformMesh(source: SpineDocument, ref: AttachmentRef, transform: MeshTransform, selection?: number[], transformDeform = true) {
  const data = structuredClone(source), { mesh, layout } = selectedMesh(data, ref, true), vertices = decode(data, mesh), matrix = affine(transform);
  const chosen = selection ?? Array.from({ length: layout.count }, (_, index) => index);
  if (!chosen.length || new Set(chosen).size !== chosen.length || chosen.some(index => !Number.isInteger(index) || index < 0 || index >= layout.count)) throw new Error('vertices must contain distinct valid mesh vertex indices.');
  const matrices = new Map<number, Matrix>();
  if (layout.weighted) {
    const skeleton = sampleSkeleton(source, undefined, 0, ref.skin), slot = skeleton.slots.find(item => item.data.name === ref.slot)!;
    if (!slot.bone.active) throw new Error('Mesh slot bone must be active in the selected skin.');
    const pose = slot.bone.appliedPose, slotMatrix = { a: pose.a, b: pose.b, c: pose.c, d: pose.d, x: pose.worldX, y: pose.worldY }, worldTransform = mul(mul(slotMatrix, matrix), inverse(slotMatrix));
    for (const index of chosen) for (const bind of vertices[index]!.binds) if (!matrices.has(bind.bone)) {
      const bone = skeleton.bones[bind.bone]!; if (!bone.active) throw new Error('All selected weighted influence bones must be active in the selected skin.');
      const p = bone.appliedPose, boneMatrix = { a: p.a, b: p.b, c: p.c, d: p.d, x: p.worldX, y: p.worldY };
      matrices.set(bind.bone, mul(mul(inverse(boneMatrix), worldTransform), boneMatrix));
    }
  } else matrices.set(-1, matrix);
  const pairs = new Map<number, Matrix>();
  for (const index of chosen) for (const bind of vertices[index]!.binds) {
    const m = matrices.get(bind.bone)!; [bind.x, bind.y] = point(m, bind.x, bind.y); pairs.set(bind.mixes[0]!.index, m);
  }
  const tracks = deformTracks(data, mesh), work = tracks.reduce((sum, track) => sum + track.frames.length * layout.deformLength, 0);
  if (transformDeform && work > maxDeformWork) throw new Error('Mesh edit exceeds 5,000,000 deformation coordinates; reduce animation data or edit meshes separately.');
  if (transformDeform) for (const track of tracks) for (const key of track.frames) rewriteDeform(key, layout.deformLength, layout.deformLength, values => {
    for (const [index, m] of pairs) [values[index * 2], values[index * 2 + 1]] = point(m, values[index * 2]!, values[index * 2 + 1]!, true);
    return values;
  });
  mesh.vertices = packed(vertices, layout.weighted); return parseDocument(data);
}

function midpoint(a: Vertex, b: Vertex, weighted: boolean): Vertex {
  if (!weighted) return { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2, binds: [{ bone: -1, x: (a.binds[0]!.x + b.binds[0]!.x) / 2, y: (a.binds[0]!.y + b.binds[0]!.y) / 2, weight: 1, mixes: [...a.binds[0]!.mixes, ...b.binds[0]!.mixes].map(mix => ({ index: mix.index, factor: mix.factor / 2 })) }] };
  const rows = new Map<number, Bind>();
  for (const bind of [...a.binds, ...b.binds]) {
    if (!bind.weight) continue;
    const row = rows.get(bind.bone) ?? { bone: bind.bone, x: 0, y: 0, weight: 0, mixes: [] }, weight = bind.weight / 2;
    row.x += bind.x * weight; row.y += bind.y * weight; row.weight += weight; row.mixes.push(...bind.mixes.map(mix => ({ index: mix.index, factor: mix.factor * weight }))); rows.set(bind.bone, row);
  }
  if (rows.size > 16) throw new Error('Subdivision needs more than 16 influences at a midpoint. Clean source weights first; no influences were discarded.');
  const binds = [...rows.values()].sort((a, b) => a.bone - b.bone).map(row => ({ ...row, x: row.x / row.weight, y: row.y / row.weight, mixes: row.mixes.map(mix => ({ index: mix.index, factor: mix.factor / row.weight })) }));
  return { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2, binds };
}
export function refineMesh(source: SpineDocument, ref: AttachmentRef, iterations = 1) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 3) throw new Error('Mesh subdivision iterations must be 1–3.');
  const data = structuredClone(source), { mesh } = selectedMesh(data, ref, true); let work = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const layout = vertexLayout(data, mesh), info = topology(mesh, layout.count);
    if (!info.refinable) throw new Error('Subdivision requires a single complete hull, consistent nondegenerate UV triangles, valid manual edges and no unused vertices. Inspect the mesh topology first.');
    if (layout.count + info.edges.size > 10000 || (mesh.triangles as number[]).length / 3 * 4 > maxTriangles) throw new Error('Subdivision exceeds 10,000 vertices or 200,000 triangles. Use fewer iterations.');
    const vertices = decode(data, mesh), mids = new Map<string, number>(), hull = Number(mesh.hull), triangles: number[] = [];
    for (const [key, edge] of info.edges) { mids.set(key, vertices.length); vertices.push(midpoint(vertices[edge.a]!, vertices[edge.b]!, layout.weighted)); }
    const order: number[] = [];
    for (let index = 0; index < hull; index++) order.push(index, mids.get(edgeKey(index, (index + 1) % hull))!);
    const used = new Set(order); for (let index = 0; index < vertices.length; index++) if (!used.has(index)) order.push(index);
    const remap = new Map(order.map((old, index) => [old, index])), next = order.map(index => vertices[index]!);
    const oldTriangles = mesh.triangles as number[];
    for (let offset = 0; offset < oldTriangles.length; offset += 3) {
      const [a, b, c] = oldTriangles.slice(offset, offset + 3) as [number, number, number], ab = mids.get(edgeKey(a, b))!, bc = mids.get(edgeKey(b, c))!, ca = mids.get(edgeKey(c, a))!;
      triangles.push(...[a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca].map(index => remap.get(index)!));
    }
    const tracks = deformTracks(data, mesh), nextLength = next.reduce((sum, vertex) => sum + vertex.binds.length * 2, 0);
    work += tracks.reduce((sum, track) => sum + track.frames.length * (layout.deformLength + nextLength), 0);
    if (work > maxDeformWork) throw new Error('Subdivision exceeds 5,000,000 deformation coordinates; reduce iterations or animation data.');
    for (const track of tracks) for (const key of track.frames) rewriteDeform(key, layout.deformLength, nextLength, values => next.flatMap(vertex => vertex.binds.flatMap(bind => [0, 1].map(axis => bind.mixes.reduce((sum, mix) => sum + values[mix.index * 2 + axis]! * mix.factor, 0)))));
    mesh.vertices = packed(next, layout.weighted); mesh.uvs = next.flatMap(vertex => [vertex.u, vertex.v]); mesh.triangles = triangles; mesh.hull = hull * 2;
    // Lock the subdivided triangle edges using Spine's coordinate indices.
    const edges = new Map<string, [number, number]>();
    for (let offset = 0; offset < triangles.length; offset += 3) {
      const [a, b, c] = triangles.slice(offset, offset + 3) as [number, number, number];
      for (const [x, y] of [[a, b], [b, c], [c, a]] as [number, number][]) edges.set(edgeKey(x, y), [x * 2, y * 2]);
    }
    mesh.edges = [...edges.values()].flat(); parseDocument(data);
  }
  return data;
}

export function refineSelectedTriangles(source: SpineDocument, ref: AttachmentRef, selection: number[]) {
  const data = structuredClone(source), { mesh, layout } = selectedMesh(data, ref, true), vertices = decode(data, mesh), original = mesh.triangles as number[], triangles: number[] = [];
  if (!selection.length || new Set(selection).size !== selection.length || selection.some(index => !Number.isInteger(index) || index < 0 || index >= original.length / 3)) throw new Error('Select distinct valid triangle indices.');
  if (layout.count + selection.length > 10000) throw new Error('Local refinement exceeds 10,000 vertices.');
  const chosen = new Set(selection);
  for (let offset = 0; offset < original.length; offset += 3) {
    const [a, b, c] = original.slice(offset, offset + 3) as [number, number, number];
    if (!chosen.has(offset / 3)) { triangles.push(a, b, c); continue; }
    const sourceVertices = [vertices[a]!, vertices[b]!, vertices[c]!], rows = new Map<number, Bind>();
    for (const vertex of sourceVertices) for (const bind of vertex.binds) {
      const weight = bind.weight / 3; if (!weight) continue;
      const row = rows.get(bind.bone) ?? { bone: bind.bone, x: 0, y: 0, weight: 0, mixes: [] };
      row.x += bind.x * weight; row.y += bind.y * weight; row.weight += weight; row.mixes.push(...bind.mixes.map(mix => ({ index: mix.index, factor: mix.factor * weight }))); rows.set(bind.bone, row);
    }
    if (rows.size > 16) throw new Error('Local refinement exceeds 16 influences at a centroid.');
    const index = vertices.length;
    vertices.push({ u: sourceVertices.reduce((n, vertex) => n + vertex.u / 3, 0), v: sourceVertices.reduce((n, vertex) => n + vertex.v / 3, 0), binds: [...rows.values()].sort((a, b) => a.bone - b.bone).map(row => ({ ...row, x: row.x / row.weight, y: row.y / row.weight, mixes: row.mixes.map(mix => ({ ...mix, factor: mix.factor / row.weight })) })) });
    triangles.push(a, b, index, b, c, index, c, a, index);
  }
  const nextLength = vertices.reduce((n, vertex) => n + vertex.binds.length * 2, 0), tracks = deformTracks(data, mesh);
  if (tracks.reduce((n, track) => n + track.frames.length * nextLength, 0) > maxDeformWork) throw new Error('Local refinement exceeds deformation budget.');
  for (const track of tracks) for (const key of track.frames) rewriteDeform(key, layout.deformLength, nextLength, values => vertices.flatMap(vertex => vertex.binds.flatMap(bind => [0, 1].map(axis => bind.mixes.reduce((n, mix) => n + values[mix.index * 2 + axis]! * mix.factor, 0)))));
  mesh.vertices = packed(vertices, layout.weighted); mesh.uvs = vertices.flatMap(vertex => [vertex.u, vertex.v]); mesh.triangles = triangles; delete mesh.edges;
  return parseDocument(data);
}
