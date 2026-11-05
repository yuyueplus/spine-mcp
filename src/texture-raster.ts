export interface RasterTexture { width: number; height: number; pixels: Uint8Array }
export interface RasterBudget { samples: number; limit?: number }

// Premultiplied texture sampling at two samples per axis. Adjacent triangles
// share one top-left ownership rule, so internal edges neither fade nor blend
// twice. The layer is resolved only after all triangles have been composited.
export function rasterizeTexture(width: number, height: number, vertices: number[], uvs: number[], triangles: number[], texture: RasterTexture, budget: RasterBudget) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0) || width * height > 2_097_152) throw new Error('Texture raster exceeds two megapixels.');
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1 || texture.width * texture.height > 16_777_216 || texture.pixels.length !== texture.width * texture.height * 4) throw new Error('Invalid decoded texture.');
  if (vertices.length % 2 || uvs.length !== vertices.length || triangles.length % 3 || !vertices.every(Number.isFinite) || !uvs.every(Number.isFinite) || triangles.some(n => !Number.isInteger(n) || n < 0 || n * 2 >= vertices.length)) throw new Error('Invalid texture geometry.');
  const scale = 2, highWidth = width * scale, highHeight = height * scale, layer = new Uint8Array(highWidth * highHeight * 4);
  const edge = (ax: number, ay: number, bx: number, by: number, x: number, y: number) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const topLeft = (ax: number, ay: number, bx: number, by: number) => by < ay || by === ay && bx > ax;
  const inside = (e: number, owns: boolean) => e > 1e-8 || Math.abs(e) <= 1e-8 && owns;
  const tex = texture.pixels, tw = texture.width, th = texture.height;
  for (let index = 0; index < triangles.length; index += 3) {
    let a = triangles[index]!, b = triangles[index + 1]!, c = triangles[index + 2]!;
    let ax = vertices[a * 2]! * scale, ay = vertices[a * 2 + 1]! * scale,
      bx = vertices[b * 2]! * scale, by = vertices[b * 2 + 1]! * scale,
      cx = vertices[c * 2]! * scale, cy = vertices[c * 2 + 1]! * scale;
    let area = edge(ax, ay, bx, by, cx, cy);
    if (!Number.isFinite(area)) throw new Error('Texture triangle exceeds finite coordinates.');
    if (Math.abs(area) < 1e-10) continue;
    if (area < 0) { [b, c] = [c, b]; [bx, cx] = [cx, bx]; [by, cy] = [cy, by]; area = -area; }
    const ua = uvs[a * 2]!, va = uvs[a * 2 + 1]!, ub = uvs[b * 2]!, vb = uvs[b * 2 + 1]!, uc = uvs[c * 2]!, vc = uvs[c * 2 + 1]!;
    if (Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va)) * tw * th < 1e-10) continue;
    const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), maxX = Math.min(highWidth - 1, Math.floor(Math.max(ax, bx, cx) - 0.5)),
      minY = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), maxY = Math.min(highHeight - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    if (minX > maxX || minY > maxY) continue;
    budget.samples += (maxX - minX + 1) * (maxY - minY + 1);
    if (budget.samples > (budget.limit ?? 256_000_000)) throw new Error('Artwork texture sampling exceeds 256 million subpixel candidates. Lower dimensions, sample fewer poses or simplify overlapping geometry.');
    const ownA = topLeft(bx, by, cx, cy), ownB = topLeft(cx, cy, ax, ay), ownC = topLeft(ax, ay, bx, by), invArea = 1 / area;
    for (let y = minY; y <= maxY; y++) {
      let ea = edge(bx, by, cx, cy, minX + 0.5, y + 0.5), eb = edge(cx, cy, ax, ay, minX + 0.5, y + 0.5), ec = edge(ax, ay, bx, by, minX + 0.5, y + 0.5);
      for (let x = minX; x <= maxX; x++, ea -= cy - by, eb -= ay - cy, ec -= by - ay) {
        if (!inside(ea, ownA) || !inside(eb, ownB) || !inside(ec, ownC)) continue;
        const w1 = eb * invArea, w2 = ec * invArea, u = ua + (ub - ua) * w1 + (uc - ua) * w2, v = va + (vb - va) * w1 + (vc - va) * w2;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        const tx = Math.max(0, Math.min(tw - 1, u * tw - 0.5)), ty = Math.max(0, Math.min(th - 1, v * th - 0.5)), x0 = Math.floor(tx), y0 = Math.floor(ty), x1 = Math.min(tw - 1, x0 + 1), y1 = Math.min(th - 1, y0 + 1), fx = tx - x0, fy = ty - y0;
        const p00 = (y0 * tw + x0) * 4, p10 = (y0 * tw + x1) * 4, p01 = (y1 * tw + x0) * 4, p11 = (y1 * tw + x1) * 4,
          q00 = (1 - fx) * (1 - fy), q10 = fx * (1 - fy), q01 = (1 - fx) * fy, q11 = fx * fy;
        const alpha = tex[p00 + 3]! * q00 + tex[p10 + 3]! * q10 + tex[p01 + 3]! * q01 + tex[p11 + 3]! * q11;
        if (!alpha) continue;
        const out = (y * highWidth + x) * 4, back = 1 - alpha / 255;
        for (let component = 0; component < 3; component++) layer[out + component] = Math.round(tex[p00 + component]! * q00 + tex[p10 + component]! * q10 + tex[p01 + component]! * q01 + tex[p11 + component]! * q11 + layer[out + component]! * back);
        layer[out + 3] = Math.round(alpha + layer[out + 3]! * back);
      }
    }
  }
  const resolved = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * 2 * highWidth + x * 2) * 4, out = (y * width + x) * 4;
    for (let c = 0; c < 4; c++) resolved[out + c] = Math.round((layer[p + c]! + layer[p + 4 + c]! + layer[p + highWidth * 4 + c]! + layer[p + highWidth * 4 + 4 + c]!) / 4);
  }
  return resolved;
}
