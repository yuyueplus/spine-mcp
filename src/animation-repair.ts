import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import { Resvg } from '@resvg/resvg-js';
import type { SpineService } from './service.js';
import { filename, label, request, captureSource, verifySource, newFolder, writeCandidate } from './character-candidates.js';
import { parseDocument, writeDocument, object, type SpineDocument, type JsonObject } from './document.js';
import { footBakeSchema } from './stability-schema.js';
import { auditOptionsSchema } from './audit-schema.js';
import { auditAnimation } from './animation-audit.js';
import { animationSampler } from './animation-sampler.js';
import { insertBoundary } from './production-keyframes.js';
import { sampleArtwork, renderArtwork } from './scene-preview.js';
import { mediaSampleTimes } from './media-sampling.js';
import { encodePng } from './raster.js';
import { runProcess } from './cli.js';
import { operation } from './character-candidates.js';
import { constraintRepairFields, prepareConstraintRepair, verifyConstraintRepairWorld } from './constrained-repair.js';
import { coalesceBakingTimes } from './world-animation.js';

const finite = z.number().finite(), time = finite.min(0).max(300);
export const repairSchema = z.object({ ...request, ...constraintRepairFields, input: filename, animation: label, newName: label, skin: label.optional(), fps: z.number().int().min(1).max(120).default(60), contacts: footBakeSchema.pick({ chains: true, constraintMode: true, physics: true, tolerance: true, orientationToleranceDegrees: true }).optional(), rotations: z.array(z.object({ bone: label, min: finite.min(-720).max(720), max: finite.min(-720).max(720), start: time.default(0), end: time.optional() }).strict()).max(32).default([]), audits: z.array(auditOptionsSchema.omit({ animation: true, skin: true })).max(10).default([]), comparison: z.object({ start: time.default(0), end: time.optional(), fps: z.number().int().min(1).max(30).default(12), width: z.number().int().min(32).max(1024).default(320), height: z.number().int().min(32).max(1024).default(480), video: z.boolean().default(true) }).strict().default({ start: 0, fps: 12, width: 320, height: 480, video: true }) }).strict();

export function buildRepairData(source: SpineDocument, args: z.output<typeof repairSchema>) {
  if (!source.animations?.[args.animation] || Object.hasOwn(source.animations, args.newName)) throw new Error('Choose an existing source animation and a NEW candidate name.');
  if (!args.contacts && !args.rotations.length) throw new Error('Provide explicit contact windows or rotation limits; anatomy and contacts are not inferred.');
  const captured = prepareConstraintRepair(source, args); let data = captured.data;
  const contactVerification = captured.contactVerification;
  const baseline = structuredClone(data), sampler = animationSampler(baseline, args.newName, args.skin), duration = sampler.duration, windows: { bone: string; start: number; end: number; min: number; max: number }[] = [];
  for (const r of args.rotations) {
    const end = r.end ?? duration;
    if (r.min > r.max || end < r.start || end > duration || windows.some(w => w.bone === r.bone && r.start <= w.end && end >= w.start)) throw new Error('Rotation limits or windows are reversed, overlapping or outside the animation.');
    const runtimeBone = sampler.skeleton.bones.find(b => b.data.name === r.bone); if (!runtimeBone) throw new Error('Rotation repair bone is missing.');
    sampler.sample(r.start); if (!runtimeBone.active) throw new Error('Rotation repair requires an active bone in the selected skin.');
    const rotation = (t: number) => { sampler.sample(t); return runtimeBone.appliedPose.rotation - runtimeBone.data.setupPose.rotation; };
    for (const t of [r.start, end]) if (t > 0 && t < duration && (rotation(t) < r.min - 1e-6 || rotation(t) > r.max + 1e-6)) throw new Error('Interior repair boundaries must already satisfy limits to preserve outside motion. Widen the window.');
    const anim = data.animations![args.newName]!; anim.bones ??= {}; const channels = object(anim.bones, 'bones'); channels[r.bone] ??= {}; const boneTracks = object(channels[r.bone], 'bone tracks');
    let track = boneTracks.rotate as JsonObject[] | undefined;
    if (!track?.length) track = boneTracks.rotate = [{ time: 0, value: 0 }, ...(duration ? [{ time: duration, value: 0 }] : [])];
    if (Number(track[0]!.time ?? 0) > 0) track.unshift({ time: 0, value: 0, curve: 'stepped' });
    data = insertBoundary(data, args.newName, { kind: 'bone', bone: r.bone, channel: 'rotate' }, r.start);
    data = insertBoundary(data, args.newName, { kind: 'bone', bone: r.bone, channel: 'rotate' }, end);
    const target = object(object(data.animations![args.newName]!.bones, 'bones')[r.bone], 'tracks'), keys = target.rotate as JsonObject[], times = new Set([r.start, end]);
    for (let i = 0; i <= Math.ceil((end - r.start) * args.fps); i++) times.add(Math.min(end, r.start + i / args.fps));
    for (const k of keys) if (Number(k.time ?? 0) >= r.start && Number(k.time ?? 0) <= end) times.add(Number(k.time ?? 0));
    if (times.size * Math.max(1, args.rotations.length) > 200000) throw new Error('Rotation repair exceeds 200,000 sampled keys.');
    const tail = keys.find(k => Math.abs(Number(k.time ?? 0) - end) <= 1e-6), repaired = coalesceBakingTimes([...times]).map(t => ({ time: t, value: Math.max(r.min, Math.min(r.max, rotation(t))), ...(Math.abs(t - end) <= 1e-6 && tail?.curve !== undefined ? { curve: tail.curve } : {}) }));
    target.rotate = [...keys.filter(k => Number(k.time ?? 0) < r.start - 1e-6), ...repaired, ...keys.filter(k => Number(k.time ?? 0) > end + 1e-6)]; windows.push({ ...r, end });
  }
  data = parseDocument(data);
  const verification = animationSampler(data, args.newName, args.skin), original = animationSampler(baseline, args.newName, args.skin), count = Math.ceil(duration * args.fps * 2), times = new Set(Array.from({ length: count + 1 }, (_, i) => Math.min(duration, i / (args.fps * 2))));
  windows.forEach(w => { times.add(w.start); times.add(w.end); });
  if (times.size * data.bones.length * 2 > 500000) throw new Error('Rotation repair verification exceeds 500,000 bone samples.');
  let maxOutsideRotationError = 0, maxLimitExcess = 0;
  for (const t of [...times].sort((a, b) => a - b)) {
    const a = original.sample(t), b = verification.sample(t);
    for (const bone of new Set(windows.map(w => w.bone))) {
      const p = a.bones.find(x => x.data.name === bone)!, q = b.bones.find(x => x.data.name === bone)!, angle = q.appliedPose.rotation - q.data.setupPose.rotation, active = windows.find(w => w.bone === bone && t >= w.start && t <= w.end);
      if (active) maxLimitExcess = Math.max(maxLimitExcess, active.min - angle, angle - active.max, 0); else maxOutsideRotationError = Math.max(maxOutsideRotationError, Math.abs(p.appliedPose.rotation - q.appliedPose.rotation));
    }
  }
  if (Math.max(maxOutsideRotationError, maxLimitExcess) > 1e-4) throw new Error('Rotation repair verification failed; increase FPS or revise the repair windows.');
  for (const [name, anim] of Object.entries(source.animations)) if (JSON.stringify(data.animations![name]) !== JSON.stringify(anim)) throw new Error('Repair changed an existing animation.');
  const constraintWorldVerification = captured.didBake ? verifyConstraintRepairWorld(source, data, args, windows, [...times].sort((a, b) => a - b), captured.physicsCaptured) : null;
  return { data, report: { contactVerification, constraintBake: captured.constraintBake, constraintOrder: captured.order, physicsCaptured: captured.physicsCaptured, constraintWorldVerification, rotationWindows: windows, maxOutsideRotationError, maxLimitExcess, checkedSamples: times.size, existingAnimationsPreserved: true, originalBonesPreserved: JSON.stringify(data.bones) === JSON.stringify(source.bones) } };
}

export async function comparisonMedia(service: SpineService, data: SpineDocument, jsonPath: string, before: string, after: string, skin: string | undefined, opts: z.output<typeof repairSchema>['comparison'], physics = false, physicsFps = 60, afterPhysics = physics) {
  const duration = animationSampler(data, before, skin).duration, end = opts.end ?? duration;
  if (end <= opts.start || end > duration) throw new Error('Comparison requires a nonempty range inside the source animation.');
  const times = mediaSampleTimes(opts.start, end, opts.fps), width = opts.width * 2, height = opts.height + 28;
  if (times.length > 180 || times.length * width * height > 64_000_000 || width * height > 2_097_152 || opts.video && (width % 2 || height % 2)) throw new Error('Comparison exceeds 180 frames/64 million pixels, or video dimensions are odd.');
  if (times.length * data.bones.length * 2 > 200000 || times.length * (data.slots?.length ?? 0) * 2 > 30000) throw new Error('Comparison exceeds its geometry sampling budget.');
  if (physics && times.reduce((n, t) => n + Math.ceil(t * physicsFps), 0) * data.bones.length * 4 > 500000) throw new Error('Comparison exceeds its reset physics integration budget.');
  const viewport = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const animation of [before, after]) for (let i = 0; i < times.length; i += 8) {
    const art = await sampleArtwork(service.workspace, data, jsonPath, animation, times.slice(i, i + 8), skin, { physics: animation === before ? physics : afterPhysics, fps: physicsFps });
    for (const frame of art.frames) for (const s of frame.slots) if (s.vertices) for (let j = 0; j < s.vertices.length; j += 2) { viewport.minX = Math.min(viewport.minX, s.vertices[j]!); viewport.maxX = Math.max(viewport.maxX, s.vertices[j]!); viewport.minY = Math.min(viewport.minY, s.vertices[j + 1]!); viewport.maxY = Math.max(viewport.maxY, s.vertices[j + 1]!); }
  }
  if (!Number.isFinite(viewport.minX)) throw new Error('Comparison needs active artwork in the selected skin.');
  const folder = await newFolder(service, 'animation-comparisons'), files: string[] = [], header = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28"><rect width="100%" height="100%" fill="#172432"/><g fill="white" font-size="14"><text x="12" y="20">ORIGINAL</text><text x="${opts.width + 12}" y="20">CANDIDATE</text></g></svg>`, { font: { loadSystemFonts: true } }).render().pixels;
  for (let i = 0; i < times.length; i += 8) {
    const subset = times.slice(i, i + 8), strips = [];
    for (const animation of [before, after]) {
      const strip = await renderArtwork(service.workspace, data, jsonPath, animation, subset, skin, { clean: true, transparent: false, width: opts.width, height: opts.height, viewport, physics: animation === before ? physics : afterPhysics, fps: physicsFps });
      strips.push(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width * subset.length}" height="${opts.height}"><image width="100%" height="100%" href="data:image/png;base64,${(await readFile(strip.path)).toString('base64')}"/></svg>`).render().pixels);
    }
    for (let j = 0; j < subset.length; j++) {
      const pixels = new Uint8Array(width * height * 4); pixels.set(header);
      for (let side = 0; side < 2; side++) for (let y = 0; y < opts.height; y++) { const offset = (y * opts.width * subset.length + j * opts.width) * 4; pixels.set(strips[side]!.subarray(offset, offset + opts.width * 4), ((y + 28) * width + side * opts.width) * 4); }
      const file = path.join(folder, `frame-${String(files.length).padStart(4, '0')}.png`); await writeFile(file, encodePng(width, height, pixels), { flag: 'wx' }); files.push(file);
    }
  }
  const player = path.join(folder, 'compare.html'); await writeFile(player, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Animation comparison</title><style>body{background:#172432;color:white;font:16px sans-serif}img{max-width:100%}</style><button id="play">Play / pause</button><input id="seek" type="range" min="0" max="${files.length - 1}" value="0"><span id="time"></span><br><img id="frame" src="frame-0000.png"><script>const count=${files.length},fps=${opts.fps};let index=0,playing=false;const frame=document.getElementById('frame'),seek=document.getElementById('seek'),time=document.getElementById('time');function show(){frame.src='frame-'+String(index).padStart(4,'0')+'.png';seek.value=index;time.textContent=(index/fps+${opts.start}).toFixed(3)+'s'}document.getElementById('play').onclick=()=>playing=!playing;seek.oninput=()=>{index=Number(seek.value);show()};setInterval(()=>{if(playing){index=(index+1)%count;show()}},1000/fps);show()</script>`, { flag: 'wx' });
  let video: string | undefined;
  if (opts.video) {
    const ffmpeg = service.config.ffmpegExecutable ?? 'ffmpeg', ffprobe = service.config.ffprobeExecutable ?? 'ffprobe';
    if (/^[\\/]{2}|:\/\//.test(ffmpeg) || /^[\\/]{2}|:\/\//.test(ffprobe)) throw new Error('Comparison encoders must be local.');
    video = path.join(folder, 'comparison.mp4'); const r = await runProcess(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-threads', '2', '-framerate', String(opts.fps), '-i', path.join(folder, 'frame-%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], 120000, { cwd: folder });
    if (r.exitCode !== 0 || (await stat(video)).size > 64 * 1024 ** 2) throw new Error('Comparison video encoding failed: ' + r.stderr.slice(-1500));
    const probe = await runProcess(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', video], 30000, { cwd: folder }), stream = JSON.parse(probe.stdout).streams?.[0];
    if (probe.exitCode || stream?.width !== width || stream?.height !== height || Number(stream?.nb_read_frames) !== files.length) throw new Error('Comparison video size/frame verification failed.');
  }
  const manifest = path.join(folder, 'comparison.json'), report = { before, after, start: opts.start, end, fps: opts.fps, times, frameCount: files.length, width, height, viewport, player, poster: files[0]!, video, files, fixedSharedCamera: true, physics, afterPhysics, physicsFps, visualAcceptance: 'pending' };
  await writeFile(manifest, JSON.stringify(report, null, 2), { flag: 'wx' }); return { ...report, manifest };
}
export async function createAnimationRepair(service: SpineService, raw: z.input<typeof repairSchema>) {
  const args = repairSchema.parse(raw);
  return operation(service, args.requestId, 'animation_repair', args, async () => {
    const source = await captureSource(service, args.input), built = buildRepairData(source.data, args), folder = await newFolder(service, 'animation-repairs'), json = (await writeDocument(service.workspace, path.join(folder, 'candidate.json'), built.data, path.dirname(source.jsonPath))).path;
    const audits: any[] = [...args.audits];
    for (const r of built.report.rotationWindows) audits.push({ start: r.start, end: r.end, fps: args.fps, physics: built.report.physicsCaptured, physicsFps: args.fps, joints: [{ bone: r.bone, min: r.min, max: r.max }], meshes: false, preview: 'none' });
    if (args.contacts) audits.push({ fps: args.fps, physics: args.physics || args.contacts.physics, physicsFps: args.fps, meshes: false, preview: 'none', contacts: args.contacts.chains.flatMap(c => c.contacts.map(w => ({ ...w, bone: c.foot, tolerance: args.contacts!.tolerance }))) });
    if (audits.length > 42) throw new Error('Too many repair audit profiles.');
    const before = [], after = [];
    for (const profile of audits) { before.push(await auditAnimation(service, { input: json, options: { ...profile, animation: args.animation, skin: args.skin } })); after.push(await auditAnimation(service, { input: json, options: { ...profile, ...(built.report.constraintBake ? { physics: false } : {}), animation: args.newName, skin: args.skin } })); }
    const beforePhysics = args.physics || Boolean(args.contacts?.physics), afterPhysics = built.report.constraintBake ? false : beforePhysics;
    const comparison = await comparisonMedia(service, parseDocument(JSON.parse(await readFile(json, 'utf8'))), json, args.animation, args.newName, args.skin, args.comparison, beforePhysics, args.fps, afterPhysics); await verifySource(service, source.source);
    const checksPassed = after.every(a => a.checksPassed && !a.findingsTruncated);
    return writeCandidate(service, 'animation_repair', json, source.source, { animation: args.animation, newName: args.newName, verification: built.report, before, after, comparison, checksPassed, note: 'Explicit rule-driven local repair candidates. Contact windows, anatomy and visual acceptance are not inferred. Existing animations remain selectable and unchanged.' }, checksPassed, [...before.map(a => a.reportPath), ...after.map(a => a.reportPath), comparison.manifest, comparison.player, ...comparison.files, ...(comparison.video ? [comparison.video] : [])]);
  });
}
