import { createContext, useContext } from 'react';
import type { GenerationJob, GraphNode, ProjectBundle } from '@/core/types';
import { opStatus, type GraphContext, type OpStatus } from '@/core/graph';
import { getNodeDef } from '@/core/nodeRegistry';
import type { GraphEditor } from './useGraphEditor';

export type NodeRunState = 'idle' | 'never_run' | 'queued' | 'running' | 'failed' | 'stale' | 'fresh';

export interface NodeStatus {
  state: NodeRunState;
  ops: Record<string, OpStatus & { job?: GenerationJob }>;
  activeJob?: GenerationJob;
  lastError?: string;
}

export interface EditorCtx {
  bundle: ProjectBundle;
  editor: GraphEditor;
  ctx: GraphContext;
  statuses: Record<string, NodeStatus>;
  selectedId: string | null;
  select: (id: string | null) => void;
  runOp: (nodeId: string, op: string, opts?: { force?: boolean }) => Promise<void>;
  canEdit: boolean;
  userId: string;
}

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const c = useContext(EditorContext);
  if (!c) throw new Error('EditorContext missing');
  return c;
}

export function computeStatuses(ctx: GraphContext, jobs: GenerationJob[]): Record<string, NodeStatus> {
  const out: Record<string, NodeStatus> = {};
  for (const node of ctx.nodes) out[node.id] = statusFor(ctx, jobs, node);
  return out;
}

function statusFor(ctx: GraphContext, jobs: GenerationJob[], node: GraphNode): NodeStatus {
  const def = getNodeDef(node.type);
  const ops: NodeStatus['ops'] = {};
  let activeJob: GenerationJob | undefined;
  let failed: string | undefined;
  let anyStale = false;
  let anyFresh = false;
  let anyNever = false;
  for (const op of def.operations) {
    let s: OpStatus;
    try {
      s = opStatus(ctx, node.id, op.id);
    } catch {
      continue;
    }
    const opJobs = jobs.filter((j) => j.nodeId === node.id && j.operation === op.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const latest = opJobs[0];
    ops[op.id] = { ...s, job: latest };
    if (latest && (latest.status === 'queued' || latest.status === 'running')) activeJob = latest;
    if (latest?.status === 'failed' && (!s.activeRun || latest.createdAt > s.activeRun.completedAt)) failed = latest.error?.message ?? 'Failed';
    if (op.kind === 'ai' || op.id === 'export') {
      if (s.freshness === 'stale') anyStale = true;
      if (s.freshness === 'fresh') anyFresh = true;
      if (s.freshness === 'never_run') anyNever = true;
    }
  }
  let state: NodeRunState = 'idle';
  if (activeJob) state = activeJob.status === 'running' ? 'running' : 'queued';
  else if (failed) state = 'failed';
  else if (anyStale) state = 'stale';
  else if (anyFresh) state = 'fresh';
  else if (anyNever) state = 'never_run';
  return { state, ops, activeJob, lastError: failed };
}
