import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { Workspace } from './config.js';
import type { SpineDocument } from './document.js';
import { sampleTimes } from './advanced-animation.js';
import { renderArtwork, sampleArtwork } from './scene-preview.js';
import { renderPreview, samplePose } from './preview.js';
import { encodePng, unpremultiplyRgba } from './raster.js';
import { checkpoint, type WorkControl } from './progress.js';

export interface FrameOptions { animation?: string; skin?: string; start: number; end: number; fps: number; kind: 'artwork' | 'bones'; physics?: boolean; clean?: boolean; transparent?: boolean; width?: number; height?: number }
export async function exportFrames(workspace: Workspace, data: SpineDocument, jsonPath: string, options: FrameOptions, control?: WorkControl, mediaTimes?: readonly number[]) {
  const times = mediaTimes ? [...mediaTimes] : sampleTimes(options.start, options.end, options.fps, 300), groups = Math.ceil(times.length / 8);
  if (!times.length || times.length > 300 || times.some((time, index) => !Number.isFinite(time) || time < options.start || time > options.end || index > 0 && time <= times[index - 1]!)) throw new Error('Frame sampling must contain 1–300 strictly ordered times inside the requested interval.');
  const clean = options.kind === 'artwork' && options.clean, width = clean ? options.width ?? 320 : 320, height = clean ? options.height ?? 300 : options.kind === 'artwork' ? 300 : 280;
  if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 4096) || width * height > 2_097_152 || times.length * width * height > 64_000_000) throw new Error('Frame dimensions exceed two megapixels per frame or 64 million output pixels.');
  if (times.length * data.bones.length > 200000 || times.length * (data.slots?.length ?? 0) > 30000) throw new Error('Frame export exceeds the geometry sample budget. Lower FPS or shorten the range.');
  if (options.physics && times.reduce((sum, time) => sum + Math.ceil(time * options.fps), 0) * data.bones.length * 2 > 500000) throw new Error('Physics frame export exceeds the simulation budget. Lower FPS or shorten the range.');
  const viewport = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (x: number, y: number) => { viewport.minX = Math.min(viewport.minX, x); viewport.maxX = Math.max(viewport.maxX, x); viewport.minY = Math.min(viewport.minY, y); viewport.maxY = Math.max(viewport.maxY, y); };
  for (let group = 0; group < groups; group++) {
    await checkpoint(control, { phase: 'measure', completed: group, total: groups });
    const subset = times.slice(group * 8, group * 8 + 8);
    if (options.kind === 'artwork') {
      const { frames } = await sampleArtwork(workspace, data, jsonPath, options.animation, subset, options.skin, options);
      for (const frame of frames) for (const slot of frame.slots) if (slot.vertices) for (let index = 0; index < slot.vertices.length; index += 2) include(slot.vertices[index]!, slot.vertices[index + 1]!);
    } else for (const time of subset) for (const bone of samplePose(data, options.animation, time, options.skin, options)) { include(bone.x, bone.y); include(bone.endX, bone.endY); }
  }
  if (!Number.isFinite(viewport.minX)) Object.assign(viewport, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  const directory = await workspace.resolve(path.join('previews', `frames-${randomUUID()}`), false); await mkdir(directory, { recursive: true });
  const files: string[] = [];
  for (let group = 0; group < groups; group++) {
    await checkpoint(control, { phase: 'render', completed: group * 8, total: times.length });
    const subset = times.slice(group * 8, group * 8 + 8), settings = { ...options, viewport };
    const strip = options.kind === 'artwork' ? await renderArtwork(workspace, data, jsonPath, options.animation, subset, options.skin, settings) : await renderPreview(workspace, data, options.animation, subset, options.skin, settings);
    const raster = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width * subset.length}" height="${height}"><image width="100%" height="100%" href="data:image/png;base64,${(await readFile(strip.path)).toString('base64')}"/></svg>`).render();
    for (let index = 0; index < subset.length; index++) {
      const pixels = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row++) { const offset = (row * width * subset.length + index * width) * 4; pixels.set(raster.pixels.subarray(offset, offset + width * 4), row * width * 4); }
      if (clean && options.transparent) unpremultiplyRgba(pixels);
      const file = path.join(directory, `frame-${String(files.length).padStart(4, '0')}.png`); await writeFile(file, encodePng(width, height, pixels), { flag: 'wx' }); files.push(file);
    }
  }
  await checkpoint(control, { phase: 'publish', completed: times.length, total: times.length });
  const manifest = { ...options, frameCount: files.length, times, endpointIncluded: times.at(-1) === options.end, width, height, viewport, frames: files.map(file => path.basename(file)), note: 'Fixed viewport across frames; CPU runtime preview. Exact sampling times and endpoint inclusion are recorded. No editor window or audio playback.' };
  const manifestPath = path.join(directory, 'frames.json'); await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  const player = path.join(directory, 'player.html');
  // All dynamic values below are numeric or generated filenames. User animation
  // names are deliberately excluded from executable HTML.
  await writeFile(player, `<!doctype html><meta charset="utf-8"><title>Spine preview</title><style>body{margin:32px;background:#121c27;color:#edf6ff;font:16px system-ui}img{display:block;margin-bottom:20px}button,input{margin-right:12px}p{color:#b3c3d4}</style><img id="frame" width="${width}" height="${height}" src="frame-0000.png"><button id="play">Pause</button><input id="seek" type="range" min="0" max="${files.length - 1}" value="0"><span id="time"></span><p>Local preview · ${options.fps} FPS · ${files.length} frames</p><script>const times=${JSON.stringify(times)},count=times.length,img=document.getElementById('frame'),seek=document.getElementById('seek'),label=document.getElementById('time');let index=0,playing=true;function show(){img.src='frame-'+String(index).padStart(4,'0')+'.png';seek.value=index;label.textContent=times[index].toFixed(3)+' s'}document.getElementById('play').onclick=function(){playing=!playing;this.textContent=playing?'Pause':'Play'};seek.oninput=()=>{index=Number(seek.value);show()};setInterval(()=>{if(playing){index=(index+1)%count;show()}},${1000 / options.fps});show()</script>`, { flag: 'wx' });
  return { directory, manifestPath, player, frameCount: files.length, files, width, height, viewport };
}
