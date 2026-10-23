/**
 * Apply database migrations: `npm run db:migrate`.
 * Uses DATABASE_URL (Supabase or any Postgres) or the local PGlite database.
 * On Supabase you can use `supabase db push` instead; don't mix the two on one database.
 */
import path from 'node:path';
import { loadConfig, loadDotEnv } from '../server/config';
import { createPgliteDb, createPostgresDb } from '../server/db/index';
import { migrate } from '../server/db/migrate';

loadDotEnv();
const cfg = loadConfig();
const db = cfg.env.DATABASE_URL
  ? createPostgresDb({ url: cfg.env.DATABASE_URL, prepare: cfg.env.DB_PREPARE ?? false, max: 1 })
  : await createPgliteDb(path.join(cfg.dataDir, 'pglite'));
try {
  const r = await migrate(db, { log: (m) => console.log(`  ${m}`) });
  console.log(`Done: ${r.applied.length} applied, ${r.skipped.length} skipped${r.shim ? ' (local auth shim installed)' : ''}.`);
} finally {
  await db.close();
}
