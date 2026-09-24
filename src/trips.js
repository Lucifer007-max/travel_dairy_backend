/** Reading trips out of the database in the shape the app uses. */

import { notFound } from './errors.js';

export const serializeUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  photoUrl: u.photo_url,
});

const place = (name, latitude, longitude) => {
  if (name == null && latitude == null) return null;
  return {
    name: name ?? `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
    latitude: latitude ?? null,
    longitude: longitude ?? null,
  };
};

const iso = (date) => (date ? date.toISOString() : null);

/** Email addresses are compared and stored in one case. */
export const normalizeEmail = (email) => email.trim().toLowerCase();

/**
 * A trip is visible to the person who made it and to anyone it was shared
 * with, matched by their account or, before they have signed in, by the email
 * it was shared with. $1 is the user id and $2 their email.
 */
const VISIBLE = `(t.user_id = $1 or exists (
        select 1 from trip_members mem
         where mem.trip_id = t.id and (mem.user_id = $1 or mem.email = $2)))`;

/**
 * What [user] may do with a trip: nothing (throws), view and add their own
 * memories (a member), or everything (the owner).
 */
export async function tripAccess(db, user, tripId) {
  const { rows } = await db.query(`select t.user_id from trips t where t.id = $3 and ${VISIBLE}`, [
    user.id,
    user.email ? normalizeEmail(user.email) : null,
    tripId,
  ]);
  if (!rows[0]) throw notFound('That trip was not found.');
  return { isOwner: rows[0].user_id === user.id, ownerId: rows[0].user_id };
}

/**
 * The trips [user] can see — their own and the ones shared with them — newest
 * first, each with the people it is shared with, its memories (in time order)
 * and their photos, including signed links to the image files.
 * Pass [tripId] for a single trip; returns [] if they can't see it.
 */
export async function loadTrips(db, storage, user, { tripId } = {}) {
  const params = [user.id, user.email ? normalizeEmail(user.email) : null];
  const { rows: trips } = await db.query(
    `select t.* from trips t
      where ${VISIBLE} ${tripId ? 'and t.id = $3' : ''}
      order by t.start_date desc, t.created_at desc`,
    tripId ? [...params, tripId] : params,
  );
  if (trips.length === 0) return [];
  const tripIds = trips.map((t) => t.id);

  const { rows: memories } = await db.query(
    'select * from memories where trip_id = any($1::uuid[]) order by happened_at, created_at',
    [tripIds],
  );
  const { rows: photos } = memories.length
    ? await db.query('select * from photos where memory_id = any($1::uuid[]) order by position, created_at', [
        memories.map((m) => m.id),
      ])
    : { rows: [] };
  const urls = await storage.signedUrls(photos.map((p) => p.storage_path));

  const { rows: members } = await db.query(
    `select mem.*, u.name, u.photo_url from trip_members mem
       left join users u on u.id = mem.user_id
      where mem.trip_id = any($1::uuid[])
      order by mem.created_at`,
    [tripIds],
  );
  const { rows: owners } = await db.query('select * from users where id = any($1::uuid[])', [
    [...new Set(trips.map((t) => t.user_id))],
  ]);

  const ownerById = new Map(owners.map((u) => [u.id, u]));
  const photosByMemory = Map.groupBy(photos, (p) => p.memory_id);
  const memoriesByTrip = Map.groupBy(memories, (m) => m.trip_id);
  const membersByTrip = Map.groupBy(members, (m) => m.trip_id);

  return trips.map((t) => ({
    id: t.id,
    title: t.title,
    destination: t.destination,
    kind: t.kind,
    startDate: t.start_date,
    endDate: t.end_date,
    coverPhotoId: t.cover_photo_id,
    createdAt: iso(t.created_at),
    updatedAt: iso(t.updated_at),
    // Who it belongs to, and who it is shared with. Only the owner may change
    // the trip itself or the people on it.
    isOwner: t.user_id === user.id,
    owner: ownerById.has(t.user_id) ? serializeUser(ownerById.get(t.user_id)) : { id: t.user_id },
    sharedWith: (membersByTrip.get(t.id) ?? []).map(serializeMember),
    memories: (memoriesByTrip.get(t.id) ?? []).map((m) => ({
      id: m.id,
      tripId: m.trip_id,
      happenedAt: iso(m.happened_at),
      title: m.title,
      note: m.note,
      emoji: m.emoji,
      createdBy: m.created_by,
      place: place(m.place_name, m.latitude, m.longitude),
      photos: (photosByMemory.get(m.id) ?? []).map((p) => ({
        id: p.id,
        url: urls.get(p.storage_path) ?? null,
        contentType: p.content_type,
        takenAt: iso(p.taken_at),
        place: place(p.place_name, p.latitude, p.longitude),
      })),
    })),
  }));
}

/** One person a trip is shared with; name and photo appear once they sign in. */
export const serializeMember = (m) => ({
  id: m.id,
  email: m.email,
  userId: m.user_id,
  name: m.name ?? null,
  photoUrl: m.photo_url ?? null,
  joined: m.user_id != null,
  invitedAt: iso(m.created_at),
});

/** Everyone a trip is shared with, in the order they were added. */
export async function loadMembers(db, tripId) {
  const { rows } = await db.query(
    `select mem.*, u.name, u.photo_url from trip_members mem
       left join users u on u.id = mem.user_id
      where mem.trip_id = $1
      order by mem.created_at`,
    [tripId],
  );
  return rows.map(serializeMember);
}

/** Storage keys of every photo matching [where] (joined photos p → memories m → trips t). */
export async function photoKeys(db, where, params) {
  const { rows } = await db.query(
    `select p.storage_path from photos p
       join memories m on m.id = p.memory_id
       join trips t on t.id = m.trip_id
      where ${where}`,
    params,
  );
  return rows.map((r) => r.storage_path);
}
