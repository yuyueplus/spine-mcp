import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { VERSION } from './version.js';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { projectRoot } from './config.js';

export async function connectSpine(options: { local?: boolean; serverName?: string } = {}) {
  let command = process.execPath;
  let args = [path.join(projectRoot, 'dist/src/index.js')];
  let env: Record<string, string> = {};
  let timeoutMs = 300_000;
  if (!options.local) {
    const config = JSON.parse(execFileSync('codex', ['mcp', 'get', options.serverName ?? 'spine43', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }));
    if (!config.enabled || config.transport?.type !== 'stdio') throw new Error('Expected an enabled registered stdio MCP server.');
    command = config.transport.command;
    args = config.transport.args ?? [];
    env = config.transport.env ?? {};
    timeoutMs = (config.tool_timeout_sec ?? 300) * 1000;
  } else {
    for (const name of ['SPINE_MCP_CONFIG', 'SPINE_MCP_ROOT', 'SPINE_MCP_EXE']) if (process.env[name]) env[name] = process.env[name]!;
  }
  const client = new Client({ name: 'spine-background-client', version: VERSION });
  const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8192); });
  try { await client.connect(transport); }
  catch (error) { await transport.close(); throw new Error(`MCP connection failed: ${(error as Error).message}. ${diagnostics}`); }
  return { client, timeoutMs };
}
