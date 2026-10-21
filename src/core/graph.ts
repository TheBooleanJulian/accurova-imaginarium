import type { Approval, Asset, AssetRole, AssetSource, GraphEdge, GraphNode, NodeRun, NodeType } from './types';
import { findPort, getNodeDef, getOperation, NODE_DEFS, type PortType } from './nodeRegistry';
import { BriefSchema, type Brief, type Direction, type DirectionsOutput, type ReferenceAnalysis, type ShotPlan } from './schemas';
import { hashValue } from './hash';

// ---------------------------------------------------------------- connections

export interface ConnectionRequest {
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
}

export type ConnectionCheck = { ok: true } | { ok: false; reason: string };

export function isTypeCompatible(out: PortType, input: PortType): boolean {
  return out === input;
}

/** True if adding source→target would close a loop (target can already reach source). */
export function wouldCreateCycle(edges: Pick<GraphEdge, 'source' | 'target'>[], source: string, target: string): boolean {
  if (source === target) return true;
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.source) ?? [];
    list.push(e.target);
    out.set(e.source, list);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of out.get(id) ?? []) stack.push(next);
  }
  return false;
}

export function validateConnection(
  nodes: Pick<GraphNode, 'id' | 'type'>[],
  edges: GraphEdge[],
  c: ConnectionRequest,
): ConnectionCheck {
  const src = nodes.find((n) => n.id === c.source);
  const dst = nodes.find((n) => n.id === c.target);
  if (!src || !dst) return { ok: false, reason: 'Both nodes must exist.' };
  const outPort = findPort(src.type, 'out', c.sourcePort);
  const inPort = findPort(dst.type, 'in', c.targetPort);
  if (!outPort) return { ok: false, reason: `${getNodeDef(src.type).label} has no output "${c.sourcePort}".` };
  if (!inPort) return { ok: false, reason: `${getNodeDef(dst.type).label} has no input "${c.targetPort}".` };
  if (!isTypeCompatible(outPort.type, inPort.type))
    return { ok: false, reason: `Type mismatch: ${outPort.type} cannot connect to ${inPort.type}.` };
  if (edges.some((e) => e.source === c.source && e.sourcePort === c.sourcePort && e.target === c.target && e.targetPort === c.targetPort))
    return { ok: false, reason: 'Those ports are already connected.' };
  if (!inPort.multiple && edges.some((e) => e.target === c.target && e.targetPort === c.targetPort))
    return { ok: false, reason: `"${inPort.label}" accepts a single connection.` };
  if (wouldCreateCycle(edges, c.source, c.target)) return { ok: false, reason: 'That connection would create a cycle.' };
  return { ok: true };
}

/** Whole-graph validation used before persisting (server and local backend). */
export function validateGraph(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id ${n.id}`);
    ids.add(n.id);
    if (!(n.type in NODE_DEFS)) errors.push(`Unknown node type ${n.type}`);
  }
  const accepted: GraphEdge[] = [];
  for (const e of edges) {
    const check = validateConnection(nodes, accepted, e);
    if (!check.ok) errors.push(`Edge ${e.id}: ${check.reason}`);
    else accepted.push(e);
  }
  return errors;
}

export function topologicalOrder(nodes: Pick<GraphNode, 'id'>[], edges: Pick<GraphEdge, 'source' | 'target'>[]): string[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of edges) {
      if (e.source !== id) continue;
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  if (order.length !== nodes.length) throw new Error('Graph contains a cycle');
  return order;
}

/** All nodes reachable downstream of `nodeId` (excluding itself), in topological order. */
export function downstreamOf(nodeId: string, nodes: Pick<GraphNode, 'id'>[], edges: Pick<GraphEdge, 'source' | 'target'>[]): string[] {
  const reach = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of edges) if (e.source === id && !reach.has(e.target)) {
      reach.add(e.target);
      stack.push(e.target);
    }
  }
  return topologicalOrder(nodes, edges).filter((id) => reach.has(id));
}

// ---------------------------------------------------------------- port values

export interface ImageRef {
  assetId: string;
  role: AssetRole;
  sourceType: AssetSource;
  contentHash: string;
  version: number;
  lineage: string;
}

export interface DirectionValue extends Direction {
  index: number;
  sourceNodeId: string;
}

export interface TextValue {
  title: string;
  text: string;
}

export interface ApprovedBundle {
  approvalNodeId: string;
  assetIds: string[];
  pendingAssetIds: string[];
  changesRequestedAssetIds: string[];
  direction: DirectionValue | null;
  shotplan: ShotPlan | null;
}

export type PortValue = Brief | ImageRef[] | ReferenceAnalysis | TextValue | DirectionValue | ShotPlan | ApprovedBundle;

export interface GraphContext {
  nodes: GraphNode[];
  edges: GraphEdge[];
  assets: Asset[];
  runs: NodeRun[];
  approvals: Approval[];
}

export function toImageRef(a: Asset): ImageRef {
  return {
    assetId: a.id,
    role: a.role,
    sourceType: a.sourceType,
    contentHash: a.contentHash,
    version: a.version,
    lineage: a.versionOf ?? a.id,
  };
}

export type ApprovalState = 'approved' | 'changes_requested' | 'pending';

/** Decision for one specific asset version (assets are immutable, so id == version). */
export function approvalStateOf(approvals: Approval[], assetId: string): ApprovalState {
  let latest: Approval | undefined;
  for (const a of approvals) if (a.assetId === assetId && (!latest || a.createdAt >= latest.createdAt)) latest = a;
  return latest?.decision ?? 'pending';
}

export function runsFor(ctx: Pick<GraphContext, 'runs'>, nodeId: string, op: string): NodeRun[] {
  return ctx.runs.filter((r) => r.nodeId === nodeId && r.operation === op).sort((a, b) => (a.completedAt < b.completedAt ? -1 : 1));
}

/**
 * The run whose output a node currently emits for an operation:
 *  1. an explicitly pinned run ("Use this version"), else
 *  2. the newest run — unless that would hide approved work, in which case the
 *     newest run that contains an approved asset stays active. Approved assets
 *     are therefore never silently replaced by a regeneration.
 */
export function activeRun(ctx: Pick<GraphContext, 'runs' | 'approvals' | 'nodes'>, nodeId: string, op: string): NodeRun | undefined {
  const runs = runsFor(ctx, nodeId, op);
  if (!runs.length) return undefined;
  const node = ctx.nodes.find((n) => n.id === nodeId);
  const pinnedId = (node?.data.pinned as Record<string, string> | undefined)?.[op];
  const pinned = pinnedId ? runs.find((r) => r.id === pinnedId) : undefined;
  if (pinned) return pinned;
  const latest = runs[runs.length - 1]!;
  const hasApproved = (r: NodeRun) => r.outputAssetIds.some((id) => approvalStateOf(ctx.approvals, id) === 'approved');
  if (hasApproved(latest)) return latest;
  for (let i = runs.length - 2; i >= 0; i--) if (hasApproved(runs[i]!)) return runs[i];
  return latest;
}

/** True when a newer run exists than the one being emitted (e.g. kept back by approvals). */
export function hasNewerCandidate(ctx: GraphContext, nodeId: string, op: string): boolean {
  const runs = runsFor(ctx, nodeId, op);
  const active = activeRun(ctx, nodeId, op);
  return !!active && runs[runs.length - 1]!.id !== active.id;
}

function imageOutputs(ctx: GraphContext, node: GraphNode, op: string): ImageRef[] | undefined {
  const run = activeRun(ctx, node.id, op);
  if (!run) return undefined;
  const selected = (node.data.selectedAssetIds as string[] | undefined) ?? [];
  const ids = selected.length ? run.outputAssetIds.filter((id) => selected.includes(id)) : run.outputAssetIds;
  const chosen = ids.length ? ids : run.outputAssetIds;
  return chosen
    .map((id) => ctx.assets.find((a) => a.id === id))
    .filter((a): a is Asset => !!a)
    .map(toImageRef);
}

/** The value a node emits on one output port, or undefined when nothing is ready. */
export function getOutputValue(ctx: GraphContext, node: GraphNode, portId: string, depth = 0): PortValue | undefined {
  if (depth > 64) throw new Error('Graph too deep or cyclic');
  const d = node.data;
  switch (node.type as NodeType) {
    case 'brief':
      return BriefSchema.parse(d);
    case 'image_asset': {
      const ids = (d.assetIds as string[] | undefined) ?? [];
      const refs = ids.map((id) => ctx.assets.find((a) => a.id === id)).filter((a): a is Asset => !!a).map(toImageRef);
      return refs.length ? refs : undefined;
    }
    case 'text': {
      const text = String(d.text ?? '').trim();
      return text ? { title: String(d.title ?? ''), text } : undefined;
    }
    case 'reference_analysis':
      return activeRun(ctx, node.id, 'analyze')?.output as ReferenceAnalysis | undefined;
    case 'concept_generator': {
      if (portId === 'direction') {
        const idx = d.selectedDirection as number | null;
        const out = activeRun(ctx, node.id, 'directions')?.output as DirectionsOutput | undefined;
        const dir = idx != null ? out?.directions[idx] : undefined;
        return dir ? { ...dir, index: idx!, sourceNodeId: node.id } : undefined;
      }
      return imageOutputs(ctx, node, 'render');
    }
    case 'pose_generator':
      return imageOutputs(ctx, node, 'poses');
    case 'image_edit':
      return imageOutputs(ctx, node, 'edit');
    case 'shot_planner':
      return (d.editedPlan as ShotPlan | null) ?? (activeRun(ctx, node.id, 'plan')?.output as ShotPlan | undefined);
    case 'approval': {
      const inputs = resolveInputs(ctx, node.id, depth + 1);
      const images = (inputs.images as ImageRef[] | undefined) ?? [];
      return buildApprovedBundle(node.id, images, ctx.approvals, inputs.direction as DirectionValue | undefined, inputs.shotplan as ShotPlan | undefined);
    }
    case 'export':
      return undefined;
  }
}

/**
 * Only the newest version of each lineage under review counts. An older approved
 * version keeps its historical approval but no longer flows downstream once a newer
 * version exists — the newer version needs its own approval.
 */
export function buildApprovedBundle(
  approvalNodeId: string,
  images: ImageRef[],
  approvals: Approval[],
  direction?: DirectionValue,
  shotplan?: ShotPlan,
): ApprovedBundle {
  const newest = new Map<string, ImageRef>();
  for (const img of images) {
    const cur = newest.get(img.lineage);
    if (!cur || img.version > cur.version) newest.set(img.lineage, img);
  }
  const bundle: ApprovedBundle = {
    approvalNodeId,
    assetIds: [],
    pendingAssetIds: [],
    changesRequestedAssetIds: [],
    direction: direction ?? null,
    shotplan: shotplan ?? null,
  };
  for (const img of newest.values()) {
    const s = approvalStateOf(approvals, img.assetId);
    if (s === 'approved') bundle.assetIds.push(img.assetId);
    else if (s === 'changes_requested') bundle.changesRequestedAssetIds.push(img.assetId);
    else bundle.pendingAssetIds.push(img.assetId);
  }
  return bundle;
}

export type ResolvedInputs = Partial<Record<string, PortValue | TextValue[]>>;

/** Collect what is flowing into each input port of a node. */
export function resolveInputs(ctx: GraphContext, nodeId: string, depth = 0): ResolvedInputs {
  const node = ctx.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  const def = getNodeDef(node.type);
  const result: ResolvedInputs = {};
  for (const port of def.inputs) {
    const incoming = ctx.edges.filter((e) => e.target === nodeId && e.targetPort === port.id);
    const values: PortValue[] = [];
    for (const e of incoming) {
      const src = ctx.nodes.find((n) => n.id === e.source);
      if (!src) continue;
      const v = getOutputValue(ctx, src, e.sourcePort, depth + 1);
      if (v !== undefined) values.push(v);
    }
    if (!values.length) continue;
    if (port.type === 'images') {
      const seen = new Set<string>();
      result[port.id] = (values as ImageRef[][]).flat().filter((r) => !seen.has(r.assetId) && !!seen.add(r.assetId));
    } else if (port.multiple) {
      result[port.id] = values as TextValue[];
    } else {
      result[port.id] = values[0];
    }
  }
  return result;
}

export function missingRequiredInputs(ctx: GraphContext, nodeId: string, op?: string): string[] {
  const node = ctx.nodes.find((n) => n.id === nodeId)!;
  const def = getNodeDef(node.type);
  const inputs = resolveInputs(ctx, nodeId);
  const needed = new Set(def.inputs.filter((p) => p.required).map((p) => p.id));
  if (op) for (const id of getOperation(node.type, op).needs ?? []) needed.add(id);
  return def.inputs.filter((p) => needed.has(p.id) && inputs[p.id] === undefined).map((p) => p.label);
}

// ---------------------------------------------------------------- hashing & staleness

function normalizeForHash(v: unknown): unknown {
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'assetId' in (v[0] as object)) {
    return (v as ImageRef[]).map((r) => ({ id: r.assetId, h: r.contentHash }));
  }
  return v;
}

export interface InputSnapshot {
  nodeType: NodeType;
  schemaVersion: number;
  operation: string;
  promptVersion: string;
  config: Record<string, unknown>;
  inputs: ResolvedInputs;
}

export function buildInputSnapshot(ctx: GraphContext, nodeId: string, op: string): { snapshot: InputSnapshot; inputHash: string } {
  const node = ctx.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  const opDef = getOperation(node.type, op);
  const config: Record<string, unknown> = {};
  for (const k of opDef.hashKeys) config[k] = node.data[k];
  const inputs = resolveInputs(ctx, nodeId);
  // Rendering depends on this node's own chosen direction, not just upstream ports.
  if (node.type === 'concept_generator' && op === 'render') {
    const own = getOutputValue(ctx, node, 'direction');
    if (own) inputs.__direction = own;
  }
  const snapshot: InputSnapshot = {
    nodeType: node.type,
    schemaVersion: node.schemaVersion,
    operation: op,
    promptVersion: opDef.promptVersion,
    config,
    inputs,
  };
  const forHash = { ...snapshot, inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, normalizeForHash(v)])) };
  return { snapshot, inputHash: hashValue(forHash) };
}

export type OpFreshness = 'never_run' | 'fresh' | 'stale';

export interface OpStatus {
  op: string;
  freshness: OpFreshness;
  currentHash: string;
  activeRun?: NodeRun;
  runCount: number;
  newerCandidate: boolean;
}

/**
 * A node's output is stale when the inputs/config it was produced from differ from
 * what it would receive now. Outputs are preserved; staleness is only a flag.
 */
export function opStatus(ctx: GraphContext, nodeId: string, op: string): OpStatus {
  const { inputHash } = buildInputSnapshot(ctx, nodeId, op);
  const run = activeRun(ctx, nodeId, op);
  return {
    op,
    currentHash: inputHash,
    activeRun: run,
    runCount: runsFor(ctx, nodeId, op).length,
    freshness: !run ? 'never_run' : run.inputHash === inputHash ? 'fresh' : 'stale',
    newerCandidate: hasNewerCandidate(ctx, nodeId, op),
  };
}

export function isNodeStale(ctx: GraphContext, nodeId: string): boolean {
  const node = ctx.nodes.find((n) => n.id === nodeId);
  if (!node) return false;
  return getNodeDef(node.type).operations.some((o) => o.kind === 'ai' && opStatus(ctx, nodeId, o.id).freshness === 'stale');
}

/** Stale nodes downstream of a change, used to tell the user what a change affects. */
export function staleNodes(ctx: GraphContext): string[] {
  return ctx.nodes.filter((n) => isNodeStale(ctx, n.id)).map((n) => n.id);
}
