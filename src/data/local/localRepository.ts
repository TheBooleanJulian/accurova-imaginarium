import type {
  ActivityEvent,
  ApprovalDecision,
  Asset,
  Comment,
  GraphEdge,
  GraphNode,
  Invitation,
  NodeRun,
  Profile,
  Project,
  ProjectBundle,
  ProjectMember,
  Role,
} from '@/core/types';
import type { AIProvider, ImageInput } from '@/core/ai';
import { JobEngine, type EngineOptions, type JobStore, type SubmitResult } from '@/core/jobEngine';
import { assertCan, can } from '@/core/permissions';
import { buildApprovedBundle, resolveInputs, validateGraph, type GraphContext, type ImageRef } from '@/core/graph';
import { normalizeNodeData } from '@/core/nodeRegistry';
import { UPLOAD_LIMITS } from '@/core/schemas';
import { hashBytes } from '@/core/hash';
import type { PendingAsset } from '@/core/executors';
import { MockProvider } from '@/ai/mockProvider';
import { createExportExecutor, passthroughRasterizer, type Rasterizer } from '@/features/export/executor';
import {
  ConflictError,
  NotFoundError,
  type CreateProjectInput,
  type ProjectSummary,
  type RepoEvent,
  type Repository,
} from '../repository';
import { blankTemplate, campaignTemplate } from '../templates';
import type { TableStore, Tables } from './tableStore';

export interface SessionStore {
  get(): string | null;
  set(userId: string | null): void;
}

export interface Broadcast {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface LocalRepoOptions {
  store: TableStore;
  provider?: AIProvider;
  session?: SessionStore;
  channel?: Broadcast | null;
  probeImage?: (blob: Blob) => Promise<{ width: number; height: number } | null>;
  engine?: EngineOptions;
  /** Turns images into JPEG/PNG for the PDF export. Defaults to JPEG/PNG passthrough. */
  rasterize?: Rasterizer;
  /** Create and sign in a default owner on first run (browser UX). */
  autoProvisionOwner?: boolean;
}

export const DEFAULT_OWNER: Pick<Profile, 'email' | 'displayName'> = { email: 'julian@accurova.local', displayName: 'Julian · Accurova' };

const memorySession = (): SessionStore => {
  let v: string | null = null;
  return { get: () => v, set: (x) => (v = x) };
};

function extFor(mime: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf' } as Record<string, string>)[mime] ?? 'bin';
}

function roleOf(members: ProjectMember[], projectId: string, userId: string | null): Role | null {
  if (!userId) return null;
  return members.find((m) => m.projectId === projectId && m.userId === userId)?.role ?? null;
}

export class LocalRepository implements Repository {
  readonly mode = 'local' as const;
  readonly authMode = 'local' as const;
  readonly providerLabel: string;
  private readonly store: TableStore;
  private readonly session: SessionStore;
  private readonly channel: Broadcast | null;
  private readonly probeImage?: LocalRepoOptions['probeImage'];
  private readonly listeners = new Map<string, Set<(e: RepoEvent) => void>>();
  private readonly urlCache = new Map<string, string>();
  private readonly autoProvision: boolean;
  readonly engine: JobEngine;

  constructor(opts: LocalRepoOptions) {
    this.store = opts.store;
    this.session = opts.session ?? memorySession();
    this.channel = opts.channel ?? null;
    this.probeImage = opts.probeImage;
    this.autoProvision = opts.autoProvisionOwner ?? false;
    const provider = opts.provider ?? new MockProvider({ latencyMs: 700 });
    this.providerLabel = provider.id === 'mock' ? 'Mock AI · offline' : provider.id;
    const exportExecutor = createExportExecutor({
      rasterize: opts.rasterize ?? passthroughRasterizer,
      loadMeta: async (projectId) => {
        const t = await this.store.read(['projects', 'profiles']);
        const project = t.projects.find((p) => p.id === projectId);
        if (!project) throw new NotFoundError('Project not found');
        return { project, names: Object.fromEntries(t.profiles.map((p) => [p.id, p.displayName])) };
      },
    });
    this.engine = new JobEngine(this.jobStore(), provider, {
      ...opts.engine,
      internalExecutors: { 'export:export': exportExecutor, ...opts.engine?.internalExecutors },
      onChange: (job) => {
        this.emit({ projectId: job.projectId, kind: 'jobs' });
        opts.engine?.onChange?.(job);
      },
    });
    if (this.channel) {
      this.channel.onmessage = (ev) => {
        const e = ev.data as RepoEvent;
        if (e?.projectId) this.dispatch(e);
      };
    }
  }

  // ------------------------------------------------------------ events

  private dispatch(e: RepoEvent) {
    for (const key of [e.projectId, '*']) this.listeners.get(key)?.forEach((cb) => cb(e));
  }

  private emit(e: RepoEvent) {
    this.dispatch(e);
    this.channel?.postMessage(e);
  }

  subscribe(projectId: string, cb: (e: RepoEvent) => void): () => void {
    const set = this.listeners.get(projectId) ?? new Set();
    set.add(cb);
    this.listeners.set(projectId, set);
    return () => set.delete(cb);
  }

  // ------------------------------------------------------------ auth

  private async me(): Promise<Profile> {
    const u = await this.currentUser();
    if (!u) throw new Error('Please sign in.');
    return u;
  }

  async currentUser(): Promise<Profile | null> {
    const id = this.session.get();
    const { profiles } = await this.store.read(['profiles']);
    const found = id ? profiles.find((p) => p.id === id) : undefined;
    if (found) return found;
    if (this.autoProvision && !id) {
      const owner = profiles.find((p) => p.email === DEFAULT_OWNER.email) ?? (await this.ensureProfile(DEFAULT_OWNER.email, DEFAULT_OWNER.displayName));
      this.session.set(owner.id);
      return owner;
    }
    return null;
  }

  private async ensureProfile(email: string, displayName?: string): Promise<Profile> {
    const norm = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm)) throw new Error('Enter a valid email address.');
    return this.store.mutate(['profiles'], (t) => {
      const existing = t.profiles.find((p) => p.email === norm);
      if (existing) return existing;
      const p: Profile = { id: crypto.randomUUID(), email: norm, displayName: displayName?.trim() || norm.split('@')[0]! };
      t.profiles.push(p);
      return p;
    });
  }

  async signIn(email: string): Promise<Profile> {
    const p = await this.ensureProfile(email);
    this.session.set(p.id);
    return p;
  }

  async signOut(): Promise<void> {
    this.session.set('signed-out');
  }

  async listLocalProfiles(): Promise<Profile[]> {
    return (await this.store.read(['profiles'])).profiles;
  }

  // ------------------------------------------------------------ helpers

  private async requireRole(projectId: string, action: Parameters<typeof assertCan>[1]): Promise<{ user: Profile; role: Role }> {
    const user = await this.me();
    const { members, projects } = await this.store.read(['members', 'projects']);
    if (!projects.some((p) => p.id === projectId)) throw new NotFoundError('Project not found');
    const role = roleOf(members, projectId, user.id);
    // Non-members get the same answer as a missing project: no existence leak.
    if (!role) throw new NotFoundError('Project not found');
    assertCan(role, action);
    return { user, role };
  }

  private activity(t: Pick<Tables, 'activity'>, e: Omit<ActivityEvent, 'id' | 'createdAt'>) {
    t.activity.push({ ...e, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    const mine = t.activity.filter((a) => a.projectId === e.projectId);
    if (mine.length > 500) {
      const drop = new Set(mine.slice(0, mine.length - 500).map((a) => a.id));
      t.activity = t.activity.filter((a) => !drop.has(a.id));
    }
  }

  private async graphContext(projectId: string): Promise<GraphContext> {
    const t = await this.store.read(['nodes', 'edges', 'assets', 'runs', 'approvals']);
    return {
      nodes: t.nodes.filter((n) => n.projectId === projectId),
      edges: t.edges.filter((e) => e.projectId === projectId),
      assets: t.assets.filter((a) => a.projectId === projectId),
      runs: t.runs.filter((r) => r.projectId === projectId),
      approvals: t.approvals.filter((a) => a.projectId === projectId),
    };
  }

  private jobStore(): JobStore {
    return {
      loadGraph: (projectId) => this.graphContext(projectId),
      getJob: async (id) => (await this.store.read(['jobs'])).jobs.find((j) => j.id === id),
      findJobByKey: async (projectId, key) => (await this.store.read(['jobs'])).jobs.find((j) => j.projectId === projectId && j.idempotencyKey === key),
      listJobs: async (projectId) => (await this.store.read(['jobs'])).jobs.filter((j) => j.projectId === projectId),
      countRecentAiJobs: async (userId, since) =>
        (await this.store.read(['jobs'])).jobs.filter((j) => j.requestedBy === userId && j.provider !== 'internal' && j.createdAt >= since).length,
      insertJob: async (job) => {
        await this.store.mutate(['jobs'], (t) => void t.jobs.push(job));
      },
      updateJob: async (id, patch) =>
        this.store.mutate(['jobs'], (t) => {
          const i = t.jobs.findIndex((j) => j.id === id);
          if (i < 0) throw new Error(`Job ${id} not found`);
          t.jobs[i] = { ...t.jobs[i]!, ...patch };
          return t.jobs[i]!;
        }),
      saveGeneratedAsset: async (projectId, p: PendingAsset, meta) => {
        const storageKey = `${projectId}/${meta.nodeId}/${meta.id}.${extFor(p.mimeType)}`;
        await this.store.putBlob(storageKey, p.bytes, p.mimeType);
        const asset: Asset = {
          id: meta.id,
          projectId,
          storageKey,
          mimeType: p.mimeType,
          width: p.width || null,
          height: p.height || null,
          sizeBytes: p.bytes.byteLength,
          role: p.role,
          sourceType: p.sourceType ?? 'ai_generated',
          parentAssetId: p.parentAssetId,
          versionOf: p.versionOf,
          version: p.version,
          nodeId: meta.nodeId,
          jobId: meta.jobId,
          label: p.label,
          prompt: p.prompt || null,
          originalFilename: p.filename ?? null,
          contentHash: hashBytes(p.bytes),
          createdBy: meta.createdBy,
          createdAt: new Date().toISOString(),
        };
        await this.store.mutate(['assets'], (t) => void t.assets.push(asset));
        this.emit({ projectId, kind: 'assets' });
        return asset;
      },
      insertRun: async (run: NodeRun) => {
        await this.store.mutate(['runs'], (t) => void t.runs.push(run));
        this.emit({ projectId: run.projectId, kind: 'graph' });
      },
      loadImage: async (projectId, ref: ImageRef): Promise<ImageInput> => {
        const { assets } = await this.store.read(['assets']);
        const a = assets.find((x) => x.id === ref.assetId && x.projectId === projectId);
        if (!a) throw new Error(`Asset ${ref.assetId} not in project`);
        const blob = await this.store.getBlob(a.storageKey);
        if (!blob) throw new Error(`Asset file missing for ${a.id}`);
        return { assetId: a.id, role: a.role, mimeType: a.mimeType, bytes: blob.bytes };
      },
      logActivity: async (e) => {
        await this.store.mutate(['activity'], (t) => this.activity(t, { ...e, meta: e.meta ?? null }));
        this.emit({ projectId: e.projectId, kind: 'activity' });
      },
    };
  }

  // ------------------------------------------------------------ projects

  async listProjects(): Promise<ProjectSummary[]> {
    const user = await this.me();
    const t = await this.store.read(['projects', 'members', 'nodes', 'edges', 'assets', 'runs', 'approvals']);
    const mine = t.members.filter((m) => m.userId === user.id);
    return mine
      .map((m) => {
        const project = t.projects.find((p) => p.id === m.projectId);
        if (!project) return null;
        const ctx: GraphContext = {
          nodes: t.nodes.filter((n) => n.projectId === project.id),
          edges: t.edges.filter((e) => e.projectId === project.id),
          assets: t.assets.filter((a) => a.projectId === project.id),
          runs: t.runs.filter((r) => r.projectId === project.id),
          approvals: t.approvals.filter((a) => a.projectId === project.id),
        };
        const cover =
          [...ctx.assets].reverse().find((a) => a.role === 'concept') ??
          ctx.assets.find((a) => a.role === 'product') ??
          ctx.assets.find((a) => a.role !== 'export');
        let pending = 0;
        for (const n of ctx.nodes.filter((x) => x.type === 'approval')) {
          const imgs = (resolveInputs(ctx, n.id).images as ImageRef[] | undefined) ?? [];
          pending += buildApprovedBundle(n.id, imgs, ctx.approvals).pendingAssetIds.length;
        }
        return { project, myRole: m.role, coverAsset: cover ?? null, nodeCount: ctx.nodes.length, pendingReviews: pending };
      })
      .filter((x): x is ProjectSummary => !!x)
      .sort((a, b) => (a.project.updatedAt < b.project.updatedAt ? 1 : -1));
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const user = await this.me();
    const name = input.name.trim();
    if (!name) throw new Error('Give the project a name.');
    const now = new Date().toISOString();
    const project: Project = {
      id: crypto.randomUUID(),
      ownerId: user.id,
      name,
      client: input.client.trim(),
      status: 'draft',
      graphRevision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const brief = { client: input.client.trim(), ...input.brief };
    const graph = input.template === 'campaign' ? campaignTemplate(project.id, user.id, brief) : blankTemplate(project.id, user.id, brief);
    await this.store.mutate(['projects', 'members', 'nodes', 'edges', 'activity'], (t) => {
      t.projects.push(project);
      t.members.push({ id: crypto.randomUUID(), projectId: project.id, userId: user.id, role: 'owner', createdAt: now });
      t.nodes.push(...graph.nodes);
      t.edges.push(...graph.edges);
      this.activity(t, { projectId: project.id, actorId: user.id, action: 'project.create', entityType: 'project', entityId: project.id, meta: { name } });
    });
    return project;
  }

  async updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'client' | 'status'>>): Promise<Project> {
    const { user } = await this.requireRole(id, 'project.update');
    const p = await this.store.mutate(['projects', 'activity'], (t) => {
      const i = t.projects.findIndex((x) => x.id === id);
      t.projects[i] = { ...t.projects[i]!, ...patch, updatedAt: new Date().toISOString() };
      this.activity(t, { projectId: id, actorId: user.id, action: 'project.update', entityType: 'project', entityId: id, meta: patch });
      return t.projects[i]!;
    });
    this.emit({ projectId: id, kind: 'project' });
    return p;
  }

  async deleteProject(id: string): Promise<void> {
    await this.requireRole(id, 'project.delete');
    await this.store.mutate(
      ['projects', 'members', 'invitations', 'nodes', 'edges', 'assets', 'jobs', 'runs', 'comments', 'approvals', 'activity'],
      (t) => {
        for (const k of Object.keys(t) as (keyof typeof t)[]) {
          const rows = t[k] as { projectId?: string; id: string }[];
          (t as Record<string, unknown>)[k] = rows.filter((r) => (k === 'projects' ? r.id !== id : r.projectId !== id));
        }
      },
    );
  }

  async loadProject(id: string): Promise<ProjectBundle> {
    const { role } = await this.requireRole(id, 'project.read');
    await this.engine.recover(id, 60_000);
    const t = await this.store.read(['projects', 'profiles', 'members', 'invitations', 'nodes', 'edges', 'assets', 'jobs', 'runs', 'comments', 'approvals', 'activity']);
    const name = (uid: string) => t.profiles.find((p) => p.id === uid)?.displayName ?? 'Unknown';
    const of = <T extends { projectId: string }>(rows: T[]) => rows.filter((r) => r.projectId === id);
    return {
      project: t.projects.find((p) => p.id === id)!,
      myRole: role,
      nodes: of(t.nodes),
      edges: of(t.edges),
      assets: of(t.assets),
      jobs: can(role, 'job.read') ? of(t.jobs) : [],
      runs: of(t.runs),
      comments: of(t.comments).map((c) => ({ ...c, authorName: name(c.authorId) })),
      approvals: of(t.approvals).map((a) => ({ ...a, reviewerName: name(a.reviewerId) })),
      activity: of(t.activity).map((a) => ({ ...a, actorName: name(a.actorId) })),
      members: of(t.members).map((m) => {
        const p = t.profiles.find((x) => x.id === m.userId);
        return { ...m, email: p?.email, displayName: p?.displayName };
      }),
      invitations: can(role, 'member.manage') ? of(t.invitations) : [],
    };
  }

  // ------------------------------------------------------------ graph

  async saveGraph(projectId: string, graph: { nodes: GraphNode[]; edges: GraphEdge[] }, baseRevision: number): Promise<{ revision: number }> {
    const { user } = await this.requireRole(projectId, 'graph.edit');
    const nodes = graph.nodes.map((n) => {
      if (n.projectId !== projectId) throw new Error('Node belongs to another project');
      return { ...n, ...normalizeNodeData(n.type, n.data, n.schemaVersion) };
    });
    const edges = graph.edges.map((e) => ({ ...e, projectId }));
    const errors = validateGraph(nodes, edges);
    if (errors.length) throw new Error(`Invalid graph: ${errors[0]}`);
    const revision = await this.store.mutate(['projects', 'nodes', 'edges', 'activity'], (t) => {
      const i = t.projects.findIndex((p) => p.id === projectId);
      const p = t.projects[i]!;
      if (p.graphRevision !== baseRevision) throw new ConflictError(p.graphRevision);
      t.projects[i] = { ...p, graphRevision: p.graphRevision + 1, updatedAt: new Date().toISOString() };
      const removed = t.nodes.filter((n) => n.projectId === projectId && !nodes.some((x) => x.id === n.id)).length;
      const added = nodes.filter((n) => !t.nodes.some((x) => x.id === n.id)).length;
      t.nodes = [...t.nodes.filter((n) => n.projectId !== projectId), ...nodes];
      t.edges = [...t.edges.filter((e) => e.projectId !== projectId), ...edges];
      if (added || removed)
        this.activity(t, { projectId, actorId: user.id, action: 'graph.update', entityType: 'project', entityId: projectId, meta: { added, removed } });
      return p.graphRevision + 1;
    });
    this.emit({ projectId, kind: 'graph' });
    return { revision };
  }

  // ------------------------------------------------------------ assets

  async uploadAsset(projectId: string, file: Blob, meta: { role: 'product' | 'brand' | 'reference'; filename: string; nodeId?: string }): Promise<Asset> {
    const { user } = await this.requireRole(projectId, 'asset.upload');
    if (!UPLOAD_LIMITS.mimeTypes.includes(file.type)) throw new Error(`${meta.filename}: only JPEG, PNG or WebP images are accepted.`);
    if (file.size > UPLOAD_LIMITS.maxBytes) throw new Error(`${meta.filename}: larger than ${UPLOAD_LIMITS.maxBytes / 1024 / 1024} MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const dims = (await this.probeImage?.(file)) ?? null;
    const id = crypto.randomUUID();
    const safe = meta.filename.replace(/[^\w.-]+/g, '_').slice(-80);
    const storageKey = `${projectId}/uploads/${id}-${safe}`;
    await this.store.putBlob(storageKey, bytes, file.type);
    const asset: Asset = {
      id,
      projectId,
      storageKey,
      mimeType: file.type,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      sizeBytes: file.size,
      role: meta.role,
      sourceType: 'upload',
      parentAssetId: null,
      versionOf: null,
      version: 1,
      nodeId: meta.nodeId ?? null,
      jobId: null,
      label: meta.filename,
      prompt: null,
      originalFilename: meta.filename,
      contentHash: hashBytes(bytes),
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(['assets', 'activity'], (t) => {
      t.assets.push(asset);
      this.activity(t, { projectId, actorId: user.id, action: 'asset.upload', entityType: 'asset', entityId: id, meta: { filename: meta.filename, role: meta.role } });
    });
    this.emit({ projectId, kind: 'assets' });
    return asset;
  }

  async assetBytes(asset: Asset): Promise<Uint8Array> {
    await this.requireRole(asset.projectId, 'asset.read');
    const b = await this.store.getBlob(asset.storageKey);
    if (!b) throw new NotFoundError('File missing');
    return b.bytes;
  }

  async assetUrl(asset: Asset, _opts?: { download?: boolean; thumb?: boolean }): Promise<string> {
    const cached = this.urlCache.get(asset.id);
    if (cached) return cached;
    const bytes = await this.assetBytes(asset);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: asset.mimeType }));
    this.urlCache.set(asset.id, url);
    return url;
  }

  // ------------------------------------------------------------ jobs

  async runNode(projectId: string, nodeId: string, operation: string, opts: { force?: boolean; idempotencyKey: string }): Promise<SubmitResult> {
    const { user } = await this.requireRole(projectId, 'node.run');
    return this.engine.submit({ projectId, nodeId, operation, requestedBy: user.id, force: opts.force, idempotencyKey: opts.idempotencyKey });
  }

  async cancelJob(jobId: string): Promise<void> {
    const { jobs } = await this.store.read(['jobs']);
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new NotFoundError('Job not found');
    await this.requireRole(job.projectId, 'job.cancel');
    await this.engine.cancel(jobId);
  }

  // ------------------------------------------------------------ review

  private async assertAssetInProject(projectId: string, assetId: string): Promise<Asset> {
    const { assets } = await this.store.read(['assets']);
    const a = assets.find((x) => x.id === assetId && x.projectId === projectId);
    if (!a) throw new NotFoundError('Asset not found in this project');
    return a;
  }

  async addComment(projectId: string, input: { assetId?: string | null; nodeId?: string | null; body: string }): Promise<Comment> {
    const { user } = await this.requireRole(projectId, 'comment.create');
    const body = input.body.trim();
    if (!body) throw new Error('Write a comment first.');
    if (body.length > 4000) throw new Error('Comment is too long.');
    if (input.assetId) await this.assertAssetInProject(projectId, input.assetId);
    const c: Comment = {
      id: crypto.randomUUID(),
      projectId,
      assetId: input.assetId ?? null,
      nodeId: input.nodeId ?? null,
      authorId: user.id,
      body,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(['comments', 'activity'], (t) => {
      t.comments.push(c);
      this.activity(t, { projectId, actorId: user.id, action: 'comment.create', entityType: input.assetId ? 'asset' : 'node', entityId: input.assetId ?? input.nodeId ?? projectId, meta: { preview: body.slice(0, 80) } });
    });
    this.emit({ projectId, kind: 'comments' });
    return { ...c, authorName: user.displayName };
  }

  async resolveComment(commentId: string, resolved: boolean): Promise<void> {
    const { comments } = await this.store.read(['comments']);
    const c = comments.find((x) => x.id === commentId);
    if (!c) throw new NotFoundError('Comment not found');
    await this.requireRole(c.projectId, 'comment.resolve');
    await this.store.mutate(['comments'], (t) => {
      const i = t.comments.findIndex((x) => x.id === commentId);
      t.comments[i] = { ...t.comments[i]!, resolved };
    });
    this.emit({ projectId: c.projectId, kind: 'comments' });
  }

  async recordApproval(projectId: string, assetId: string, decision: ApprovalDecision, comment?: string): Promise<void> {
    const { user } = await this.requireRole(projectId, 'approval.create');
    const asset = await this.assertAssetInProject(projectId, assetId);
    if (asset.sourceType === 'export') throw new Error('Exports cannot be approved.');
    if (decision === 'changes_requested' && !comment?.trim()) throw new Error('Tell us what to change.');
    await this.store.mutate(['approvals', 'activity'], (t) => {
      t.approvals.push({
        id: crypto.randomUUID(),
        projectId,
        assetId,
        assetVersion: asset.version,
        reviewerId: user.id,
        decision,
        comment: comment?.trim() || null,
        createdAt: new Date().toISOString(),
      });
      this.activity(t, { projectId, actorId: user.id, action: `approval.${decision}`, entityType: 'asset', entityId: assetId, meta: { label: asset.label, version: asset.version } });
    });
    this.emit({ projectId, kind: 'approvals' });
  }

  // ------------------------------------------------------------ members

  async createInvitation(projectId: string, email: string, role: Exclude<Role, 'owner'>): Promise<Invitation> {
    const { user } = await this.requireRole(projectId, 'member.manage');
    const norm = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm)) throw new Error('Enter a valid email address.');
    const inv: Invitation = {
      id: crypto.randomUUID(),
      projectId,
      email: norm,
      role,
      token: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
      status: 'pending',
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(['invitations', 'activity'], (t) => {
      t.invitations.push(inv);
      this.activity(t, { projectId, actorId: user.id, action: 'member.invite', entityType: 'invitation', entityId: inv.id, meta: { email: norm, role } });
    });
    this.emit({ projectId, kind: 'members' });
    return inv;
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    const { invitations } = await this.store.read(['invitations']);
    const inv = invitations.find((i) => i.id === invitationId);
    if (!inv) throw new NotFoundError('Invitation not found');
    await this.requireRole(inv.projectId, 'member.manage');
    await this.store.mutate(['invitations'], (t) => {
      const i = t.invitations.findIndex((x) => x.id === invitationId);
      t.invitations[i] = { ...t.invitations[i]!, status: 'revoked' };
    });
    this.emit({ projectId: inv.projectId, kind: 'members' });
  }

  async previewInvitation(token: string) {
    const t = await this.store.read(['invitations', 'projects']);
    const inv = t.invitations.find((i) => i.token === token);
    if (!inv) throw new NotFoundError('This invitation link is not valid.');
    const p = t.projects.find((x) => x.id === inv.projectId);
    return { projectName: p?.name ?? 'Project', client: p?.client ?? '', role: inv.role as Role, email: inv.email, status: inv.status };
  }

  async acceptInvitation(token: string): Promise<{ projectId: string; role: Role }> {
    const user = await this.me();
    const result = await this.store.mutate(['invitations', 'members', 'activity'], (t) => {
      const i = t.invitations.findIndex((x) => x.token === token);
      const inv = t.invitations[i];
      if (!inv) throw new NotFoundError('This invitation link is not valid.');
      if (inv.status !== 'pending') throw new Error(`This invitation has been ${inv.status}.`);
      if (inv.email !== user.email) throw new Error(`This invitation is for ${inv.email}. Sign in with that email to accept it.`);
      const existing = t.members.find((m) => m.projectId === inv.projectId && m.userId === user.id);
      if (!existing) t.members.push({ id: crypto.randomUUID(), projectId: inv.projectId, userId: user.id, role: inv.role, createdAt: new Date().toISOString() });
      t.invitations[i] = { ...inv, status: 'accepted', acceptedAt: new Date().toISOString() };
      this.activity(t, { projectId: inv.projectId, actorId: user.id, action: 'member.join', entityType: 'member', entityId: user.id, meta: { role: inv.role } });
      return { projectId: inv.projectId, role: (existing?.role ?? inv.role) as Role };
    });
    this.emit({ projectId: result.projectId, kind: 'members' });
    return result;
  }

  async updateMemberRole(memberId: string, role: Exclude<Role, 'owner'>): Promise<void> {
    const { members } = await this.store.read(['members']);
    const m = members.find((x) => x.id === memberId);
    if (!m) throw new NotFoundError('Member not found');
    await this.requireRole(m.projectId, 'member.manage');
    if (m.role === 'owner') throw new Error("The owner's role can't be changed.");
    await this.store.mutate(['members'], (t) => {
      const i = t.members.findIndex((x) => x.id === memberId);
      t.members[i] = { ...t.members[i]!, role };
    });
    this.emit({ projectId: m.projectId, kind: 'members' });
  }

  async removeMember(memberId: string): Promise<void> {
    const { members } = await this.store.read(['members']);
    const m = members.find((x) => x.id === memberId);
    if (!m) throw new NotFoundError('Member not found');
    await this.requireRole(m.projectId, 'member.manage');
    if (m.role === 'owner') throw new Error("The owner can't be removed.");
    await this.store.mutate(['members'], (t) => {
      t.members = t.members.filter((x) => x.id !== memberId);
    });
    this.emit({ projectId: m.projectId, kind: 'members' });
  }
}
