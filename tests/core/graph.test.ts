import { describe, expect, it } from 'vitest';
import {
  activeRun,
  buildApprovedBundle,
  downstreamOf,
  hasNewerCandidate,
  opStatus,
  topologicalOrder,
  validateConnection,
  validateGraph,
  wouldCreateCycle,
  type GraphContext,
  type ImageRef,
} from '@/core/graph';
import { defaultNodeData, normalizeNodeData, NODE_DEFS } from '@/core/nodeRegistry';
import { NODE_TYPES, type Approval, type Asset, type GraphEdge, type NodeRun } from '@/core/types';
import { makeEdge, makeNode, campaignTemplate } from '@/data/templates';
import { buildInputSnapshot } from '@/core/graph';
import { hashValue, stableStringify } from '@/core/hash';

const P = 'proj';
const U = 'user';

describe('node schemas', () => {
  it('every node type has defaults that validate', () => {
    for (const t of NODE_TYPES) {
      const d = defaultNodeData(t);
      expect(NODE_DEFS[t].configSchema.safeParse(d).success).toBe(true);
    }
  });

  it('rejects invalid configuration', () => {
    expect(() => normalizeNodeData('concept_generator', { variations: 9 })).toThrow();
    expect(() => normalizeNodeData('pose_generator', { change: ['juggling'] })).toThrow();
    expect(() => normalizeNodeData('image_asset', { role: 'concept' })).toThrow();
  });

  it('refuses data from a newer schema version', () => {
    expect(() => normalizeNodeData('brief', {}, 99)).toThrow(/newer/);
  });

  it('fills defaults while keeping provided values', () => {
    const { data } = normalizeNodeData('concept_generator', { guidance: 'moody' });
    expect(data.guidance).toBe('moody');
    expect(data.variations).toBe(2);
  });
});

describe('connections', () => {
  const brief = makeNode(P, 'brief', { x: 0, y: 0 }, U);
  const imgs = makeNode(P, 'image_asset', { x: 0, y: 0 }, U);
  const concept = makeNode(P, 'concept_generator', { x: 0, y: 0 }, U);
  const pose = makeNode(P, 'pose_generator', { x: 0, y: 0 }, U);
  const nodes = [brief, imgs, concept, pose];

  it('accepts matching port types', () => {
    expect(validateConnection(nodes, [], { source: brief.id, sourcePort: 'brief', target: concept.id, targetPort: 'brief' })).toEqual({ ok: true });
  });

  it('rejects mismatched types', () => {
    const r = validateConnection(nodes, [], { source: imgs.id, sourcePort: 'images', target: concept.id, targetPort: 'brief' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/mismatch/);
  });

  it('rejects unknown ports', () => {
    expect(validateConnection(nodes, [], { source: brief.id, sourcePort: 'nope', target: concept.id, targetPort: 'brief' }).ok).toBe(false);
  });

  it('limits single-input ports to one edge but allows multi-input ports', () => {
    const brief2 = makeNode(P, 'brief', { x: 0, y: 0 }, U);
    const imgs2 = makeNode(P, 'image_asset', { x: 0, y: 0 }, U);
    const all = [...nodes, brief2, imgs2];
    const edges = [makeEdge(P, brief, 'brief', concept, 'brief'), makeEdge(P, imgs, 'images', concept, 'images')];
    expect(validateConnection(all, edges, { source: brief2.id, sourcePort: 'brief', target: concept.id, targetPort: 'brief' }).ok).toBe(false);
    expect(validateConnection(all, edges, { source: imgs2.id, sourcePort: 'images', target: concept.id, targetPort: 'images' }).ok).toBe(true);
  });

  it('rejects duplicate edges', () => {
    const edges = [makeEdge(P, imgs, 'images', concept, 'images')];
    expect(validateConnection(nodes, edges, { source: imgs.id, sourcePort: 'images', target: concept.id, targetPort: 'images' }).ok).toBe(false);
  });
});

describe('DAG', () => {
  const a = makeNode(P, 'concept_generator', { x: 0, y: 0 }, U);
  const b = makeNode(P, 'pose_generator', { x: 0, y: 0 }, U);
  const c = makeNode(P, 'image_edit', { x: 0, y: 0 }, U);
  const ab = makeEdge(P, a, 'images', b, 'images');
  const bc = makeEdge(P, b, 'images', c, 'images');

  it('detects cycles including self-loops', () => {
    expect(wouldCreateCycle([ab, bc], c.id, a.id)).toBe(true);
    expect(wouldCreateCycle([ab], a.id, a.id)).toBe(true);
    expect(wouldCreateCycle([ab], b.id, c.id)).toBe(false);
  });

  it('rejects a connection that closes a loop', () => {
    const r = validateConnection([a, b, c], [ab, bc], { source: c.id, sourcePort: 'images', target: b.id, targetPort: 'images' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/cycle/);
  });

  it('validateGraph flags a cyclic edge list and topologicalOrder refuses it', () => {
    const ca: GraphEdge = { id: 'x', projectId: P, source: c.id, sourcePort: 'images', target: b.id, targetPort: 'images' };
    expect(validateGraph([a, b, c], [ab, bc, ca]).join()).toMatch(/cycle|single/);
    expect(() => topologicalOrder([a, b, c], [ab, bc, { ...ca, target: a.id }])).toThrow(/cycle/);
  });

  it('the campaign template is a valid DAG and downstream order is topological', () => {
    const g = campaignTemplate(P, U);
    expect(validateGraph(g.nodes, g.edges)).toEqual([]);
    const brief = g.nodes.find((n) => n.type === 'brief')!;
    const down = downstreamOf(brief.id, g.nodes, g.edges);
    const typeAt = (id: string) => g.nodes.find((n) => n.id === id)!.type;
    expect(down.map(typeAt)).toContain('export');
    expect(down.indexOf(g.nodes.find((n) => n.type === 'concept_generator')!.id)).toBeLessThan(
      down.indexOf(g.nodes.find((n) => n.type === 'approval')!.id),
    );
  });
});

function asset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id, projectId: P, storageKey: id, mimeType: 'image/png', width: 1, height: 1, sizeBytes: 1, role: 'concept',
    sourceType: 'ai_generated', parentAssetId: null, versionOf: null, version: 1, nodeId: null, jobId: null, label: id,
    prompt: null, originalFilename: null, contentHash: `h-${id}`, createdBy: U, createdAt: '2026-01-01T00:00:00Z', ...over,
  };
}

function run(nodeId: string, op: string, inputHash: string, outputAssetIds: string[], at: string, output: unknown = {}): NodeRun {
  return { id: `run-${at}`, jobId: `job-${at}`, projectId: P, nodeId, operation: op, inputHash, outputAssetIds, output, completedAt: at };
}

const approve = (assetId: string, decision: Approval['decision'] = 'approved', at = '2026-01-02T00:00:00Z'): Approval => ({
  id: `ap-${assetId}-${at}`, projectId: P, assetId, assetVersion: 1, reviewerId: 'client', decision, comment: null, createdAt: at,
});

describe('staleness and dependency invalidation', () => {
  function setup() {
    const brief = makeNode(P, 'brief', { x: 0, y: 0 }, U, { client: 'Acme', product: 'Watch' });
    const concept = makeNode(P, 'concept_generator', { x: 0, y: 0 }, U, { selectedDirection: 0 });
    const pose = makeNode(P, 'pose_generator', { x: 0, y: 0 }, U);
    const ctx: GraphContext = {
      nodes: [brief, concept, pose],
      edges: [makeEdge(P, brief, 'brief', concept, 'brief'), makeEdge(P, concept, 'images', pose, 'images')],
      assets: [asset('c1'), asset('c2'), asset('p1', { role: 'pose', parentAssetId: 'c1' })],
      runs: [],
      approvals: [],
    };
    const directions = { directions: [0, 1, 2].map((i) => ({ title: `D${i}`, rationale: '', creativeDirection: '', palette: ['#000', '#fff'], lighting: '', proposedShots: ['a'], poseSuggestions: ['a'], backgroundAndProps: ['a'], constraints: [], negativeInstructions: [] })) };
    ctx.runs.push(run(concept.id, 'directions', buildInputSnapshot(ctx, concept.id, 'directions').inputHash, [], '2026-01-01T01:00:00Z', directions));
    ctx.runs.push(run(concept.id, 'render', buildInputSnapshot(ctx, concept.id, 'render').inputHash, ['c1'], '2026-01-01T02:00:00Z'));
    ctx.runs.push(run(pose.id, 'poses', buildInputSnapshot(ctx, pose.id, 'poses').inputHash, ['p1'], '2026-01-01T03:00:00Z'));
    return { ctx, brief, concept, pose };
  }

  it('fresh outputs stay fresh when nothing changed', () => {
    const { ctx, concept, pose } = setup();
    expect(opStatus(ctx, concept.id, 'directions').freshness).toBe('fresh');
    expect(opStatus(ctx, concept.id, 'render').freshness).toBe('fresh');
    expect(opStatus(ctx, pose.id, 'poses').freshness).toBe('fresh');
  });

  it('an upstream brief edit marks the direct dependant stale and preserves its outputs', () => {
    const { ctx, brief, concept } = setup();
    brief.data = { ...brief.data, product: 'Wallet' };
    const s = opStatus(ctx, concept.id, 'directions');
    expect(s.freshness).toBe('stale');
    expect(s.activeRun?.outputAssetIds).toEqual([]);
    expect(opStatus(ctx, concept.id, 'render').activeRun?.outputAssetIds).toEqual(['c1']);
  });

  it('regenerating a node marks downstream nodes stale', () => {
    const { ctx, concept, pose } = setup();
    ctx.runs.push(run(concept.id, 'render', 'whatever', ['c2'], '2026-01-01T04:00:00Z'));
    expect(opStatus(ctx, pose.id, 'poses').freshness).toBe('stale');
    expect(opStatus(ctx, pose.id, 'poses').activeRun?.outputAssetIds).toEqual(['p1']);
  });

  it('selecting a different direction only invalidates rendering, not direction generation', () => {
    const { ctx, concept } = setup();
    concept.data = { ...concept.data, selectedDirection: 2 };
    expect(opStatus(ctx, concept.id, 'directions').freshness).toBe('fresh');
    expect(opStatus(ctx, concept.id, 'render').freshness).toBe('stale');
  });

  it('moving a node changes nothing about execution', () => {
    const { ctx, concept, pose } = setup();
    const before = buildInputSnapshot(ctx, pose.id, 'poses').inputHash;
    concept.position = { x: 999, y: -40 };
    expect(buildInputSnapshot(ctx, pose.id, 'poses').inputHash).toBe(before);
  });

  it('approved outputs are never silently replaced by a regeneration', () => {
    const { ctx, concept } = setup();
    ctx.approvals.push(approve('c1'));
    ctx.runs.push(run(concept.id, 'render', 'new', ['c2'], '2026-01-01T05:00:00Z'));
    expect(activeRun(ctx, concept.id, 'render')?.outputAssetIds).toEqual(['c1']);
    expect(hasNewerCandidate(ctx, concept.id, 'render')).toBe(true);
    concept.data = { ...concept.data, pinned: { render: 'run-2026-01-01T05:00:00Z' } };
    expect(activeRun(ctx, concept.id, 'render')?.outputAssetIds).toEqual(['c2']);
  });
});

describe('approval versioning', () => {
  const ref = (id: string, version: number, lineage: string): ImageRef => ({ assetId: id, role: 'edit', sourceType: 'ai_generated', contentHash: id, version, lineage });

  it('a newer version needs its own approval while the old approval is kept', () => {
    const approvals = [approve('v1')];
    const b = buildApprovedBundle('n', [ref('v1', 1, 'v1'), ref('v2', 2, 'v1')], approvals);
    expect(b.assetIds).toEqual([]);
    expect(b.pendingAssetIds).toEqual(['v2']);
    expect(approvals).toHaveLength(1);
    const b2 = buildApprovedBundle('n', [ref('v1', 1, 'v1'), ref('v2', 2, 'v1')], [...approvals, approve('v2')]);
    expect(b2.assetIds).toEqual(['v2']);
  });

  it('the latest decision wins for one version', () => {
    const b = buildApprovedBundle('n', [ref('a', 1, 'a')], [approve('a', 'approved', '2026-01-01'), approve('a', 'changes_requested', '2026-01-03')]);
    expect(b.changesRequestedAssetIds).toEqual(['a']);
  });
});

describe('hashing', () => {
  it('is independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });
});
