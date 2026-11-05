import { crc32 } from 'node:zlib';

/** Add a valid private ancillary chunk BEFORE IEND. Pixels, color metadata and
 * compressed image data are unchanged. Constant file lengths avoid length-
 * stability debounce restarting for every animation frame. No trailing junk. */
export function padPreviewPng(png: Buffer, length: number) {
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND') throw new Error('Expected a complete encoded PNG.');
  if (!Number.isInteger(length) || length < png.length + 12 || length > 16 * 1024 * 1024) throw new Error('Invalid padded PNG size.');
  const extra = Buffer.alloc(length - png.length), dataLength = extra.length - 12;
  extra.writeUInt32BE(dataLength); extra.write('npAD', 4, 4, 'ascii'); extra.writeUInt32BE(crc32(extra.subarray(4, -4)), extra.length - 4);
  return Buffer.concat([png.subarray(0, -12), extra, png.subarray(-12)]);
}
