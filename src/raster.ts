import { deflateSync } from 'node:zlib';
function chunk(type: string, bytes: Buffer) {
  const input = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
  for (const byte of input) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, input, checksum]);
}
export function encodePng(width: number, height: number, rgba: Uint8Array) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_777_216 || rgba.length !== width * height * 4) throw new Error('Invalid output raster dimensions.');
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
// resvg pixels are premultiplied RGBA; the destination preview is opaque.
export function compositeOpaque(destination: Uint8Array, source: Uint8Array, blend: string) {
  for (let index = 0; index < destination.length; index += 4) {
    const alpha = source[index + 3]! / 255; if (!alpha) continue;
    for (let component = 0; component < 3; component++) {
      const src = source[index + component]! / 255, dst = destination[index + component]! / 255;
      const value = blend === 'additive' ? src + dst : blend === 'multiply' ? src * dst + dst * (1 - alpha) : blend === 'screen' ? src + dst - src * dst : src + dst * (1 - alpha);
      destination[index + component] = Math.round(Math.max(0, Math.min(1, value)) * 255);
    }
    destination[index + 3] = 255;
  }
}

// Source pixels from resvg are premultiplied; PNG output is straight RGBA.
export function compositeRgba(destination: Uint8Array, source: Uint8Array, blend: string) {
  if (destination.length !== source.length || destination.length % 4) throw new Error('RGBA raster sizes differ.');
  for (let index = 0; index < destination.length; index += 4) {
    const alpha = source[index + 3]! / 255; if (!alpha) continue;
    const backAlpha = destination[index + 3]! / 255, outAlpha = blend === 'additive' ? Math.min(1, alpha + backAlpha) : alpha + backAlpha * (1 - alpha);
    for (let component = 0; component < 3; component++) {
      const src = source[index + component]! / 255, dst = destination[index + component]! / 255, straight = src / alpha;
      const mixed = blend === 'multiply' ? straight * dst : blend === 'screen' ? straight + dst - straight * dst : straight;
      const premultiplied = blend === 'additive' ? src + dst * backAlpha : src * (1 - backAlpha) + dst * backAlpha * (1 - alpha) + mixed * alpha * backAlpha;
      destination[index + component] = Math.round(Math.max(0, Math.min(1, premultiplied / outAlpha)) * 255);
    }
    destination[index + 3] = Math.round(outAlpha * 255);
  }
}
export function unpremultiplyRgba(pixels: Uint8Array) {
  if (pixels.length % 4) throw new Error('Invalid RGBA pixels.');
  for (let i = 0; i < pixels.length; i += 4) for (let component = 0; component < 3; component++) pixels[i + component] = pixels[i + 3] ? Math.min(255, Math.round(pixels[i + component]! * 255 / pixels[i + 3]!)) : 0;
  return pixels;
}
