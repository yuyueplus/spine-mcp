import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import type { SpineService } from './service.js';
import type { FrameOptions } from './frames.js';
import { runProcess } from './cli.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { checkpoint, type WorkControl } from './progress.js';
import { mediaSampleTimes } from './media-sampling.js';

export type MediaFormat = 'apng' | 'gif' | 'mp4' | 'spritesheet';
export interface MediaOptions extends FrameOptions { formats: MediaFormat[]; columns?: number; rows?: number; plays?: number; crf?: number; omitEndFrame?: boolean }
function executable(configured: string | null | undefined, name: string) { const value = configured ?? (process.platform === 'win32' ? `${name}.exe` : name); if (/^[\\/]{2}|:\/\//.test(value)) throw new Error('Media executable must be local.'); return value; }
async function checked(exe: string, args: string[], cwd: string) { const result = await runProcess(exe, args, 120000, { cwd }); if (result.exitCode !== 0) throw new Error(`Media encoder failed (${result.exitCode}): ${(result.stderr || result.stdout).slice(-2000)}`); return result; }
export async function mediaStatus(service: SpineService) {
  const tools: Record<string, unknown> = {};
  for (const [name, configured] of [['ffmpeg', service.config.ffmpegExecutable], ['ffprobe', service.config.ffprobeExecutable]] as const) { try { const result = await checked(executable(configured, name), ['-version'], service.workspace.root); tools[name] = { available: true, version: result.stdout.split(/\r?\n/)[0], configured: !!configured }; } catch (error) { tools[name] = { available: false, error: (error as Error).message }; } }
  return { tools, cpuEncoding: true, editorWindowRequired: false, formats: ['apng', 'gif', 'mp4', 'spritesheet'], bundledEncoder: false };
}
export async function exportMedia(service: SpineService, input: string, options: MediaOptions, skeletonName?: string, control?: WorkControl) {
  if (options.kind !== 'artwork') throw new Error('Media export renders clean artwork. Use export_frames for bone diagrams.');
  if (!options.formats.length || options.formats.length > 4 || new Set(options.formats).size !== options.formats.length || options.formats.some(format => !['apng', 'gif', 'mp4', 'spritesheet'].includes(format))) throw new Error('Select distinct supported media formats.');
  const columns = options.columns ?? 8, rows = options.rows ?? 8, plays = options.plays ?? 0, crf = options.crf ?? 18;
  if (![columns, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 16) || !Number.isInteger(plays) || plays < 0 || plays > 65535 || !Number.isInteger(crf) || crf < 0 || crf > 51) throw new Error('Invalid sprite layout, play count or CRF.');
  const encoder = executable(service.config.ffmpegExecutable, 'ffmpeg'), probe = executable(service.config.ffprobeExecutable, 'ffprobe');
  await checked(encoder, ['-version'], service.workspace.root); await checked(probe, ['-version'], service.workspace.root);
  const source = await service.workspace.resolve(input), hash = await fileSha256(source), loaded = await service.load(source, skeletonName), snapshot = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false);
  const sampling = mediaSampleTimes(options.start, options.end, options.fps, options.omitEndFrame !== false);
  const { exportFrames } = await import('./frames.js'); const frames = await exportFrames(service.workspace, loaded.data, loaded.jsonPath, { ...options, clean: true, transparent: options.transparent ?? true }, control, sampling), sourceManifest = JSON.parse(await readFile(frames.manifestPath, 'utf8')) as { times: number[] };
  const count = frames.frameCount;
  const directory = await service.workspace.resolve(path.join('previews', `media-${randomUUID()}`), false); await mkdir(directory, { recursive: true });
  const inputArgs = ['-framerate', String(options.fps), '-start_number', '0', '-i', path.join(frames.directory, 'frame-%04d.png')], common = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-threads', '2', '-filter_threads', '2', '-filter_complex_threads', '2'], outputs: { format: MediaFormat; path: string; bytes: number; sha256: string; probe?: unknown }[] = [];
  let bytes = 0;
  const record = async (format: MediaFormat, file: string, inspect = true) => {
    const size = (await stat(file)).size; bytes += size; if (!size || size > 64 * 1024 * 1024 || bytes > 128 * 1024 * 1024) throw new Error('Media exceeds 64 MiB per file or 128 MiB total.');
    let details: unknown; if (inspect) { const result = await checked(probe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,duration:format=duration', '-of', 'json', file], directory); details = JSON.parse(result.stdout); const stream = (details as any).streams?.[0]; if (!stream || stream.width !== frames.width || stream.height !== frames.height || Number(stream.nb_read_frames) !== count) throw new Error(`Encoded ${format} frame count or size differs from the source sequence.`); }
    outputs.push({ format, path: file, bytes: size, sha256: await fileSha256(file), ...(details ? { probe: details } : {}) });
  };
  for (let index = 0; index < options.formats.length; index++) {
    const format = options.formats[index]!; await checkpoint(control, { phase: `encode:${format}`, completed: index, total: options.formats.length });
    if (format === 'spritesheet') {
      if (columns * frames.width > 8192 || rows * frames.height > 8192 || columns * rows * frames.width * frames.height > 16_777_216) throw new Error('Sprite page exceeds 8192 pixels per side or 16 megapixels.');
      const pages: { image: string; frames: { index: number; time: number; x: number; y: number; width: number; height: number }[] }[] = [], perPage = columns * rows;
      for (let start = 0; start < count; start += perPage) { const length = Math.min(perPage, count - start), file = path.join(directory, `sprites-${String(pages.length).padStart(3, '0')}.png`); await checked(encoder, [...common, '-start_number', String(start), '-i', path.join(frames.directory, 'frame-%04d.png'), '-vf', `tile=${columns}x${rows}:nb_frames=${length}`, '-frames:v', '1', '-threads', '2', file], directory); const header = await readFile(file); if (header.readUInt32BE(16) !== columns * frames.width || header.readUInt32BE(20) !== rows * frames.height) throw new Error('Sprite page dimensions differ.'); await record(format, file, false); pages.push({ image: path.basename(file), frames: Array.from({ length }, (_, i) => ({ index: start + i, time: sourceManifest.times[start + i]!, x: i % columns * frames.width, y: Math.floor(i / columns) * frames.height, width: frames.width, height: frames.height })) }); }
      await writeFile(path.join(directory, 'sprites.json'), JSON.stringify({ fps: options.fps, frameCount: count, columns, rows, pages }, null, 2), { flag: 'wx' });
    } else {
      if (format === 'mp4' && (frames.width % 2 || frames.height % 2)) throw new Error('H.264/YUV420 MP4 requires even output width and height.');
      const file = path.join(directory, `animation.${format === 'apng' ? 'apng' : format}`), tail = format === 'mp4' ? ['-filter_complex', '[0:v]split[fg][bg];[bg]lutrgb=r=0:g=0:b=0,format=rgb24[black];[black][fg]overlay=shortest=1:format=rgb[out]', '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-movflags', '+faststart'] : format === 'gif' ? ['-filter_complex', '[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=sierra2_4a', '-loop', String(plays)] : ['-f', 'apng', '-plays', String(plays), '-pix_fmt', 'rgba'];
      await checked(encoder, [...common, ...inputArgs, '-frames:v', String(count), ...tail, '-threads', '2', file], directory); await record(format, file);
    }
  }
  await assertSnapshot(snapshot); if (await fileSha256(source) !== hash) throw new Error('Media source changed during rendering.');
  const manifestPath = path.join(directory, 'media.json'), manifest = { schemaVersion: 1, complete: true, input: source, sourceHash: hash, frameManifest: frames.manifestPath, frameCount: count, fps: options.fps, requestedDuration: options.end - options.start, encodedDuration: count / options.fps, endpointOmitted: sourceManifest.times.at(-1) !== options.end, width: frames.width, height: frames.height, cpuRendering: true, cpuEncoding: true, outputs, options, note: 'CPU preview imagery and fixed-frame-rate encoding. GIF timing and palette are quantized, MP4 uses lossy H.264/YUV. No editor window, GPU context, audio playback or input control.' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' }); await checkpoint(control, { phase: 'complete', completed: options.formats.length, total: options.formats.length });
  return { directory, manifestPath, frameCount: count, fps: options.fps, encodedDuration: count / options.fps, files: outputs.map(output => output.path), outputs, complete: true };
}
