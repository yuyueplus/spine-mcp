import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { loadConfig, projectRoot } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { readDocument, writeDocument } from '../src/document.js';
import { auditAssets } from '../src/production-assets.js';
import { compareProjects } from '../src/production-workflows.js';
import { animationDuration } from '../src/advanced-animation.js';
import { documentSkins } from '../src/slot-data.js';
import { constraintList } from '../src/constraint-data.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION } from '../src/version.js';
const service = new SpineService(await loadConfig()), root = path.join(service.workspace.root, 'official-examples/examples'), directory = path.join(service.workspace.root, `official-regression-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const results: unknown[] = [];
const fixtures = [['raptor', 'raptor-pro.spine', 'constraints-and-deformation'], ['mix-and-match', 'mix-and-match-pro.spine', 'multiple-skins'], ['stretchyman', 'stretchyman-pro.spine', 'path-and-transform'], ['cloud-pot', 'cloud-pot-pro.spine', 'physics']] as const;
for (const [folder, preferred, category] of fixtures) {
  const start = performance.now();
  try {
    const filename = preferred || (await readdir(path.join(root, folder))).find(file => file.endsWith('.spine')); if (!filename) throw new Error('Official project is missing.'); const source = path.join(root, folder, filename), sourceHash = await fileSha256(source), loaded = await service.load(source), audit = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false); assert.equal(audit.valid, true, JSON.stringify(audit.missing.slice(0, 5)));
    if (category === 'physics') assert.ok(constraintList(loaded.data).some(constraint => constraint.type === 'physics'), 'The official physics fixture must contain actual physics constraints.');
    const rebuilt = await service.buildProject([{ input: loaded.jsonPath, name: folder }], path.join(directory, `${folder}.spine`)), actual = await service.load(rebuilt.output), skins = documentSkins(loaded.data), skin = String(skins.find(skin => skin.name !== 'default' && Object.keys(skin.attachments as object ?? {}).length)?.name ?? skins[0]?.name ?? 'default'), comparisons = [];
    for (const [name, animation] of Object.entries(loaded.data.animations ?? {}).slice(0, 3)) {
      const duration = animationDuration(animation), times = [0, duration / 4, duration / 2, duration * 0.75, duration]; const comparison = await compareProjects(service, loaded.jsonPath, actual.jsonPath, { animation: name, times, skin, physics: category === 'physics', fps: 30, tolerance: 0.05, render: category === 'physics' }); assert.equal(comparison.withinTolerance, true); comparisons.push({ animation: name, reportPath: comparison.reportPath, maxError: comparison.maxSampledError, imageComparisons: comparison.images.length });
    }
    assert.equal(await fileSha256(source), sourceHash); results.push({ category, source, sourceHash, bones: loaded.data.bones.length, skins: skins.length, constraints: constraintList(loaded.data).map(c => c.type), animations: Object.keys(loaded.data.animations ?? {}).length, resources: audit.files.length, native: rebuilt.output, comparisons, originalUnchanged: true, elapsedMs: performance.now() - start, passed: true });
  } catch (error) { results.push({ category, passed: false, error: (error as Error).message, elapsedMs: performance.now() - start }); }
  await writeFile(path.join(service.workspace.root, 'official-regression-report.json'), JSON.stringify({ version: VERSION, officialRepository: 'https://github.com/EsotericSoftware/spine-runtimes/tree/4.2/examples', originalEditorVersion: '4.2', targetEditorVersion: '4.3.23', note: 'Official fixtures: Raptor, Mix-and-match, Stretchyman and Cloud-pot. Cloud-pot contains actual physics constraints; Stretchyman is classified by its path/transform data. These are not user production projects.', results, passed: results.length === fixtures.length && results.every((result: any) => result.passed) }, null, 2));
}
console.log(JSON.stringify({ directory, results }, null, 2)); if (!results.every((result: any) => result.passed)) process.exitCode = 1;



