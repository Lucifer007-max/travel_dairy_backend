import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import multer from 'multer';

import { withTransaction } from '../db.js';
import { badRequest, forbidden, HttpError, notFound } from '../errors.js';
import { id, memoryCreate, memoryUpdate } from '../schemas.js';
import { detectImageType } from '../storage/images.js';
import { loadTrips, photoKeys, tripAccess } from '../trips.js';

const MAX_PHOTOS = 30;

export function memoriesRouter({ pool, storage, config }) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: MAX_PHOTOS, fields: 5 },
  }).array('photos', MAX_PHOTOS);

  /**
   * A memory on a trip the person can see. Everyone sharing a trip may add
   * memories, but only the trip's owner and whoever wrote a memory may change
   * or remove it.
   */
  async function editableMemory(user, memoryId) {
    const { rows } = await pool.query(
      'select m.*, t.user_id as trip_owner_id from memories m join trips t on t.id = m.trip_id where m.id = $1',
      [memoryId],
    );
    const memory = rows[0];
    if (!memory) throw notFound('That memory was not found.');
    const { isOwner } = await tripAccess(pool, user, memory.trip_id);
    if (!isOwner && memory.created_by !== user.id) {
      throw forbidden('This memory was added by someone else on the trip.');
    }
    return memory;
  }

  /**
   * Add a memory. Send multipart/form-data with a "data" field holding the
   * memory as JSON, and its photos as "photos" files in the same order as
   * data.photos (which carries each photo's time and place). A memory without
   * photos can be sent as plain JSON.
   */
  router.post('/trips/:tripId/memories', upload, async (req, res) => {
    const tripId = id.parse(req.params.tripId);
    let raw = req.body;
    if (req.is('multipart/form-data')) {
      try {
        raw = JSON.parse(req.body?.data ?? '{}');
      } catch {
        throw badRequest('The "data" field must be JSON.');
      }
    }
    const input = memoryCreate.parse(raw);
    const files = req.files ?? [];
    if (input.photos.length > 0 && input.photos.length !== files.length) {
      throw badRequest(`Got ${files.length} photos but details for ${input.photos.length}.`);
    }
    await tripAccess(pool, req.user, tripId);

    const memoryId = randomUUID();
    const photos = files.map((file, position) => {
      const type = detectImageType(file.buffer);
      if (!type) {
        throw new HttpError(415, 'unsupported_image', 'Only JPEG, PNG, WebP and HEIC photos can be added.');
      }
      const photoId = randomUUID();
      return {
        id: photoId,
        position,
        file,
        type,
        key: `${req.user.id}/${tripId}/${memoryId}/${photoId}.${type.extension}`,
        meta: input.photos[position] ?? {},
      };
    });

    const stored = [];
    try {
      for (const p of photos) {
        await storage.put(p.key, p.file.buffer, p.type.contentType);
        stored.push(p.key);
      }
      await withTransaction(pool, async (db) => {
        await db.query(
          `insert into memories (id, trip_id, created_by, title, note, emoji, happened_at,
                                 place_name, latitude, longitude)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            memoryId,
            tripId,
            req.user.id,
            input.title,
            input.note,
            input.emoji,
            input.happenedAt,
            input.place?.name ?? null,
            input.place?.latitude ?? null,
            input.place?.longitude ?? null,
          ],
        );
        for (const p of photos) {
          await db.query(
            `insert into photos (id, memory_id, storage_path, content_type, size_bytes, position,
                                 taken_at, place_name, latitude, longitude)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              p.id,
              memoryId,
              p.key,
              p.type.contentType,
              p.file.size,
              p.position,
              p.meta.takenAt ?? null,
              p.meta.place?.name ?? null,
              p.meta.place?.latitude ?? null,
              p.meta.place?.longitude ?? null,
            ],
          );
        }
        await db.query('update trips set updated_at = now() where id = $1', [tripId]);
      });
    } catch (error) {
      // Don't leave orphaned files behind a failed save.
      await storage.remove(stored).catch(() => {});
      throw error;
    }

    const [trip] = await loadTrips(pool, storage, req.user, { tripId });
    res.status(201).json({ memory: trip.memories.find((m) => m.id === memoryId), trip });
  });

  router.patch('/memories/:memoryId', async (req, res) => {
    const memory = await editableMemory(req.user, id.parse(req.params.memoryId));
    const changes = memoryUpdate.parse(req.body);

    const columns = {};
    for (const key of ['title', 'note', 'emoji']) if (key in changes) columns[key] = changes[key];
    if (changes.happenedAt) columns.happened_at = changes.happenedAt;
    if ('place' in changes) {
      columns.place_name = changes.place?.name ?? null;
      columns.latitude = changes.place?.latitude ?? null;
      columns.longitude = changes.place?.longitude ?? null;
    }
    const entries = Object.entries(columns);
    if (entries.length > 0) {
      await pool.query(
        `update memories set ${entries.map(([c], i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
          where id = $1`,
        [memory.id, ...entries.map(([, v]) => v)],
      );
    }
    const [trip] = await loadTrips(pool, storage, req.user, { tripId: memory.trip_id });
    res.json({ memory: trip.memories.find((m) => m.id === memory.id), trip });
  });

  router.delete('/memories/:memoryId', async (req, res) => {
    const memory = await editableMemory(req.user, id.parse(req.params.memoryId));
    const keys = await photoKeys(pool, 'm.id = $1', [memory.id]);
    await pool.query('delete from memories where id = $1', [memory.id]);
    await storage.remove(keys).catch((err) => req.log?.warn({ err }, 'could not remove photo files'));
    res.status(204).end();
  });

  router.delete('/photos/:photoId', async (req, res) => {
    const photoId = id.parse(req.params.photoId);
    const { rows: found } = await pool.query('select memory_id from photos where id = $1', [photoId]);
    if (!found[0]) throw notFound('That photo was not found.');
    await editableMemory(req.user, found[0].memory_id);

    const { rows } = await pool.query('delete from photos where id = $1 returning storage_path', [photoId]);
    if (!rows[0]) throw notFound('That photo was not found.');
    await storage.remove([rows[0].storage_path]).catch((err) => req.log?.warn({ err }, 'could not remove photo file'));
    res.status(204).end();
  });

  return router;
}
