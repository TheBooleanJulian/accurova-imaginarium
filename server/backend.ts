import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Asset, ApprovalDecision, GraphEdge, GraphNode, Invitation, Profile, Project, ProjectBundle, Role } from '../src/core/types';
import { NODE_TYPES } from '../src/core/types';
import { assertCan, can, PermissionError, type Action } from '../src/core/permissions';
import { buildApprovedBundle, resolveInputs, validateGraph, type ImageRef } from '../src/core/graph';
import { normalizeNodeData } from '../src/core/nodeRegistry';
import { BriefSchema, UPLOAD_LIMITS } from '../src/core/schemas';
import { JobEngine, SubmitError, type SubmitResult } from '../src/core/jobEngine';
import { blankTemplate, campaignTemplate } from '../src/data/templates';
import type { ProjectSummary } from '../src/data/repository';
import type { Config } from './config';
import type { Db, Queryable } from './db/index';
import { isUniqueViolation, pgCode } from './db/index';
import {
  toActivity,
  toApproval,
  toAsset,
  toComment,
  toEdge,
  toInvitation,
  toJob,
  toMember,
  toNode,
  toProfile,
  toProject,
  toRun,
} from './db/mappers';
import { DuplicateJobError, loadGraphContext, sha256 } from './jobs/pgJobStore';
import { ObjectNotFoundError, type ObjectStorage, type UploadTarget } from './storage';
import { ImageValidationError, makeThumbnail, probeImage } from './images';

// ------------------------------------------------------------------ errors

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra?: Record<string, unknown>;
  constructor(status: number, message: string, code = 'error', extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found');
const bad = (msg: string, code = 'bad_request') => new HttpError(400, msg, code);

/** Translate domain and database errors into HTTP errors with safe messages. */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof PermissionError) return new HttpError(403, e.message, 'forbidden');
  if (e instanceof SubmitError) return new HttpError(e.code === 'usage_limit' ? 429 : 400, e.message, e.code);
  if (e instanceof ImageValidationError) return bad(e.message, 'invalid_image');
  if (e instanceof ObjectNotFoundError) return notFound('File not found');
  if (e instanceof z.ZodError) return bad(`Invalid request: ${e.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`, 'validation');
  const code = pgCode(e);
  if (code === '42501') return new HttpError(403, (e as Error).message.includes('row-level security') ? "You don't have permission to do that." : (e as Error).message, 'forbidden');
  if (code === '23505') return new HttpError(409, 'That already exists.', 'conflict');
  if (code === '23503') return bad('That refers to something that does not exist in this project.', 'invalid_reference');
  if (code === '23514' || code === '22P02') return bad('Some values are not valid.', 'invalid_value');
  if (code === 'P0002') return notFound((e as Error).message);
  if (code === '22023') return bad((e as Error).message, 'invalid');
  if (code === '28000') return new HttpError(401, (e as Error).message, 'unauthenticated');
  return new HttpError(500, 'Something went wrong on the server.', 'internal');
}

// ------------------------------------------------------------------ request schemas (validated with Zod)

const uuid = z.string().uuid();
export const CreateProjectBody = z.object({
  name: z.string().trim().min(1).max(200),
  client: z.string().trim().max(200).default(''),
  template: z.enum(['campaign', 'blank']).default('campaign'),
  brief: BriefSchema.partial().optional(),
});
export const UpdateProjectBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    client: z.string().trim().max(200).optional(),
    status: z.enum(['draft', 'in_review', 'approved', 'archived']).optional(),
  })
  .strict();
const XY = z.object({ x: z.number().finite(), y: z.number().finite() });
export const GraphBody = z.object({
  baseRevision: z.number().int().min(1),
  nodes: z
    .array(
      z.object({
        id: uuid,
        projectId: z.string().optional(),
        type: z.enum(NODE_TYPES),
        schemaVersion: z.number().int().min(1),
        position: XY,
        size: z.object({ width: z.number().min(40).max(4000), height: z.number().min(40).max(4000) }).nullish(),
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .max(400),
  edges: z
    .array(z.object({ id: uuid, source: uuid, sourcePort: z.string().max(40), target: uuid, targetPort: z.string().max(40) }))
    .max(2000),
});
export const UploadUrlBody = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string(),
  size: z.number().int().min(1),
  role: z.enum(['product', 'brand', 'reference']),
  nodeId: uuid.optional(),
});
export const RunBody = z.object({ operation: z.string().min(1).max(40), force: z.boolean().optional() });
export const CommentBody = z.object({ body: z.string().trim().min(1).max(4000), nodeId: uuid.optional() });
export const ApprovalBody = z.object({ decision: z.enum(['approved', 'changes_requested']), comment: z.string().trim().max(4000).optional() });
export const InviteBody = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['editor', 'reviewer', 'viewer']) });
export const RoleBody = z.object({ role: z.enum(['editor', 'reviewer', 'viewer']) });

// ------------------------------------------------------------------ backend

export interface BackendDeps {
  cfg: Config;
  db: Db;
  storage: ObjectStorage;
  engine: JobEngine;
}

export class Backend {
  private readonly d: BackendDeps;

  constructor(deps: BackendDeps) {
    this.d = deps;
  }

  private get db() {
    return this.d.db;
  }

  /** Caller's role in a project, read under RLS. Non-members get 404 (no existence leak). */
  private async roleIn(q: Queryable, projectId: string): Promise<Role> {
    if (!uuid.safeParse(projectId).success) throw notFound('Project not found');
    const [r] = await q.query<{ role: Role | null }>('select public.project_role($1) as role', [projectId]);
    if (!r?.role) throw notFound('Project not found');
    return r.role;
  }

  private async require(q: Queryable, projectId: string, action: Action): Promise<Role> {
    const role = await this.roleIn(q, projectId);
    assertCan(role, action);
    return role;
  }

  private async activity(q: Queryable, user: Profile, projectId: string, action: string, entityType: string, entityId: string, meta?: Record<string, unknown>) {
    await q.query(
      `insert into public.activity_events (project_id, actor_id, action, entity_type, entity_id, meta) values ($1, $2, $3, $4, $5, $6::text::jsonb)`,
      [projectId, user.id, action, entityType, entityId, JSON.stringify(meta ?? null)],
    );
  }

  // ---------------------------------------------------------------- projects

  async listProjects(user: Profile): Promise<ProjectSummary[]> {
    return this.db.asUser(user.id, async (q) => {
      const rows = await q.query(
        `select p.*, m.role as my_role, (select count(*)::int from public.nodes n where n.project_id = p.id) as node_count
         from public.projects p
         join public.project_members m on m.project_id = p.id and m.user_id = auth.uid()
         order by p.updated_at desc`,
      );
      const out: ProjectSummary[] = [];
      for (const r of rows) {
        const project = toProject(r);
        const cover = await q.query(
          `select * from public.assets where project_id = $1 and source_type <> 'export'
           order by (role = 'concept') desc, (role = 'product') desc, created_at desc limit 1`,
          [project.id],
        );
        const ctx = await loadGraphContext(q, project.id);
        let pending = 0;
        for (const n of ctx.nodes.filter((x) => x.type === 'approval')) {
          const imgs = (resolveInputs(ctx, n.id).images as ImageRef[] | undefined) ?? [];
          pending += buildApprovedBundle(n.id, imgs, ctx.approvals).pendingAssetIds.length;
        }
        out.push({ project, myRole: r.my_role as Role, coverAsset: cover[0] ? toAsset(cover[0]) : null, nodeCount: Number(r.node_count), pendingReviews: pending });
      }
      return out;
    });
  }

  async createProject(user: Profile, body: unknown): Promise<Project> {
    const input = CreateProjectBody.parse(body);
    return this.db.asUser(user.id, async (q) => {
      const [row] = await q.query(`insert into public.projects (owner_id, name, client) values ($1, $2, $3) returning *`, [user.id, input.name, input.client]);
      const project = toProject(row!);
      // Only brief fields the caller actually filled in; the client name comes from the project.
      const given = Object.fromEntries(Object.entries(input.brief ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()));
      const brief = { client: input.client, ...given };
      const graph = input.template === 'campaign' ? campaignTemplate(project.id, user.id, brief) : blankTemplate(project.id, user.id, brief);
      await this.writeGraph(q, project.id, graph.nodes, graph.edges);
      await this.activity(q, user, project.id, 'project.create', 'project', project.id, { name: input.name });
      return project;
    });
  }

  async updateProject(user: Profile, projectId: string, body: unknown): Promise<Project> {
    const patch = UpdateProjectBody.parse(body);
    return this.db.asUser(user.id, async (q) => {
      await this.require(q, projectId, 'project.update');
      const [row] = await q.query(
        `update public.projects set name = coalesce($2, name), client = coalesce($3, client), status = coalesce($4, status) where id = $1 returning *`,
        [projectId, patch.name ?? null, patch.client ?? null, patch.status ?? null],
      );
      await this.activity(q, user, projectId, 'project.update', 'project', projectId, patch);
      return toProject(row!);
    });
  }

  async deleteProject(user: Profile, projectId: string): Promise<void> {
    const keys = await this.db.asUser(user.id, async (q) => {
      await this.require(q, projectId, 'project.delete');
      const assets = await q.query<{ storage_key: string; thumb_key: string | null }>('select storage_key, thumb_key from public.assets where project_id = $1', [projectId]);
      await q.query('delete from public.projects where id = $1', [projectId]);
      return assets.flatMap((a) => [a.storage_key, a.thumb_key].filter((k): k is string => !!k));
    });
    // Files go after the rows; a failure here leaves orphans, never dangling rows.
    for (let i = 0; i < keys.length; i += 100) await this.d.storage.delete(keys.slice(i, i + 100)).catch(() => undefined);
  }

  async loadProject(user: Profile, projectId: string): Promise<ProjectBundle> {
    return this.db.asUser(user.id, async (q) => {
      const role = await this.roleIn(q, projectId);
      const [p] = await q.query('select * from public.projects where id = $1', [projectId]);
      const nodes = (await q.query('select * from public.nodes where project_id = $1 order by created_at, id', [projectId])).map(toNode);
      const edges = (await q.query('select * from public.edges where project_id = $1 order by created_at, id', [projectId])).map(toEdge);
      const assets = (await q.query('select * from public.assets where project_id = $1 order by created_at, id', [projectId])).map((r) => {
        const { thumbKey: _t, ...a } = toAsset(r);
        return a;
      });
      // RLS hides jobs from reviewers and viewers; no extra filtering needed.
      const jobs = (await q.query('select * from public.generation_jobs where project_id = $1 order by created_at desc limit 300', [projectId])).map(toJob);
      const runs = (await q.query('select * from public.node_runs where project_id = $1 order by completed_at, id', [projectId])).map(toRun);
      const comments = (
        await q.query(
          `select c.*, pr.display_name as author_name from public.comments c left join public.profiles pr on pr.id = c.author_id
           where c.project_id = $1 order by c.created_at`,
          [projectId],
        )
      ).map(toComment);
      const approvals = (
        await q.query(
          `select a.*, pr.display_name as reviewer_name from public.approvals a left join public.profiles pr on pr.id = a.reviewer_id
           where a.project_id = $1 order by a.created_at`,
          [projectId],
        )
      ).map(toApproval);
      const activity = (
        await q.query(
          `select e.*, pr.display_name as actor_name from public.activity_events e left join public.profiles pr on pr.id = e.actor_id
           where e.project_id = $1 order by e.created_at desc limit 300`,
          [projectId],
        )
      ).map(toActivity);
      const members = (
        await q.query(
          `select m.*, pr.email, pr.display_name from public.project_members m join public.profiles pr on pr.id = m.user_id
           where m.project_id = $1 order by (m.role = 'owner') desc, m.created_at`,
          [projectId],
        )
      ).map(toMember);
      const invitations = can(role, 'member.manage')
        ? (await q.query('select * from public.project_invitations where project_id = $1 order by created_at desc', [projectId])).map(toInvitation)
        : [];
      return { project: toProject(p!), myRole: role, nodes, edges, assets, jobs: jobs.reverse(), runs, comments, approvals, activity, members, invitations };
    });
  }

  /** Cheap fingerprint of everything a viewer could see change; clients poll this instead of reloading. */
  async changeToken(user: Profile, projectId: string): Promise<string> {
    return this.db.asUser(user.id, async (q) => {
      await this.roleIn(q, projectId);
      const [r] = await q.query(
        `select p.graph_revision, p.updated_at,
           (select max(created_at) from public.activity_events where project_id = $1) as act,
           (select max(updated_at) from public.generation_jobs where project_id = $1) as jobs,
           (select max(updated_at) from public.comments where project_id = $1) as com,
           (select count(*) from public.approvals where project_id = $1) as appr,
           (select count(*) from public.project_members where project_id = $1) as mem
         from public.projects p where p.id = $1`,
        [projectId],
      );
      return sha256(new TextEncoder().encode(JSON.stringify(r))).slice(0, 24);
    });
  }

  // ---------------------------------------------------------------- graph

  private async writeGraph(q: Queryable, projectId: string, nodes: GraphNode[], edges: GraphEdge[]) {
    const nodeRows = nodes.map((n) => ({
      id: n.id,
      type: n.type,
      schema_version: n.schemaVersion,
      position: n.position,
      size: n.size ?? null,
      data: n.data,
    }));
    await q.query(
      `insert into public.nodes (id, project_id, type, schema_version, position, size, data, created_by)
       select x.id, $1, x.type, x.schema_version, x.position, x.size, x.data, auth.uid()
       from jsonb_to_recordset($2::text::jsonb) as x(id uuid, type text, schema_version int, position jsonb, size jsonb, data jsonb)
       on conflict (id) do update set
         schema_version = excluded.schema_version, position = excluded.position, size = excluded.size, data = excluded.data,
         updated_at = case when nodes.data is distinct from excluded.data then now() else nodes.updated_at end
       where nodes.project_id = excluded.project_id and nodes.type = excluded.type`,
      [projectId, JSON.stringify(nodeRows)],
    );
    await q.query(`delete from public.edges where project_id = $1`, [projectId]);
    await q.query(
      `delete from public.nodes where project_id = $1 and id not in (select (jsonb_array_elements_text($2::text::jsonb))::uuid)`,
      [projectId, JSON.stringify(nodes.map((n) => n.id))],
    );
    if (edges.length) {
      await q.query(
        `insert into public.edges (id, project_id, source_node_id, source_port, target_node_id, target_port)
         select x.id, $1, x.source, x.source_port, x.target, x.target_port
         from jsonb_to_recordset($2::text::jsonb) as x(id uuid, source uuid, source_port text, target uuid, target_port text)`,
        [projectId, JSON.stringify(edges.map((e) => ({ id: e.id, source: e.source, source_port: e.sourcePort, target: e.target, target_port: e.targetPort })))],
      );
    }
  }

  /** Optimistic concurrency: rejected with 409 unless `baseRevision` is the current revision. */
  async saveGraph(user: Profile, projectId: string, body: unknown): Promise<{ revision: number }> {
    const input = GraphBody.parse(body);
    const now = new Date().toISOString();
    const nodes: GraphNode[] = input.nodes.map((n) => {
      if (n.projectId && n.projectId !== projectId) throw bad('Node belongs to another project');
      let normalized;
      try {
        normalized = normalizeNodeData(n.type, n.data, n.schemaVersion);
      } catch (e) {
        throw bad(`Invalid settings on a ${n.type} node: ${e instanceof z.ZodError ? e.issues[0]?.message : (e as Error).message}`, 'validation');
      }
      return { id: n.id, projectId, type: n.type, schemaVersion: normalized.schemaVersion, data: normalized.data, position: n.position, size: n.size ?? undefined, createdBy: user.id, createdAt: now, updatedAt: now };
    });
    const edges: GraphEdge[] = input.edges.map((e) => ({ ...e, projectId }));
    const errors = validateGraph(nodes, edges);
    if (errors.length) throw bad(`Invalid graph: ${errors[0]}`, 'invalid_graph');
    // Ids already used by another project: refuse rather than silently skip. (Owner connection:
    // RLS would hide those rows from the caller.)
    const foreign = await this.db.query<{ id: string }>(
      `select id from public.nodes where project_id <> $1 and id in (select (jsonb_array_elements_text($2::text::jsonb))::uuid)`,
      [projectId, JSON.stringify(nodes.map((n) => n.id))],
    );
    if (foreign.length) throw bad('Node belongs to another project');

    return this.db.asUser(user.id, async (q) => {
      await this.require(q, projectId, 'graph.edit');
      const bumped = await q.query<{ graph_revision: number }>(
        `update public.projects set graph_revision = graph_revision + 1 where id = $1 and graph_revision = $2 returning graph_revision`,
        [projectId, input.baseRevision],
      );
      if (!bumped[0]) {
        const [cur] = await q.query<{ graph_revision: number }>('select graph_revision from public.projects where id = $1', [projectId]);
        throw new HttpError(409, 'Someone else saved this project since you loaded it.', 'conflict', { serverRevision: Number(cur?.graph_revision) });
      }
      const before = await q.query<{ id: string; type: string }>('select id, type from public.nodes where project_id = $1', [projectId]);
      const existing = new Map(before.map((r) => [r.id, r.type]));
      for (const n of nodes) {
        const t = existing.get(n.id);
        if (t && t !== n.type) throw bad('A node cannot change type.');
      }
      await this.writeGraph(q, projectId, nodes, edges);
      const added = nodes.filter((n) => !existing.has(n.id)).length;
      const removed = [...existing.keys()].filter((id) => !nodes.some((n) => n.id === id)).length;
      if (added || removed) await this.activity(q, user, projectId, 'graph.update', 'project', projectId, { added, removed });
      return { revision: Number(bumped[0].graph_revision) };
    });
  }

  // ---------------------------------------------------------------- uploads

  private signToken(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', this.d.cfg.signingSecret).update(body).digest('base64url')}`;
  }

  private readToken<T>(token: string): T {
    const [body, sig] = token.split('.');
    if (!body || !sig) throw bad('Invalid upload token');
    const want = Buffer.from(createHmac('sha256', this.d.cfg.signingSecret).update(body).digest('base64url'));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw bad('Invalid upload token');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  }

  async createUploadUrl(user: Profile, projectId: string, body: unknown): Promise<{ upload: UploadTarget; uploadToken: string }> {
    const input = UploadUrlBody.parse(body);
    if (!UPLOAD_LIMITS.mimeTypes.includes(input.contentType)) throw bad(`${input.filename}: only JPEG, PNG or WebP images are accepted.`, 'invalid_image');
    if (input.size > this.d.cfg.maxUploadBytes) throw bad(`${input.filename}: larger than ${this.d.cfg.env.MAX_UPLOAD_MB} MB.`, 'too_large');
    await this.db.asUser(user.id, async (q) => {
      await this.require(q, projectId, 'asset.upload');
      const [{ n }] = await q.query<{ n: number }>('select count(*)::int as n from public.assets where project_id = $1', [projectId]);
      if (Number(n) >= this.d.cfg.env.MAX_ASSETS_PER_PROJECT) throw bad('This project has reached its image limit.', 'limit');
      if (input.nodeId) {
        const node = await q.query('select 1 from public.nodes where id = $1 and project_id = $2', [input.nodeId, projectId]);
        if (!node.length) throw bad('Save the graph before uploading to a new node, then try again.', 'unknown_node');
      }
    });
    const assetId = randomUUID();
    const key = `${projectId}/uploads/${assetId}`;
    const ttl = 15 * 60;
    const upload = await this.d.storage.uploadTarget(key, input.contentType, { ttlSeconds: ttl, maxBytes: this.d.cfg.maxUploadBytes });
    const uploadToken = this.signToken({ a: assetId, p: projectId, k: key, r: input.role, n: input.nodeId ?? null, f: input.filename, u: user.id, exp: Date.now() + ttl * 1000 });
    return { upload, uploadToken };
  }

  /** Called after the browser uploaded the bytes: verify they really are an image, then record the asset. */
  async finalizeUpload(user: Profile, projectId: string, body: unknown): Promise<Asset> {
    const { uploadToken } = z.object({ uploadToken: z.string().min(10).max(4000) }).parse(body);
    const t = this.readToken<{ a: string; p: string; k: string; r: Asset['role']; n: string | null; f: string; u: string; exp: number }>(uploadToken);
    if (t.p !== projectId || t.u !== user.id) throw new HttpError(403, 'This upload belongs to someone else.', 'forbidden');
    if (t.exp < Date.now() - 60 * 60 * 1000) throw bad('This upload expired. Please upload again.', 'expired');

    const prior = await this.db.asUser(user.id, async (q) => {
      await this.require(q, projectId, 'asset.upload');
      return q.query('select * from public.assets where id = $1 and project_id = $2', [t.a, projectId]);
    });
    if (prior[0]) return toAsset(prior[0]);

    const bytes = await this.d.storage.get(t.k).catch((e) => {
      if (e instanceof ObjectNotFoundError) throw bad('The file never arrived. Please upload again.', 'missing_upload');
      throw e;
    });
    let probe;
    try {
      if (bytes.byteLength > this.d.cfg.maxUploadBytes) throw new ImageValidationError(`${t.f}: larger than ${this.d.cfg.env.MAX_UPLOAD_MB} MB.`);
      probe = await probeImage(bytes);
    } catch (e) {
      await this.d.storage.delete([t.k]).catch(() => undefined);
      throw e;
    }
    // Re-store with the verified content type so it is served correctly.
    await this.d.storage.put(t.k, bytes, probe.mimeType);
    const thumbKey = `${t.k}.thumb.webp`;
    await this.d.storage.put(thumbKey, await makeThumbnail(bytes), 'image/webp');
    const filename = t.f.replace(/[\r\n"]/g, '').slice(-200);

    return this.db.asUser(user.id, async (q) => {
      const [row] = await q.query(
        `insert into public.assets
          (id, project_id, storage_key, thumb_key, mime_type, width, height, size_bytes, role, source_type, version, node_id,
           label, original_filename, content_hash, provenance, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'upload', 1, $10, $11, $11, $12, $13::text::jsonb, $14)
         returning *`,
        [
          t.a, projectId, t.k, thumbKey, probe.mimeType, probe.width, probe.height, bytes.byteLength, t.r, t.n, filename, sha256(bytes),
          JSON.stringify({ kind: 'upload', uploadedBy: user.id, declaredName: filename }), user.id,
        ],
      );
      await this.activity(q, user, projectId, 'asset.upload', 'asset', t.a, { filename, role: t.r });
      const { thumbKey: _t, ...asset } = toAsset(row!);
      return asset;
    });
  }

  async assetUrl(user: Profile, assetId: string, opts: { download?: boolean; thumb?: boolean }): Promise<{ url: string; expiresAt: string }> {
    if (!uuid.safeParse(assetId).success) throw notFound('Asset not found');
    const row = await this.db.asUser(user.id, async (q) => (await q.query('select * from public.assets where id = $1', [assetId]))[0]);
    if (!row) throw notFound('Asset not found');
    const a = toAsset(row);
    const key = opts.thumb && a.thumbKey ? a.thumbKey : a.storageKey;
    const ext = a.mimeType === 'application/pdf' ? 'pdf' : a.mimeType.split('/')[1] ?? 'bin';
    const name = (a.originalFilename ?? a.label ?? a.id).replace(/[^\w .()-]+/g, '_').slice(0, 120);
    const download = opts.download ? (name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`) : undefined;
    const ttl = this.d.cfg.env.SIGNED_URL_TTL_SECONDS;
    const url = await this.d.storage.signedUrl(key, { ttlSeconds: ttl, download });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  // ---------------------------------------------------------------- jobs

  async runNode(user: Profile, nodeId: string, body: unknown, idempotencyKey: string | undefined): Promise<SubmitResult> {
    const input = RunBody.parse(body);
    if (!uuid.safeParse(nodeId).success) throw notFound('Node not found');
    const projectId = await this.db.asUser(user.id, async (q) => {
      const [n] = await q.query<{ project_id: string }>('select project_id from public.nodes where id = $1', [nodeId]);
      if (!n) throw notFound('Node not found. Save the graph and try again.');
      await this.require(q, n.project_id, 'node.run');
      return n.project_id;
    });
    const key = idempotencyKey && /^[\w-]{8,100}$/.test(idempotencyKey) ? idempotencyKey : undefined;
    const submit = () => this.d.engine.submit({ projectId, nodeId, operation: input.operation, requestedBy: user.id, force: input.force, idempotencyKey: key });
    try {
      return await submit();
    } catch (e) {
      // Lost a race with an identical request: the retry finds and returns that job.
      if (e instanceof DuplicateJobError) return submit();
      throw e;
    }
  }

  async getJob(user: Profile, jobId: string) {
    if (!uuid.safeParse(jobId).success) throw notFound('Job not found');
    const row = await this.db.asUser(user.id, async (q) => (await q.query('select * from public.generation_jobs where id = $1', [jobId]))[0]);
    if (!row) throw notFound('Job not found');
    return toJob(row);
  }

  async cancelJob(user: Profile, jobId: string) {
    const job = await this.getJob(user, jobId);
    await this.db.asUser(user.id, (q) => this.require(q, job.projectId, 'job.cancel'));
    return this.d.engine.cancel(jobId);
  }

  async createExport(user: Profile, projectId: string, body: unknown, idempotencyKey?: string): Promise<SubmitResult> {
    const { nodeId } = z.object({ nodeId: uuid.optional() }).parse(body ?? {});
    const target = await this.db.asUser(user.id, async (q) => {
      await this.require(q, projectId, 'export.create');
      const rows = await q.query<{ id: string }>(
        `select id from public.nodes where project_id = $1 and type = 'export' and ($2::uuid is null or id = $2) order by created_at limit 1`,
        [projectId, nodeId ?? null],
      );
      return rows[0]?.id;
    });
    if (!target) throw bad('Add an Export node to this project first.', 'no_export_node');
    return this.runNode(user, target, { operation: 'export' }, idempotencyKey);
  }

  async getExport(user: Profile, jobId: string) {
    const job = await this.getJob(user, jobId);
    if (job.nodeType !== 'export') throw notFound('Export not found');
    const assetId = job.outputAssetIds[0];
    const link = job.status === 'succeeded' && assetId ? await this.assetUrl(user, assetId, { download: true }) : null;
    return { job, assetId: assetId ?? null, url: link?.url ?? null, expiresAt: link?.expiresAt ?? null };
  }

  // ---------------------------------------------------------------- review

  async addComment(user: Profile, target: { projectId?: string; assetId?: string }, body: unknown) {
    const input = CommentBody.parse(body);
    return this.db.asUser(user.id, async (q) => {
      let projectId = target.projectId;
      if (target.assetId) {
        if (!uuid.safeParse(target.assetId).success) throw notFound('Asset not found');
        const [a] = await q.query<{ project_id: string }>('select project_id from public.assets where id = $1', [target.assetId]);
        if (!a) throw notFound('Asset not found');
        projectId = a.project_id;
      }
      if (!projectId) throw bad('Missing project');
      await this.require(q, projectId, 'comment.create');
      if (input.nodeId) {
        const n = await q.query('select 1 from public.nodes where id = $1 and project_id = $2', [input.nodeId, projectId]);
        if (!n.length) throw bad('That node is not in this project.');
      }
      const [row] = await q.query(
        `insert into public.comments (project_id, asset_id, node_id, author_id, body) values ($1, $2, $3, $4, $5) returning *`,
        [projectId, target.assetId ?? null, input.nodeId ?? null, user.id, input.body],
      );
      await this.activity(q, user, projectId, 'comment.create', target.assetId ? 'asset' : 'node', target.assetId ?? input.nodeId ?? projectId, {
        preview: input.body.slice(0, 80),
      });
      return { ...toComment(row!), authorName: user.displayName };
    });
  }

  async resolveComment(user: Profile, commentId: string, body: unknown) {
    const { resolved } = z.object({ resolved: z.boolean() }).parse(body);
    if (!uuid.safeParse(commentId).success) throw notFound('Comment not found');
    return this.db.asUser(user.id, async (q) => {
      const [c] = await q.query<{ project_id: string }>('select project_id from public.comments where id = $1', [commentId]);
      if (!c) throw notFound('Comment not found');
      await this.require(q, c.project_id, 'comment.resolve');
      const [row] = await q.query('update public.comments set resolved = $2 where id = $1 returning *', [commentId, resolved]);
      return toComment(row!);
    });
  }

  async recordApproval(user: Profile, assetId: string, body: unknown) {
    const input = ApprovalBody.parse(body);
    if (!uuid.safeParse(assetId).success) throw notFound('Asset not found');
    return this.db.asUser(user.id, async (q) => {
      const [row] = await q.query('select * from public.assets where id = $1', [assetId]);
      if (!row) throw notFound('Asset not found');
      const asset = toAsset(row);
      const role = await this.require(q, asset.projectId, 'approval.create');
      if (asset.sourceType !== 'ai_generated') throw bad('Only generated concepts, poses and edits can be approved.', 'not_reviewable');
      if (input.decision === 'changes_requested' && !input.comment) throw bad('Tell us what to change.', 'comment_required');
      const [a] = await q.query(
        `insert into public.approvals (project_id, asset_id, asset_version, reviewer_id, reviewer_role, decision, comment)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [asset.projectId, asset.id, asset.version, user.id, role, input.decision as ApprovalDecision, input.comment || null],
      );
      await this.activity(q, user, asset.projectId, `approval.${input.decision}`, 'asset', asset.id, { label: asset.label, version: asset.version });
      return { ...toApproval(a!), reviewerName: user.displayName };
    });
  }

  // ---------------------------------------------------------------- members & invitations

  async createInvitation(user: Profile, projectId: string, body: unknown): Promise<Invitation> {
    const input = InviteBody.parse(body);
    return this.db.asUser(user.id, async (q) => {
      await this.require(q, projectId, 'member.manage');
      const member = await q.query(
        `select 1 from public.project_members m join public.profiles p on p.id = m.user_id where m.project_id = $1 and lower(p.email) = $2`,
        [projectId, input.email],
      );
      if (member.length) throw bad(`${input.email} already has access to this project.`, 'already_member');
      // Re-inviting replaces any earlier pending link for the same address.
      await q.query(`update public.project_invitations set status = 'revoked' where project_id = $1 and lower(email) = $2 and status = 'pending'`, [projectId, input.email]);
      const token = randomBytes(32).toString('base64url');
      const [row] = await q.query(
        `insert into public.project_invitations (project_id, email, role, token, created_by) values ($1, $2, $3, $4, $5) returning *`,
        [projectId, input.email, input.role, token, user.id],
      );
      await this.activity(q, user, projectId, 'member.invite', 'invitation', String(row!.id), { email: input.email, role: input.role });
      return toInvitation(row!);
    });
  }

  async revokeInvitation(user: Profile, invitationId: string): Promise<void> {
    if (!uuid.safeParse(invitationId).success) throw notFound('Invitation not found');
    await this.db.asUser(user.id, async (q) => {
      const rows = await q.query(`update public.project_invitations set status = 'revoked' where id = $1 and status = 'pending' returning id`, [invitationId]);
      if (!rows.length) throw notFound('Invitation not found');
    });
  }

  async previewInvitation(token: string) {
    if (!/^[\w-]{32,100}$/.test(token)) throw notFound('This invitation link is not valid.');
    const rows = await this.db.query('select * from public.preview_invitation($1)', [token]);
    const r = rows[0];
    if (!r) throw notFound('This invitation link is not valid.');
    return { projectName: String(r.project_name), client: String(r.client), role: r.role as Role, email: String(r.email), status: r.status as Invitation['status'] };
  }

  async acceptInvitation(user: Profile, token: string): Promise<{ projectId: string; role: Role }> {
    if (!/^[\w-]{32,100}$/.test(token)) throw notFound('This invitation link is not valid.');
    return this.db.asUser(user.id, async (q) => {
      const [r] = await q.query<{ project_id: string; role: Role }>('select * from public.accept_invitation($1)', [token]);
      return { projectId: r!.project_id, role: r!.role };
    });
  }

  async updateMemberRole(user: Profile, memberId: string, body: unknown): Promise<void> {
    const { role } = RoleBody.parse(body);
    await this.memberChange(user, memberId, (q) => q.query(`update public.project_members set role = $2 where id = $1 and role <> 'owner' returning id`, [memberId, role]));
  }

  async removeMember(user: Profile, memberId: string): Promise<void> {
    await this.memberChange(user, memberId, (q) => q.query(`delete from public.project_members where id = $1 and role <> 'owner' returning id`, [memberId]));
  }

  private async memberChange(user: Profile, memberId: string, change: (q: Queryable) => Promise<unknown[]>) {
    if (!uuid.safeParse(memberId).success) throw notFound('Member not found');
    await this.db.asUser(user.id, async (q) => {
      const [m] = await q.query<{ project_id: string; role: string }>('select project_id, role from public.project_members where id = $1', [memberId]);
      if (!m) throw notFound('Member not found');
      await this.require(q, m.project_id, 'member.manage');
      if (m.role === 'owner') throw bad("The owner's access can't be changed.", 'owner');
      const rows = await change(q);
      if (!rows.length) throw notFound('Member not found');
    });
  }

  // ---------------------------------------------------------------- export metadata (worker)

  async exportMeta(projectId: string) {
    return this.db.service(async (q) => {
      const [p] = await q.query('select * from public.projects where id = $1', [projectId]);
      if (!p) throw notFound('Project not found');
      const people = await q.query(
        `select pr.* from public.profiles pr join public.project_members m on m.user_id = pr.id where m.project_id = $1
         union select pr.* from public.profiles pr join public.approvals a on a.reviewer_id = pr.id where a.project_id = $1`,
        [projectId],
      );
      return { project: toProject(p), names: Object.fromEntries(people.map((r) => [String(r.id), toProfile(r).displayName])) };
    });
  }
}

export { isUniqueViolation };
