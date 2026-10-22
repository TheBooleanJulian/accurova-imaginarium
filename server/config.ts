import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v == null ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : d))
    .pipe(z.number().int().min(0));

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(8787),
  DATA_DIR: z.string().default('.data'),
  PUBLIC_APP_URL: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  DB_PREPARE: bool,
  DB_POOL_MAX: int(10),
  MIGRATE_ON_START: bool,

  AUTH_MODE: z.enum(['dev', 'supabase']).optional(),
  ALLOW_DEV_AUTH: bool,
  DEV_AUTH_SECRET: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),

  STORAGE: z.enum(['local', 'supabase']).optional(),
  STORAGE_BUCKET: z.string().default('project-assets'),
  SIGNING_SECRET: z.string().optional(),
  SIGNED_URL_TTL_SECONDS: int(3600),
  MAX_UPLOAD_MB: int(20),
  MAX_ASSETS_PER_PROJECT: int(500),

  AI_PROVIDER: z.enum(['mock', 'openai']).default('mock'),
  MOCK_LATENCY_MS: int(600),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_TEXT_MODEL: z.string().default('gpt-4.1'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-2'),
  OPENAI_TIMEOUT_MS: int(180_000),
  // Optional USD per 1M tokens, used only to estimate cost per job in the UI.
  OPENAI_PRICE_TEXT_IN: z.coerce.number().optional(),
  OPENAI_PRICE_TEXT_OUT: z.coerce.number().optional(),
  OPENAI_PRICE_IMAGE_IN: z.coerce.number().optional(),
  OPENAI_PRICE_IMAGE_OUT: z.coerce.number().optional(),

  WORKER: z.enum(['inline', 'off']).default('inline'),
  WORKER_CONCURRENCY: int(2),
  WORKER_POLL_MS: int(1500),
  MAX_CONCURRENT_JOBS_PER_PROJECT: int(2),
  MAX_JOBS_PER_USER_PER_DAY: int(60),
  JOB_MAX_ATTEMPTS: int(3),
  JOB_RETRY_BASE_MS: int(2000),
  JOB_LEASE_SECONDS: int(600),
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env;
  production: boolean;
  dataDir: string;
  authMode: 'dev' | 'supabase';
  storageMode: 'local' | 'supabase';
  devAuthSecret: string;
  signingSecret: string;
  maxUploadBytes: number;
}

/** A random secret persisted under DATA_DIR so dev tokens and signed URLs survive restarts. */
function persistentSecret(dataDir: string, name: string): string {
  const file = path.join(dataDir, `${name}.secret`);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const s = randomBytes(32).toString('hex');
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const env = parsed.data;
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR);
  const authMode = env.AUTH_MODE ?? (env.SUPABASE_URL ? 'supabase' : 'dev');
  const storageMode = env.STORAGE ?? (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? 'supabase' : 'local');

  if (authMode === 'dev' && production && !env.ALLOW_DEV_AUTH) {
    throw new Error('AUTH_MODE=dev signs people in by email alone. Refusing to start in production without ALLOW_DEV_AUTH=true.');
  }
  if (authMode === 'supabase' && !env.SUPABASE_URL) throw new Error('AUTH_MODE=supabase needs SUPABASE_URL.');
  if (storageMode === 'supabase' && !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error('STORAGE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) throw new Error('AI_PROVIDER=openai needs OPENAI_API_KEY.');
  if (production && storageMode === 'local' && !env.SIGNING_SECRET) {
    // Fine for a single VPS, but say so loudly.
    console.warn('[imaginarium] STORAGE=local in production: files live on this server only.');
  }

  return {
    env,
    production,
    dataDir,
    authMode,
    storageMode,
    devAuthSecret: env.DEV_AUTH_SECRET ?? persistentSecret(dataDir, 'dev-auth'),
    signingSecret: env.SIGNING_SECRET ?? persistentSecret(dataDir, 'signing'),
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
  };
}
