import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';
import { loadConfig } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { readDocument } from '../src/document.js';
import { documentSkins } from '../src/slot-data.js';
import { bakingTimes } from '../src/world-animation.js';
import { animationDuration } from '../src/advanced-animation.js';
import { constraintList } from '../src/constraint-data.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION } from '../src/version.js';

const service = new SpineService(await loadConfig()), { client, timeoutMs } = await connectSpine(), directory = path.join(service.workspace.root, `advanced-official-${randomUUID().slice(0, 8)}`); await mkdir(directory);
async function call(name: string, args: Record<string, unknown>) { const response = await client.callTool({ name, arguments: args }, { timeout: timeoutMs }), block = response.content.find(item => item.type === 'text'); if (response.isError || block?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(response.content)}`); return JSON.parse(block.text); }
try {
  const official = JSON.parse(await readFile(path.join(service.workspace.root, 'official-regression-report.json'), 'utf8')); assert.equal(official.passed, true); const results = [];
  for (const fixture of official.results) {
    const originalHash = await fileSha256(fixture.source), loaded = await service.load(fixture.source), entry = Object.entries(loaded.data.animations ?? {}).find(([, animation]) => animationDuration(animation) > 0 && animationDuration(animation) <= 10); assert.ok(entry);
    const [animation] = entry, skins = documentSkins(loaded.data), skin = String(skins.find(item => item.name !== 'default' && Object.keys(item.attachments as object ?? {}).length)?.name ?? skins[0]?.name ?? 'default'), fps = 10, physics = fixture.category === 'physics';
    const baked = await call('spine_bake_constraints', { input: loaded.jsonPath, output: path.join(directory, `${fixture.category}.json`), animation, newName: 'baked-official', skin, fps, physics, tolerance: 0.02 });
    const keys = bakingTimes(loaded.data, animation, fps), times = [...new Set([keys[0]!, keys[Math.floor(keys.length / 2)]!, keys.at(-1)!])];
    const before = await call('spine_compare_projects', { input: loaded.jsonPath, other: baked.path, animation, otherAnimation: 'baked-official', times, skin, physics, fps, tolerance: 0.02, render: false }); assert.equal(before.withinTolerance, true);
    const native = await call('spine_build_project', { entries: [{ input: baked.path, name: 'official' }], output: path.join(directory, `${fixture.category}.spine`) }), after = await call('spine_compare_projects', { input: baked.path, other: native.output, animation: 'baked-official', times, skin, physics, fps, tolerance: 0.05, render: false }); assert.equal(after.withinTolerance, true);
    const output = await readDocument(baked.path); assert.deepEqual(output.animations![animation], loaded.data.animations![animation]); assert.equal(await fileSha256(fixture.source), originalHash);
    results.push({ category: fixture.category, source: fixture.source, sourceHash: originalHash, animation, skin, fps, physics, constraints: [...new Set(constraintList(loaded.data).map(item => item.type))], selectedSkinBakeVerified: true, otherAnimationsPreserved: true, originalUnchanged: true, sourceSampledComparison: before.reportPath, sourceMaxError: before.maxSampledError, nativeReadbackVerified: true, nativeComparison: after.reportPath, nativeMaxError: after.maxSampledError, output: baked.path, native: native.output });
  }
  const report = { passed: true, version: VERSION, results, note: 'Four official fixtures including Cloud-pot with actual physics constraints, selected animation/skin per project, bounded sampled constraint baking plus native import/export. Not user-production acceptance.' }, reportPath = path.join(service.workspace.root, `advanced-official-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, version: VERSION, officialFixtures: results.length, reportPath }, null, 2));
} finally { await client.close(); }
