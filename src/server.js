import { buildApp } from './bootstrap.js';

// A long-running server (npm start, Docker). On Vercel, api/index.js is used instead.
const { app, config, pool, storage, logger } = buildApp();

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
