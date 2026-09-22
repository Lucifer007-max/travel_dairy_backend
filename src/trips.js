/** Reading trips out of the database in the shape the app uses. */

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

/**
 * The user's trips, newest first, each with its memories (in time order) and
 * their photos, including signed links to the image files.
 * Pass [tripId] for a single trip; returns [] if it isn't theirs.
 */
export async function loadTrips(db, storage, userId, { tripId } = {}) {
  const { rows: trips } = await db.query(
    `select * from trips
      where user_id = $1 ${tripId ? 'and id = $2' : ''}
      order by start_date desc, created_at desc`,
    tripId ? [userId, tripId] : [userId],
  );
  if (trips.length === 0) return [];

  const { rows: memories } = await db.query(
    'select * from memories where trip_id = any($1::uuid[]) order by happened_at, created_at',
    [trips.map((t) => t.id)],
  );
  const { rows: photos } = memories.length
    ? await db.query('select * from photos where memory_id = any($1::uuid[]) order by position, created_at', [
        memories.map((m) => m.id),
      ])
    : { rows: [] };
  const urls = await storage.signedUrls(photos.map((p) => p.storage_path));

  const photosByMemory = Map.groupBy(photos, (p) => p.memory_id);
  const memoriesByTrip = Map.groupBy(memories, (m) => m.trip_id);

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
    memories: (memoriesByTrip.get(t.id) ?? []).map((m) => ({
      id: m.id,
      tripId: m.trip_id,
      happenedAt: iso(m.happened_at),
      title: m.title,
      note: m.note,
      emoji: m.emoji,
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
