import path from 'node:path';
import { configSchema } from './config.js';
import { SpineService } from './service.js';
import { runSavedSync } from './saved-sync.js';
const config = configSchema.parse(JSON.parse(process.env.SPINE_SYNC_CONFIG ?? '{}')), directory = path.resolve(process.argv[2] ?? '');
await runSavedSync(new SpineService(config), directory);
