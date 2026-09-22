import { readdir, readFile } from 'node:fs/promises';

import { withTransaction } from './db.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** Applies any migrations/*.sql not yet recorded, in name order. Returns what ran. */
export async function migrate(pool, dir = MIGRATIONS) {
  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
  const { rows } = await pool.query('select name from schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(new URL(file, dir), 'utf8');
    await withTransaction(pool, async (db) => {
      await db.query(sql);
      await db.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
