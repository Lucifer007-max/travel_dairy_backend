import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';

import request from 'supertest';

import { JPEG, PNG, setup } from './helpers.js';

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => {
  await ctx.teardown();
});
beforeEach(async () => {
  await ctx.pool.query('truncate users cascade');
  // Each test starts with no stored photo files either.
  for (const entry of await readdir(ctx.storageDir)) {
    await rm(`${ctx.storageDir}/${entry}`, { recursive: true, force: true });
  }
});

const api = () => request(ctx.app);
const auth = (token) => ({ Authorization: `Bearer ${token}` });

let people = 0;

/** A session for a new Google account (a different person each call). */
async function session() {
  people += 1;
  const { token } = await google(`g-${people}`, `person${people}@example.com`, `Person ${people}`);
  return token;
}

async function google(sub = 'g-1', email = 'aanya@example.com', name = 'Aanya Mehta') {
  const res = await api().post('/v1/auth/google').send({ idToken: `google:${sub}:${email}:${name}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function createTrip(token, overrides = {}) {
  const res = await api()
    .post('/v1/trips')
    .set(auth(token))
    .send({ title: 'Goa', destination: 'Goa', kind: 'beach', startDate: '2026-06-12', endDate: '2026-06-16', ...overrides });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.trip;
}

function addMemory(token, tripId, data, photos = []) {
  const req = api().post(`/v1/trips/${tripId}/memories`).set(auth(token));
  if (photos.length === 0 && !data.__multipart) return req.send(data);
  req.field('data', JSON.stringify(data));
  photos.forEach((buffer, i) => req.attach('photos', buffer, `photo-${i}.jpg`));
  return req;
}

describe('health', () => {
  test('reports ok when the database answers', async () => {
    const res = await api().get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.storage, 'local');
  });
});

describe('signing in', () => {
  test('Google sign-in creates the account once and returns the same one after', async () => {
    const first = await google();
    assert.equal(first.user.email, 'aanya@example.com');
    assert.equal(first.user.name, 'Aanya Mehta');
    assert.equal(first.user.isGuest, undefined);
    const second = await google();
    assert.equal(second.user.id, first.user.id);
  });

  test('there is no guest sign-in: every account is a Google account', async () => {
    const res = await api().post('/v1/auth/guest').send({});
    assert.ok(res.status === 401 || res.status === 404, `got ${res.status}`);
    assert.equal(res.body.token, undefined);
    const { rows } = await ctx.pool.query('select count(*)::int as n from users where google_sub is null');
    assert.equal(rows[0].n, 0);
  });

  test('a bad Google token is refused', async () => {
    const res = await api().post('/v1/auth/google').send({ idToken: 'not-a-real-google-token' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'invalid_google_token');
  });

  test('requests without a valid session are refused', async () => {
    assert.equal((await api().get('/v1/trips')).status, 401);
    const res = await api().get('/v1/trips').set(auth('forged.token.value'));
    assert.equal(res.status, 401);
    assert.match(res.body.error.message, /sign in/i);
  });

  test('the profile name can be changed', async () => {
    const token = await session();
    const res = await api().patch('/v1/me').set(auth(token)).send({ name: '  Asha  ' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.name, 'Asha');
  });
});

describe('trips', () => {
  test('a trip can be created, listed, changed and deleted', async () => {
    const token = await session();
    const trip = await createTrip(token);
    assert.equal(trip.kind, 'beach');
    assert.equal(trip.startDate, '2026-06-12');
    assert.deepEqual(trip.memories, []);

    const list = await api().get('/v1/trips').set(auth(token));
    assert.equal(list.body.trips.length, 1);

    const changed = await api().patch(`/v1/trips/${trip.id}`).set(auth(token)).send({ title: 'Goa with friends' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.trip.title, 'Goa with friends');

    assert.equal((await api().delete(`/v1/trips/${trip.id}`).set(auth(token))).status, 204);
    assert.equal((await api().get(`/v1/trips/${trip.id}`).set(auth(token))).status, 404);
  });

  test('bad trip details are explained', async () => {
    const token = await session();
    const res = await api()
      .post('/v1/trips')
      .set(auth(token))
      .send({ title: '', destination: 'Goa', startDate: '2026-06-16', endDate: '2026-06-12' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    const paths = res.body.error.details.map((d) => d.path);
    assert.ok(paths.includes('title'));
  });

  test("someone else's trip can't be seen, changed or deleted", async () => {
    const owner = await session();
    const stranger = await session();
    const trip = await createTrip(owner);
    assert.equal((await api().get(`/v1/trips/${trip.id}`).set(auth(stranger))).status, 404);
    assert.equal((await api().patch(`/v1/trips/${trip.id}`).set(auth(stranger)).send({ title: 'x' })).status, 404);
    assert.equal((await api().delete(`/v1/trips/${trip.id}`).set(auth(stranger))).status, 404);
    assert.equal((await api().get('/v1/trips').set(auth(stranger))).body.trips.length, 0);
  });

  test('a malformed id is a 400, not a server error', async () => {
    const token = await session();
    const res = await api().get('/v1/trips/not-a-uuid').set(auth(token));
    assert.equal(res.status, 400);
  });
});

describe('memories and photos', () => {
  test('a memory with photos is stored, and its photo links serve the files', async () => {
    const token = await session();
    const trip = await createTrip(token);
    const res = await addMemory(
      token,
      trip.id,
      {
        title: 'Sunset at Vagator',
        note: 'Best sunset of the trip.',
        happenedAt: '2026-06-14T13:12:00.000Z',
        place: { name: 'Vagator Beach', latitude: 15.601, longitude: 73.734 },
        photos: [
          { takenAt: '2026-06-14T13:12:00.000Z', place: { name: 'Vagator Beach', latitude: 15.601, longitude: 73.734 } },
          { takenAt: '2026-06-14T13:15:00.000Z' },
        ],
      },
      [JPEG, PNG],
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const memory = res.body.memory;
    assert.equal(memory.title, 'Sunset at Vagator');
    assert.equal(memory.place.name, 'Vagator Beach');
    assert.equal(memory.photos.length, 2);
    assert.equal(memory.photos[0].contentType, 'image/jpeg');
    assert.equal(memory.photos[1].contentType, 'image/png');
    assert.equal(res.body.trip.memories.length, 1);

    const url = new URL(memory.photos[0].url);
    assert.equal(url.origin, 'http://api.test');
    const file = await api().get(url.pathname + url.search);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/jpeg');
    assert.deepEqual(Buffer.from(file.body), JPEG);

    url.searchParams.set('signature', 'tampered');
    assert.equal((await api().get(url.pathname + url.search)).status, 403);
  });

  test('a memory can be just words, sent as JSON', async () => {
    const token = await session();
    const trip = await createTrip(token);
    const res = await addMemory(token, trip.id, { note: 'Rain all day.', happenedAt: '2026-06-13T05:00:00Z' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.memory.photos.length, 0);
    assert.equal(res.body.memory.title, null);
  });

  test("files that aren't photos are refused and nothing is saved", async () => {
    const token = await session();
    const trip = await createTrip(token);
    const res = await addMemory(
      token,
      trip.id,
      { happenedAt: '2026-06-14T10:00:00Z', photos: [{}] },
      [Buffer.from('#!/bin/sh\necho not an image\n'.padEnd(64, ' '))],
    );
    assert.equal(res.status, 415);
    const { rows } = await ctx.pool.query('select count(*)::int as n from memories');
    assert.equal(rows[0].n, 0);
    assert.deepEqual(await readdir(ctx.storageDir), []);
  });

  test('photos over the size limit are refused', async () => {
    const token = await session();
    const trip = await createTrip(token);
    const huge = Buffer.concat([JPEG, Buffer.alloc(1.2 * 1024 * 1024)]);
    const res = await addMemory(token, trip.id, { happenedAt: '2026-06-14T10:00:00Z', photos: [{}] }, [huge]);
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'file_too_large');
  });

  test('photo details must match the photos sent', async () => {
    const token = await session();
    const trip = await createTrip(token);
    const res = await addMemory(token, trip.id, { happenedAt: '2026-06-14T10:00:00Z', photos: [{}, {}] }, [JPEG]);
    assert.equal(res.status, 400);
  });

  test('a memory can be edited and deleted, and its files go with it', async () => {
    const token = await session();
    const trip = await createTrip(token);
    const created = await addMemory(token, trip.id, { happenedAt: '2026-06-14T10:00:00Z', photos: [{}] }, [JPEG]);
    const memoryId = created.body.memory.id;

    const edited = await api()
      .patch(`/v1/memories/${memoryId}`)
      .set(auth(token))
      .send({ title: 'Fort Aguada', place: { name: 'Fort Aguada' } });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.memory.title, 'Fort Aguada');
    assert.equal(edited.body.memory.place.latitude, null);

    assert.equal((await api().delete(`/v1/memories/${memoryId}`).set(auth(token))).status, 204);
    const { rows } = await ctx.pool.query('select count(*)::int as n from photos');
    assert.equal(rows[0].n, 0);
    const userDirs = await readdir(ctx.storageDir, { recursive: true });
    assert.ok(!userDirs.some((f) => f.endsWith('.jpg')), 'photo file removed');
  });

  test('a photo from the trip can be its cover; one from elsewhere cannot', async () => {
    const token = await session();
    const goa = await createTrip(token);
    const manali = await createTrip(token, { title: 'Manali', startDate: '2026-05-21', endDate: '2026-05-25' });
    const inGoa = (await addMemory(token, goa.id, { happenedAt: '2026-06-14T10:00:00Z', photos: [{}] }, [JPEG])).body
      .memory.photos[0].id;

    const ok = await api().patch(`/v1/trips/${goa.id}`).set(auth(token)).send({ coverPhotoId: inGoa });
    assert.equal(ok.body.trip.coverPhotoId, inGoa);
    const bad = await api().patch(`/v1/trips/${manali.id}`).set(auth(token)).send({ coverPhotoId: inGoa });
    assert.equal(bad.status, 400);
  });
});

describe('sharing a trip', () => {
  const share = (token, tripId, email) =>
    api().post(`/v1/trips/${tripId}/members`).set(auth(token)).send({ email });
  const emailOf = async (token) => (await api().get('/v1/me').set(auth(token))).body.user.email;

  test('only the trip it was shared for shows up for the other person', async () => {
    const owner = await session();
    const shared = await createTrip(owner, { title: 'Goa' });
    const private_ = await createTrip(owner, { title: 'Manali' });

    const res = await share(owner, shared.id, 'Friend@Example.com');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.members.map((m) => [m.email, m.joined]),
      [['friend@example.com', false]],
      'invitations wait, in one case, until that person signs in',
    );

    const { token: friend } = await google('g-friend', 'friend@example.com', 'Ravi');
    const { trips } = (await api().get('/v1/trips').set(auth(friend))).body;
    assert.deepEqual(trips.map((t) => t.title), ['Goa']);
    assert.equal(trips[0].isOwner, false);
    assert.equal(trips[0].owner.email, await emailOf(owner));
    assert.equal((await api().get(`/v1/trips/${private_.id}`).set(auth(friend))).status, 404);

    // The owner sees who it is shared with, now that they have joined.
    const members = (await api().get(`/v1/trips/${shared.id}/members`).set(auth(owner))).body.members;
    assert.deepEqual(members.map((m) => [m.email, m.name, m.joined]), [['friend@example.com', 'Ravi', true]]);
  });

  test('someone sharing the trip can add memories but not change the trip itself', async () => {
    const owner = await session();
    const trip = await createTrip(owner);
    const { token: friend } = await google('g-friend', 'friend@example.com', 'Ravi');
    await share(owner, trip.id, 'friend@example.com');

    const added = await addMemory(friend, trip.id, { happenedAt: '2026-06-14T10:00:00Z', note: 'Sunset' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const ours = (await api().get(`/v1/trips/${trip.id}`).set(auth(owner))).body.trip;
    assert.deepEqual(ours.memories.map((m) => m.note), ['Sunset']);

    assert.equal((await api().patch(`/v1/trips/${trip.id}`).set(auth(friend)).send({ title: 'Mine' })).status, 403);
    assert.equal((await api().delete(`/v1/trips/${trip.id}`).set(auth(friend))).status, 403);
    assert.equal((await share(friend, trip.id, 'someone@example.com')).status, 403);
  });

  test("a memory belongs to whoever added it: no one else can change it", async () => {
    const owner = await session();
    const trip = await createTrip(owner);
    const { token: friend } = await google('g-friend', 'friend@example.com', 'Ravi');
    await share(owner, trip.id, 'friend@example.com');

    const theirs = (await addMemory(friend, trip.id, { happenedAt: '2026-06-14T10:00:00Z', note: 'Theirs' })).body
      .memory;
    const mine = (await addMemory(owner, trip.id, { happenedAt: '2026-06-15T10:00:00Z', note: 'Mine' })).body.memory;

    assert.equal((await api().patch(`/v1/memories/${mine.id}`).set(auth(friend)).send({ note: 'x' })).status, 403);
    assert.equal((await api().delete(`/v1/memories/${theirs.id}`).set(auth(friend))).status, 204, 'their own');
    assert.equal((await api().delete(`/v1/memories/${mine.id}`).set(auth(owner))).status, 204, 'the owner may');
  });

  test('people can be removed, and can leave a trip themselves', async () => {
    const owner = await session();
    const trip = await createTrip(owner);
    const { token: friend } = await google('g-friend', 'friend@example.com', 'Ravi');
    const { token: other } = await google('g-other', 'other@example.com', 'Sam');
    await share(owner, trip.id, 'friend@example.com');
    await share(owner, trip.id, 'other@example.com');

    const members = (await api().get(`/v1/trips/${trip.id}/members`).set(auth(owner))).body.members;
    const [ravi, sam] = members;

    // One person can't remove another.
    assert.equal((await api().delete(`/v1/trips/${trip.id}/members/${sam.id}`).set(auth(friend))).status, 403);
    // But can leave.
    assert.equal((await api().delete(`/v1/trips/${trip.id}/members/${ravi.id}`).set(auth(friend))).status, 204);
    assert.equal((await api().get(`/v1/trips/${trip.id}`).set(auth(friend))).status, 404);

    // And the owner can remove anyone.
    assert.equal((await api().delete(`/v1/trips/${trip.id}/members/${sam.id}`).set(auth(owner))).status, 204);
    assert.equal((await api().get('/v1/trips').set(auth(other))).body.trips.length, 0);
    assert.deepEqual((await api().get(`/v1/trips/${trip.id}/members`).set(auth(owner))).body.members, []);
  });

  test('sharing twice changes nothing, and a trip cannot be shared with yourself', async () => {
    const owner = await session();
    const trip = await createTrip(owner);
    assert.equal((await share(owner, trip.id, 'friend@example.com')).status, 201);
    const again = await share(owner, trip.id, 'FRIEND@example.com');
    assert.equal(again.status, 200);
    assert.equal(again.body.members.length, 1);
    assert.equal((await share(owner, trip.id, await emailOf(owner))).status, 400, 'their own address');
    assert.equal((await share(owner, trip.id, 'not-an-email')).status, 400);
  });

  test('deleting a trip takes the sharing with it', async () => {
    const owner = await session();
    const trip = await createTrip(owner);
    await share(owner, trip.id, 'friend@example.com');
    assert.equal((await api().delete(`/v1/trips/${trip.id}`).set(auth(owner))).status, 204);
    const { rows } = await ctx.pool.query('select count(*)::int as n from trip_members');
    assert.equal(rows[0].n, 0);
  });
});

describe('notifications', () => {
  test('being added to a trip is recorded for that person, and can be marked read', async () => {
    const owner = await session();
    const trip = await createTrip(owner, { title: 'Goa' });
    const { token: friend } = await google('g-friend', 'friend@example.com', 'Ravi');

    await api().post(`/v1/trips/${trip.id}/members`).set(auth(owner)).send({ email: 'friend@example.com' });

    const { body } = await api().get('/v1/notifications').set(auth(friend));
    assert.equal(body.unread, 1);
    assert.equal(body.notifications[0].kind, 'trip_shared');
    assert.match(body.notifications[0].title, /added you to a trip$/);
    assert.match(body.notifications[0].body, /Goa/);
    assert.equal(body.notifications[0].tripId, trip.id);
    assert.equal(body.notifications[0].read, false);

    // Nobody else is told.
    assert.equal((await api().get('/v1/notifications').set(auth(owner))).body.notifications.length, 0);

    assert.equal((await api().post('/v1/notifications/read').set(auth(friend))).status, 204);
    const after = await api().get('/v1/notifications').set(auth(friend));
    assert.equal(after.body.unread, 0);
    assert.equal(after.body.notifications[0].read, true);
  });

  test('someone invited before they had an account is told when they sign in', async () => {
    const owner = await session();
    const trip = await createTrip(owner, { title: 'Manali' });
    await api().post(`/v1/trips/${trip.id}/members`).set(auth(owner)).send({ email: 'later@example.com' });

    const { token } = await google('g-later', 'later@example.com', 'Sam');
    const { body } = await api().get('/v1/notifications').set(auth(token));
    assert.equal(body.unread, 1);
    assert.match(body.notifications[0].body, /Manali/);

    // Signing in again doesn't tell them twice.
    await google('g-later', 'later@example.com', 'Sam');
    assert.equal((await api().get('/v1/notifications').set(auth(token))).body.notifications.length, 1);
  });

  test('a phone can be registered for pushes and forgotten again', async () => {
    const token = await session();
    const device = { token: 'fcm-token-1234567890', platform: 'android' };

    assert.equal((await api().post('/v1/me/devices').set(auth(token)).send(device)).status, 204);
    assert.equal((await api().post('/v1/me/devices').set(auth(token)).send(device)).status, 204, 'twice is fine');
    const { rows } = await ctx.pool.query('select count(*)::int as n from device_tokens');
    assert.equal(rows[0].n, 1);

    assert.equal((await api().delete('/v1/me/devices').set(auth(token)).send(device)).status, 204);
    const after = await ctx.pool.query('select count(*)::int as n from device_tokens');
    assert.equal(after.rows[0].n, 0);
    assert.equal((await api().post('/v1/me/devices').set(auth(token)).send({ token: 'short' })).status, 400);
  });
});

describe('deleting the account', () => {
  test('removes the person, their trips and their photo files', async () => {
    const token = await session();
    const trip = await createTrip(token);
    await addMemory(token, trip.id, { happenedAt: '2026-06-14T10:00:00Z', photos: [{}] }, [JPEG]);

    assert.equal((await api().delete('/v1/me').set(auth(token))).status, 204);
    assert.equal((await api().get('/v1/me').set(auth(token))).status, 401);
    const { rows } = await ctx.pool.query('select count(*)::int as n from trips');
    assert.equal(rows[0].n, 0);
    const files = await readdir(ctx.storageDir, { recursive: true });
    assert.ok(!files.some((f) => f.endsWith('.jpg')));
  });
});

describe('errors', () => {
  test('unknown routes and bad JSON get clear JSON errors', async () => {
    const missing = await api().get('/v1/nope');
    assert.equal(missing.status, 401, 'API routes need a session first');
    const bad = await api().post('/v1/auth/google').set('Content-Type', 'application/json').send('{"idToken":');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_json');
    assert.equal((await api().get('/nope')).status, 404);
  });
});
