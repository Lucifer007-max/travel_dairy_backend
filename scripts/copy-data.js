import pg from 'pg';

import { migrate } from '../src/migrate.js';

// Copies every account, trip, memory and photo record from another database
// (e.g. the local development one) into DATABASE_URL (e.g. Supabase), keeping
// their ids so photo files already in storage still match. Safe to re-run:
// rows that already exist are skipped.
//
//   npm run copy-data -- postgres://postgres@127.0.0.1:54329/traveldiary_dev

pg.types.setTypeParser(1082, (value) => value); // dates stay "2026-06-12"

const source = process.argv[2];
const target = process.env.DATABASE_URL;
if (!source || !target) {
  console.error('Usage: npm run copy-data -- <source database URL>   (copies into DATABASE_URL)');
  process.exit(1);
}
if (source === target) {
  console.error('The source and DATABASE_URL are the same database; nothing to copy.');
  process.exit(1);
}

const ssl = (url, flag) => (flag || /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined);
const from = new pg.Pool({ connectionString: source, ssl: ssl(source, false) });
const to = new pg.Pool({ connectionString: target, ssl: ssl(target, process.env.DATABASE_SSL === 'true') });

async function copy(db, table, rows) {
  let added = 0;
  for (const row of rows) {
    const columns = Object.keys(row);
    const { rowCount } = await db.query(
      `insert into ${table} (${columns.join(', ')})
       values (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       on conflict do nothing`,
      columns.map((c) => row[c]),
    );
    added += rowCount;
  }
  console.log(`  ${table}: ${added} added, ${rows.length - added} already there`);
}

try {
  const applied = await migrate(to);
  console.log(applied.length ? `Target schema: applied ${applied.join(', ')}` : 'Target schema is up to date.');

  const read = async (sql) => (await from.query(sql)).rows;
  const users = await read('select * from users order by created_at');
  const trips = await read('select * from trips order by created_at');
  const memories = await read('select * from memories order by created_at');
  const photos = await read('select * from photos order by created_at');

  const db = await to.connect();
  try {
    await db.query('begin');
    await copy(db, 'users', users);
    // Covers point at photos, so trips go in without them first.
    await copy(db, 'trips', trips.map((t) => ({ ...t, cover_photo_id: null })));
    await copy(db, 'memories', memories);
    await copy(db, 'photos', photos);
    for (const t of trips.filter((t) => t.cover_photo_id)) {
      await db.query('update trips set cover_photo_id = $1 where id = $2 and cover_photo_id is null', [t.cover_photo_id, t.id]);
    }
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
  console.log('Done.');
} catch (error) {
  console.error('Copy failed:', error.message);
  process.exitCode = 1;
} finally {
  await from.end();
  await to.end();
}
