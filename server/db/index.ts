import postgres from 'postgres';

export type Row = Record<string, unknown>;

/** The one query primitive every service uses. Parameters are positional ($1, $2…). */
export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run a multi-statement script (migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db {
  readonly kind: 'postgres' | 'pglite';
  /**
   * Transaction as the table owner (bypasses RLS). Only for the job worker,
   * migrations and narrowly-scoped server operations that have already
   * checked permissions.
   */
  service<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /**
   * Transaction as the Supabase `authenticated` role with the caller's claims,
   * so every row-level security policy applies exactly as it would for a
   * direct Supabase client call.
   */
  asUser<T>(userId: string, fn: (q: Queryable) => Promise<T>, claims?: Record<string, unknown>): Promise<T>;
  /** One statement as the owner, outside a transaction. */
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function enterUser(q: Queryable, userId: string, claims?: Record<string, unknown>) {
  const c = JSON.stringify({ sub: userId, role: 'authenticated', ...claims });
  await q.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [c, userId]);
  await q.query('set local role authenticated');
}

export interface PostgresOptions {
  url: string;
  /** Supabase's transaction pooler (port 6543) needs prepared statements off. */
  prepare?: boolean;
  max?: number;
}

export function createPostgresDb(opts: PostgresOptions): Db {
  const sql = postgres(opts.url, {
    prepare: opts.prepare ?? false,
    max: opts.max ?? 10,
    idle_timeout: 30,
    onnotice: () => undefined,
    // bigint (size_bytes, counts) as JS numbers; our values are far below 2^53.
    types: { bigint: { to: 20, from: [20], serialize: (v: number) => String(v), parse: (v: string) => Number(v) } },
  });
  const wrap = (tx: postgres.Sql | postgres.TransactionSql): Queryable => ({
    query: async <T extends Row>(text: string, params: unknown[] = []) =>
      (await tx.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[],
    exec: async (script: string) => {
      await tx.unsafe(script, [], { simple: true } as never);
    },
  });
  return {
    kind: 'postgres',
    service: (fn) => sql.begin((tx) => fn(wrap(tx))) as Promise<never>,
    asUser: (userId, fn, claims) =>
      sql.begin(async (tx) => {
        const q = wrap(tx);
        await enterUser(q, userId, claims);
        return fn(q);
      }) as Promise<never>,
    query: (text, params) => wrap(sql).query(text, params),
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * Embedded Postgres (WASM) for zero-install local development. Same SQL, same
 * migrations, same RLS. Single connection, so transactions are serialised.
 */
export async function createPgliteDb(dataDir: string | undefined): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
  const wrap = (tx: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (s: string) => Promise<unknown> }): Queryable => ({
    query: async <T extends Row>(text: string, params: unknown[] = []) => (await tx.query(text, params)).rows as T[],
    exec: async (script: string) => {
      await tx.exec(script);
    },
  });
  // PGlite runs one transaction at a time; queue callers so they don't interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    kind: 'pglite',
    service: (fn) => serial(() => pg.transaction((tx) => fn(wrap(tx)))),
    asUser: (userId, fn, claims) =>
      serial(() =>
        pg.transaction(async (tx) => {
          const q = wrap(tx);
          await enterUser(q, userId, claims);
          return fn(q);
        }),
      ),
    query: (text, params) => serial(() => wrap(pg).query(text, params)),
    close: () => pg.close(),
  };
}

/** Postgres error helpers. */
export function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code ?? err?.cause?.code;
}
export const isUniqueViolation = (e: unknown) => pgCode(e) === '23505';
export const isRlsViolation = (e: unknown) => pgCode(e) === '42501';
