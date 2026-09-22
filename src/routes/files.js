import { Router } from 'express';

import { HttpError, notFound } from '../errors.js';
import { CONTENT_TYPES } from '../storage/images.js';

/** Serves photo files for the local storage driver through signed links. */
export function filesRouter({ storage }) {
  const router = Router();
  if (storage.driver !== 'local') return router;

  router.get('/*key', (req, res, next) => {
    const key = req.params.key.join('/');
    const file = storage.fileFor(key, req.query.expires, req.query.signature);
    if (!file) throw new HttpError(403, 'link_expired', 'This photo link is not valid or has expired.');

    const extension = key.split('.').pop();
    res.sendFile(
      file,
      {
        headers: {
          'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400, immutable',
        },
      },
      (error) => {
        if (!error) return;
        next(error.code === 'ENOENT' ? notFound('That photo is gone.') : error);
      },
    );
  });

  return router;
}
