import type {
  ApprovalDecision,
  Asset,
  Comment,
  GraphEdge,
  GraphNode,
  Invitation,
  Profile,
  Project,
  ProjectBundle,
  Role,
} from '@/core/types';
import type { SubmitResult } from '@/core/jobEngine';
import type { Brief } from '@/core/schemas';

export interface ProjectSummary {
  project: Project;
  myRole: Role;
  coverAsset: Asset | null;
  nodeCount: number;
  pendingReviews: number;
}

export type RepoEventKind = 'project' | 'graph' | 'jobs' | 'assets' | 'comments' | 'approvals' | 'members' | 'activity';
export interface RepoEvent {
  projectId: string;
  kind: RepoEventKind;
}

export class ConflictError extends Error {
  readonly serverRevision: number;
  constructor(serverRevision: number) {
    super('Someone else saved this project since you loaded it.');
    this.name = 'ConflictError';
    this.serverRevision = serverRevision;
  }
}

export class NotFoundError extends Error {
  constructor(what = 'Not found') {
    super(what);
    this.name = 'NotFoundError';
  }
}

export interface CreateProjectInput {
  name: string;
  client: string;
  template: 'campaign' | 'blank';
  brief?: Partial<Brief>;
}


export interface Repository {
  readonly mode: 'local' | 'server';
  /** How people sign in: browser-local profiles, server dev login (email only), or Supabase Auth. */
  readonly authMode: 'local' | 'dev' | 'supabase';
  /** Human label for the AI backend, shown in the UI so mock output is never mistaken for real. */
  readonly providerLabel: string;

  currentUser(): Promise<Profile | null>;
  signIn(email: string, password?: string): Promise<Profile>;
  signUp?(email: string, password: string, displayName: string): Promise<Profile | null>;
  signOut(): Promise<void>;
  /** Local mode only: quick account switcher for testing the client experience. */
  listLocalProfiles?(): Promise<Profile[]>;

  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'client' | 'status'>>): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  loadProject(id: string): Promise<ProjectBundle>;

  /** Optimistic concurrency: rejects with ConflictError unless baseRevision matches. */
  saveGraph(projectId: string, graph: { nodes: GraphNode[]; edges: GraphEdge[] }, baseRevision: number): Promise<{ revision: number }>;

  uploadAsset(projectId: string, file: Blob, meta: { role: 'product' | 'brand' | 'reference'; filename: string; nodeId?: string }): Promise<Asset>;
  /** A short-lived URL for displaying (or, with `download`, saving) an asset. */
  assetUrl(asset: Asset, opts?: { download?: boolean }): Promise<string>;
  assetBytes(asset: Asset): Promise<Uint8Array>;

  runNode(projectId: string, nodeId: string, operation: string, opts: { force?: boolean; idempotencyKey: string }): Promise<SubmitResult>;
  cancelJob(jobId: string): Promise<void>;

  addComment(projectId: string, input: { assetId?: string | null; nodeId?: string | null; body: string }): Promise<Comment>;
  resolveComment(commentId: string, resolved: boolean): Promise<void>;
  recordApproval(projectId: string, assetId: string, decision: ApprovalDecision, comment?: string): Promise<void>;

  createInvitation(projectId: string, email: string, role: Exclude<Role, 'owner'>): Promise<Invitation>;
  revokeInvitation(invitationId: string): Promise<void>;
  previewInvitation(token: string): Promise<{ projectName: string; client: string; role: Role; email: string; status: Invitation['status'] }>;
  acceptInvitation(token: string): Promise<{ projectId: string; role: Role }>;
  updateMemberRole(memberId: string, role: Exclude<Role, 'owner'>): Promise<void>;
  removeMember(memberId: string): Promise<void>;

  subscribe(projectId: string, cb: (e: RepoEvent) => void): () => void;
}
