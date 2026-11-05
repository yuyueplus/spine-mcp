import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { z } from 'zod/v4';
import type { SpineService } from './service.js';
import { suiteSchema } from './stability-schema.js';
import { auditAssets, assertSnapshot } from './production-assets.js';
import { fileSha256 } from './file-hash.js';
import { auditAnimation } from './animation-audit.js';
import { getAcceptance } from './acceptance.js';
import { checkpoint, type WorkControl } from './progress.js';

export async function runRegressionSuite(service: SpineService, raw: z.input<typeof suiteSchema>, control?: WorkControl) {
  const args = suiteSchema.parse(raw), directory = await service.workspace.resolve(path.join('reports', `regression-${randomUUID()}`), false); await mkdir(directory, { recursive: true });
  const cases: { name: string; input: string; passed: boolean; sourceSha256?: string; structural?: string; resources?: string; nativeRoundTrip?: unknown; audits?: unknown[]; visualAcceptance?: string; error?: string }[] = [];
  const reportPath = path.join(directory, 'regression.json');
  const save = async () => { await writeFile(reportPath, JSON.stringify({ completedCases: cases.length, requestedCases: args.cases.length, cases }, null, 2)); };
  for (const [index, item] of args.cases.entries()) {
    await checkpoint(control, { phase: 'regression-case', completed: index, total: args.cases.length, detail: item.name });
    const row: typeof cases[number] = { name: item.name, input: item.input, passed: false, visualAcceptance: 'pending' };
    try {
      const input = await service.workspace.resolve(item.input), hash = await fileSha256(input); row.sourceSha256 = hash;
      if (item.expectedSha256 && hash !== item.expectedSha256) throw new Error('Pinned fixture hash changed; update the fixture deliberately before accepting this regression.');
      const loaded = await service.load(input, item.skeletonName), resources = await auditAssets(service.workspace, loaded.data, loaded.jsonPath, false); row.structural = 'passed'; row.resources = resources.valid ? 'passed' : 'failed';
      if (!resources.valid) throw new Error('Regression fixture has missing resources.');
      if (item.expectedResourceHashes) {
        const expected = new Map<string, string>();
        for (const resource of item.expectedResourceHashes) expected.set(await service.workspace.resolve(resource.path), resource.sha256);
        if (expected.size !== item.expectedResourceHashes.length || expected.size !== resources.files.length || resources.files.some(file => expected.get(file.path) !== file.sha256)) throw new Error('Pinned resource inventory or hash changed; review the image/audio fixture deliberately.');
      }
      if (item.nativeRoundTrip) { const output = path.join(directory, `case-${index}.spine`); row.nativeRoundTrip = await service.buildProject([{ input: loaded.jsonPath, name: `regression_case_${index}` }], output, control); }
      else row.nativeRoundTrip = { requested: false };
      row.audits = [];
      for (const options of item.audits) { const result = await auditAnimation(service, { input, skeletonName: item.skeletonName, options }, control); row.audits.push({ animation: options.animation, checksPassed: result.checksPassed, reportPath: result.reportPath, findingCounts: result.findingCounts }); }
      await assertSnapshot(resources); if (await fileSha256(input) !== hash) throw new Error('Fixture changed while the regression was running.');
      row.visualAcceptance = (await getAcceptance(service, input, item.skeletonName)).visualAcceptance;
      row.passed = row.audits.every(a => (a as { checksPassed: boolean }).checksPassed);
    } catch (error) { row.error = (error as Error).message; }
    cases.push(row); await save(); if (!row.passed && args.stopOnError) break;
  }
  const checksPassed = cases.length === args.cases.length && cases.every(c => c.passed), visualAcceptance = cases.some(c => c.visualAcceptance === 'rejected') ? 'reported_rejected' : cases.length === args.cases.length && cases.every(c => c.visualAcceptance === 'accepted') ? 'reported_accepted' : 'pending';
  const result = { checksPassed, visualAcceptance, releaseReady: checksPassed && visualAcceptance === 'reported_accepted', cases, skipped: args.cases.length - cases.length, reportPath, editorOpened: false,
    note: 'Structural/resources/native/numeric checks are separate from caller-reported visual reviews. This suite never opens an editor or modifies fixtures.' };
  await writeFile(reportPath, JSON.stringify(result, null, 2)); return result;
}
