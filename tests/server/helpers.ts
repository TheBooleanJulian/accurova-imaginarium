import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import sharp from 'sharp';
import { inject } from 'vitest';
import { MockProvider, type MockOptions } from '@/ai/mockProvider';
import type { AIProvider } from '@/core/ai';
import type { GraphEdge, GraphNode, ProjectBundle } from '@/core/types';
import { loadConfig } from '../../server/config';
import { createPostgresDb, type Db } from '../../server/db/index';
import { migrate } from '../../server/db/migrate';
import { createRuntime, type Runtime } from '../../server/runtime';

export const PG_URL = inject('pgAdminUrl');
export const hasPg = !!PG_URL;

/** A fresh database per test file, migrated, dropped afterwards. */
export async function freshDatabase(): Promise<{ url: string; db: Db; drop: () => Promise<void> }> {
  const name = `imaginarium_test_${randomBytes(5).toString('hex')}`;
  const admin = postgres(PG_URL, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = PG_URL.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
  const db = createPostgresDb({ url, max: 8 });
  await migrate(db);
  return {
    url,
    db,
    async drop() {
      await db.close();
      const a = postgres(PG_URL, { max: 1, onnotice: () => undefined });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export interface TestServer {
  rt: Runtime;
  db: Db;
  call: <T = unknown>(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit }) => Promise<{ status: number; body: T }>;
  login: (email: string, name?: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function startServer(opts: { mock?: MockOptions; provider?: AIProvider; env?: Record<string, string> } = {}): Promise<TestServer> {
  const { db, drop } = await freshDatabase();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'imaginarium-data-'));
  const cfg = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    AUTH_MODE: 'dev',
    STORAGE: 'local',
    WORKER: 'inline',
    JOB_RETRY_BASE_MS: '5',
    WORKER_POLL_MS: '50',
    MAX_CONCURRENT_JOBS_PER_PROJECT: '4',
    WORKER_CONCURRENCY: '4',
    ...opts.env,
  });
  const provider = opts.provider ?? new MockProvider({ latencyMs: 0, ...opts.mock });
  const rt = await createRuntime(cfg, { db, provider, providerLabel: 'Mock (test)', skipMigrate: true, log: () => undefined });
  const call: TestServer['call'] = async (method, p, o = {}) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let body: BodyInit | undefined = o.raw;
    if (o.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    const res = await rt.app.request(p, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* binary or text */
    }
    return { status: res.status, body: parsed as never };
  };
  const login = async (email: string, name?: string) => {
    const r = await call<{ token: string }>('POST', '/api/auth/dev-login', { body: { email, displayName: name } });
    if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token;
  };
  return {
    rt,
    db,
    call,
    login,
    async close() {
      await rt.engine.whenIdle();
      await drop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function testImage(format: 'jpeg' | 'png' | 'webp' = 'jpeg', w = 640, h = 800, hue = '#8a7a66'): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${hue}"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="#1b2733"/></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg))[format]().toBuffer());
}

/** Upload through the real two-step flow (signed upload URL, then finalize). */
export async function upload(s: TestServer, token: string, projectId: string, bytes: Uint8Array, opts: { role?: 'product' | 'brand' | 'reference'; filename?: string; contentType?: string; nodeId?: string } = {}) {
  const contentType = opts.contentType ?? 'image/jpeg';
  const u = await s.call<{ upload: { url: string; headers: Record<string, string> }; uploadToken: string; error?: string }>('POST', `/api/projects/${projectId}/assets/upload-url`, {
    token,
    body: { filename: opts.filename ?? 'photo.jpg', contentType, size: bytes.byteLength, role: opts.role ?? 'product', nodeId: opts.nodeId },
  });
  if (u.status !== 200) return { status: u.status, body: u.body as unknown };
  const put = await s.rt.app.request(u.body.upload.url, { method: 'PUT', headers: u.body.upload.headers, body: new Blob([bytes as BlobPart]) });
  if (put.status !== 200) return { status: put.status, body: await put.text() };
  return s.call('POST', `/api/projects/${projectId}/assets`, { token, body: { uploadToken: u.body.uploadToken } });
}

export function byType(b: { nodes: GraphNode[] }, type: GraphNode['type'], nth = 0): GraphNode {
  const n = b.nodes.filter((x) => x.type === type)[nth];
  if (!n) throw new Error(`no ${type}`);
  return n;
}

/** Save a modified graph through the API. */
export async function saveGraph(s: TestServer, token: string, b: ProjectBundle, nodes: GraphNode[], edges: GraphEdge[] = b.edges) {
  return s.call<{ revision: number }>('PUT', `/api/projects/${b.project.id}/graph`, {
    token,
    body: { baseRevision: b.project.graphRevision, nodes, edges },
  });
}

export function patchNode(b: ProjectBundle, id: string, data: Record<string, unknown>): GraphNode[] {
  return b.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n));
}

export async function load(s: TestServer, token: string, projectId: string): Promise<ProjectBundle> {
  const r = await s.call<ProjectBundle>('GET', `/api/projects/${projectId}`, { token });
  if (r.status !== 200) throw new Error(`load ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Run an operation and wait for the worker to finish it. */
export async function runOp(s: TestServer, token: string, nodeId: string, operation: string, force = false) {
  const r = await s.call<{ job: { id: string }; deduped: string | false }>('POST', `/api/nodes/${nodeId}/run`, {
    token,
    body: { operation, force },
    headers: { 'idempotency-key': `k-${randomBytes(8).toString('hex')}` },
  });
  if (r.status >= 300) throw new Error(`run ${operation} → ${r.status} ${JSON.stringify(r.body)}`);
  await s.rt.engine.whenIdle();
  const j = await s.call<{ status: string; error: { message: string } | null }>('GET', `/api/jobs/${r.body.job.id}`, { token });
  return { submit: r, job: j.body };
}
