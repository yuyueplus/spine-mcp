import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Workspace } from './config.js';
import { writeDocument, type SpineDocument } from './document.js';

function chunk(type: string, data: Buffer): Buffer {
  const input = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([prefix, input, suffix]);
}
function demoPng(): Buffer {
  const width = 120, height = 24;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * (width * 4 + 1) + 1 + x * 4;
    const edge = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
    pixels.set(edge ? [35, 61, 57, 255] : [65, 211, 157, 255], i);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export async function createDemo(workspace: Workspace) {
  const directory = await workspace.resolve(`demo-${randomUUID().slice(0, 8)}`, false);
  await mkdir(path.join(directory, 'images'), { recursive: true });
  await writeFile(path.join(directory, 'images', 'arm.png'), demoPng(), { flag: 'wx' });
  const data: SpineDocument = {
    skeleton: { spine: '4.3.23', x: 0, y: -12, width: 120, height: 24, images: './images/', fps: 30 },
    bones: [{ name: 'root' }, { name: 'arm', parent: 'root', length: 120 }],
    slots: [{ name: 'arm-slot', bone: 'arm', attachment: 'arm' }],
    skins: [{ name: 'default', attachments: { 'arm-slot': { arm: { x: 60, width: 120, height: 24 } } } }],
    animations: {},
  };
  const result = await writeDocument(workspace, path.join(directory, 'base.json'), data);
  return { ...result, directory, images: path.join(directory, 'images') };
}
