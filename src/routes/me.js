import { Router } from 'express';

import { deviceRegistration } from '../schemas.js';
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

  // This phone, so pushes can reach it. Sent after every sign-in and whenever
  // Firebase gives the app a new token; the same token may move between
  // accounts if two people use one phone.
  router.post('/me/devices', async (req, res) => {
    const { token, platform } = deviceRegistration.parse(req.body);
    await pool.query(
      `insert into device_tokens (user_id, token, platform) values ($1, $2, $3)
       on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform,
                                         last_seen_at = now()`,
      [req.user.id, token, platform],
    );
    res.status(204).end();
  });

  // Signing out: stop pushing to this phone.
  router.delete('/me/devices', async (req, res) => {
    const { token } = deviceRegistration.parse(req.body);
    await pool.query('delete from device_tokens where token = $1 and user_id = $2', [token, req.user.id]);
    res.status(204).end();
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
