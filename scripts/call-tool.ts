import { readFile } from 'node:fs/promises';
import { connectSpine } from '../src/mcp-client.js';

const argv = process.argv.slice(2);
const localIndex = argv.indexOf('--local');
const local = localIndex !== -1;
if (local) argv.splice(localIndex, 1);
const action = argv.shift();
if (!action || action === '--help') {
  console.log('Usage: node dist/scripts/call-tool.js list [--local]\n       node dist/scripts/call-tool.js TOOL [--args-file FILE] [--local]\nDefault: use the registered spine43 server. Images are summarized; preview paths are returned in text metadata.');
} else {
  let args: Record<string, unknown> = {};
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--args-file' || !argv[1]) throw new Error('Use --args-file FILE to pass tool arguments.');
    const text = (await readFile(argv[1], 'utf8')).replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be a JSON object.');
    args = parsed as Record<string, unknown>;
  }
  const { client, timeoutMs } = await connectSpine({ local });
  try {
    if (action === 'list') console.log(JSON.stringify(await client.listTools(), null, 2));
    else {
      const result = await client.callTool({ name: action, arguments: args }, { timeout: timeoutMs });
      const content = result.content.map(block => {
        if (block.type === 'image') return { type: 'image', mimeType: block.mimeType, bytes: Buffer.byteLength(block.data, 'base64') };
        if (block.type === 'text') { try { return { type: 'text', value: JSON.parse(block.text) }; } catch { return block; } }
        return block;
      });
      console.log(JSON.stringify({ isError: result.isError ?? false, content }, null, 2));
      if (result.isError) process.exitCode = 1;
    }
  } finally { await client.close(); }
}
