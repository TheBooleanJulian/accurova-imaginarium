import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { Profile } from '../src/core/types';
import type { Config } from './config';
import type { Authenticator } from './auth';
import { Backend, HttpError, toHttpError } from './backend';
import { LocalStorage, sniffMime, type ObjectStorage } from './storage';
import type { JobEngine } from '../src/core/jobEngine';

type Env = { Variables: { user: Profile } };

export interface AppDeps {
  cfg: Config;
  backend: Backend;
  auth: Authenticator;
  storage: ObjectStorage;
  engine: JobEngine;
  providerLabel: string;
  /** Serverless hosts: keep the invocation alive until queued work finishes. */
  waitUntil?: (p: Promise<unknown>) => void;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * HTTP API. Every route below /api (except config, health, invitation preview,
 * dev login and signed file URLs) requires a bearer token. Handlers are thin:
 * validation, permissions and RLS-scoped queries live in Backend.
 */
export function createApp(d: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const log = d.log ?? ((m: string, e?: unknown) => console.error(`[imaginarium] ${m}`, e ?? ''));

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (c.req.path.startsWith('/api/')) {
      c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
      c.header('X-Frame-Options', 'DENY');
    }
  });

  if (d.cfg.env.CORS_ORIGINS) {
    const origins = d.cfg.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    app.use('/api/*', cors({ origin: origins, allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'x-upsert'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], maxAge: 600 }));
  }

  app.onError((err, c) => {
    const h = toHttpError(err);
    if (h.status >= 500) log(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: h.message, code: h.code, ...h.extra }, h.status as 400);
  });
  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found', code: 'not_found' }, 404) : c.text('Not found', 404)));

  const json = bodyLimit({ maxSize: 6 * 1024 * 1024, onError: (c) => c.json({ error: 'Request too large', code: 'too_large' }, 413) });
  const body = async (c: Context) => {
    try {
      return await c.req.json();
    } catch {
      throw new HttpError(400, 'Expected a JSON body.', 'bad_json');
    }
  };

  // ---------------------------------------------------------------- public

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/config', (c) =>
    c.json({
      mode: 'server',
      authMode: d.auth.mode,
      supabaseUrl: d.auth.mode === 'supabase' ? d.cfg.env.SUPABASE_URL : null,
      supabaseAnonKey: d.auth.mode === 'supabase' ? (d.cfg.env.SUPABASE_ANON_KEY ?? null) : null,
      providerLabel: d.providerLabel,
      limits: { maxUploadMb: d.cfg.env.MAX_UPLOAD_MB, maxJobsPerUserPerDay: d.cfg.env.MAX_JOBS_PER_USER_PER_DAY },
    }),
  );

  app.get('/api/invitations/:token', async (c) => c.json(await d.backend.previewInvitation(c.req.param('token'))));

  if (d.auth.devProfiles) app.get('/api/auth/dev-profiles', async (c) => c.json(await d.auth.devProfiles!()));
  if (d.auth.devLogin) {
    app.post('/api/auth/dev-login', json, async (c) => {
      const b = (await body(c)) as { email?: string; displayName?: string };
      if (typeof b.email !== 'string') throw new HttpError(400, 'Enter your email.');
      return c.json(await d.auth.devLogin!(b.email, b.displayName));
    });
  }

  // Local storage only: signed reads and uploads (Supabase hands out its own URLs).
  if (d.storage instanceof LocalStorage) {
    const local = d.storage;
    const keyOf = (c: Context) => decodeURIComponent(c.req.path.slice('/api/files/'.length));
    app.get('/api/files/*', async (c) => {
      const key = keyOf(c);
      const exp = Number(c.req.query('exp'));
      const dl = c.req.query('dl') ?? '';
      if (!local.verify(['GET', key, String(exp), dl], c.req.query('sig') ?? '', exp)) return c.json({ error: 'Link expired or invalid', code: 'bad_signature' }, 403);
      const bytes = await local.get(key);
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        'Content-Type': sniffMime(bytes),
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        'Content-Disposition': dl ? `attachment; filename="${dl.replace(/["\\\r\n]/g, '_')}"` : 'inline',
      });
    });
    app.put('/api/files/*', async (c) => {
      const key = keyOf(c);
      const exp = Number(c.req.query('exp'));
      const max = Number(c.req.query('max'));
      if (!local.verify(['PUT', key, String(exp), String(max)], c.req.query('sig') ?? '', exp)) return c.json({ error: 'Upload link expired or invalid', code: 'bad_signature' }, 403);
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > max) return c.json({ error: 'File too large', code: 'too_large' }, 413);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > max) return c.json({ error: 'File too large', code: 'too_large' }, 413);
      await local.put(key, bytes);
      return c.json({ ok: true });
    });
  }

  // Cron / serverless worker: process due jobs. Protected by CRON_SECRET.
  app.post('/api/worker/tick', async (c) => {
    const secret = d.cfg.env.CRON_SECRET;
    if (!secret || c.req.header('authorization') !== `Bearer ${secret}`) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
    const picked = await d.engine.poll();
    await d.engine.whenIdle();
    return c.json({ picked });
  });
  app.get('/api/worker/tick', async (c) => {
    // Vercel Cron uses GET with the same bearer secret.
    const secret = d.cfg.env.CRON_SECRET;
    if (!secret || c.req.header('authorization') !== `Bearer ${secret}`) return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
    const picked = await d.engine.poll();
    await d.engine.whenIdle();
    return c.json({ picked });
  });

  // ---------------------------------------------------------------- authenticated

  const authed = new Hono<Env>();
  authed.use('*', async (c, next) => {
    const h = c.req.header('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const user = token ? await d.auth.verify(token) : null;
    if (!user) return c.json({ error: 'Please sign in.', code: 'unauthenticated' }, 401);
    c.set('user', user);
    await next();
  });
  /** After submitting work on a serverless host, keep running until it is done. */
  const keepAlive = () => d.waitUntil?.(d.engine.whenIdle());

  authed.get('/me', (c) => c.json(c.get('user')));

  authed.get('/projects', async (c) => c.json(await d.backend.listProjects(c.get('user'))));
  authed.post('/projects', json, async (c) => c.json(await d.backend.createProject(c.get('user'), await body(c)), 201));
  authed.get('/projects/:id', async (c) => c.json(await d.backend.loadProject(c.get('user'), c.req.param('id'))));
  authed.patch('/projects/:id', json, async (c) => c.json(await d.backend.updateProject(c.get('user'), c.req.param('id'), await body(c))));
  authed.delete('/projects/:id', async (c) => {
    await d.backend.deleteProject(c.get('user'), c.req.param('id'));
    return c.body(null, 204);
  });
  authed.get('/projects/:id/changes', async (c) => c.json({ token: await d.backend.changeToken(c.get('user'), c.req.param('id')) }));
  authed.put('/projects/:id/graph', json, async (c) => c.json(await d.backend.saveGraph(c.get('user'), c.req.param('id'), await body(c))));

  authed.post('/projects/:id/assets/upload-url', json, async (c) => c.json(await d.backend.createUploadUrl(c.get('user'), c.req.param('id'), await body(c))));
  authed.post('/projects/:id/assets', json, async (c) => c.json(await d.backend.finalizeUpload(c.get('user'), c.req.param('id'), await body(c)), 201));
  authed.get('/assets/:id/url', async (c) =>
    c.json(await d.backend.assetUrl(c.get('user'), c.req.param('id'), { download: c.req.query('download') === '1', thumb: c.req.query('variant') === 'thumb' })),
  );
  authed.post('/assets/:id/comments', json, async (c) => c.json(await d.backend.addComment(c.get('user'), { assetId: c.req.param('id') }, await body(c)), 201));
  authed.post('/assets/:id/approvals', json, async (c) => c.json(await d.backend.recordApproval(c.get('user'), c.req.param('id'), await body(c)), 201));
  authed.post('/projects/:id/comments', json, async (c) => c.json(await d.backend.addComment(c.get('user'), { projectId: c.req.param('id') }, await body(c)), 201));
  authed.patch('/comments/:id', json, async (c) => c.json(await d.backend.resolveComment(c.get('user'), c.req.param('id'), await body(c))));

  authed.post('/nodes/:id/run', json, async (c) => {
    const r = await d.backend.runNode(c.get('user'), c.req.param('id'), await body(c), c.req.header('idempotency-key'));
    keepAlive();
    return c.json(r, r.deduped ? 200 : 202);
  });
  authed.get('/jobs/:id', async (c) => c.json(await d.backend.getJob(c.get('user'), c.req.param('id'))));
  authed.post('/jobs/:id/cancel', async (c) => c.json(await d.backend.cancelJob(c.get('user'), c.req.param('id'))));
  authed.post('/projects/:id/exports', json, async (c) => {
    const raw = await c.req.text();
    const r = await d.backend.createExport(c.get('user'), c.req.param('id'), raw ? JSON.parse(raw) : {}, c.req.header('idempotency-key'));
    keepAlive();
    return c.json(r, r.deduped ? 200 : 202);
  });
  authed.get('/exports/:id', async (c) => c.json(await d.backend.getExport(c.get('user'), c.req.param('id'))));

  authed.post('/projects/:id/invitations', json, async (c) => c.json(await d.backend.createInvitation(c.get('user'), c.req.param('id'), await body(c)), 201));
  authed.delete('/invitations/:id', async (c) => {
    await d.backend.revokeInvitation(c.get('user'), c.req.param('id'));
    return c.body(null, 204);
  });
  authed.post('/invitations/:token/accept', async (c) => c.json(await d.backend.acceptInvitation(c.get('user'), c.req.param('token'))));
  authed.patch('/members/:id', json, async (c) => {
    await d.backend.updateMemberRole(c.get('user'), c.req.param('id'), await body(c));
    return c.body(null, 204);
  });
  authed.delete('/members/:id', async (c) => {
    await d.backend.removeMember(c.get('user'), c.req.param('id'));
    return c.body(null, 204);
  });

  app.route('/api', authed);
  return app;
}
