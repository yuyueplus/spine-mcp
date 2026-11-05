import path from 'node:path';
import { configSchema } from './config.js';
import { SpineService } from './service.js';
import { runNativePreview } from './native-preview.js';

const config = configSchema.parse(JSON.parse(process.env.SPINE_NATIVE_PREVIEW_CONFIG ?? '{}'));
await runNativePreview(new SpineService(config), path.resolve(process.argv[2] ?? ''));
