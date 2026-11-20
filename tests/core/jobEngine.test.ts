import { describe, expect, it } from 'vitest';
import { byType, makeWorld, pngBlob } from '../helpers';
import { SubmitError } from '@/core/jobEngine';
import type { LocalRepository } from '@/data/local/localRepository';

async function setupProject(repo: LocalRepository) {
  await repo.signIn('demo@imaginarium.local');
  const project = await repo.createProject({ name: 'Watch launch', client: 'Acme', template: 'campaign', brief: { product: 'Field watch', objective: 'Launch' } });
  const bundle = await repo.loadProject(project.id);
  return { project, bundle };
}

describe('job engine', () => {
  it('runs a job end-to-end: queued → running → succeeded with a recorded run', async () => {
    const { make } = makeWorld();
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const concept = byType(bundle.nodes, 'concept_generator');
    const seen: string[] = [];
    repo.subscribe(project.id, (e) => e.kind === 'jobs' && seen.push(e.kind));
    const { job, deduped } = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'k1' });
    expect(deduped).toBe(false);
    expect(job.status).toBe('queued');
    expect(job.provider).toBe('mock');
    expect(job.inputHash).toMatch(/^[0-9a-f]+$/);
    await repo.engine.whenIdle();
    const after = await repo.loadProject(project.id);
    const done = after.jobs.find((j) => j.id === job.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(1);
    expect(done.finishedAt).toBeTruthy();
    expect(after.runs.find((r) => r.jobId === job.id)?.output).toMatchObject({ directions: expect.any(Array) });
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it('dedupes: same idempotency key, already running, and already up to date', async () => {
    const { make } = makeWorld({ mock: { latencyMs: 30 } });
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const concept = byType(bundle.nodes, 'concept_generator');
    const a = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'same' });
    const b = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'same' });
    expect(b.deduped).toBe('same_request');
    expect(b.job.id).toBe(a.job.id);
    const c = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'other' });
    expect(c.deduped).toBe('already_running');
    await repo.engine.whenIdle();
    const d = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'third' });
    expect(d.deduped).toBe('up_to_date');
    const e = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'fourth', force: true });
    expect(e.deduped).toBe(false);
    await repo.engine.whenIdle();
    const jobs = (await repo.loadProject(project.id)).jobs;
    expect(jobs.filter((j) => j.nodeId === concept.id)).toHaveLength(2);
  });

  it('retries retryable provider failures with backoff, then succeeds', async () => {
    const { make } = makeWorld({ mock: { failTimes: 2, failRetryable: true } });
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const concept = byType(bundle.nodes, 'concept_generator');
    const { job } = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'r' });
    await repo.engine.whenIdle();
    const done = (await repo.loadProject(project.id)).jobs.find((j) => j.id === job.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(3);
  });

  it('gives up after the attempt budget and records the error', async () => {
    const { make } = makeWorld({ mock: { failTimes: 10, failRetryable: true } });
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const concept = byType(bundle.nodes, 'concept_generator');
    const { job } = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'r' });
    await repo.engine.whenIdle();
    const p = await repo.loadProject(project.id);
    const done = p.jobs.find((j) => j.id === job.id)!;
    expect(done.status).toBe('failed');
    expect(done.attempts).toBe(3);
    expect(done.error?.message).toMatch(/Mock provider failure/);
    expect(p.runs.filter((r) => r.jobId === job.id)).toHaveLength(0);
  });

  it('does not retry non-retryable failures', async () => {
    const { make } = makeWorld({ mock: { failTimes: 1, failRetryable: false } });
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const concept = byType(bundle.nodes, 'concept_generator');
    const { job } = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'r' });
    await repo.engine.whenIdle();
    const done = (await repo.loadProject(project.id)).jobs.find((j) => j.id === job.id)!;
    expect(done.status).toBe('failed');
    expect(done.attempts).toBe(1);
  });

  it('cancels a running job without persisting partial output', async () => {
    const { make } = makeWorld({ mock: { latencyMs: 200 } });
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const concept = byType(bundle.nodes, 'concept_generator');
    const { job } = await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'c' });
    await new Promise((r) => setTimeout(r, 20));
    await repo.cancelJob(job.id);
    await repo.engine.whenIdle();
    const p = await repo.loadProject(project.id);
    expect(p.jobs.find((j) => j.id === job.id)!.status).toBe('cancelled');
    expect(p.runs).toHaveLength(0);
  });

  it('fails the job if outputs cannot be persisted (never succeeds without stored files)', async () => {
    const { make, store } = makeWorld();
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const concept = byType(bundle.nodes, 'concept_generator');
    await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: 'd' });
    await repo.engine.whenIdle();
    await repo.saveGraph(
      project.id,
      { nodes: bundle.nodes.map((n) => (n.id === concept.id ? { ...n, data: { ...n.data, selectedDirection: 1 } } : n)), edges: bundle.edges },
      bundle.project.graphRevision,
    );
    store.failBlobWrites = 1;
    const { job } = await repo.runNode(project.id, concept.id, 'render', { idempotencyKey: 'r' });
    await repo.engine.whenIdle();
    const p = await repo.loadProject(project.id);
    expect(p.jobs.find((j) => j.id === job.id)!.status).toBe('failed');
    expect(p.runs.filter((r) => r.jobId === job.id)).toHaveLength(0);
  });

  it('refuses to run with missing required inputs or unmet preconditions', async () => {
    const { make } = makeWorld();
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const pose = byType(bundle.nodes, 'pose_generator');
    await expect(repo.runNode(project.id, pose.id, 'poses', { idempotencyKey: 'x' })).rejects.toBeInstanceOf(SubmitError);
    const concept = byType(bundle.nodes, 'concept_generator');
    await expect(repo.runNode(project.id, concept.id, 'render', { idempotencyKey: 'y' })).rejects.toThrow(/direction/);
  });

  it('enforces the daily usage limit', async () => {
    const { make } = makeWorld({ engine: { maxJobsPerUserPerDay: 1 } });
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const concept = byType(bundle.nodes, 'concept_generator');
    await repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: '1' });
    await repo.engine.whenIdle();
    await expect(repo.runNode(project.id, concept.id, 'directions', { idempotencyKey: '2', force: true })).rejects.toThrow(/limit/);
  });

  it('respects the concurrency limit', async () => {
    const { make } = makeWorld({ mock: { latencyMs: 60 }, engine: { concurrency: 1 } });
    const repo = make();
    const { project, bundle } = await setupProject(repo);
    const product = byType(bundle.nodes, 'image_asset');
    const up = await repo.uploadAsset(project.id, pngBlob(), { role: 'product', filename: 'p.png' });
    const nodes = bundle.nodes.map((n) => (n.id === product.id ? { ...n, data: { ...n.data, assetIds: [up.id] } } : n));
    await repo.saveGraph(project.id, { nodes, edges: bundle.edges }, bundle.project.graphRevision);
    const a = await repo.runNode(project.id, byType(nodes, 'concept_generator').id, 'directions', { idempotencyKey: 'a' });
    const b = await repo.runNode(project.id, byType(nodes, 'reference_analysis').id, 'analyze', { idempotencyKey: 'b' });
    await new Promise((r) => setTimeout(r, 20));
    const mid = (await repo.loadProject(project.id)).jobs;
    const statuses = [a, b].map((x) => mid.find((j) => j.id === x.job.id)!.status).sort();
    expect(statuses).toEqual(['queued', 'running']);
    await repo.engine.whenIdle();
  });
});
