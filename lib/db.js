import pg from 'pg';

const { Pool } = pg;

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}

// Shared pool, reused across warm serverless invocations. Use the Supabase
// "Session pooler" connection string so explicit BEGIN/COMMIT works reliably.
let _pool = null;
function pool() {
  if (!_pool) {
    const isLocal = /localhost|127\.0\.0\.1/.test(connectionString());
    _pool = new Pool({
      connectionString: connectionString(),
      max: 3,
      idleTimeoutMillis: 10_000,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

// Tagged-template client for one-off queries. Returns the rows array directly:
//   const rows = await sql`SELECT * FROM orders WHERE id = ${id}`;
export function sql(strings, ...values) {
  let text = '';
  strings.forEach((s, i) => {
    text += s;
    if (i < values.length) text += '$' + (i + 1);
  });
  return pool()
    .query(text, values)
    .then((r) => r.rows);
}

// Interactive transaction. Callback receives a pg client with `.query`:
//   await withTransaction(async (client) => {
//     const { rows } = await client.query('INSERT ... RETURNING id', [..]);
//   });
export async function withTransaction(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}
