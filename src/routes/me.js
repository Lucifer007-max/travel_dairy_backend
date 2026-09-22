import { Router } from 'express';

import { profileUpdate } from '../schemas.js';
import { photoKeys, serializeUser } from '../trips.js';

export function meRouter({ pool, storage }) {
  const router = Router();

  router.get('/me', (req, res) => {
    res.json({ user: serializeUser(req.user) });
  });

  router.patch('/me', async (req, res) => {
    const { name } = profileUpdate.parse(req.body);
    const { rows } = await pool.query('update users set name = $2, updated_at = now() where id = $1 returning *', [
      req.user.id,
      name,
    ]);
    res.json({ user: serializeUser(rows[0]) });
  });

  // Delete the account and everything in it, photos included.
  router.delete('/me', async (req, res) => {
    const keys = await photoKeys(pool, 't.user_id = $1', [req.user.id]);
    await pool.query('delete from users where id = $1', [req.user.id]);
    await storage.remove(keys).catch((err) => req.log?.warn({ err }, 'could not remove photo files'));
    res.status(204).end();
  });

  return router;
}
