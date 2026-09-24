/**
 * Telling people when something happens to them: a row in `notifications`
 * (which the app lists, and which survives a phone being off) and, when
 * Firebase Cloud Messaging is configured, a push to their devices.
 *
 * FCM is optional. Without FIREBASE_SERVICE_ACCOUNT everything still works —
 * people see the notification the next time they open the app — so the API
 * runs the same in development and in tests.
 */

import { JWT } from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** The service account JSON from Firebase → Project settings → Service accounts. */
export function parseServiceAccount(raw) {
  if (!raw?.trim()) return null;
  let json;
  try {
    // Accept the file's contents, or the same thing base64-encoded (easier to
    // paste into a hosting dashboard).
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    json = JSON.parse(text);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must be the service account JSON (or that JSON base64-encoded).');
  }
  const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = json;
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key.');
  }
  // Dashboards often store the key with the newlines escaped.
  return { projectId, clientEmail, privateKey: privateKey.replaceAll('\\n', '\n') };
}

export const serializeNotification = (n) => ({
  id: n.id,
  kind: n.kind,
  title: n.title,
  body: n.body,
  tripId: n.trip_id,
  read: n.read_at != null,
  createdAt: n.created_at?.toISOString() ?? null,
});

export function createNotifier({ config, pool, logger, fetchImpl = fetch, accessToken }) {
  const account = parseServiceAccount(config.FIREBASE_SERVICE_ACCOUNT);
  const jwt =
    account && !accessToken ? new JWT({ email: account.clientEmail, key: account.privateKey, scopes: [SCOPE] }) : null;
  // Google's access tokens last an hour and the library caches them.
  const authorize = accessToken ?? (jwt ? async () => (await jwt.getAccessToken()).token : null);

  /** One push. Returns false if the device is gone and its token was dropped. */
  async function pushTo(token, message) {
    const accessToken = await authorize();
    const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { ...message, token } }),
    });
    if (res.ok) return true;

    const detail = await res.text().catch(() => '');
    // The app was uninstalled or the token was replaced: stop using it.
    if (res.status === 404 || (res.status === 400 && detail.includes('INVALID_ARGUMENT'))) {
      await pool.query('delete from device_tokens where token = $1', [token]);
      return false;
    }
    throw new Error(`FCM refused the message (${res.status}): ${detail.slice(0, 200)}`);
  }

  return {
    /** True when pushes can actually be sent. */
    get enabled() {
      return authorize != null;
    },

    /**
     * Records a notification for [userId] and pushes it to their devices.
     * Never throws: failing to notify must not fail the thing that happened.
     */
    async notify({ userId, kind, title, body, tripId = null, actorId = null }) {
      let saved;
      try {
        const { rows } = await pool.query(
          `insert into notifications (user_id, kind, title, body, trip_id, actor_id)
           values ($1, $2, $3, $4, $5, $6) returning *`,
          [userId, kind, title, body, tripId, actorId],
        );
        saved = rows[0];
      } catch (err) {
        logger?.warn({ err }, 'could not record a notification');
        return null;
      }

      if (authorize) {
        try {
          const { rows: devices } = await pool.query('select token from device_tokens where user_id = $1', [userId]);
          await Promise.all(
            devices.map((d) =>
              pushTo(d.token, {
                notification: { title, body },
                data: { kind, notificationId: saved.id, tripId: tripId ?? '' },
                android: { priority: 'high', notification: { channelId: 'traveldiary' } },
                apns: { payload: { aps: { sound: 'default' } } },
              }).catch((err) => logger?.warn({ err }, 'could not push to a device')),
            ),
          );
        } catch (err) {
          logger?.warn({ err }, 'could not push a notification');
        }
      }
      return saved;
    },
  };
}
