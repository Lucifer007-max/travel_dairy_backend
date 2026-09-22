import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { badRequest } from '../errors.js';

/**
 * Photos on the server's own disk, for development and tests. Links are signed
 * with an expiry so they work in an image widget without a sign-in header.
 */
export function createLocalStorage(config) {
  const root = path.resolve(config.LOCAL_STORAGE_DIR);
  const ttl = config.SIGNED_URL_TTL_SECONDS;

  const resolve = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw badRequest('Invalid file path.');
    return full;
  };
  const sign = (key, expires) =>
    createHmac('sha256', config.JWT_SECRET).update(`${key}:${expires}`).digest('base64url');

  return {
    driver: 'local',

    async put(key, buffer) {
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, buffer, { flag: 'wx' });
    },

    async remove(keys) {
      await Promise.all(keys.map((key) => rm(resolve(key), { force: true })));
    },

    async signedUrls(keys) {
      // Expiry snapped to a window so a photo keeps the same URL (and stays
      // in the app's image cache) across reloads within that window.
      const now = Math.floor(Date.now() / 1000);
      const expires = (Math.floor(now / ttl) + 2) * ttl;
      return new Map(
        keys.map((key) => [
          key,
          `${config.PUBLIC_BASE_URL}/v1/files/${key.split('/').map(encodeURIComponent).join('/')}` +
            `?expires=${expires}&signature=${sign(key, expires)}`,
        ]),
      );
    },

    /** The file for a signed link, or null if the link is wrong or has expired. */
    fileFor(key, expires, signature) {
      const exp = Number(expires);
      if (!Number.isInteger(exp) || exp < Date.now() / 1000 || typeof signature !== 'string') return null;
      const expected = Buffer.from(sign(key, exp));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      return resolve(key);
    },
  };
}
