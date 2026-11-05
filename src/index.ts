import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { SpineService } from './service.js';

const config = await loadConfig();
if (process.argv[2] === 'doctor') {
  console.log(JSON.stringify(await new SpineService(config).doctor(true), null, 2));
} else if (process.argv[2] === '--help') {
  console.log('Spine 4.3.23 MCP: node dist/src/index.js [doctor]\nConfiguration: SPINE_MCP_CONFIG, SPINE_MCP_ROOT, SPINE_MCP_EXE. Default mode is MCP stdio.');
} else {
  void new SpineService(config).nativePreviews.recoverActive().catch(error => console.error(`Native preview recovery: ${(error as Error).message}`));
  serveStdio(() => createServer(config));
  console.error('Spine 4.3.23 MCP ready on stdio.');
}
