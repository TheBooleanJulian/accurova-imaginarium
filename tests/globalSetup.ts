import type { TestProject } from 'vitest/node';
// @ts-expect-error plain ESM helper without types
import { startCluster } from '../scripts/pg-cluster.mjs';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection string for a Postgres server, or '' when none is available. */
    pgAdminUrl: string;
  }
}

/**
 * Server tests need real Postgres. Use TEST_DATABASE_URL if given (e.g. a local
 * Supabase or CI service), otherwise start a throwaway cluster from the
 * Postgres binaries on this machine. Without either, server suites are skipped.
 */
export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('pgAdminUrl', process.env.TEST_DATABASE_URL);
    return;
  }
  const cluster = (await startCluster()) as { url: string; stop: () => void } | null;
  project.provide('pgAdminUrl', cluster?.url ?? '');
  if (!cluster) console.warn('[tests] No Postgres found: server/database suites will be skipped. Set TEST_DATABASE_URL or PG_BIN.');
  return () => cluster?.stop();
}
