import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApprovalDecision, Asset, Comment, GraphEdge, GraphNode, Invitation, Profile, Project, ProjectBundle, Role } from '@/core/types';
import { SubmitError, type SubmitResult } from '@/core/jobEngine';
import { ConflictError, NotFoundError, type CreateProjectInput, type ProjectSummary, type RepoEvent, type Repository } from '../repository';

interface ServerConfig {
  mode: 'server';
  authMode: 'dev' | 'supabase';
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  providerLabel: string;
  limits: { maxUploadMb: number; maxJobsPerUserPerDay: number };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'imaginarium.devToken';
const SUBMIT_CODES = new Set(['missing_inputs', 'not_ready', 'usage_limit', 'unknown_op']);

function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k: string, v: string | null) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* private mode: session-only */
  }
}

/**
 * Talks to the Imaginarium API (server/app.ts). Auth is either the server's
 * dev login (email only, local development) or Supabase Auth, whose access
 * token is sent as a bearer token. Live updates come from polling a cheap
 * change token per project.
 */
export class ApiRepository implements Repository {
  readonly mode = 'server' as const;
  readonly authMode: 'dev' | 'supabase';
  readonly providerLabel: string;
  readonly limits: ServerConfig['limits'];
  private readonly base: string;
  private token: string | null = null;
  private sb: SupabaseClient | null = null;
  private readonly urlCache = new Map<string, { url: string; until: number }>();
  private readonly listeners = new Map<string, Set<(e: RepoEvent) => void>>();
  private readonly pollers = new Map<string, () => void>();
  listLocalProfiles?: () => Promise<Profile[]>;

  private constructor(base: string, cfg: ServerConfig) {
    this.base = base.replace(/\/$/, '');
    this.authMode = cfg.authMode;
    this.providerLabel = cfg.providerLabel;
    this.limits = cfg.limits;
    if (cfg.authMode === 'dev') this.listLocalProfiles = () => this.req<Profile[]>('GET', '/api/auth/dev-profiles', undefined, { anonymous: true });
  }

  static async connect(base: string): Promise<ApiRepository> {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/config`);
    if (!res.ok) throw new Error(`Could not reach the Imaginarium API (${res.status}). Is the server running?`);
    const cfg = (await res.json()) as ServerConfig;
    const repo = new ApiRepository(base, cfg);
    if (cfg.authMode === 'supabase') {
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error('Server is in Supabase auth mode but SUPABASE_ANON_KEY is not set.');
      const { createClient } = await import('@supabase/supabase-js');
      repo.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
      const { data } = await repo.sb.auth.getSession();
      repo.token = data.session?.access_token ?? null;
      repo.sb.auth.onAuthStateChange((_e, session) => {
        repo.token = session?.access_token ?? null;
      });
    } else {
      repo.token = storageGet(TOKEN_KEY);
    }
    return repo;
  }

  // ------------------------------------------------------------ http

  private abs(url: string): string {
    return /^https?:\/\//.test(url) ? url : `${this.base}${url}`;
  }

  private async req<T>(method: string, path: string, body?: unknown, opts: { anonymous?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token && !opts.anonymous) headers.Authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(this.abs(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Error('Network error: the server could not be reached.');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const message = String(data.error ?? res.statusText);
      const code = String(data.code ?? 'error');
      if (res.status === 409 && code === 'conflict' && typeof data.serverRevision === 'number') throw new ConflictError(data.serverRevision);
      if (res.status === 404) throw new NotFoundError(message);
      if (SUBMIT_CODES.has(code)) throw new SubmitError(code as SubmitError['code'], message);
      throw new ApiError(res.status, message, code);
    }
    return data as T;
  }

  // ------------------------------------------------------------ events (polling)

  private emit(projectId: string, kind: RepoEvent['kind'] = 'project') {
    for (const key of [projectId, '*']) this.listeners.get(key)?.forEach((cb) => cb({ projectId, kind }));
  }

  subscribe(projectId: string, cb: (e: RepoEvent) => void): () => void {
    const set = this.listeners.get(projectId) ?? new Set();
    set.add(cb);
    this.listeners.set(projectId, set);
    if (!this.pollers.has(projectId)) this.pollers.set(projectId, this.startPolling(projectId));
    return () => {
      set.delete(cb);
      if (!set.size) {
        this.listeners.delete(projectId);
        this.pollers.get(projectId)?.();
        this.pollers.delete(projectId);
      }
    };
  }

  private startPolling(projectId: string): () => void {
    let last: string | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        try {
          if (projectId === '*') {
            if (last !== null) this.emit('*');
            last = 'x';
          } else {
            const { token } = await this.req<{ token: string }>('GET', `/api/projects/${projectId}/changes`);
            if (last !== null && token !== last) this.emit(projectId);
            last = token;
          }
        } catch {
          /* transient: try again next tick */
        }
      }
      timer = setTimeout(tick, projectId === '*' ? 20_000 : 2000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  // ------------------------------------------------------------ auth

  async currentUser(): Promise<Profile | null> {
    if (this.sb) {
      const { data } = await this.sb.auth.getSession();
      this.token = data.session?.access_token ?? null;
    }
    if (!this.token) return null;
    try {
      return await this.req<Profile>('GET', '/api/me');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (!this.sb) storageSet(TOKEN_KEY, null);
        this.token = null;
        return null;
      }
      throw e;
    }
  }

  async signIn(email: string, password?: string): Promise<Profile> {
    if (this.sb) {
      const { data, error } = await this.sb.auth.signInWithPassword({ email, password: password ?? '' });
      if (error) throw new Error(error.message);
      this.token = data.session?.access_token ?? null;
      return this.req<Profile>('GET', '/api/me');
    }
    const r = await this.req<{ token: string; user: Profile }>('POST', '/api/auth/dev-login', { email }, { anonymous: true });
    this.token = r.token;
    storageSet(TOKEN_KEY, r.token);
    return r.user;
  }

  async signUp(email: string, password: string, displayName: string): Promise<Profile | null> {
    if (!this.sb) {
      const r = await this.req<{ token: string; user: Profile }>('POST', '/api/auth/dev-login', { email, displayName }, { anonymous: true });
      this.token = r.token;
      storageSet(TOKEN_KEY, r.token);
      return r.user;
    }
    const { data, error } = await this.sb.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName }, emailRedirectTo: window.location.href },
    });
    if (error) throw new Error(error.message);
    if (!data.session) return null; // email confirmation required
    this.token = data.session.access_token;
    return this.req<Profile>('GET', '/api/me');
  }

  async signOut(): Promise<void> {
    if (this.sb) await this.sb.auth.signOut();
    else storageSet(TOKEN_KEY, null);
    this.token = null;
    this.urlCache.clear();
  }

  // ------------------------------------------------------------ projects & graph

  listProjects(): Promise<ProjectSummary[]> {
    return this.req('GET', '/api/projects');
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const p = await this.req<Project>('POST', '/api/projects', input);
    this.emit('*');
    return p;
  }

  async updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'client' | 'status'>>): Promise<Project> {
    const p = await this.req<Project>('PATCH', `/api/projects/${id}`, patch);
    this.emit(id);
    return p;
  }

  async deleteProject(id: string): Promise<void> {
    await this.req('DELETE', `/api/projects/${id}`);
    this.emit('*');
  }

  loadProject(id: string): Promise<ProjectBundle> {
    return this.req('GET', `/api/projects/${id}`);
  }

  async saveGraph(projectId: string, graph: { nodes: GraphNode[]; edges: GraphEdge[] }, baseRevision: number): Promise<{ revision: number }> {
    const r = await this.req<{ revision: number }>('PUT', `/api/projects/${projectId}/graph`, {
      baseRevision,
      nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, schemaVersion: n.schemaVersion, position: n.position, size: n.size ?? null, data: n.data })),
      edges: graph.edges.map((e) => ({ id: e.id, source: e.source, sourcePort: e.sourcePort, target: e.target, targetPort: e.targetPort })),
    });
    this.emit(projectId, 'graph');
    return r;
  }

  // ------------------------------------------------------------ assets

  async uploadAsset(projectId: string, file: Blob, meta: { role: 'product' | 'brand' | 'reference'; filename: string; nodeId?: string }): Promise<Asset> {
    const { upload, uploadToken } = await this.req<{ upload: { url: string; method: 'PUT'; headers: Record<string, string> }; uploadToken: string }>(
      'POST',
      `/api/projects/${projectId}/assets/upload-url`,
      { filename: meta.filename, contentType: file.type, size: file.size, role: meta.role, nodeId: meta.nodeId },
    );
    const put = await fetch(this.abs(upload.url), { method: upload.method, headers: upload.headers, body: file });
    if (!put.ok) throw new Error(`${meta.filename}: upload failed (${put.status}).`);
    const asset = await this.req<Asset>('POST', `/api/projects/${projectId}/assets`, { uploadToken });
    this.emit(projectId, 'assets');
    return asset;
  }

  async assetUrl(asset: Asset, opts: { download?: boolean; thumb?: boolean } = {}): Promise<string> {
    const key = `${asset.id}:${opts.download ? 'd' : opts.thumb ? 't' : 'f'}`;
    const hit = this.urlCache.get(key);
    if (hit && hit.until > Date.now()) return hit.url;
    const q = new URLSearchParams();
    if (opts.download) q.set('download', '1');
    if (opts.thumb) q.set('variant', 'thumb');
    const r = await this.req<{ url: string; expiresAt: string }>('GET', `/api/assets/${asset.id}/url${q.size ? `?${q}` : ''}`);
    const url = this.abs(r.url);
    this.urlCache.set(key, { url, until: Date.parse(r.expiresAt) - 60_000 });
    return url;
  }

  async assetBytes(asset: Asset): Promise<Uint8Array> {
    const res = await fetch(await this.assetUrl(asset));
    if (!res.ok) throw new Error('Could not download the file.');
    return new Uint8Array(await res.arrayBuffer());
  }

  // ------------------------------------------------------------ jobs

  async runNode(projectId: string, nodeId: string, operation: string, opts: { force?: boolean; idempotencyKey: string }): Promise<SubmitResult> {
    const r = await this.req<SubmitResult>('POST', `/api/nodes/${nodeId}/run`, { operation, force: !!opts.force }, { headers: { 'Idempotency-Key': opts.idempotencyKey } });
    this.emit(projectId, 'jobs');
    return r;
  }

  async cancelJob(jobId: string): Promise<void> {
    const job = await this.req<{ projectId: string }>('POST', `/api/jobs/${jobId}/cancel`);
    if (job?.projectId) this.emit(job.projectId, 'jobs');
  }

  // ------------------------------------------------------------ review

  async addComment(projectId: string, input: { assetId?: string | null; nodeId?: string | null; body: string }): Promise<Comment> {
    const c = input.assetId
      ? await this.req<Comment>('POST', `/api/assets/${input.assetId}/comments`, { body: input.body })
      : await this.req<Comment>('POST', `/api/projects/${projectId}/comments`, { body: input.body, nodeId: input.nodeId ?? undefined });
    this.emit(projectId, 'comments');
    return c;
  }

  async resolveComment(commentId: string, resolved: boolean): Promise<void> {
    const c = await this.req<Comment>('PATCH', `/api/comments/${commentId}`, { resolved });
    this.emit(c.projectId, 'comments');
  }

  async recordApproval(projectId: string, assetId: string, decision: ApprovalDecision, comment?: string): Promise<void> {
    await this.req('POST', `/api/assets/${assetId}/approvals`, { decision, comment: comment?.trim() || undefined });
    this.emit(projectId, 'approvals');
  }

  // ------------------------------------------------------------ members

  async createInvitation(projectId: string, email: string, role: Exclude<Role, 'owner'>): Promise<Invitation> {
    const inv = await this.req<Invitation>('POST', `/api/projects/${projectId}/invitations`, { email, role });
    this.emit(projectId, 'members');
    return inv;
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    await this.req('DELETE', `/api/invitations/${invitationId}`);
    this.listeners.forEach((_, k) => this.emit(k, 'members'));
  }

  previewInvitation(token: string) {
    return this.req<{ projectName: string; client: string; role: Role; email: string; status: Invitation['status'] }>('GET', `/api/invitations/${token}`, undefined, {
      anonymous: true,
    });
  }

  async acceptInvitation(token: string): Promise<{ projectId: string; role: Role }> {
    const r = await this.req<{ projectId: string; role: Role }>('POST', `/api/invitations/${token}/accept`);
    this.emit('*');
    return r;
  }

  async updateMemberRole(memberId: string, role: Exclude<Role, 'owner'>): Promise<void> {
    await this.req('PATCH', `/api/members/${memberId}`, { role });
    this.listeners.forEach((_, k) => this.emit(k, 'members'));
  }

  async removeMember(memberId: string): Promise<void> {
    await this.req('DELETE', `/api/members/${memberId}`);
    this.listeners.forEach((_, k) => this.emit(k, 'members'));
  }
}
