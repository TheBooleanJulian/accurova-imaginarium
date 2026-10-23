/**
 * Single-process deployment: API + job worker + the built frontend (dist/).
 * Suits a VPS, Render, Railway, Fly.io or any Node host.
 *
 *   npm run build && npm start
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { loadConfig, loadDotEnv } from './config';
import { createRuntime } from './runtime';

loadDotEnv();
const cfg = loadConfig();
const rt = await createRuntime(cfg);
rt.startWorker();

const dist = path.resolve(process.env.STATIC_DIR ?? 'dist');
if (existsSync(path.join(dist, 'index.html'))) {
  rt.app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  rt.app.use('*', serveStatic({ root: path.relative(process.cwd(), dist) }));
  // Hash routing means every app URL is served by index.html.
  rt.app.get('*', serveStatic({ path: path.relative(process.cwd(), path.join(dist, 'index.html')) }));
}

const server = serve({ fetch: rt.app.fetch, port: cfg.env.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`[imaginarium] http://localhost:${info.port}  db=${rt.db.kind} storage=${rt.storage.kind} auth=${rt.auth.mode} ai=${rt.providerLabel}`);
});

const shutdown = async () => {
  console.log('[imaginarium] shutting down…');
  server.close();
  await rt.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
