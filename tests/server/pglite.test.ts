import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project, ProjectBundle } from '@/core/types';
import { MockProvider } from '@/ai/mockProvider';
import { loadConfig } from '../../server/config';
import { createPgliteDb } from '../../server/db/index';
import { createRuntime } from '../../server/runtime';

/** The zero-install path: embedded Postgres (PGlite), same migrations, same RLS. No server needed. */
describe('zero-install server (PGlite)', () => {
  it('migrates, signs in, runs a job and exports a draft', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'imaginarium-pglite-'));
    const db = await createPgliteDb(undefined);
    const rt = await createRuntime(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, AUTH_MODE: 'dev', STORAGE: 'local' }), {
      db,
      provider: new MockProvider({ latencyMs: 0 }),
      log: () => undefined,
    });
    try {
      const req = async <T>(method: string, p: string, token?: string, body?: unknown) => {
        const res = await rt.app.request(p, {
          method,
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: (await res.json()) as T };
      };
      const { body: login } = await req<{ token: string }>('POST', '/api/auth/dev-login', undefined, { email: 'julian@accurova.sg' });
      const { body: project } = await req<Project>('POST', '/api/projects', login.token, { name: 'PGlite', client: 'Acme', brief: { product: 'Lamp' } });
      const { body: b } = await req<ProjectBundle>('GET', `/api/projects/${project.id}`, login.token);
      const cg = b.nodes.find((n) => n.type === 'concept_generator')!;
      expect((await req('POST', `/api/nodes/${cg.id}/run`, login.token, { operation: 'directions' })).status).toBe(202);
      await rt.engine.whenIdle();
      const ex = await req<{ job: { id: string } }>('POST', `/api/projects/${project.id}/exports`, login.token, {});
      expect(ex.status).toBe(202);
      await rt.engine.whenIdle();
      const { body: done } = await req<{ job: { status: string }; url: string }>('GET', `/api/exports/${ex.body.job.id}`, login.token);
      expect(done.job.status).toBe('succeeded');
      // RLS is live on PGlite too: a stranger sees nothing.
      const { body: other } = await req<{ token: string }>('POST', '/api/auth/dev-login', undefined, { email: 'stranger@x.sg' });
      expect((await req('GET', `/api/projects/${project.id}`, other.token)).status).toBe(404);
    } finally {
      await rt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
