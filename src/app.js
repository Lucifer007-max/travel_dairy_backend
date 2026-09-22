import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { createTokens } from './auth/tokens.js';
import { notFound } from './errors.js';
import { requireUser } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { meRouter } from './routes/me.js';
import { memoriesRouter } from './routes/memories.js';
import { tripsRouter } from './routes/trips.js';

/**
 * Builds the API. Everything it depends on is passed in, so tests can use a
 * test database, temporary storage and a fake Google verifier.
 */
export function createApp({ config, pool, storage, verifyGoogleIdToken, logger }) {
  const app = express();
  const tokens = createTokens(config);
  const deps = { config, pool, storage, tokens, verifyGoogleIdToken };

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : true }));
  if (logger) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    await pool.query('select 1');
    res.json({ ok: true });
  });

  const v1 = express.Router();
  v1.use(
    '/auth',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: config.NODE_ENV === 'test' ? 1000 : 60,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many sign-in attempts. Please wait a few minutes.' } },
    }),
    authRouter(deps),
  );
  v1.use('/files', filesRouter(deps));
  v1.use(requireUser(deps));
  v1.use(meRouter(deps));
  v1.use(tripsRouter(deps));
  v1.use(memoriesRouter(deps));
  app.use('/v1', v1);

  app.use((req) => {
    throw notFound(`No route for ${req.method} ${req.path}.`);
  });
  app.use(errorHandler(logger));
  return app;
}
