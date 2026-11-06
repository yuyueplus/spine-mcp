import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { configSchema, projectRoot } from '../src/config.js';
import { VERSION } from '../src/version.js';

const args = process.argv.slice(2), flags = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) { const flag = args[index], value = args[index + 1]; if (!flag || !['--config', '--output', '--workspace', '--cli', '--gui', '--ffmpeg', '--ffprobe', '--native-dir'].includes(flag) || !value || value.startsWith('--')) throw new Error('Usage: npm run setup -- --output NEW.json [--config OLD.json] [--workspace LOCAL_DIR] [--cli Spine.com] [--gui Spine.exe] [--ffmpeg ffmpeg.exe] [--ffprobe ffprobe.exe] [--native-dir NATIVE_PACKAGE_DIR]'); flags.set(flag, value); }
let previous: Record<string, unknown> = {}; if (flags.has('--config')) {
  const source = path.resolve(flags.get('--config')!); previous = JSON.parse((await readFile(source, 'utf8')).replace(/^\uFEFF/, ''));
  for (const field of ['workspaceRoot', 'cliExecutable', 'guiExecutable', 'ffmpegExecutable', 'ffprobeExecutable']) if (typeof previous[field] === 'string') previous[field] = path.resolve(path.dirname(source), previous[field]);
  for (const field of ['cliRuntimeDiscovery', 'guiRuntimeDiscovery']) {
    const discovery = previous[field];
    if (discovery && typeof discovery === 'object' && 'root' in discovery && typeof discovery.root === 'string') discovery.root = path.resolve(path.dirname(source), discovery.root);
  }
}
if (previous.nativeRenderer && typeof previous.nativeRenderer==='object') { const n=previous.nativeRenderer as Record<string,unknown>; for(const k of ['workerExecutable','roomServerExecutable','nativeLibrary'])if(typeof n[k]==='string')n[k]=path.resolve(path.dirname(path.resolve(flags.get('--config')!)),n[k] as string); }
if(flags.has('--native-dir')){const dir=path.resolve(flags.get('--native-dir')!),ext=process.platform==='win32'?'.exe':'';previous.nativeRenderer={workerExecutable:path.join(dir,'spine-worker'+ext),roomServerExecutable:path.join(dir,'spine-roomd'+ext),nativeLibrary:path.join(dir,process.platform==='win32'?'spine-bgfx.dll':process.platform==='darwin'?'libspine-bgfx.dylib':'libspine-bgfx.so'),slots:[{id:'local',capacity:1,memoryMB:1024}],queueLimit:16};}
if (flags.has('--gui')) delete previous.guiRuntimeDiscovery;
const config = configSchema.parse({ ...previous, schemaVersion: 1, ...(flags.has('--workspace') ? { workspaceRoot: path.resolve(flags.get('--workspace')!) } : {}), ...(flags.has('--cli') ? { cliExecutable: path.resolve(flags.get('--cli')!) } : {}), ...(flags.has('--gui') ? { guiExecutable: path.resolve(flags.get('--gui')!) } : {}), ...(flags.has('--ffmpeg') ? { ffmpegExecutable: path.resolve(flags.get('--ffmpeg')!) } : {}), ...(flags.has('--ffprobe') ? { ffprobeExecutable: path.resolve(flags.get('--ffprobe')!) } : {}) });
for (const filename of [config.workspaceRoot, config.cliExecutable, config.guiExecutable, config.guiRuntimeDiscovery?.root, config.ffmpegExecutable, config.ffprobeExecutable]) if (filename && /^[\\/]{2}/.test(filename)) throw new Error('Use local disks for workspace and executables.');
const output = path.resolve(flags.get('--output') ?? path.join(projectRoot, 'spine.generated.json')); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(config, null, 2), { flag: 'wx' }); await mkdir(config.workspaceRoot, { recursive: true });
console.log(JSON.stringify({ version: VERSION, config: output, migratedFrom: flags.get('--config') ?? null, previousConfigUnchanged: true, profile: 'spine-4.3.23', mcpServer: { command: process.execPath, args: [path.join(projectRoot, 'dist/src/index.js')], env: { SPINE_MCP_CONFIG: output } } }, null, 2));
