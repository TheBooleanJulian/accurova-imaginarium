import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from './config';
import type { Db } from './db/index';
import { toProfile } from './db/mappers';
import type { Profile } from '../src/core/types';

export type AuthUser = Profile;

export interface Authenticator {
  readonly mode: 'dev' | 'supabase';
  /** Resolve a bearer token to a user (creating their profile row if needed), or null if invalid. */
  verify(token: string): Promise<AuthUser | null>;
  /** Dev mode only: sign in by email. */
  devLogin?(email: string, displayName?: string): Promise<{ token: string; user: AuthUser }>;
  /** Dev mode only: accounts that exist on this server (for the account switcher). */
  devProfiles?(): Promise<AuthUser[]>;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function ensureProfile(db: Db, id: string, email: string, name: string): Promise<AuthUser> {
  const rows = await db.query(
    `insert into public.profiles (id, email, display_name) values ($1, lower($2), $3)
     on conflict (id) do update set email = lower(excluded.email)
     returning id, email, display_name`,
    [id, email, name || email.split('@')[0]],
  );
  return toProfile(rows[0]!);
}

/**
 * Local development sign-in: email only, signed with a server secret.
 * Creates the user in auth.users (the local shim), which triggers profile creation.
 * Refused in production unless ALLOW_DEV_AUTH=true.
 */
export function createDevAuth(cfg: Config, db: Db): Authenticator {
  const key = new TextEncoder().encode(cfg.devAuthSecret);
  return {
    mode: 'dev',
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: 'imaginarium-dev', audience: 'authenticated' });
        if (!payload.sub) return null;
        const rows = await db.query('select id, email, display_name from public.profiles where id = $1', [payload.sub]);
        return rows[0] ? toProfile(rows[0]) : null;
      } catch {
        return null;
      }
    },
    async devLogin(email, displayName) {
      const norm = email.trim().toLowerCase();
      if (!EMAIL_RE.test(norm)) throw new Error('Enter a valid email address.');
      const existing = await db.query<{ id: string }>('select id from auth.users where lower(email) = $1', [norm]);
      let id = existing[0]?.id;
      if (!id) {
        const created = await db.query<{ id: string }>(
          `insert into auth.users (email, raw_user_meta_data) values ($1, $2::text::jsonb) returning id`,
          [norm, JSON.stringify({ display_name: displayName?.trim() || '' })],
        );
        id = created[0]!.id;
      }
      const user = await ensureProfile(db, id, norm, displayName?.trim() ?? '');
      const token = await new SignJWT({ email: norm, role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(id)
        .setIssuer('imaginarium-dev')
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(key);
      return { token, user };
    },
    async devProfiles() {
      return (await db.query('select id, email, display_name from public.profiles order by created_at')).map(toProfile);
    },
  };
}

/**
 * Supabase Auth. With SUPABASE_JWT_SECRET (legacy HS256 projects) tokens are
 * verified locally; otherwise the token is checked against /auth/v1/user
 * (works with asymmetric signing keys too) and cached briefly.
 */
export function createSupabaseAuth(cfg: Config, db: Db, fetchImpl: typeof fetch = fetch): Authenticator {
  const url = cfg.env.SUPABASE_URL!.replace(/\/$/, '');
  const apikey = cfg.env.SUPABASE_ANON_KEY ?? cfg.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const secret = cfg.env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(cfg.env.SUPABASE_JWT_SECRET) : null;
  const cache = new Map<string, { user: AuthUser; until: number }>();
  const ensured = new Set<string>();

  const remember = async (id: string, email: string, name: string): Promise<AuthUser> => {
    if (!ensured.has(id)) {
      const u = await ensureProfile(db, id, email, name);
      ensured.add(id);
      return u;
    }
    const rows = await db.query('select id, email, display_name from public.profiles where id = $1', [id]);
    return rows[0] ? toProfile(rows[0]) : ensureProfile(db, id, email, name);
  };

  return {
    mode: 'supabase',
    async verify(token) {
      const k = createHash('sha256').update(token).digest('hex');
      const hit = cache.get(k);
      if (hit && hit.until > Date.now()) return hit.user;
      let id: string | undefined;
      let email: string;
      let name: string;
      try {
        if (secret) {
          const { payload } = await jwtVerify(token, secret, { audience: 'authenticated' });
          id = payload.sub;
          email = String(payload.email ?? '');
          const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
          name = String(meta.display_name ?? meta.full_name ?? '');
        } else {
          const res = await fetchImpl(`${url}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey } });
          if (!res.ok) return null;
          const u = (await res.json()) as { id?: string; email?: string; user_metadata?: Record<string, unknown> };
          id = u.id;
          email = u.email ?? '';
          name = String(u.user_metadata?.display_name ?? u.user_metadata?.full_name ?? '');
        }
      } catch {
        return null;
      }
      if (!id || !email) return null;
      const user = await remember(id, email, name);
      cache.set(k, { user, until: Date.now() + 60_000 });
      if (cache.size > 5000) cache.clear();
      return user;
    },
  };
}

export function createAuth(cfg: Config, db: Db): Authenticator {
  return cfg.authMode === 'supabase' ? createSupabaseAuth(cfg, db) : createDevAuth(cfg, db);
}
