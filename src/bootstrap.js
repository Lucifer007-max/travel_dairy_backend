import pino from 'pino';

import { createApp } from './app.js';
import { createGoogleVerifier } from './auth/google.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createStorage } from './storage/index.js';

/** Builds the real API from environment settings. Used by server.js and by Vercel (api/index.js). */
export function buildApp(env = process.env) {
  const config = loadConfig(env);
  const logger = pino({ level: config.LOG_LEVEL });
  const pool = createPool(config);
  const storage = createStorage(config);
  const app = createApp({ config, pool, storage, verifyGoogleIdToken: createGoogleVerifier(config), logger });
  return { app, config, pool, storage, logger };
}
