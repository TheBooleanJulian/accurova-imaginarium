import type { GraphEdge, GraphNode, NodeType } from '@/core/types';
import { defaultNodeData, getNodeDef } from '@/core/nodeRegistry';
import type { Brief } from '@/core/schemas';

export function makeNode(
  projectId: string,
  type: NodeType,
  position: { x: number; y: number },
  createdBy: string,
  data: Record<string, unknown> = {},
): GraphNode {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    type,
    schemaVersion: getNodeDef(type).schemaVersion,
    position,
    data: { ...defaultNodeData(type), ...data },
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeEdge(projectId: string, source: GraphNode, sourcePort: string, target: GraphNode, targetPort: string): GraphEdge {
  return { id: crypto.randomUUID(), projectId, source: source.id, sourcePort, target: target.id, targetPort };
}

/** The standard Accurova preshoot pipeline, pre-wired. */
export function campaignTemplate(projectId: string, userId: string, brief: Partial<Brief> = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const n = (type: NodeType, x: number, y: number, data: Record<string, unknown> = {}) => makeNode(projectId, type, { x, y }, userId, data);
  // Columns 420 apart, rows sized for each node's preview so nothing overlaps as outputs arrive.
  const briefNode = n('brief', 0, 0, brief);
  const product = n('image_asset', 0, 300, { title: 'Product photos', role: 'product' });
  const refs = n('image_asset', 0, 560, { title: 'Inspiration', role: 'reference' });
  const analysis = n('reference_analysis', 420, 520);
  const concept = n('concept_generator', 840, 140);
  const pose = n('pose_generator', 1260, -60);
  const planner = n('shot_planner', 1260, 420);
  const approval = n('approval', 1680, 160);
  const exp = n('export', 2100, 200);
  const e = (s: GraphNode, sp: string, t: GraphNode, tp: string) => makeEdge(projectId, s, sp, t, tp);
  return {
    nodes: [briefNode, product, refs, analysis, concept, pose, planner, approval, exp],
    edges: [
      e(refs, 'images', analysis, 'images'),
      e(product, 'images', analysis, 'images'),
      e(briefNode, 'brief', analysis, 'brief'),
      e(briefNode, 'brief', concept, 'brief'),
      e(analysis, 'analysis', concept, 'analysis'),
      e(product, 'images', concept, 'images'),
      e(concept, 'images', pose, 'images'),
      e(concept, 'direction', pose, 'direction'),
      e(concept, 'direction', planner, 'direction'),
      e(concept, 'images', planner, 'images'),
      e(briefNode, 'brief', planner, 'brief'),
      e(concept, 'images', approval, 'images'),
      e(pose, 'images', approval, 'images'),
      e(concept, 'direction', approval, 'direction'),
      e(planner, 'shotplan', approval, 'shotplan'),
      e(approval, 'approved', exp, 'approved'),
      e(briefNode, 'brief', exp, 'brief'),
    ],
  };
}

export function blankTemplate(projectId: string, userId: string, brief: Partial<Brief> = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return { nodes: [makeNode(projectId, 'brief', { x: 0, y: 0 }, userId, brief)], edges: [] };
}
