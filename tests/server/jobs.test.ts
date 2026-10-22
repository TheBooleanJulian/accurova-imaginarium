import { afterEach, describe, expect, it } from 'vitest';
import type { Project, ProjectBundle } from '@/core/types';
import { activeRun, hasNewerCandidate } from '@/core/graph';
import { MockProvider } from '@/ai/mockProvider';
import { createRuntime } from '../../server/runtime';
import { loadConfig } from '../../server/config';
import { byType, hasPg, load, patchNode, runOp, saveGraph, startServer, type TestServer } from './helpers';

async function setup(s: TestServer, token: string) {
  const project = (await s.call<Project>('POST', '/api/projects', { token, body: { name: 'Jobs', client: 'Acme', brief: { product: 'Watch' } } })).body;
  return { project, b: await load(s, token, project.id) };
}

const submit = (s: TestServer, token: string, nodeId: string, operation: string, opts: { key?: string; force?: boolean } = {}) =>
  s.call<{ job: { id: string; status: string; attempts: number }; deduped: string | false; error?: string; code?: string }>('POST', `/api/nodes/${nodeId}/run`, {
    token,
    body: { operation, force: opts.force },
    headers: opts.key ? { 'idempotency-key': opts.key } : {},
  });

describe.skipIf(!hasPg)('durable job queue (Postgres)', () => {
  let s: TestServer | null = null;
  afterEach(async () => {
    await s?.close();
    s = null;
  });

  it('deduplicates by idempotency key and by live job per node', async () => {
    s = await startServer({ mock: { latencyMs: 300 } });
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const cg = byType(b, 'concept_generator').id;
    const r1 = await submit(s, tok, cg, 'directions', { key: 'same-key-123' });
    const r2 = await submit(s, tok, cg, 'directions', { key: 'same-key-123' });
    expect(r1.status).toBe(202);
    expect(r2.body.deduped).toBe('same_request');
    expect(r2.body.job.id).toBe(r1.body.job.id);
    // A different request while it is still running gets the running job back.
    const r3 = await submit(s, tok, cg, 'directions', { key: 'other-key-456', force: true });
    expect(r3.body.deduped).toBe('already_running');
    expect(r3.body.job.id).toBe(r1.body.job.id);
    await s.rt.engine.whenIdle();
    // With nothing changed, a plain re-run is "up to date"; force makes a new version.
    expect((await submit(s, tok, cg, 'directions')).body.deduped).toBe('up_to_date');
    const forced = await submit(s, tok, cg, 'directions', { force: true });
    expect(forced.body.deduped).toBe(false);
    await s.rt.engine.whenIdle();
    const jobs = (await load(s, tok, b.project.id)).jobs.filter((j) => j.operation === 'directions');
    expect(jobs).toHaveLength(2);
  });

  it('survives a burst of simultaneous identical requests with one job', async () => {
    s = await startServer({ mock: { latencyMs: 200 } });
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const cg = byType(b, 'concept_generator').id;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => submit(s!, tok, cg, 'directions', { key: `burst-${i}-abcdef` })));
    expect(results.every((r) => r.status < 300)).toBe(true);
    expect(new Set(results.map((r) => r.body.job.id)).size).toBe(1);
    await s.rt.engine.whenIdle();
    const rows = await s.db.query(`select count(*)::int as n from generation_jobs where node_id = $1`, [cg]);
    expect(rows[0]!.n).toBe(1);
  });

  it('retries transient provider failures with backoff, then succeeds', async () => {
    s = await startServer({ mock: { failTimes: 2, failRetryable: true } });
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const r = await runOp(s, tok, byType(b, 'concept_generator').id, 'directions');
    expect(r.job).toMatchObject({ status: 'succeeded', attempts: 3, error: null });
  });

  it('fails permanently on non-retryable errors and when attempts run out', async () => {
    s = await startServer({ mock: { failTimes: 1, failRetryable: false } });
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const r = await runOp(s, tok, byType(b, 'concept_generator').id, 'directions');
    expect(r.job).toMatchObject({ status: 'failed', attempts: 1 });
    expect(r.job.error).toMatchObject({ code: 'mock_failure', retryable: false });
    await s.close();

    s = await startServer({ mock: { failTimes: 10, failRetryable: true }, env: { JOB_MAX_ATTEMPTS: '3' } });
    const tok2 = await s.login('b@x.sg');
    const { b: b2 } = await setup(s, tok2);
    const r2 = await runOp(s, tok2, byType(b2, 'concept_generator').id, 'directions');
    expect(r2.job).toMatchObject({ status: 'failed', attempts: 3 });
    const after = await load(s, tok2, b2.project.id);
    expect(after.runs).toHaveLength(0);
    expect(after.activity.some((a) => a.action === 'job.failed')).toBe(true);
  });

  it('cancels running and queued jobs without storing outputs', async () => {
    s = await startServer({ mock: { latencyMs: 1500 }, env: { MAX_CONCURRENT_JOBS_PER_PROJECT: '1' } });
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const running = await submit(s, tok, byType(b, 'concept_generator').id, 'directions');
    await new Promise((r) => setTimeout(r, 150));
    const queued = await submit(s, tok, byType(b, 'shot_planner').id, 'plan');
    expect((await s.call<{ status: string }>('GET', `/api/jobs/${queued.body.job.id}`, { token: tok })).body.status).toBe('queued');
    expect((await s.call('POST', `/api/jobs/${queued.body.job.id}/cancel`, { token: tok })).status).toBe(200);
    expect((await s.call('POST', `/api/jobs/${running.body.job.id}/cancel`, { token: tok })).status).toBe(200);
    await s.rt.engine.whenIdle();
    const after = await load(s, tok, b.project.id);
    expect(after.jobs.map((j) => j.status).sort()).toEqual(['cancelled', 'cancelled']);
    expect(after.runs).toHaveLength(0);
  });

  it('enforces the per-user daily generation limit with 429', async () => {
    s = await startServer({ env: { MAX_JOBS_PER_USER_PER_DAY: '2' } });
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const cg = byType(b, 'concept_generator').id;
    await runOp(s, tok, cg, 'directions');
    await runOp(s, tok, cg, 'directions', true);
    const third = await submit(s, tok, cg, 'directions', { force: true });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('usage_limit');
  });

  it('never marks a job successful if its output could not be stored', async () => {
    s = await startServer();
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const cg = byType(b, 'concept_generator');
    await runOp(s, tok, cg.id, 'directions');
    let cur = await load(s, tok, b.project.id);
    await saveGraph(s, tok, cur, patchNode(cur, cg.id, { selectedDirection: 0, variations: 2 }));
    const put = s.rt.storage.put.bind(s.rt.storage);
    let calls = 0;
    s.rt.storage.put = async (key, bytes, type) => {
      if (key.includes('/generated/') && calls++ === 1) throw new Error('disk full');
      return put(key, bytes, type);
    };
    const r = await runOp(s, tok, cg.id, 'render');
    expect(r.job.status).toBe('failed');
    expect(r.job.error?.message).toMatch(/disk full/);
    cur = await load(s, tok, b.project.id);
    expect(cur.runs.filter((x) => x.operation === 'render')).toHaveLength(0);
    expect(cur.jobs.find((j) => j.operation === 'render')!.outputAssetIds).toEqual([]);
  });

  it('recovers a job whose worker died (expired lease) and finishes it once', async () => {
    s = await startServer({ env: { JOB_LEASE_SECONDS: '30' } });
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const cg = byType(b, 'concept_generator').id;
    const r = await submit(s, tok, cg, 'directions');
    await s.rt.engine.whenIdle();
    // Rewind it to "running on a dead worker, 10 minutes ago".
    await s.db.query(
      `update generation_jobs set status = 'running', attempts = 1, locked_by = 'dead-worker', locked_at = now() - interval '10 minutes', finished_at = null where id = $1`,
      [r.body.job.id],
    );
    await s.db.query(`delete from node_runs where job_id = $1`, [r.body.job.id]);
    expect(await s.rt.engine.poll()).toBe(1);
    await s.rt.engine.whenIdle();
    const job = (await s.call<{ status: string; attempts: number }>('GET', `/api/jobs/${r.body.job.id}`, { token: tok })).body;
    expect(job).toMatchObject({ status: 'succeeded', attempts: 2 });
    const runs = await s.db.query(`select id from node_runs where job_id = $1`, [r.body.job.id]);
    expect(runs).toHaveLength(1);
  });

  it('lets two workers share one queue without double-processing', async () => {
    s = await startServer({ env: { WORKER: 'off' } });
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    // A second process on the same database.
    const other = await createRuntime(loadConfig({ NODE_ENV: 'test', DATA_DIR: s.rt.cfg.dataDir, AUTH_MODE: 'dev', STORAGE: 'local', JOB_RETRY_BASE_MS: '5' }), {
      db: s.db,
      provider: new MockProvider({ latencyMs: 50 }),
      skipMigrate: true,
      log: () => undefined,
    });
    // Insert queued jobs directly, as if submitted by an API-only instance.
    const nodes = [byType(b, 'concept_generator').id, byType(b, 'reference_analysis').id, byType(b, 'shot_planner').id];
    const ops = ['directions', 'analyze', 'plan'];
    for (let i = 0; i < nodes.length; i++) {
      const id = crypto.randomUUID();
      await s.db.query(
        `insert into generation_jobs (id, project_id, node_id, node_type, operation, status, provider, model, input_snapshot, input_hash, prompt_version, idempotency_key, requested_by)
         select $1, $2, n.id, n.type, $4, 'queued', 'mock', 'm', '{"inputs":{},"config":{}}', 'h', 'v', $5, p.owner_id
         from nodes n join projects p on p.id = n.project_id where n.id = $3`,
        [id, b.project.id, nodes[i], ops[i], `direct-${id}`],
      );
    }
    await Promise.all([s.rt.engine.poll(), other.engine.poll(), s.rt.engine.poll(), other.engine.poll()]);
    await Promise.all([s.rt.engine.whenIdle(), other.engine.whenIdle()]);
    const rows = await s.db.query<{ status: string; attempts: number }>(`select status, attempts from generation_jobs where project_id = $1`, [b.project.id]);
    expect(rows).toHaveLength(3);
    // Each job was taken by exactly one worker, exactly once, and reached a final state.
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    expect(rows.every((r) => ['succeeded', 'failed'].includes(r.status))).toBe(true);
    const runCounts = await s.db.query<{ n: number }>(`select count(*)::int as n from node_runs where project_id = $1 group by job_id`, [b.project.id]);
    expect(runCounts.every((r) => r.n === 1)).toBe(true);
  });

  it('never silently replaces approved work when regenerating', async () => {
    s = await startServer();
    const tok = await s.login('a@x.sg');
    const { b } = await setup(s, tok);
    const cg = byType(b, 'concept_generator');
    await runOp(s, tok, cg.id, 'directions');
    let cur: ProjectBundle = await load(s, tok, b.project.id);
    await saveGraph(s, tok, cur, patchNode(cur, cg.id, { selectedDirection: 0, variations: 1 }));
    await runOp(s, tok, cg.id, 'render');
    cur = await load(s, tok, b.project.id);
    const v1 = cur.assets.find((a) => a.role === 'concept')!;
    await s.call('POST', `/api/assets/${v1.id}/approvals`, { token: tok, body: { decision: 'approved' } });
    await runOp(s, tok, cg.id, 'render', true);
    cur = await load(s, tok, b.project.id);
    const ctx = { nodes: cur.nodes, edges: cur.edges, assets: cur.assets, runs: cur.runs, approvals: cur.approvals };
    expect(cur.runs.filter((r) => r.operation === 'render')).toHaveLength(2);
    expect(activeRun(ctx, cg.id, 'render')!.outputAssetIds).toEqual([v1.id]);
    expect(hasNewerCandidate(ctx, cg.id, 'render')).toBe(true);
    expect(cur.assets.filter((a) => a.role === 'concept')).toHaveLength(2);
  });
});
