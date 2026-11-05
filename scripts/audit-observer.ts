import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { projectRoot } from '../src/config.js';

// Loaded with node --import only in QA clients, never in the MCP server/worker.
const destination = process.env.SPINE_AUDIT_CALLS;
if (destination) {
  const base = path.resolve(projectRoot, 'work/audits'), relative = path.relative(base, path.resolve(destination));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Audit log must be inside work/audits.');
  const record = (value: unknown) => appendFileSync(destination, `${JSON.stringify(value)}\n`);
  const original = Client.prototype.callTool;
  Client.prototype.callTool = async function (this: Client, params, options) {
    const id = createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16), started = Date.now();
    const common = { id, name: params.name, serverVersion: this.getServerVersion()?.version, argsSha256: createHash('sha256').update(JSON.stringify(params.arguments ?? {})).digest('hex') };
    record({ ...common, event: 'start', at: new Date().toISOString() });
    try {
      const response = await original.call(this, params, options);
      record({ ...common, event: 'result', outcome: response.isError ? 'rejected' : 'success', elapsedMs: Date.now() - started, ...(response.isError ? { message: response.content.filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 1500) } : {}) });
      return response;
    } catch (error) {
      record({ ...common, event: 'result', outcome: 'exception', elapsedMs: Date.now() - started, message: (error as Error).message.slice(0, 1500) });
      throw error;
    }
  };
}
