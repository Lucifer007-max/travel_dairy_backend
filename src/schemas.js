import { z } from 'zod';

export const TRIP_KINDS = ['beach', 'mountains', 'city', 'roadTrip', 'other'];

export const id = z.uuid({ message: 'Not a valid id.' });

/** Optional text: trimmed, and blank becomes null. */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-06-12.')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date.');

const instant = z.iso.datetime({ offset: true, message: 'Use an ISO 8601 time with a timezone.' });

export const place = z
  .object({
    name: z.string().trim().min(1).max(200),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
  })
  .refine((p) => (p.latitude == null) === (p.longitude == null), 'Give both latitude and longitude, or neither.');

export const googleSignIn = z.object({ idToken: z.string().min(10) });

export const profileUpdate = z.object({ name: z.string().trim().min(1).max(80) });

export const tripCreate = z
  .object({
    title: z.string().trim().min(1).max(120),
    destination: z.string().trim().min(1).max(120),
    kind: z.enum(TRIP_KINDS).default('other'),
    startDate: day,
    endDate: day,
  })
  .refine((t) => t.endDate >= t.startDate, { path: ['endDate'], message: 'The trip must end on or after its start.' });

export const tripUpdate = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    destination: z.string().trim().min(1).max(120).optional(),
    kind: z.enum(TRIP_KINDS).optional(),
    startDate: day.optional(),
    endDate: day.optional(),
    coverPhotoId: id.nullable().optional(),
  })
  .refine((t) => Object.keys(t).length > 0, 'Nothing to change.');

export const memoryCreate = z.object({
  title: optionalText(120),
  note: optionalText(4000),
  emoji: optionalText(16),
  happenedAt: instant,
  place: place.nullish(),
  photos: z
    .array(z.object({ takenAt: instant.nullish(), place: place.nullish() }))
    .max(30)
    .default([]),
});

export const memoryUpdate = z
  .object({
    title: optionalText(120),
    note: optionalText(4000),
    emoji: optionalText(16),
    happenedAt: instant.optional(),
    place: place.nullish(),
  })
  .refine((m) => Object.keys(m).length > 0, 'Nothing to change.');
