/**
 * Domain types shared by the frontend, the local backend, tests and the
 * Supabase edge functions. Mirrors supabase/migrations/*.sql.
 *
 * Three kinds of state are kept apart on purpose:
 *  - visual state      → GraphNode.position / size
 *  - creative config   → GraphNode.data (validated per node type)
 *  - execution state   → GenerationJob / NodeRun records (never stored on the node)
 */

export type Role = 'owner' | 'editor' | 'reviewer' | 'viewer';

export interface Profile {
  id: string;
  email: string;
  displayName: string;
}

export type ProjectStatus = 'draft' | 'in_review' | 'approved' | 'archived';

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  client: string;
  status: ProjectStatus;
  graphRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: Role;
  createdAt: string;
  /** Joined for display only. */
  email?: string;
  displayName?: string;
}

export interface Invitation {
  id: string;
  projectId: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  token: string;
  status: 'pending' | 'accepted' | 'revoked';
  createdBy: string;
  createdAt: string;
  acceptedAt?: string;
}

export interface XY {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  projectId: string;
  type: NodeType;
  schemaVersion: number;
  position: XY;
  size?: { width: number; height: number };
  data: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  projectId: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export const NODE_TYPES = [
  'brief',
  'image_asset',
  'reference_analysis',
  'text',
  'concept_generator',
  'pose_generator',
  'image_edit',
  'shot_planner',
  'approval',
  'export',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** What an image *is*. Drives the fidelity labelling everywhere in the UI and PDF. */
export type AssetRole = 'product' | 'brand' | 'reference' | 'concept' | 'pose' | 'edit' | 'export';
/** Where an image came from. `upload` = real photograph/file, `ai_generated` = never a fact about the product. */
export type AssetSource = 'upload' | 'ai_generated' | 'export';

export interface Asset {
  id: string;
  projectId: string;
  storageKey: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  role: AssetRole;
  sourceType: AssetSource;
  /** Provenance: the asset this one was derived from (edit source, pose source…). */
  parentAssetId: string | null;
  /** Versioning: the root of the revision chain this asset belongs to (self for v1). */
  versionOf: string | null;
  version: number;
  nodeId: string | null;
  jobId: string | null;
  label: string | null;
  prompt: string | null;
  originalFilename: string | null;
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  estCostUsd?: number;
}

export interface GenerationJob {
  id: string;
  projectId: string;
  nodeId: string;
  nodeType: NodeType;
  operation: string;
  status: JobStatus;
  provider: string;
  model: string;
  inputSnapshot: unknown;
  inputHash: string;
  promptVersion: string;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  error: JobError | null;
  outputAssetIds: string[];
  usage: UsageInfo | null;
  requestedBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface NodeRun {
  id: string;
  jobId: string;
  projectId: string;
  nodeId: string;
  operation: string;
  inputHash: string;
  outputAssetIds: string[];
  output: unknown;
  completedAt: string;
}

export interface Comment {
  id: string;
  projectId: string;
  assetId: string | null;
  nodeId: string | null;
  authorId: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  authorName?: string;
}

export type ApprovalDecision = 'approved' | 'changes_requested';

export interface Approval {
  id: string;
  projectId: string;
  assetId: string;
  assetVersion: number;
  reviewerId: string;
  decision: ApprovalDecision;
  comment: string | null;
  createdAt: string;
  reviewerName?: string;
}

export interface ActivityEvent {
  id: string;
  projectId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
  actorName?: string;
}

/** Everything the editor or review screen needs for one project. */
export interface ProjectBundle {
  project: Project;
  myRole: Role;
  nodes: GraphNode[];
  edges: GraphEdge[];
  assets: Asset[];
  jobs: GenerationJob[];
  runs: NodeRun[];
  comments: Comment[];
  approvals: Approval[];
  activity: ActivityEvent[];
  members: ProjectMember[];
  invitations: Invitation[];
}
