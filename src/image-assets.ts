import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Workspace } from './config.js';
import type { SpineDocument } from './document.js';
import { setRegion, type RegionTransform } from './slot-edits.js';
import { colorRgba } from './slot-data.js';

export async function readPngAsset(workspace: Workspace, filename: string) {
  const resolved = await workspace.resolve(filename);
  if (path.extname(resolved).toLowerCase() !== '.png') throw new Error('This image workflow currently supports PNG files only.');
  const info = await stat(resolved);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('PNG must be a regular file no larger than 16 MiB.');
  const bytes = await readFile(resolved);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG header.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216) throw new Error('PNG dimensions exceed the preview limit (8192 per side, 16 megapixels total).');
  return { path: resolved, width, height, bytes };
}
export async function imagesRoot(workspace: Workspace, data: SpineDocument, jsonPath: string) {
  const images = data.skeleton.images;
  if (images !== undefined && typeof images !== 'string') throw new Error('skeleton.images must be a local directory path.');
  return workspace.resolve(path.resolve(path.dirname(jsonPath), (images as string | undefined) || '.'));
}
export async function attachImage(workspace: Workspace, data: SpineDocument, jsonPath: string, skin: string, slot: string, name: string, image: string, transform: RegionTransform = {}, replace = false, setAsSetup = false) {
  const root = await imagesRoot(workspace, data, jsonPath), asset = await readPngAsset(workspace, image);
  const relative = path.relative(root, asset.path);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Image must be inside the skeleton images directory. No assets were copied or changed.');
  // The editor restores region width/height from the PNG when importing. Encode
  // requested display dimensions in scale instead, so JSON and .spine agree.
  const { width, height, ...pose } = transform;
  const region = {
    path: relative.slice(0, -4).replaceAll('\\', '/'), width: asset.width, height: asset.height, ...pose,
    ...(width === undefined ? {} : { scaleX: (pose.scaleX ?? 1) * width / asset.width }),
    ...(height === undefined ? {} : { scaleY: (pose.scaleY ?? 1) * height / asset.height }),
  };
  if (region.color !== undefined) region.color = colorRgba(region.color);
  return setRegion(data, skin, slot, name, region, replace, setAsSetup);
}
