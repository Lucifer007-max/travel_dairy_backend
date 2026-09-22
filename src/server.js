import pino from 'pino';

import { createApp } from './app.js';
import { createGoogleVerifier } from './auth/google.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createStorage } from './storage/index.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const pool = createPool(config);
const storage = createStorage(config);

const app = createApp({
  config,
  pool,
  storage,
  verifyGoogleIdToken: createGoogleVerifier(config),
  logger,
});

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, storage: storage.driver, googleClients: config.GOOGLE_CLIENT_IDS.length },
    'TravelDiary API listening',
  );
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
