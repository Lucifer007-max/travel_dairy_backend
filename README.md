# TravelDiary API

Node.js (Express 5) backend for the TravelDiary app. Data lives in **Supabase**: PostgreSQL for
people, trips, memories and photo details, and a private **Supabase Storage** bucket for the photo
files. The app talks only to this API; it never holds database or storage keys.

## Run it locally

Needs Node 22+ and a PostgreSQL database (Supabase, or any local Postgres).

```sh
cp .env.example .env        # then fill in DATABASE_URL, JWT_SECRET, GOOGLE_CLIENT_IDS
npm install
npm run migrate             # creates the tables
npm run dev                 # http://localhost:8787, restarts on changes
npm test                    # API tests against TEST_DATABASE_URL (a throwaway database)
```

With `STORAGE_DRIVER=local`, photos are saved in `./uploads` and served through signed links.
The Android emulator reaches this computer at `http://10.0.2.2:8787`, which is the app's default.

## Connect Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **Database**: *Connect* → **Session pooler** connection string → `DATABASE_URL`, and set
   `DATABASE_SSL=true`. Run `npm run migrate`.
3. **Storage**: *Project Settings → API* → copy the project URL to `SUPABASE_URL` and the
   **service_role** key to `SUPABASE_SERVICE_ROLE_KEY`. Set `STORAGE_DRIVER=supabase`, then
   `npm run setup:storage` to create the private `photos` bucket.
4. `GOOGLE_CLIENT_IDS` = the **Web application** OAuth client ID the app uses as its
   `serverClientId`. The server checks every Google sign-in against it.

The service role key and database password are secrets: they belong only in this server's
environment, never in the app or in git. The tables have row level security turned on with no
policies, so Supabase's public REST API can't read them; only this server (the table owner) can.

## Deploy

`Dockerfile` builds a small image that applies migrations and starts the server; any container
host works (Render, Fly.io, Railway, Cloud Run…). Set the same environment variables there, with
`PUBLIC_BASE_URL` set to the public HTTPS address. Build the app against it with
`flutter build apk --dart-define=API_BASE_URL=https://your-api.example.com`.

## API

All routes are under `/v1` and return JSON. Errors are always
`{ "error": { "code", "message", "details"? } }`, with a message fit to show people.
Everything except sign-in needs `Authorization: Bearer <token>`.

| Method & path | What it does |
| --- | --- |
| `POST /v1/auth/google` `{ idToken }` | Sign in with a Google ID token. A guest session sent along has its trips moved over. |
| `POST /v1/auth/guest` | Start a guest account. |
| `GET /v1/me` · `PATCH /v1/me` `{ name }` · `DELETE /v1/me` | The account; delete removes everything, photos included. |
| `GET /v1/trips` | Every trip, newest first, with memories and signed photo links. |
| `POST /v1/trips` `{ title, destination, kind, startDate, endDate }` | New trip (`kind`: beach, mountains, city, roadTrip, other). |
| `GET · PATCH · DELETE /v1/trips/:id` | One trip. `PATCH` also takes `coverPhotoId`. |
| `POST /v1/trips/:id/memories` | New memory. Multipart: `data` (JSON) + `photos` files in the same order as `data.photos`. |
| `PATCH · DELETE /v1/memories/:id` | Edit or remove a memory. |
| `DELETE /v1/photos/:id` | Remove one photo. |
| `GET /health` | Database check for uptime monitors. |

A memory's `data`: `{ title?, note?, emoji?, happenedAt, place?: { name, latitude?, longitude? },
photos: [{ takenAt?, place? }] }`. Times are ISO 8601 with a timezone. Photos must really be JPEG,
PNG, WebP or HEIC (checked from the file's bytes), up to `MAX_UPLOAD_MB` each and 30 per memory.

## Layout

```text
src/
  server.js         starts the server
  app.js            the Express app: security headers, CORS, logging, routes, errors
  config.js         environment settings, checked at startup
  db.js, migrate.js Postgres pool, transactions, migrations
  schemas.js        request validation (zod)
  trips.js          reading trips out in the app's shape
  auth/             Google ID token checks, session tokens
  routes/           auth, me, trips, memories, files
  storage/          Supabase Storage and local-disk drivers
migrations/         SQL, applied in name order
test/               API tests (node:test + supertest) on a real database
```
