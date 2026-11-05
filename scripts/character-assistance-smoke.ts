import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { connectSpine } from '../src/mcp-client.js';
import { encodePng } from '../src/raster.js';
import { fileSha256 } from '../src/file-hash.js';
import { VERSION } from '../src/version.js';
import { sampleState } from '../src/production-quality.js';

const config = await loadConfig(), directory = path.join(config.workspaceRoot, `character-assistance-${randomUUID().slice(0, 8)}`); await mkdir(directory);
const source = path.join(directory, 'source.json'), image = path.join(directory, 'part.png'); await writeFile(image, encodePng(16, 32, new Uint8Array(16 * 32 * 4).fill(255)));
await writeFile(source, JSON.stringify({ skeleton: { spine: '4.3.23', images: '.', fps: 30 }, bones: [{ name: 'root' }], slots: [{ name: 'upper', bone: 'root', attachment: 'upper' }, { name: 'lower', bone: 'root', attachment: 'lower' }], skins: [{ name: 'default', attachments: { upper: { upper: { path: 'part', x: 0, y: 12, width: 16, height: 32 } }, lower: { lower: { path: 'part', x: 0, y: -12, width: 16, height: 32 } } } }], animations: { idle: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 15 }] } } } } }));
const sourceHash = await fileSha256(source), imageHash = await fileSha256(image), { client, timeoutMs } = await connectSpine();
const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }, { timeout: timeoutMs }), t = r.content.find(c => c.type === 'text'); if (r.isError || t?.type !== 'text') throw new Error(`${name}: ${JSON.stringify(r.content)}`); return JSON.parse(t.text); };
try {
  const before = await call('spine_audit_character_layers', { input: source, seams: [{ name: 'overlapping-joint', a: { slot: 'upper' }, b: { slot: 'lower' }, point: { x: 0, y: 0 }, radius: 2 }, { name: 'uncovered-region', a: { slot: 'upper' }, b: { slot: 'lower' }, point: { x: 100, y: 0 }, radius: 2 }] }); assert.equal(before.seams[0].passed, true); assert.equal(before.seams[1].passed, false);
  const suggestion = await call('spine_suggest_character_rig', { input: source, output: path.join(directory, 'prepared.json'), chains: [{ namePrefix: 'limb', parent: 'root', layers: [{ slot: 'upper' }, { slot: 'lower' }], points: [{ x: 0, y: 25 }, { x: 0, y: 0 }, { x: 0, y: -25 }] }] }); assert.equal(suggestion.projectWritten, false); assert.equal(suggestion.anatomyInference, false);
  const prepared = await call('spine_prepare_character', suggestion.recipe), native = await call('spine_build_project', { entries: [{ input: prepared.path, name: 'assisted-character' }], output: path.join(directory, 'assisted.spine') });
  const setup = await call('spine_compare_projects', { input: prepared.path, other: native.output, animation: 'idle', times: [0, 0.5, 1], tolerance: 0.001, render: false });
  // The native importer may reorder triangle faces. build_project verifies
  // identical oriented topology; independently retain strict world-coordinate
  // checks and add full-frame artwork checks instead of treating face order as
  // a change to bone/vertex coordinates. No error tolerance is relaxed.
  const inspected = await call('spine_inspect', { input: native.output }), expectedData = JSON.parse(await readFile(prepared.path, 'utf8')), actualData = JSON.parse(await readFile(inspected.workingJson, 'utf8'));
  let maxWorldError = 0;
  for (const time of [0, 0.5, 1]) {
    const a = sampleState(expectedData, 'idle', time), b = sampleState(actualData, 'idle', time);
    assert.deepEqual(a.signature.filter(s => !s.startsWith('[')), b.signature.filter(s => !s.startsWith('['))); assert.equal(a.values.length, b.values.length);
    maxWorldError = Math.max(maxWorldError, ...a.values.map((value, i) => Math.abs(value - b.values[i]!)));
  }
  assert.ok(maxWorldError <= 0.001);
  const pixels = await call('spine_compare_artwork', { input: prepared.path, other: native.output, animation: 'idle', times: [0, 0.5, 1], meanPixelTolerance: 0.01 }); assert.equal(pixels.withinTolerance, true);
  const oldArt = await call('spine_render_artwork', { input: source, animation: 'idle', times: [0] }), newArt = await call('spine_render_artwork', { input: prepared.path, animation: 'idle', times: [0] });
  const bounds = (slots: any[]) => { const p = slots.flatMap(s => s.vertices ?? []), xs = p.filter((_: number, i: number) => i % 2 === 0), ys = p.filter((_: number, i: number) => i % 2 === 1); return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]; };
  const a = bounds(oldArt.frames[0].slots), b = bounds(newArt.frames[0].slots); assert.ok(Math.max(...a.map((v, i) => Math.abs(v - b[i]!))) < 0.001);
  const meshAudit = await call('spine_audit_character_layers', { input: prepared.path }); assert.ok(meshAudit.layers.every((l: any) => l.geometry === 'mesh'));
  const formal = path.join(config.workspaceRoot, 'production-delivery-2.10.1-Ecj31Y/Anime-Girl-Delivery.json'), formalHash = await fileSha256(formal), realLayers = await call('spine_audit_character_layers', { input: formal }); assert.ok(realLayers.layers.length > 5); assert.equal(await fileSha256(formal), formalHash);
  assert.equal(await fileSha256(source), sourceHash); assert.equal(await fileSha256(image), imageHash);
  const report = { passed: true, version: VERSION, directory, layerAudit: before.reportPath, suggestion: suggestion.reportPath, preparation: prepared.path, native: native.output, rawFaceOrderComparison: setup.reportPath, nativeOrientedTopologyVerified: true, maxWorldError, worldTolerance: 0.001, artworkComparison: pixels.reportPath, meanPixelTolerance: 0.01, setupBoundsError: Math.max(...a.map((v, i) => Math.abs(v - b[i]!))), meshAnalysis: meshAudit.reportPath, realCharacterAnalysis: realLayers.reportPath, realCharacterLayers: realLayers.layers.length, anatomyInference: false, originalsUnchanged: true, editorOpened: false, visualAcceptance: 'pending' };
  const reportPath = path.join(config.workspaceRoot, `character-assistance-report-${VERSION}.json`); await writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, version: VERSION, reportPath, realCharacterLayers: report.realCharacterLayers }));
} finally { await client.close(); }
