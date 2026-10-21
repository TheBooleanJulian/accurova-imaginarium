import type { Asset, GenerationJob, NodeRun, UsageInfo } from './types';
import type { AIProvider, ImageInput } from './ai';
import { CancelledError, ProviderError } from './ai';
import { buildInputSnapshot, missingRequiredInputs, opStatus, type GraphContext, type ImageRef } from './graph';
import { getNodeDef, getOperation } from './nodeRegistry';
import { executeAiOperation, type ExecContext, type ExecResult, type PendingAsset } from './executors';
import { hashValue } from './hash';

/** Persistence the engine needs. Implemented by the local backend and the server worker. */
export interface JobStore {
  loadGraph(projectId: string): Promise<GraphContext>;
  getJob(jobId: string): Promise<GenerationJob | undefined>;
  findJobByKey(projectId: string, idempotencyKey: string): Promise<GenerationJob | undefined>;
  listJobs(projectId: string): Promise<GenerationJob[]>;
  countRecentAiJobs(userId: string, sinceIso: string): Promise<number>;
  insertJob(job: GenerationJob): Promise<void>;
  updateJob(jobId: string, patch: Partial<GenerationJob>): Promise<GenerationJob>;
  /** Must durably store the bytes before resolving. */
  saveGeneratedAsset(projectId: string, asset: PendingAsset, meta: { id: string; nodeId: string; jobId: string; createdBy: string }): Promise<Asset>;
  insertRun(run: NodeRun): Promise<void>;
  loadImage(projectId: string, ref: ImageRef): Promise<ImageInput>;
  logActivity(e: { projectId: string; actorId: string; action: string; entityType: string; entityId: string; meta?: Record<string, unknown> }): Promise<void>;
}

export type InternalExecutor = (ctx: Omit<ExecContext, 'provider'> & { job: GenerationJob; graph: GraphContext }) => Promise<ExecResult>;

export interface EngineOptions {
  concurrency?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxJobsPerUserPerDay?: number;
  internalExecutors?: Record<string, InternalExecutor>;
  now?: () => Date;
  uuid?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onChange?: (job: GenerationJob) => void;
}

export interface SubmitRequest {
  projectId: string;
  nodeId: string;
  operation: string;
  requestedBy: string;
  /** Deliberate regeneration: run even if an up-to-date output exists. */
  force?: boolean;
  /** Client-supplied key so a retried HTTP request can't create a second job. */
  idempotencyKey?: string;
}

export interface SubmitResult {
  job: GenerationJob;
  deduped: false | 'same_request' | 'already_running' | 'up_to_date';
}

export class SubmitError extends Error {
  readonly code: 'missing_inputs' | 'not_ready' | 'usage_limit' | 'unknown_op';
  constructor(code: SubmitError['code'], message: string) {
    super(message);
    this.name = 'SubmitError';
    this.code = code;
  }
}

const ACTIVE = new Set(['queued', 'running']);

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new CancelledError());
    }, { once: true });
  });

export class JobEngine {
  private readonly store: JobStore;
  private readonly provider: AIProvider;
  private readonly opts: Required<Omit<EngineOptions, 'onChange' | 'internalExecutors'>> & Pick<EngineOptions, 'onChange' | 'internalExecutors'>;
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private running = 0;
  private readonly idleWaiters: (() => void)[] = [];

  constructor(store: JobStore, provider: AIProvider, opts: EngineOptions = {}) {
    this.store = store;
    this.provider = provider;
    this.opts = {
      concurrency: opts.concurrency ?? 2,
      maxAttempts: opts.maxAttempts ?? 3,
      baseDelayMs: opts.baseDelayMs ?? 800,
      maxJobsPerUserPerDay: opts.maxJobsPerUserPerDay ?? 200,
      now: opts.now ?? (() => new Date()),
      uuid: opts.uuid ?? (() => crypto.randomUUID()),
      sleep: opts.sleep ?? defaultSleep,
      onChange: opts.onChange,
      internalExecutors: opts.internalExecutors,
    };
  }

  get providerId(): string {
    return this.provider.id;
  }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    if (req.idempotencyKey) {
      const existing = await this.store.findJobByKey(req.projectId, req.idempotencyKey);
      if (existing) return { job: existing, deduped: 'same_request' };
    }

    const graph = await this.store.loadGraph(req.projectId);
    const node = graph.nodes.find((n) => n.id === req.nodeId);
    if (!node) throw new SubmitError('unknown_op', 'Node not found in this project.');
    let opDef;
    try {
      opDef = getOperation(node.type, req.operation);
    } catch (e) {
      throw new SubmitError('unknown_op', (e as Error).message);
    }

    const missing = missingRequiredInputs(graph, node.id, req.operation);
    if (missing.length) throw new SubmitError('missing_inputs', `Connect ${missing.join(', ')} first.`);
    const notReady = opDef.check?.(node.data);
    if (notReady) throw new SubmitError('not_ready', notReady);

    const jobs = await this.store.listJobs(req.projectId);
    const active = jobs.find((j) => j.nodeId === node.id && j.operation === req.operation && ACTIVE.has(j.status));
    if (active) return { job: active, deduped: 'already_running' };

    const { snapshot, inputHash } = buildInputSnapshot(graph, node.id, req.operation);
    if (!req.force) {
      const status = opStatus(graph, node.id, req.operation);
      if (status.freshness === 'fresh' && status.activeRun) {
        const prior = jobs.find((j) => j.id === status.activeRun!.jobId);
        if (prior) return { job: prior, deduped: 'up_to_date' };
      }
    }

    if (opDef.kind === 'ai') {
      const since = new Date(this.opts.now().getTime() - 24 * 3600 * 1000).toISOString();
      const used = await this.store.countRecentAiJobs(req.requestedBy, since);
      if (used >= this.opts.maxJobsPerUserPerDay)
        throw new SubmitError('usage_limit', `Daily generation limit reached (${this.opts.maxJobsPerUserPerDay}). Try again tomorrow or raise the limit.`);
    }

    const now = this.opts.now().toISOString();
    const id = this.opts.uuid();
    const job: GenerationJob = {
      id,
      projectId: req.projectId,
      nodeId: node.id,
      nodeType: node.type,
      operation: req.operation,
      status: 'queued',
      provider: opDef.kind === 'ai' ? this.provider.id : 'internal',
      model: opDef.kind === 'ai' ? this.provider.modelFor(isImageOp(node.type, req.operation) ? 'image' : 'text') : 'pdf',
      inputSnapshot: snapshot,
      inputHash,
      promptVersion: opDef.promptVersion,
      idempotencyKey: req.idempotencyKey ?? hashValue({ p: req.projectId, n: node.id, o: req.operation, h: inputHash, f: req.force ? id : '' }),
      attempts: 0,
      maxAttempts: this.opts.maxAttempts,
      error: null,
      outputAssetIds: [],
      usage: null,
      requestedBy: req.requestedBy,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
    await this.store.insertJob(job);
    await this.store.logActivity({
      projectId: req.projectId,
      actorId: req.requestedBy,
      action: req.force ? 'job.regenerate' : 'job.submit',
      entityType: 'node',
      entityId: node.id,
      meta: { jobId: id, operation: req.operation, label: getNodeDef(node.type).label },
    });
    this.opts.onChange?.(job);
    this.enqueue(id);
    return { job, deduped: false };
  }

  /** Re-queue jobs interrupted by a crash or page reload (durability). */
  async recover(projectId: string, olderThanMs = 0): Promise<number> {
    const jobs = await this.store.listJobs(projectId);
    const nowMs = this.opts.now().getTime();
    let n = 0;
    for (const j of jobs) {
      if (!ACTIVE.has(j.status) || this.controllers.has(j.id) || this.queue.includes(j.id)) continue;
      // Another tab/worker may still own a recently-updated job.
      if (olderThanMs && nowMs - Date.parse(j.updatedAt) < olderThanMs) continue;
      const updated = await this.store.updateJob(j.id, { status: 'queued', updatedAt: this.opts.now().toISOString() });
      this.opts.onChange?.(updated);
      this.enqueue(j.id);
      n++;
    }
    return n;
  }

  async cancel(jobId: string): Promise<GenerationJob | undefined> {
    const job = await this.store.getJob(jobId);
    if (!job || !ACTIVE.has(job.status)) return job;
    const qi = this.queue.indexOf(jobId);
    if (qi >= 0) this.queue.splice(qi, 1);
    const ctrl = this.controllers.get(jobId);
    if (ctrl) {
      ctrl.abort();
      return job; // the worker records the cancellation
    }
    return this.finish(job, { status: 'cancelled', error: { message: 'Cancelled by user' } });
  }

  /** Resolves once nothing is queued or running (tests, graceful shutdown). */
  whenIdle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private enqueue(jobId: string) {
    this.queue.push(jobId);
    this.pump();
  }

  private pump() {
    while (this.running < this.opts.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      void this.work(id).finally(() => {
        this.running--;
        this.pump();
        if (!this.running && !this.queue.length) this.idleWaiters.splice(0).forEach((r) => r());
      });
    }
  }

  private async finish(job: GenerationJob, patch: Partial<GenerationJob>): Promise<GenerationJob> {
    const now = this.opts.now().toISOString();
    const updated = await this.store.updateJob(job.id, { ...patch, finishedAt: now, updatedAt: now });
    this.opts.onChange?.(updated);
    const action = `job.${updated.status}`;
    await this.store.logActivity({
      projectId: job.projectId,
      actorId: job.requestedBy,
      action,
      entityType: 'job',
      entityId: job.id,
      meta: { nodeId: job.nodeId, operation: job.operation, error: updated.error?.message },
    });
    return updated;
  }

  private async work(jobId: string): Promise<void> {
    let job = await this.store.getJob(jobId);
    if (!job || job.status !== 'queued') return;
    const ctrl = new AbortController();
    this.controllers.set(jobId, ctrl);
    try {
      while (true) {
        const now = this.opts.now().toISOString();
        job = await this.store.updateJob(jobId, {
          status: 'running',
          attempts: job.attempts + 1,
          startedAt: job.startedAt ?? now,
          updatedAt: now,
        });
        this.opts.onChange?.(job);
        try {
          const result = await this.execute(job, ctrl.signal);
          if (ctrl.signal.aborted) throw new CancelledError();
          // Persist every output durably BEFORE the job can be marked successful.
          const assets: Asset[] = [];
          for (const pending of result.assets) {
            assets.push(
              await this.store.saveGeneratedAsset(job.projectId, pending, {
                id: this.opts.uuid(),
                nodeId: job.nodeId,
                jobId: job.id,
                createdBy: job.requestedBy,
              }),
            );
          }
          const run: NodeRun = {
            id: this.opts.uuid(),
            jobId: job.id,
            projectId: job.projectId,
            nodeId: job.nodeId,
            operation: job.operation,
            inputHash: job.inputHash,
            outputAssetIds: assets.map((a) => a.id),
            output: result.output,
            completedAt: this.opts.now().toISOString(),
          };
          await this.store.insertRun(run);
          await this.finish(job, {
            status: 'succeeded',
            error: null,
            outputAssetIds: run.outputAssetIds,
            usage: result.usage as UsageInfo,
            model: result.model || job.model,
          });
          return;
        } catch (err) {
          if (err instanceof CancelledError || ctrl.signal.aborted) {
            await this.finish(job, { status: 'cancelled', error: { message: 'Cancelled by user' } });
            return;
          }
          const pe = err instanceof ProviderError ? err : null;
          const error = { message: (err as Error).message || 'Unknown error', code: pe?.code ?? 'internal_error', retryable: !!pe?.retryable };
          if (error.retryable && job.attempts < job.maxAttempts) {
            job = await this.store.updateJob(jobId, { status: 'queued', error, updatedAt: this.opts.now().toISOString() });
            this.opts.onChange?.(job);
            const delay = this.opts.baseDelayMs * 2 ** (job.attempts - 1) * (0.75 + Math.random() * 0.5);
            try {
              await this.opts.sleep(delay, ctrl.signal);
            } catch {
              await this.finish(job, { status: 'cancelled', error: { message: 'Cancelled by user' } });
              return;
            }
            continue;
          }
          await this.finish(job, { status: 'failed', error });
          return;
        }
      }
    } finally {
      this.controllers.delete(jobId);
    }
  }

  private async execute(job: GenerationJob, signal: AbortSignal): Promise<ExecResult> {
    const graph = await this.store.loadGraph(job.projectId);
    const node = graph.nodes.find((n) => n.id === job.nodeId);
    if (!node) throw new ProviderError('The node was deleted before the job ran.', { code: 'node_deleted' });
    const lineageMax = new Map<string, number>();
    for (const a of graph.assets) {
      const l = a.versionOf ?? a.id;
      lineageMax.set(l, Math.max(lineageMax.get(l) ?? 0, a.version));
    }
    const base = {
      node,
      op: job.operation,
      // Execute exactly what was snapshotted at submit time.
      snapshot: job.inputSnapshot as ExecContext['snapshot'],
      loadImage: (ref: ImageRef) => this.store.loadImage(job.projectId, ref),
      nextVersion: (lineage: string) => (lineageMax.get(lineage) ?? 0) + 1,
      seed: job.id,
      signal,
    };
    const opDef = getOperation(node.type, job.operation);
    if (opDef.kind === 'internal') {
      const exec = this.opts.internalExecutors?.[`${node.type}:${job.operation}`];
      if (!exec) throw new ProviderError(`No executor for ${node.type}:${job.operation}`, { code: 'no_executor' });
      return exec({ ...base, job, graph });
    }
    return executeAiOperation({ ...base, provider: this.provider });
  }
}

export function isImageOp(type: string, op: string): boolean {
  return ['concept_generator:render', 'pose_generator:poses', 'image_edit:edit'].includes(`${type}:${op}`);
}
