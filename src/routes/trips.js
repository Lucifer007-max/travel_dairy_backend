import { Router } from 'express';

import { badRequest, notFound } from '../errors.js';
import { id, tripCreate, tripUpdate } from '../schemas.js';
import { loadTrips, photoKeys } from '../trips.js';

const COLUMNS = {
  title: 'title',
  destination: 'destination',
  kind: 'kind',
  startDate: 'start_date',
  endDate: 'end_date',
  coverPhotoId: 'cover_photo_id',
};

export function tripsRouter({ pool, storage }) {
  const router = Router();

  async function oneTrip(userId, tripId) {
    const [trip] = await loadTrips(pool, storage, userId, { tripId });
    if (!trip) throw notFound('That trip was not found.');
    return trip;
  }

  router.get('/trips', async (req, res) => {
    res.json({ trips: await loadTrips(pool, storage, req.user.id) });
  });

  router.get('/trips/:tripId', async (req, res) => {
    res.json({ trip: await oneTrip(req.user.id, id.parse(req.params.tripId)) });
  });

  router.post('/trips', async (req, res) => {
    const t = tripCreate.parse(req.body);
    const { rows } = await pool.query(
      `insert into trips (user_id, title, destination, kind, start_date, end_date)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [req.user.id, t.title, t.destination, t.kind, t.startDate, t.endDate],
    );
    res.status(201).json({ trip: await oneTrip(req.user.id, rows[0].id) });
  });

  router.patch('/trips/:tripId', async (req, res) => {
    const tripId = id.parse(req.params.tripId);
    const changes = tripUpdate.parse(req.body);
    await oneTrip(req.user.id, tripId);

    if (changes.coverPhotoId) {
      const { rowCount } = await pool.query(
        'select 1 from photos p join memories m on m.id = p.memory_id where p.id = $1 and m.trip_id = $2',
        [changes.coverPhotoId, tripId],
      );
      if (rowCount === 0) throw badRequest('The cover must be a photo from this trip.');
    }

    const entries = Object.entries(changes).filter(([, v]) => v !== undefined);
    await pool.query(
      `update trips set ${entries.map(([k], i) => `${COLUMNS[k]} = $${i + 3}`).join(', ')}, updated_at = now()
        where id = $1 and user_id = $2`,
      [tripId, req.user.id, ...entries.map(([, v]) => v)],
    );
    res.json({ trip: await oneTrip(req.user.id, tripId) });
  });

  router.delete('/trips/:tripId', async (req, res) => {
    const tripId = id.parse(req.params.tripId);
    const keys = await photoKeys(pool, 't.id = $1 and t.user_id = $2', [tripId, req.user.id]);
    const { rowCount } = await pool.query('delete from trips where id = $1 and user_id = $2', [tripId, req.user.id]);
    if (rowCount === 0) throw notFound('That trip was not found.');
    await storage.remove(keys).catch((err) => req.log?.warn({ err }, 'could not remove photo files'));
    res.status(204).end();
  });

  return router;
}
