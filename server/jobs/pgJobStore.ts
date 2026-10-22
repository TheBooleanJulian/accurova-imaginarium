import { createHash } from 'node:crypto';
import type { Asset, GenerationJob, NodeRun } from '../../src/core/types';
import type { JobStore } from '../../src/core/jobEngine';
import type { GraphContext, ImageRef } from '../../src/core/graph';
import type { PendingAsset } from '../../src/core/executors';
import type { Db, Queryable } from '../db/index';
import { isUniqueViolation } from '../db/index';
import { toApproval, toAsset, toEdge, toJob, toNode, toRun } from '../db/mappers';
import type { ObjectStorage } from '../storage';
import { makeThumbnail, svgToPng } from '../images';

export class DuplicateJobError extends Error {
  constructor() {
    super('A job for this node is already queued or running.');
    this.name = 'DuplicateJobError';
  }
}

export interface PgJobStoreOptions {
  maxConcurrentPerProject: number;
  leaseSeconds: number;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Everything the graph functions need, read as the table owner (the worker has no user). */
export async function loadGraphContext(q: Queryable, projectId: string): Promise<GraphContext> {
  const [nodes, edges, assets, runs, approvals] = [
    await q.query('select * from public.nodes where project_id = $1 order by created_at, id', [projectId]),
    await q.query('select * from public.edges where project_id = $1 order by created_at, id', [projectId]),
    await q.query('select * from public.assets where project_id = $1 order by created_at, id', [projectId]),
    await q.query('select * from public.node_runs where project_id = $1 order by completed_at, id', [projectId]),
    await q.query(
      `select a.*, p.display_name as reviewer_name from public.approvals a left join public.profiles p on p.id = a.reviewer_id
       where a.project_id = $1 order by a.created_at, a.id`,
      [projectId],
    ),
  ];
  return {
    nodes: nodes.map(toNode),
    edges: edges.map(toEdge),
    assets: assets.map(toAsset),
    runs: runs.map(toRun),
    approvals: approvals.map(toApproval),
  };
}

/** Column mapping for partial job updates coming from the engine. */
const JOB_COLUMNS: Partial<Record<keyof GenerationJob, [string, 'json' | 'plain']>> = {
  status: ['status', 'plain'],
  attempts: ['attempts', 'plain'],
  startedAt: ['started_at', 'plain'],
  finishedAt: ['finished_at', 'plain'],
  error: ['error', 'json'],
  outputAssetIds: ['output_asset_ids', 'json'],
  usage: ['usage', 'json'],
  model: ['model', 'plain'],
  runAfter: ['run_after', 'plain'],
  cancelRequested: ['cancel_requested', 'plain'],
};

export function createPgJobStore(db: Db, storage: ObjectStorage, opts: PgJobStoreOptions): JobStore {
  const getJob = async (id: string) => {
    const rows = await db.query('select * from public.generation_jobs where id = $1', [id]);
    return rows[0] ? toJob(rows[0]) : undefined;
  };

  return {
    loadGraph: (projectId) => db.service((q) => loadGraphContext(q, projectId)),
    getJob,
    async findJobByKey(projectId, key) {
      const rows = await db.query('select * from public.generation_jobs where project_id = $1 and idempotency_key = $2', [projectId, key]);
      return rows[0] ? toJob(rows[0]) : undefined;
    },
    async listJobs(projectId) {
      return (await db.query('select * from public.generation_jobs where project_id = $1 order by created_at', [projectId])).map(toJob);
    },
    async countRecentAiJobs(userId, since) {
      const [r] = await db.query<{ n: number }>(
        `select count(*)::int as n from public.generation_jobs where requested_by = $1 and provider <> 'internal' and created_at >= $2`,
        [userId, since],
      );
      return Number(r?.n ?? 0);
    },
    async insertJob(job) {
      try {
        const rows = await db.query(
          `insert into public.generation_jobs
             (id, project_id, node_id, node_type, operation, status, provider, model, input_snapshot, input_hash, prompt_version,
              idempotency_key, attempts, max_attempts, error, output_asset_ids, usage, requested_by, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11, $12, $13, $14, $15::text::jsonb, $16::text::jsonb, $17::text::jsonb, $18, $19, $19)
           on conflict do nothing
           returning id`,
          [
            job.id, job.projectId, job.nodeId, job.nodeType, job.operation, job.status, job.provider, job.model,
            JSON.stringify(job.inputSnapshot), job.inputHash, job.promptVersion, job.idempotencyKey, job.attempts, job.maxAttempts,
            JSON.stringify(job.error), JSON.stringify(job.outputAssetIds), JSON.stringify(job.usage), job.requestedBy, job.createdAt,
          ],
        );
        if (!rows.length) throw new DuplicateJobError();
      } catch (e) {
        if (isUniqueViolation(e)) throw new DuplicateJobError();
        throw e;
      }
    },
    async updateJob(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, v] of Object.entries(patch) as [keyof GenerationJob, unknown][]) {
        const col = JOB_COLUMNS[k];
        if (!col) continue;
        params.push(col[1] === 'json' ? JSON.stringify(v ?? null) : v);
        sets.push(`${col[0]} = $${params.length}${col[1] === 'json' ? '::text::jsonb' : ''}`);
      }
      if (patch.status && patch.status !== 'running') sets.push('locked_by = null');
      sets.push('updated_at = now()');
      const rows = await db.query(`update public.generation_jobs set ${sets.join(', ')} where id = $1 returning *`, params);
      if (!rows[0]) throw new Error(`Job ${id} not found`);
      return toJob(rows[0]);
    },
    async saveGeneratedAsset(projectId, p: PendingAsset, meta) {
      let bytes = p.bytes;
      let mimeType = p.mimeType;
      if (mimeType === 'image/svg+xml') {
        // Never store or serve SVG: rasterise mock output to PNG.
        bytes = await svgToPng(bytes, p.width, p.height);
        mimeType = 'image/png';
      }
      const folder = p.sourceType === 'export' ? 'exports' : 'generated';
      const key = `${projectId}/${folder}/${meta.id}.${EXT[mimeType] ?? 'bin'}`;
      await storage.put(key, bytes, mimeType);
      let thumbKey: string | null = null;
      if (mimeType.startsWith('image/')) {
        thumbKey = `${key}.thumb.webp`;
        await storage.put(thumbKey, await makeThumbnail(bytes), 'image/webp');
      }
      const rows = await db.query(
        `insert into public.assets
           (id, project_id, storage_key, thumb_key, mime_type, width, height, size_bytes, role, source_type, parent_asset_id,
            version_of, version, node_id, job_id, label, prompt, original_filename, content_hash, provenance, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::text::jsonb, $21)
         returning *`,
        [
          meta.id, projectId, key, thumbKey, mimeType, p.width || null, p.height || null, bytes.byteLength, p.role,
          p.sourceType ?? 'ai_generated', p.parentAssetId, p.versionOf, p.version, meta.nodeId, meta.jobId, p.label,
          p.prompt || null, p.filename ?? null, sha256(bytes),
          JSON.stringify({ kind: p.sourceType ?? 'ai_generated', jobId: meta.jobId, nodeId: meta.nodeId, parentAssetId: p.parentAssetId }),
          meta.createdBy,
        ],
      );
      return toAsset(rows[0]!);
    },
    async insertRun(run: NodeRun) {
      await db.query(
        `insert into public.node_runs (id, job_id, project_id, node_id, operation, input_hash, output_asset_ids, output, completed_at)
         values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9)
         on conflict (job_id) do update set output_asset_ids = excluded.output_asset_ids, output = excluded.output, completed_at = excluded.completed_at`,
        [run.id, run.jobId, run.projectId, run.nodeId, run.operation, run.inputHash, JSON.stringify(run.outputAssetIds), JSON.stringify(run.output ?? null), run.completedAt],
      );
    },
    async loadImage(projectId, ref: ImageRef) {
      const rows = await db.query('select * from public.assets where id = $1 and project_id = $2', [ref.assetId, projectId]);
      const a: Asset | undefined = rows[0] ? toAsset(rows[0]) : undefined;
      if (!a) throw new Error(`Asset ${ref.assetId} is not in this project`);
      return { assetId: a.id, role: a.role, mimeType: a.mimeType, bytes: await storage.get(a.storageKey) };
    },
    async logActivity(e) {
      await db.query(
        `insert into public.activity_events (project_id, actor_id, action, entity_type, entity_id, meta) values ($1, $2, $3, $4, $5, $6::text::jsonb)`,
        [e.projectId, e.actorId, e.action, e.entityType, e.entityId, JSON.stringify(e.meta ?? null)],
      );
    },

    // ------------------------------------------------ shared queue

    async claimJob(jobId, workerId) {
      return db.service(async (q) => {
        // Lock the row; SKIP LOCKED means two workers never both take it.
        const locked = await q.query(
          `select id, project_id from public.generation_jobs
           where id = $1 and (
             (status = 'queued' and run_after <= now() and not cancel_requested)
             or (status = 'running' and locked_at < now() - make_interval(secs => $2) and attempts < max_attempts)
           )
           for update skip locked`,
          [jobId, opts.leaseSeconds],
        );
        if (!locked[0]) return undefined;
        const [{ n }] = await q.query<{ n: number }>(
          `select count(*)::int as n from public.generation_jobs where project_id = $1 and status = 'running' and id <> $2 and locked_at >= now() - make_interval(secs => $3)`,
          [locked[0].project_id, jobId, opts.leaseSeconds],
        );
        if (Number(n) >= opts.maxConcurrentPerProject) return undefined;
        const rows = await q.query(
          `update public.generation_jobs
           set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now()),
               locked_by = $2, locked_at = now(), updated_at = now()
           where id = $1 returning *`,
          [jobId, workerId],
        );
        return rows[0] ? toJob(rows[0]) : undefined;
      });
    },
    async listRunnable(limit) {
      // Jobs whose worker vanished and that have no attempts left fail instead of looping forever.
      await db.query(
        `update public.generation_jobs
         set status = 'failed', finished_at = now(), updated_at = now(), locked_by = null,
             error = '{"message":"The worker stopped responding and no attempts are left.","code":"lease_expired","retryable":false}'::jsonb
         where status = 'running' and locked_at < now() - make_interval(secs => $1) and attempts >= max_attempts`,
        [opts.leaseSeconds],
      );
      const rows = await db.query<{ id: string }>(
        `select id from public.generation_jobs
         where (status = 'queued' and run_after <= now() and not cancel_requested)
            or (status = 'running' and locked_at < now() - make_interval(secs => $2))
         order by created_at limit $1`,
        [Math.max(1, limit * 3), opts.leaseSeconds],
      );
      return rows.map((r) => r.id);
    },
    async heartbeat(jobId, workerId) {
      const rows = await db.query<{ cancel_requested: boolean }>(
        `update public.generation_jobs set locked_at = now() where id = $1 and locked_by = $2 and status = 'running' returning cancel_requested`,
        [jobId, workerId],
      );
      return { cancelRequested: !!rows[0]?.cancel_requested };
    },
    async requestCancel(jobId) {
      const cancelled = await db.query(
        `update public.generation_jobs
         set status = 'cancelled', finished_at = now(), updated_at = now(), locked_by = null,
             error = '{"message":"Cancelled by user"}'::jsonb
         where id = $1 and status = 'queued' returning *`,
        [jobId],
      );
      if (cancelled[0]) return toJob(cancelled[0]);
      const flagged = await db.query(
        `update public.generation_jobs set cancel_requested = true, updated_at = now() where id = $1 and status = 'running' returning *`,
        [jobId],
      );
      return flagged[0] ? toJob(flagged[0]) : getJob(jobId);
    },
  };
}
