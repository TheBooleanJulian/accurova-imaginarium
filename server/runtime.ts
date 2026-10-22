import path from 'node:path';
import { hostname } from 'node:os';
import type { AIProvider } from '../src/core/ai';
import { JobEngine } from '../src/core/jobEngine';
import { createExportExecutor } from '../src/features/export/executor';
import { loadConfig, type Config } from './config';
import { createPgliteDb, createPostgresDb, type Db } from './db/index';
import { migrate } from './db/migrate';
import { createStorage, type ObjectStorage } from './storage';
import { createProvider } from './ai/index';
import { createPgJobStore } from './jobs/pgJobStore';
import { Backend } from './backend';
import { createAuth, type Authenticator } from './auth';
import { createApp } from './app';
import { rasterizeForPdf } from './images';

export interface RuntimeOverrides {
  db?: Db;
  storage?: ObjectStorage;
  provider?: AIProvider;
  providerLabel?: string;
  auth?: Authenticator;
  waitUntil?: (p: Promise<unknown>) => void;
  log?: (msg: string, err?: unknown) => void;
  /** Skip the migration step (tests that migrate themselves). */
  skipMigrate?: boolean;
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export async function createRuntime(cfg: Config = loadConfig(), o: RuntimeOverrides = {}) {
  const log = o.log ?? ((m: string, e?: unknown) => (e ? console.error(`[imaginarium] ${m}`, e) : console.log(`[imaginarium] ${m}`)));
  const db =
    o.db ??
    (cfg.env.DATABASE_URL
      ? createPostgresDb({ url: cfg.env.DATABASE_URL, prepare: cfg.env.DB_PREPARE ?? false, max: cfg.env.DB_POOL_MAX })
      : await createPgliteDb(path.join(cfg.dataDir, 'pglite')));
  const shouldMigrate = !o.skipMigrate && (cfg.env.MIGRATE_ON_START ?? (db.kind === 'pglite' || !cfg.production));
  if (shouldMigrate) await migrate(db, { log: (m) => log(`migrate: ${m}`) });

  const storage = o.storage ?? createStorage(cfg);
  const providerInfo = o.provider ? { provider: o.provider, label: o.providerLabel ?? o.provider.id } : createProvider(cfg);
  const store = createPgJobStore(db, storage, {
    maxConcurrentPerProject: Math.max(1, cfg.env.MAX_CONCURRENT_JOBS_PER_PROJECT),
    leaseSeconds: Math.max(30, cfg.env.JOB_LEASE_SECONDS),
  });

  // The export executor needs project names; Backend is created right after.
  let backend: Backend | null = null;
  const engine = new JobEngine(store, providerInfo.provider, {
    workerId: `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`,
    concurrency: Math.max(1, cfg.env.WORKER_CONCURRENCY),
    maxAttempts: Math.max(1, cfg.env.JOB_MAX_ATTEMPTS),
    baseDelayMs: cfg.env.JOB_RETRY_BASE_MS,
    maxJobsPerUserPerDay: cfg.env.MAX_JOBS_PER_USER_PER_DAY,
    internalExecutors: {
      'export:export': createExportExecutor({ rasterize: rasterizeForPdf, loadMeta: (pid) => backend!.exportMeta(pid) }),
    },
  });
  backend = new Backend({ cfg, db, storage, engine });
  const auth = o.auth ?? createAuth(cfg, db);
  const app = createApp({ cfg, backend, auth, storage, engine, providerLabel: providerInfo.label, waitUntil: o.waitUntil, log });

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    cfg,
    db,
    storage,
    engine,
    backend,
    auth,
    app,
    providerLabel: providerInfo.label,
    /** Long-running hosts: poll the shared queue so jobs from any instance (or a restart) get done. */
    startWorker() {
      if (timer || cfg.env.WORKER === 'off') return;
      const tick = () => void engine.poll().catch((e) => log('worker poll failed', e));
      tick();
      timer = setInterval(tick, Math.max(250, cfg.env.WORKER_POLL_MS));
      timer.unref?.();
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = null;
      await engine.whenIdle();
      await db.close();
    },
  };
}
