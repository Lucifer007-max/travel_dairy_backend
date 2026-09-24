import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createNotifier } from '../src/notify.js';

/** Just enough Postgres: one notification row and a list of device tokens. */
function fakePool(tokens) {
  const deleted = [];
  return {
    deleted,
    async query(sql, params) {
      if (sql.includes('insert into notifications')) return { rows: [{ id: 'n1', created_at: new Date() }] };
      if (sql.includes('delete from device_tokens')) {
        deleted.push(params[0]);
        return { rows: [] };
      }
      if (sql.includes('from device_tokens')) return { rows: tokens.map((token) => ({ token })) };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const account = JSON.stringify({
  project_id: 'traveldiary',
  client_email: 'push@traveldiary.iam.gserviceaccount.com',
  private_key: 'key',
});

test('a notification is pushed to every device of the person it is for', async () => {
  const sent = [];
  const notifier = createNotifier({
    config: { FIREBASE_SERVICE_ACCOUNT: account },
    pool: fakePool(['phone-a', 'phone-b']),
    accessToken: async () => 'access-token',
    fetchImpl: async (url, init) => {
      sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  assert.equal(notifier.enabled, true);
  await notifier.notify({ userId: 'u1', kind: 'trip_shared', title: 'Ravi added you', body: 'Goa', tripId: 't1' });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, 'https://fcm.googleapis.com/v1/projects/traveldiary/messages:send');
  assert.equal(sent[0].auth, 'Bearer access-token');
  assert.deepEqual(sent[0].body.message.notification, { title: 'Ravi added you', body: 'Goa' });
  assert.equal(sent[0].body.message.data.tripId, 't1');
  assert.deepEqual(sent.map((s) => s.body.message.token), ['phone-a', 'phone-b']);
});

test('a token Firebase no longer knows is dropped, and a failure never escapes', async () => {
  const pool = fakePool(['gone', 'fine']);
  const notifier = createNotifier({
    config: { FIREBASE_SERVICE_ACCOUNT: account },
    pool,
    accessToken: async () => 'access-token',
    fetchImpl: async (_url, init) =>
      JSON.parse(init.body).message.token === 'gone'
        ? { ok: false, status: 404, text: async () => 'UNREGISTERED' }
        : { ok: false, status: 503, text: async () => 'try later' },
  });

  const saved = await notifier.notify({ userId: 'u1', kind: 'trip_shared', title: 't', body: 'b' });
  assert.equal(saved.id, 'n1', 'the notification is still recorded');
  assert.deepEqual(pool.deleted, ['gone']);
});

test('without Firebase configured, notifications are recorded and nothing is pushed', async () => {
  const notifier = createNotifier({
    config: {},
    pool: fakePool(['phone-a']),
    fetchImpl: () => assert.fail('should not push'),
  });
  assert.equal(notifier.enabled, false);
  assert.equal((await notifier.notify({ userId: 'u1', kind: 'k', title: 't', body: 'b' })).id, 'n1');
});
