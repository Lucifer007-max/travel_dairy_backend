import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { HttpError } from '../src/errors.js';
import { migrate } from '../src/migrate.js';
import { createLocalStorage } from '../src/storage/local.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/traveldiary_test';

/** Makes the test database if it doesn't exist yet. */
async function ensureDatabase(url) {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (rowCount === 0) await client.query(`create database "${name.replaceAll('"', '""')}"`);
  } finally {
    await client.end();
  }
}

/**
 * A fake Google: "google:<sub>:<email>:<name>" verifies as that person;
 * anything else is rejected the way a bad token would be.
 */
async function fakeGoogle(idToken) {
  const [scheme, sub, email, name] = idToken.split(':');
  if (scheme !== 'google' || !sub) {
    throw new HttpError(401, 'invalid_google_token', "Google sign-in couldn't be verified. Please try again.");
  }
  return { sub, email: email || null, name: name || null, picture: `https://example.com/${sub}.jpg` };
}

/** A fresh app on an empty test database and an empty temporary photo folder. */
export async function setup() {
  await ensureDatabase(TEST_DATABASE_URL);
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'traveldiary-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-signing',
    GOOGLE_CLIENT_IDS: 'test-client.apps.googleusercontent.com',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: storageDir,
    PUBLIC_BASE_URL: 'http://api.test',
    MAX_UPLOAD_MB: '1',
  });
  const pool = createPool(config);
  await migrate(pool);
  await pool.query('truncate users cascade');
  const storage = createLocalStorage(config);
  const app = createApp({ config, pool, storage, verifyGoogleIdToken: fakeGoogle });

  return {
    app,
    pool,
    storageDir,
    async teardown() {
      await pool.end();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

/** Smallest byte runs the server accepts as each image type. */
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 3)]);
