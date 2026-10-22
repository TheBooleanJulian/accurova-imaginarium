import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from './index';

/** Works from source (server/db) and from the bundle (dist-server): walk up to the repo root. */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'supabase', 'migrations'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const ROOT = findRoot();
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const SHIM = path.join(ROOT, 'supabase', 'local', '000_supabase_shim.sql');
const SUPABASE_ONLY = /^--\s*imaginarium:supabase-only/m;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  shim: boolean;
}

/**
 * Applies supabase/migrations/*.sql in order, once each, tracked in
 * public.imaginarium_schema_migrations. On plain Postgres/PGlite it first
 * installs a minimal auth shim (auth.users, auth.uid(), Supabase roles).
 * On Supabase prefer `supabase db push`; this runner also works there.
 */
export async function migrate(db: Db, opts: { dir?: string; log?: (m: string) => void } = {}): Promise<MigrateResult> {
  const log = opts.log ?? (() => undefined);
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const result: MigrateResult = { applied: [], skipped: [], shim: false };

  const [{ has_auth }] = await db.query<{ has_auth: boolean }>(`select to_regclass('auth.users') is not null as has_auth`);
  if (!has_auth) {
    log('auth schema missing: installing local Supabase shim');
    const shim = await readFile(SHIM, 'utf8');
    await db.service((q) => q.exec(shim));
    result.shim = true;
  }
  const [{ has_storage }] = await db.query<{ has_storage: boolean }>(`select to_regclass('storage.objects') is not null as has_storage`);

  await db.query(`create table if not exists public.imaginarium_schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ name: string }>('select name from public.imaginarium_schema_migrations')).map((r) => r.name));

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    if (SUPABASE_ONLY.test(sql) && !has_storage) {
      result.skipped.push(f);
      log(`skip ${f} (Supabase storage only)`);
      continue;
    }
    await db.service(async (q) => {
      await q.exec(sql);
      await q.query('insert into public.imaginarium_schema_migrations (name) values ($1)', [f]);
    });
    result.applied.push(f);
    log(`applied ${f}`);
  }
  return result;
}
