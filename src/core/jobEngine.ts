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

  // ---- Optional: multi-process queues (the Postgres store implements these). ----
  /** Atomically take a due queued job (or one whose lease expired). Undefined if another worker got it. */
  claimJob?(jobId: string, workerId: string): Promise<GenerationJob | undefined>;
  /** Ids of jobs this worker could pick up now, respecting per-project limits. */
  listRunnable?(limit: number): Promise<string[]>;
  /** Extend this worker's lease; reports a cancel requested from elsewhere. */
  heartbeat?(jobId: string, workerId: string): Promise<{ cancelRequested: boolean }>;
  /** Cancel atomically: queued → cancelled now; running → flag for its worker. */
  requestCancel?(jobId: string): Promise<GenerationJob | undefined>;
}

export type InternalExecutor = (ctx: Omit<ExecContext, 'provider'> & { job: GenerationJob; graph: GraphContext }) => Promise<ExecResult>;

export interface EngineOptions {
  /** Identifies this process when claiming jobs from a shared queue. */
  workerId?: string;
  /** How often a running job renews its lease and checks for remote cancellation. */
  heartbeatMs?: number;
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
  readonly workerId: string;
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private running = 0;
  private readonly idleWaiters: (() => void)[] = [];

  constructor(store: JobStore, provider: AIProvider, opts: EngineOptions = {}) {
    this.store = store;
    this.provider = provider;
    this.workerId = opts.workerId ?? `w-${Math.random().toString(36).slice(2, 10)}`;
    this.opts = {
      workerId: this.workerId,
      heartbeatMs: opts.heartbeatMs ?? 10_000,
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
    const ctrl = this.controllers.get(jobId);
    if (ctrl) {
      ctrl.abort();
      return job; // the worker records the cancellation
    }
    const qi = this.queue.indexOf(jobId);
    if (qi >= 0) this.queue.splice(qi, 1);
    if (this.store.requestCancel) {
      // Shared queue: another worker may hold it. Let the database decide atomically.
      const updated = await this.store.requestCancel(jobId);
      if (updated?.status === 'cancelled') {
        this.opts.onChange?.(updated);
        await this.store.logActivity({
          projectId: job.projectId,
          actorId: job.requestedBy,
          action: 'job.cancelled',
          entityType: 'job',
          entityId: job.id,
          meta: { nodeId: job.nodeId, operation: job.operation },
        });
      }
      return updated;
    }
    return this.finish(job, { status: 'cancelled', error: { message: 'Cancelled by user' } });
  }

  /** Shared queue: pick up due jobs submitted by any process. Returns how many were taken on. */
  async poll(): Promise<number> {
    if (!this.store.listRunnable) return 0;
    const capacity = this.opts.concurrency - this.running - this.queue.length;
    if (capacity <= 0) return 0;
    const ids = await this.store.listRunnable(capacity);
    let n = 0;
    for (const id of ids) {
      if (this.controllers.has(id) || this.queue.includes(id)) continue;
      this.enqueue(id);
      n++;
    }
    return n;
  }

  /** Jobs currently queued or running in this process. */
  get load(): number {
    return this.running + this.queue.length;
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
    if (updated.status === 'succeeded' && job.nodeType === 'export') {
      await this.store.logActivity({
        projectId: job.projectId,
        actorId: job.requestedBy,
        action: 'export.create',
        entityType: 'asset',
        entityId: updated.outputAssetIds[0] ?? job.id,
        meta: { jobId: job.id, mode: (job.inputSnapshot as { config?: { mode?: string } })?.config?.mode },
      });
    }
    return updated;
  }

  /** Move a queued job to running: atomically when the store supports claiming. */
  private async start(jobId: string, current: GenerationJob): Promise<GenerationJob | undefined> {
    if (this.store.claimJob) return this.store.claimJob(jobId, this.workerId);
    if (current.status !== 'queued') return undefined;
    const now = this.opts.now().toISOString();
    return this.store.updateJob(jobId, { status: 'running', attempts: current.attempts + 1, startedAt: current.startedAt ?? now, updatedAt: now });
  }

  private async work(jobId: string): Promise<void> {
    let job = await this.store.getJob(jobId);
    if (!job || job.status !== 'queued') {
      // A shared queue may hand us a running job whose previous worker died (expired lease).
      if (!job || !this.store.claimJob || job.status !== 'running') return;
    }
    const ctrl = new AbortController();
    this.controllers.set(jobId, ctrl);
    let beat: ReturnType<typeof setInterval> | null = null;
    if (this.store.heartbeat) {
      beat = setInterval(() => {
        void this.store
          .heartbeat!(jobId, this.workerId)
          .then((h) => h.cancelRequested && ctrl.abort())
          .catch(() => undefined);
      }, this.opts.heartbeatMs);
    }
    try {
      while (true) {
        const claimed = await this.start(jobId, job);
        if (!claimed) return; // someone else has it, or it was cancelled meanwhile
        job = claimed;
        this.opts.onChange?.(job);
        try {
          const result = await this.execute(job, ctrl.signal);
          if (ctrl.signal.aborted) throw new CancelledError();
          if (this.store.heartbeat && (await this.store.heartbeat(jobId, this.workerId)).cancelRequested) throw new CancelledError();
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
            const delay = this.opts.baseDelayMs * 2 ** (job.attempts - 1) * (0.75 + Math.random() * 0.5);
            const now = this.opts.now();
            job = await this.store.updateJob(jobId, {
              status: 'queued',
              error,
              updatedAt: now.toISOString(),
              runAfter: new Date(now.getTime() + delay).toISOString(),
            });
            this.opts.onChange?.(job);
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
      if (beat) clearInterval(beat);
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
