import { Router } from 'express';

import { id } from '../schemas.js';
import { serializeNotification } from '../notify.js';

export function notificationsRouter({ pool }) {
  const router = Router();

  // Everything recent, newest first, with how many are still unread.
  router.get('/notifications', async (req, res) => {
    const { rows } = await pool.query(
      'select * from notifications where user_id = $1 order by created_at desc limit 50',
      [req.user.id],
    );
    res.json({
      notifications: rows.map(serializeNotification),
      unread: rows.filter((n) => n.read_at == null).length,
    });
  });

  // Mark them read: all of them, or just the ids given.
  router.post('/notifications/read', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((v) => id.parse(v)) : null;
    await pool.query(
      `update notifications set read_at = now()
        where user_id = $1 and read_at is null ${ids ? 'and id = any($2::uuid[])' : ''}`,
      ids ? [req.user.id, ids] : [req.user.id],
    );
    res.status(204).end();
  });

  return router;
}
