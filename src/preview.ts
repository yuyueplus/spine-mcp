import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { SpineDocument } from './document.js';
import type { Workspace } from './config.js';
import { sampleSkeleton, escapeXml, boneDiagramLoader, type PreviewOptions } from './runtime.js';

export interface BoneSample { name: string; x: number; y: number; endX: number; endY: number; rotation: number }
export function samplePose(data: SpineDocument, animation: string | undefined, time: number, skin?: string, options: PreviewOptions = {}): BoneSample[] {
  const skeleton = sampleSkeleton(data, animation, time, skin, boneDiagramLoader, options);
  return skeleton.bones.filter(bone => bone.active).map(bone => {
    const p = bone.appliedPose;
    const result = { name: bone.data.name, x: p.worldX, y: p.worldY, endX: p.worldX + p.a * bone.data.length, endY: p.worldY + p.c * bone.data.length, rotation: p.getWorldRotationX() };
    if (![result.x, result.y, result.endX, result.endY, result.rotation].every(Number.isFinite)) throw new Error(`Preview produced a non-finite transform for ${bone.data.name}.`);
    return result;
  });
}

export async function renderPreview(workspace: Workspace, data: SpineDocument, animation: string | undefined, times: number[], skin?: string, options: PreviewOptions = {}) {
  if (!times.length || times.length > 8) throw new Error('Provide one to eight preview times.');
  const frames = times.map(time => ({ time, bones: samplePose(data, animation, time, skin, options) }));
  const panelWidth = 320, height = 280, pad = 32;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const frame of frames) for (const b of frame.bones) {
    minX = Math.min(minX, b.x, b.endX); maxX = Math.max(maxX, b.x, b.endX);
    minY = Math.min(minY, b.y, b.endY); maxY = Math.max(maxY, b.y, b.endY);
  }
  if (options.viewport) ({ minX, maxX, minY, maxY } = options.viewport);
  const zoom = Math.min((panelWidth - pad * 2) / Math.max(maxX - minX, 1), (height - 100) / Math.max(maxY - minY, 1), 3);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const panels = frames.map((frame, index) => {
    const px = (x: number) => index * panelWidth + panelWidth / 2 + (x - cx) * zoom;
    const py = (y: number) => height / 2 + 12 - (y - cy) * zoom;
    const bones = frame.bones.map(b => `<line x1="${px(b.x)}" y1="${py(b.y)}" x2="${px(b.endX)}" y2="${py(b.endY)}" stroke="#55dfad" stroke-width="5" stroke-linecap="round"/><circle cx="${px(b.x)}" cy="${py(b.y)}" r="4" fill="#e6fcf5"/>${frame.bones.length <= 30 ? `<text x="${px(b.endX) + 5}" y="${py(b.endY) - 8}" fill="#b7c9c2" font-size="12">${escapeXml(b.name)}</text>` : ''}`).join('');
    return `<rect x="${index * panelWidth + 1}" y="1" width="${panelWidth - 2}" height="${height - 2}" rx="12" fill="#17241f"/><text x="${index * panelWidth + 18}" y="28" fill="#e6fcf5" font-size="15">${escapeXml(animation ?? 'Setup pose')} · ${frame.time.toFixed(3)} s</text>${bones}<text x="${index * panelWidth + 18}" y="${height - 18}" fill="#91aaa0" font-size="11">Bone diagram · physics ${options.physics ? 'on' : 'off'}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth * times.length}" height="${height}" font-family="Arial,sans-serif"><rect width="100%" height="100%" fill="#101a16"/>${panels}</svg>`;
  const png = new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
  const directory = await workspace.resolve('previews', false);
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, `pose-${randomUUID()}.png`);
  await writeFile(output, png, { flag: 'wx' });
  return { path: output, mimeType: 'image/png', data: png.toString('base64'), animation: animation ?? null, frames, physics: Boolean(options.physics), previewRuntime: '@esotericsoftware/spine-core 4.3.13', note: 'Headless bone diagram. Artwork and meshes are omitted. Optional physics is simulated from a reset at time zero; runtime package patch differs from editor 4.3.23.' };
}
