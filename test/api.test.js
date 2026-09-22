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
