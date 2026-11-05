import path from 'node:path';
import { readDocument, writeDocument } from '../src/document.js';
import { loadConfig } from '../src/config.js';
import { SpineService } from '../src/service.js';
import { randomUUID } from 'node:crypto';
const service = new SpineService(await loadConfig()), source = await readDocument(process.argv[2]!), prefix = `precision-${randomUUID().slice(0, 8)}`;
for (const fps of [240, 1000]) { const data = structuredClone(source); data.skeleton.fps = fps; const input = await writeDocument(service.workspace, `${prefix}-${fps}.json`, data, path.dirname(process.argv[2]!)); try { const result = await service.buildProject([{ input: input.path, name: 'test' }], `${prefix}-${fps}.spine`); console.log(JSON.stringify({ fps, passed: true, result })); } catch (error) { console.log(JSON.stringify({ fps, passed: false, error: (error as Error).message })); } }
