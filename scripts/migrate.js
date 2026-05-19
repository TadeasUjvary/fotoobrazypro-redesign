// One-shot migration runner: applies every migrations/*.sql in order.
// Usage: DATABASE_URL=... node scripts/migrate.js
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env or your shell.');
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

await client.connect();
try {
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    await client.query(sql);
    console.log('done');
  }
  console.log('All migrations applied.');
} catch (err) {
  console.error('\nMigration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
