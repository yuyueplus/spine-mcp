import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { projectRoot } from '../src/config.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION } from '../src/version.js';
import { verifyNativeBridgeBundle } from '../src/native-editor-bridge.js';
import { productCompletionStatus } from '../src/product-catalog.js';
const evidence=await productCompletionStatus();
const unverifiedTest=process.argv.includes('--unverified-test');
if(!unverifiedTest&&(!evidence.codeMatchesEvidence||!evidence.nativeBridgeEvidenceMatches||evidence.verification?.localSupportedScopePassed!==true))throw Error('Release needs matching current-source, current-bridge and local-scope verification. Pending external hardware checks may remain explicit.');
const nativeBundle=await verifyNativeBridgeBundle();
const directory = path.join(projectRoot, 'releases', `spine-mcp-${VERSION}-${randomUUID().slice(0, 8)}`); await mkdir(directory, { recursive: true });
for (const name of ['dist/src', 'dist/scripts', 'dist/test', 'src', 'scripts', 'examples', 'test', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'COMPLETION-PLAN.json', 'EXTENSION-PLAN.json', 'VERIFICATION.json', 'SUPPORT.json', 'RESEARCH.json', 'THIRD_PARTY_SPINE_LICENSE.txt', 'THIRD_PARTY_PNGJS_LICENSE.txt', 'THIRD_PARTY_AG_PSD_LICENSE.txt']) await cp(path.join(projectRoot, name), path.join(directory, name), { recursive: true, errorOnExist: true, force: false });
for(const name of ['bundle.json','spine-editor-bridge.jar','README.md',...nativeBundle.sources.map(s=>s.path)]){const target=path.join(directory,'native-bridge',name);await mkdir(path.dirname(target),{recursive:true});await cp(path.join(projectRoot,'native-bridge',name),target,{errorOnExist:true,force:false});}
await writeFile(path.join(directory, 'spine.local.json'), JSON.stringify({ schemaVersion: 1, targetVersion: '4.3.23', workspaceRoot: './work', cliExecutable: null, guiExecutable: null, cliTimeoutMs: 60000 }, null, 2), { flag: 'wx' });
await writeFile(path.join(directory, 'verify-release.mjs'), `import path from 'node:path';
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<2))throw Error('Node.js22.2 or newer is required.');
const root=path.dirname(fileURLToPath(import.meta.url)),manifest=JSON.parse(await readFile(path.join(root,'release-manifest.json'),'utf8')),base=await realpath(root);
if(!Array.isArray(manifest.files)||manifest.files.length>20000)throw Error('Invalid release inventory');
for(const f of manifest.files){const file=path.resolve(root,f.path),rel=path.relative(base,await realpath(file));if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Release path escape');if(createHash('sha256').update(await readFile(file)).digest('hex')!==f.sha256)throw Error('Changed release file: '+f.path);}
console.log('Verified '+manifest.files.length+' release files. Local integrity only; obtain the package from a trusted source.');
`,{flag:'wx'});
await writeFile(path.join(directory, 'Install.ps1'), "param([switch]$SkipPsdRaster)\n$ErrorActionPreference = 'Stop'\nSet-Location -LiteralPath $PSScriptRoot\nnode verify-release.mjs\nif ($LASTEXITCODE -ne 0) { throw 'Release integrity verification failed.' }\nnpm ci --omit=dev --no-audit --no-fund\nif ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }\nif (-not $SkipPsdRaster) { npm run setup:psd-raster; if ($LASTEXITCODE -ne 0) { throw 'PSD raster setup failed. Install Python 3.11+ or explicitly use -SkipPsdRaster for saved-raster-only PSD support.' } }\nWrite-Output 'Installed. Configure Spine using npm run setup with a NEW config output; existing config remains intact.'\n", { flag: 'wx' });
await writeFile(path.join(directory,'Install.sh'),`#!/bin/sh
set -eu
cd "$(dirname "$0")"
skip_psd=0
for option do case "$option" in --skip-psd-raster) skip_psd=1;; *) echo 'Usage: sh Install.sh [--skip-psd-raster]' >&2; exit 2;; esac; done
node verify-release.mjs
npm ci --omit=dev --no-audit --no-fund
if [ "$skip_psd" != '1' ]; then npm run setup:psd-raster; fi
echo 'Installed. Configure Spine with npm run setup and a NEW config output. Native rendering needs the matching platform package.'
`,{flag:'wx',mode:0o755});
const files: { path: string; sha256: string }[] = []; const walk = async (folder: string): Promise<void> => { for (const entry of await readdir(folder, { withFileTypes: true })) { const filename = path.join(folder, entry.name); if (entry.isDirectory()) await walk(filename); else files.push({ path: path.relative(directory, filename).replaceAll('\\', '/'), sha256: await fileSha256(filename) }); } }; await walk(directory);
await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify({ version: VERSION, verifiedLocalScope:!unverifiedTest, unverifiedTest, allHardwareAcceptancePassed:evidence.verified, node: '>=22.2', dependencies: JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).dependencies, files }, null, 2), { flag: 'wx' }); console.log(JSON.stringify({ version: VERSION, directory, files: files.length, verifiedLocalScope:!unverifiedTest, unverifiedTest, install: path.join(directory, 'Install.ps1'), portableAfterSetup: true }, null, 2));
