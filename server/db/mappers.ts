import type {
  ActivityEvent,
  Approval,
  Asset,
  Comment,
  GenerationJob,
  GraphEdge,
  GraphNode,
  Invitation,
  NodeRun,
  Profile,
  Project,
  ProjectMember,
} from '../../src/core/types';
import type { Row } from './index';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const str = (v: unknown): string => (v == null ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const json = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

export const toProfile = (r: Row): Profile => ({ id: str(r.id), email: str(r.email), displayName: str(r.display_name) || str(r.email).split('@')[0]! });

export const toProject = (r: Row): Project => ({
  id: str(r.id),
  ownerId: str(r.owner_id),
  name: str(r.name),
  client: str(r.client),
  status: r.status as Project['status'],
  graphRevision: num(r.graph_revision),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toMember = (r: Row): ProjectMember => ({
  id: str(r.id),
  projectId: str(r.project_id),
  userId: str(r.user_id),
  role: r.role as ProjectMember['role'],
  createdAt: iso(r.created_at),
  email: r.email == null ? undefined : str(r.email),
  displayName: r.display_name == null ? undefined : str(r.display_name),
});

export const toInvitation = (r: Row): Invitation => ({
  id: str(r.id),
  projectId: str(r.project_id),
  email: str(r.email),
  role: r.role as Invitation['role'],
  token: str(r.token),
  status: r.status as Invitation['status'],
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
  acceptedAt: r.accepted_at == null ? undefined : iso(r.accepted_at),
});

export const toNode = (r: Row): GraphNode => ({
  id: str(r.id),
  projectId: str(r.project_id),
  type: r.type as GraphNode['type'],
  schemaVersion: num(r.schema_version),
  position: json(r.position, { x: 0, y: 0 }),
  size: json<GraphNode['size']>(r.size, undefined),
  data: json(r.data, {}),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toEdge = (r: Row): GraphEdge => ({
  id: str(r.id),
  projectId: str(r.project_id),
  source: str(r.source_node_id),
  sourcePort: str(r.source_port),
  target: str(r.target_node_id),
  targetPort: str(r.target_port),
});

export const toAsset = (r: Row): Asset & { thumbKey?: string | null } => ({
  id: str(r.id),
  projectId: str(r.project_id),
  storageKey: str(r.storage_key),
  thumbKey: strOrNull(r.thumb_key),
  mimeType: str(r.mime_type),
  width: r.width == null ? null : num(r.width),
  height: r.height == null ? null : num(r.height),
  sizeBytes: num(r.size_bytes),
  role: r.role as Asset['role'],
  sourceType: r.source_type as Asset['sourceType'],
  parentAssetId: strOrNull(r.parent_asset_id),
  versionOf: strOrNull(r.version_of),
  version: num(r.version),
  nodeId: strOrNull(r.node_id),
  jobId: strOrNull(r.job_id),
  label: strOrNull(r.label),
  prompt: strOrNull(r.prompt),
  originalFilename: strOrNull(r.original_filename),
  contentHash: str(r.content_hash),
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
});

export const toJob = (r: Row): GenerationJob => ({
  id: str(r.id),
  projectId: str(r.project_id),
  nodeId: str(r.node_id),
  nodeType: r.node_type as GenerationJob['nodeType'],
  operation: str(r.operation),
  status: r.status as GenerationJob['status'],
  provider: str(r.provider),
  model: str(r.model),
  inputSnapshot: json(r.input_snapshot, {}),
  inputHash: str(r.input_hash),
  promptVersion: str(r.prompt_version),
  idempotencyKey: str(r.idempotency_key),
  attempts: num(r.attempts),
  maxAttempts: num(r.max_attempts),
  error: json(r.error, null),
  outputAssetIds: json(r.output_asset_ids, []),
  usage: json(r.usage, null),
  requestedBy: str(r.requested_by),
  cancelRequested: !!r.cancel_requested,
  createdAt: iso(r.created_at),
  startedAt: isoOrNull(r.started_at),
  finishedAt: isoOrNull(r.finished_at),
  updatedAt: iso(r.updated_at),
});

export const toRun = (r: Row): NodeRun => ({
  id: str(r.id),
  jobId: str(r.job_id),
  projectId: str(r.project_id),
  nodeId: str(r.node_id),
  operation: str(r.operation),
  inputHash: str(r.input_hash),
  outputAssetIds: json(r.output_asset_ids, []),
  output: json(r.output, null),
  completedAt: iso(r.completed_at),
});

export const toComment = (r: Row): Comment => ({
  id: str(r.id),
  projectId: str(r.project_id),
  assetId: strOrNull(r.asset_id),
  nodeId: strOrNull(r.node_id),
  authorId: str(r.author_id),
  body: str(r.body),
  resolved: !!r.resolved,
  createdAt: iso(r.created_at),
  authorName: r.author_name == null ? undefined : str(r.author_name),
});

export const toApproval = (r: Row): Approval => ({
  id: str(r.id),
  projectId: str(r.project_id),
  assetId: str(r.asset_id),
  assetVersion: num(r.asset_version),
  reviewerId: str(r.reviewer_id),
  decision: r.decision as Approval['decision'],
  comment: strOrNull(r.comment),
  createdAt: iso(r.created_at),
  reviewerName: r.reviewer_name == null ? undefined : str(r.reviewer_name),
});

export const toActivity = (r: Row): ActivityEvent => ({
  id: str(r.id),
  projectId: str(r.project_id),
  actorId: str(r.actor_id),
  action: str(r.action),
  entityType: str(r.entity_type),
  entityId: str(r.entity_id),
  meta: json(r.meta, null),
  createdAt: iso(r.created_at),
  actorName: r.actor_name == null ? undefined : str(r.actor_name),
});
