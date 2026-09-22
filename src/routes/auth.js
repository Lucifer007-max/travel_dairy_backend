import { Router } from 'express';

import { googleSignIn } from '../schemas.js';
import { serializeUser } from '../trips.js';

export function authRouter({ pool, tokens, verifyGoogleIdToken }) {
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

    res.json({ token: tokens.issue(rows[0].id), user: serializeUser(rows[0]) });
  });

  return router;
}
