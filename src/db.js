import pg from 'pg';

// Trip dates are calendar days, not instants: keep DATE columns as 'YYYY-MM-DD'.
pg.types.setTypeParser(1082, (value) => value);

export function createPool(config) {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    // Supabase requires TLS; its pooler certificates aren't in Node's default CA list.
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    // Serverless platforms run many small copies; keep each one's share small.
    max: config.VERCEL ? 3 : 10,
    idleTimeoutMillis: 30_000,
  });
}

/** Runs [fn] in a transaction on one connection, rolling back if it throws. */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
