import { Router } from 'express';

import { badRequest, forbidden, notFound } from '../errors.js';
import { id, memberInvite, tripCreate, tripUpdate } from '../schemas.js';
import { loadMembers, loadTrips, normalizeEmail, photoKeys, tripAccess } from '../trips.js';

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

  async function oneTrip(user, tripId) {
    const [trip] = await loadTrips(pool, storage, user, { tripId });
    if (!trip) throw notFound('That trip was not found.');
    return trip;
  }

  /** Only the person who made the trip may change it or the people on it. */
  async function ownedTrip(user, tripId) {
    const { isOwner } = await tripAccess(pool, user, tripId);
    if (!isOwner) throw forbidden('Only the person who created this trip can change it.');
  }

  router.get('/trips', async (req, res) => {
    res.json({ trips: await loadTrips(pool, storage, req.user) });
  });

  router.get('/trips/:tripId', async (req, res) => {
    res.json({ trip: await oneTrip(req.user, id.parse(req.params.tripId)) });
  });

  router.post('/trips', async (req, res) => {
    const t = tripCreate.parse(req.body);
    const { rows } = await pool.query(
      `insert into trips (user_id, title, destination, kind, start_date, end_date)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [req.user.id, t.title, t.destination, t.kind, t.startDate, t.endDate],
    );
    res.status(201).json({ trip: await oneTrip(req.user, rows[0].id) });
  });

  router.patch('/trips/:tripId', async (req, res) => {
    const tripId = id.parse(req.params.tripId);
    const changes = tripUpdate.parse(req.body);
    await ownedTrip(req.user, tripId);

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
    res.json({ trip: await oneTrip(req.user, tripId) });
  });

  router.delete('/trips/:tripId', async (req, res) => {
    const tripId = id.parse(req.params.tripId);
    const { isOwner } = await tripAccess(pool, req.user, tripId);
    if (!isOwner) throw forbidden('Only the person who created this trip can delete it. You can leave it instead.');

    const keys = await photoKeys(pool, 't.id = $1', [tripId]);
    await pool.query('delete from trips where id = $1', [tripId]);
    await storage.remove(keys).catch((err) => req.log?.warn({ err }, 'could not remove photo files'));
    res.status(204).end();
  });

  // Sharing. A trip is shared with one person at a time, by the email address
  // on their Google account, and only that trip is shared. Everything happens
  // in the app: nothing is emailed and no link is made.

  router.get('/trips/:tripId/members', async (req, res) => {
    const tripId = id.parse(req.params.tripId);
    await tripAccess(pool, req.user, tripId);
    res.json({ members: await loadMembers(pool, tripId) });
  });

  router.post('/trips/:tripId/members', async (req, res) => {
    const tripId = id.parse(req.params.tripId);
    const email = normalizeEmail(memberInvite.parse(req.body).email);
    await ownedTrip(req.user, tripId);
    if (req.user.email && normalizeEmail(req.user.email) === email) {
      throw badRequest('This trip is already yours.');
    }

    // If they already have an account the trip shows up for them at once;
    // otherwise the invitation waits for their first sign-in.
    const { rows: existing } = await pool.query('select id from users where lower(email) = $1', [email]);
    const joined = existing[0]?.id ?? null;
    const { rows } = await pool.query(
      `insert into trip_members (trip_id, email, user_id, invited_by, joined_at)
       values ($1, $2, $3, $4, case when $3::uuid is null then null else now() end)
       on conflict (trip_id, email) do nothing
       returning id`,
      [tripId, email, joined, req.user.id],
    );
    res.status(rows[0] ? 201 : 200).json({ members: await loadMembers(pool, tripId) });
  });

  // The owner can remove anyone; anyone else can only remove themselves, which
  // is how they leave a shared trip.
  router.delete('/trips/:tripId/members/:memberId', async (req, res) => {
    const tripId = id.parse(req.params.tripId);
    const memberId = id.parse(req.params.memberId);
    const { isOwner } = await tripAccess(pool, req.user, tripId);

    const { rows } = await pool.query('select * from trip_members where id = $1 and trip_id = $2', [memberId, tripId]);
    const member = rows[0];
    if (!member) throw notFound('That person is not on this trip.');
    const isSelf =
      member.user_id === req.user.id || (req.user.email && normalizeEmail(req.user.email) === member.email);
    if (!isOwner && !isSelf) throw forbidden('Only the person who created this trip can remove people from it.');

    await pool.query('delete from trip_members where id = $1', [memberId]);
    res.status(204).end();
  });

  return router;
}
