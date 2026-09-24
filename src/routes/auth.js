import { Router } from 'express';

import { googleSignIn } from '../schemas.js';
import { serializeUser } from '../trips.js';

export function authRouter({ pool, tokens, verifyGoogleIdToken, notifier }) {
  const router = Router();

  // Sign in with a Google ID token from the app. Accounts are Google-only:
  // the first sign-in creates the account, later ones return the same one.
  router.post('/google', async (req, res) => {
    const { idToken } = googleSignIn.parse(req.body);
    const google = await verifyGoogleIdToken(idToken);
    const name = (google.name ?? google.email?.split('@')[0] ?? 'Traveller').slice(0, 80);

    const { rows } = await pool.query(
      `insert into users (google_sub, email, name, photo_url)
       values ($1, $2, $3, $4)
       on conflict (google_sub) do update
         set email = excluded.email, photo_url = excluded.photo_url, updated_at = now()
       returning *`,
      [google.sub, google.email, name, google.picture],
    );

    // Trips shared with this email before they had an account are theirs now,
    // and they are told about each one.
    if (rows[0].email) {
      const { rows: claimed } = await pool.query(
        `update trip_members set user_id = $1, joined_at = coalesce(joined_at, now())
          where user_id is null and email = lower($2)
          returning trip_id`,
        [rows[0].id, rows[0].email],
      );
      for (const { trip_id: tripId } of claimed) {
        const { rows: trips } = await pool.query(
          'select t.title, u.name as owner from trips t join users u on u.id = t.user_id where t.id = $1',
          [tripId],
        );
        if (!trips[0]) continue;
        await notifier?.notify({
          userId: rows[0].id,
          kind: 'trip_shared',
          title: `${trips[0].owner} added you to a trip`,
          body: `You can now see "${trips[0].title}" and add your own memories to it.`,
          tripId,
        });
      }
    }

    res.json({ token: tokens.issue(rows[0].id), user: serializeUser(rows[0]) });
  });

  return router;
}
