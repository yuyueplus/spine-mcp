export interface SurfacePoint {
  triangle: number;
  vertices: [number, number, number];
  factors: [number, number, number];
  distance: number;
  ambiguous: boolean;
}
type Face = { index: number; vertices: [number, number, number]; ax: number; ay: number; bx: number; by: number; cx: number; cy: number; area: number };

// Queries use the closest point on the filled triangles, including their
// boundary. Degenerate faces never supply weights. Ties use the first face.
export function surfaceSampler(positions: number[], triangles: number[], queries: number) {
  if (positions.length % 2 || positions.some(n => !Number.isFinite(n)) || triangles.length % 3 || !Number.isInteger(queries) || queries < 0) throw new Error('Surface sampling requires finite 2D vertices and complete triangles.');
  if (queries * triangles.length / 3 > 5_000_000) throw new Error('Surface sampling exceeds five million triangle comparisons.');
  const faces: Face[] = [];
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const vertices = triangles.slice(offset, offset + 3) as [number, number, number];
    if (vertices.some(index => !Number.isInteger(index) || index < 0 || index * 2 >= positions.length)) throw new Error('Surface triangle references an invalid vertex.');
    const [a, b, c] = vertices, ax = positions[a * 2]!, ay = positions[a * 2 + 1]!, bx = positions[b * 2]!, by = positions[b * 2 + 1]!, cx = positions[c * 2]!, cy = positions[c * 2 + 1]!;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), scale = Math.max((bx - ax) ** 2 + (by - ay) ** 2, (cx - ax) ** 2 + (cy - ay) ** 2, (cx - bx) ** 2 + (cy - by) ** 2);
    if (!Number.isFinite(area) || !Number.isFinite(scale)) throw new Error('Surface coordinates exceed finite arithmetic limits.');
    if (!scale || Math.abs(area) <= scale * 1e-12) continue;
    faces.push({ index: offset / 3, vertices, ax, ay, bx, by, cx, cy, area });
  }
  if (!faces.length) throw new Error('Surface has no nondegenerate triangles.');
  let used = 0;
  const signature = (sample: SurfacePoint) => new Map(sample.vertices.map((index, i) => [index, sample.factors[i]!] as const).filter(([, factor]) => factor > 1e-10));
  const sameSample = (a: SurfacePoint, b: SurfacePoint) => { const left = signature(a), right = signature(b); return left.size === right.size && [...left].every(([index, weight]) => Math.abs(weight - (right.get(index) ?? -1)) < 1e-8); };
  return {
    triangles: faces.length, skippedDegenerate: triangles.length / 3 - faces.length,
    locate(x: number, y: number): SurfacePoint {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Surface query must be finite.');
      if (++used > queries) throw new Error('Surface sampling query budget exceeded.');
      let best: SurfacePoint | undefined;
      for (const face of faces) {
        const { ax, ay, bx, by, cx, cy, area } = face;
        const v = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / area, w = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area, u = 1 - v - w;
        let factors: [number, number, number], distance: number;
        if (u >= 0 && v >= 0 && w >= 0) { factors = [u, v, w]; distance = 0; }
        else {
          distance = Infinity; factors = [1, 0, 0];
          for (const [first, second, px, py, qx, qy] of [[0, 1, ax, ay, bx, by], [1, 2, bx, by, cx, cy], [2, 0, cx, cy, ax, ay]] as const) {
            const dx = qx - px, dy = qy - py, t = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy))), d = Math.hypot(x - px - t * dx, y - py - t * dy);
            if (d < distance) { distance = d; factors = [0, 0, 0]; factors[first] = 1 - t; factors[second] = t; }
          }
        }
        if (!Number.isFinite(distance) || factors.some(n => !Number.isFinite(n))) throw new Error('Surface query produced non-finite interpolation.');
        const candidate: SurfacePoint = { triangle: face.index, vertices: face.vertices, factors, distance, ambiguous: false };
        if (!best || distance < best.distance) {
          candidate.ambiguous = !!best && distance === best.distance && !sameSample(best, candidate); best = candidate;
        } else if (distance === best.distance && !sameSample(best, candidate)) best.ambiguous = true;
      }
      return best!;
    },
  };
}
