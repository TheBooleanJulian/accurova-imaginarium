import { describe, expect, it } from 'vitest';
import { byType, makeWorld, pngBlob } from '../helpers';
import { ConflictError, NotFoundError } from '@/data/repository';
import { PermissionError } from '@/core/permissions';
import { resolveInputs, type ApprovedBundle, type ImageRef } from '@/core/graph';
import type { GraphNode, ProjectBundle } from '@/core/types';
import type { LocalRepository } from '@/data/local/localRepository';

function patchNode(b: ProjectBundle, id: string, data: Record<string, unknown>): GraphNode[] {
  return b.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n));
}

async function save(repo: LocalRepository, b: ProjectBundle, nodes: GraphNode[]): Promise<ProjectBundle> {
  await repo.saveGraph(b.project.id, { nodes, edges: b.edges }, b.project.graphRevision);
  return repo.loadProject(b.project.id);
}

async function run(repo: LocalRepository, b: ProjectBundle, nodeId: string, op: string) {
  const r = await repo.runNode(b.project.id, nodeId, op, { idempotencyKey: crypto.randomUUID() });
  await repo.engine.whenIdle();
  const after = await repo.loadProject(b.project.id);
  const job = after.jobs.find((j) => j.id === r.job.id)!;
  if (job.status !== 'succeeded') throw new Error(`${op} ${job.status}: ${job.error?.message}`);
  return after;
}

describe('graph persistence', () => {
  it('saves with revision checks and rejects a stale concurrent save', async () => {
    const { make } = makeWorld();
    const alice = make();
    await alice.signIn('julian@accurova.local');
    const p = await alice.createProject({ name: 'P', client: 'C', template: 'campaign' });
    const b1 = await alice.loadProject(p.id);
    const b2 = await alice.loadProject(p.id); // a second editor tab with the same base revision
    const { revision } = await alice.saveGraph(p.id, { nodes: patchNode(b1, byType(b1.nodes, 'brief').id, { product: 'A' }), edges: b1.edges }, b1.project.graphRevision);
    expect(revision).toBe(b1.project.graphRevision + 1);
    await expect(
      alice.saveGraph(p.id, { nodes: patchNode(b2, byType(b2.nodes, 'brief').id, { product: 'B' }), edges: b2.edges }, b2.project.graphRevision),
    ).rejects.toBeInstanceOf(ConflictError);
    const reloaded = await alice.loadProject(p.id);
    expect(byType(reloaded.nodes, 'brief').data.product).toBe('A');
  });

  it('rejects invalid graphs (cycles, bad types, foreign nodes)', async () => {
    const { make } = makeWorld();
    const repo = make();
    await repo.signIn('julian@accurova.local');
    const p = await repo.createProject({ name: 'P', client: 'C', template: 'campaign' });
    const b = await repo.loadProject(p.id);
    const pose = byType(b.nodes, 'pose_generator');
    const concept = byType(b.nodes, 'concept_generator');
    const cyclic = [...b.edges, { id: 'cyc', projectId: p.id, source: pose.id, sourcePort: 'images', target: concept.id, targetPort: 'images' }];
    await expect(repo.saveGraph(p.id, { nodes: b.nodes, edges: cyclic }, b.project.graphRevision)).rejects.toThrow(/cycle/);
    await expect(repo.saveGraph(p.id, { nodes: patchNode(b, concept.id, { variations: 50 }), edges: b.edges }, b.project.graphRevision)).rejects.toThrow();
    const foreign = b.nodes.map((n, i) => (i === 0 ? { ...n, projectId: 'other' } : n));
    await expect(repo.saveGraph(p.id, { nodes: foreign, edges: b.edges }, b.project.graphRevision)).rejects.toThrow(/another project/);
  });
});

describe('uploads', () => {
  it('validates type and size and preserves the original bytes', async () => {
    const { make } = makeWorld();
    const repo = make();
    await repo.signIn('julian@accurova.local');
    const p = await repo.createProject({ name: 'P', client: 'C', template: 'blank' });
    await expect(repo.uploadAsset(p.id, new Blob(['x'], { type: 'text/plain' }), { role: 'reference', filename: 'a.txt' })).rejects.toThrow(/JPEG/);
    const big = new Blob([new Uint8Array(21 * 1024 * 1024)], { type: 'image/png' });
    await expect(repo.uploadAsset(p.id, big, { role: 'reference', filename: 'big.png' })).rejects.toThrow(/MB/);
    const a = await repo.uploadAsset(p.id, pngBlob(), { role: 'product', filename: 'watch.png' });
    expect(a.sourceType).toBe('upload');
    expect(a.role).toBe('product');
    expect(Array.from(await repo.assetBytes(a))).toEqual(Array.from(new Uint8Array(await pngBlob().arrayBuffer())));
  });
});

describe('permissions and isolation', () => {
  async function twoClients() {
    const { make } = makeWorld();
    const owner = make();
    await owner.signIn('julian@accurova.local');
    const pA = await owner.createProject({ name: 'Client A shoot', client: 'A', template: 'campaign' });
    const pB = await owner.createProject({ name: 'Client B shoot', client: 'B', template: 'campaign' });
    const inv = await owner.createInvitation(pA.id, 'client@a.com', 'reviewer');
    const client = make();
    await client.signIn('client@a.com');
    await client.acceptInvitation(inv.token);
    return { owner, client, pA, pB };
  }

  it('a client cannot see or touch another client’s project', async () => {
    const { client, pA, pB } = await twoClients();
    expect((await client.listProjects()).map((s) => s.project.id)).toEqual([pA.id]);
    await expect(client.loadProject(pB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.addComment(pB.id, { body: 'hi' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.uploadAsset(pB.id, pngBlob(), { role: 'reference', filename: 'x.png' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reviewers can comment and approve but cannot edit, run, upload or read jobs', async () => {
    const { owner, client, pA } = await twoClients();
    const ownerView = await owner.loadProject(pA.id);
    const concept = byType(ownerView.nodes, 'concept_generator');
    await owner.runNode(pA.id, concept.id, 'directions', { idempotencyKey: 'x' });
    await owner.engine.whenIdle();

    const b = await client.loadProject(pA.id);
    expect(b.myRole).toBe('reviewer');
    expect(b.jobs).toEqual([]);
    expect(b.invitations).toEqual([]);
    await expect(client.saveGraph(pA.id, { nodes: b.nodes, edges: b.edges }, b.project.graphRevision)).rejects.toBeInstanceOf(PermissionError);
    await expect(client.runNode(pA.id, concept.id, 'directions', { idempotencyKey: 'y', force: true })).rejects.toBeInstanceOf(PermissionError);
    await expect(client.uploadAsset(pA.id, pngBlob(), { role: 'reference', filename: 'x.png' })).rejects.toBeInstanceOf(PermissionError);
    await expect(client.createInvitation(pA.id, 'x@y.com', 'viewer')).rejects.toBeInstanceOf(PermissionError);
    const c = await client.addComment(pA.id, { body: 'Love direction 2' });
    expect(c.authorName).toBe('client');
  });

  it('viewers are read-only', async () => {
    const { make } = makeWorld();
    const owner = make();
    await owner.signIn('julian@accurova.local');
    const p = await owner.createProject({ name: 'P', client: 'C', template: 'blank' });
    const a = await owner.uploadAsset(p.id, pngBlob(), { role: 'reference', filename: 'r.png' });
    const inv = await owner.createInvitation(p.id, 'viewer@c.com', 'viewer');
    const viewer = make();
    await viewer.signIn('viewer@c.com');
    await viewer.acceptInvitation(inv.token);
    await expect(viewer.addComment(p.id, { body: 'x' })).rejects.toBeInstanceOf(PermissionError);
    await expect(viewer.recordApproval(p.id, a.id, 'approved')).rejects.toBeInstanceOf(PermissionError);
    expect((await viewer.loadProject(p.id)).assets).toHaveLength(1);
  });

  it('invitations are bound to the invited email and single-use', async () => {
    const { make } = makeWorld();
    const owner = make();
    await owner.signIn('julian@accurova.local');
    const p = await owner.createProject({ name: 'P', client: 'C', template: 'blank' });
    const inv = await owner.createInvitation(p.id, 'right@c.com', 'reviewer');
    const wrong = make();
    await wrong.signIn('wrong@c.com');
    await expect(wrong.acceptInvitation(inv.token)).rejects.toThrow(/right@c.com/);
    const right = make();
    await right.signIn('right@c.com');
    expect((await right.acceptInvitation(inv.token)).role).toBe('reviewer');
    await expect(right.acceptInvitation(inv.token)).rejects.toThrow(/accepted/);
    const revoked = await owner.createInvitation(p.id, 'late@c.com', 'viewer');
    await owner.revokeInvitation(revoked.id);
    const late = make();
    await late.signIn('late@c.com');
    await expect(late.acceptInvitation(revoked.token)).rejects.toThrow(/revoked/);
  });

  it('owner role is protected', async () => {
    const { owner, pA } = await twoClients();
    const b = await owner.loadProject(pA.id);
    const ownerMember = b.members.find((m) => m.role === 'owner')!;
    await expect(owner.removeMember(ownerMember.id)).rejects.toThrow(/owner/);
  });
});

describe('end-to-end: brief → concepts → poses → shot plan → client approval → export', () => {
  it('runs the whole Accurova workflow through the application API', async () => {
    const { make } = makeWorld();
    const owner = make();
    await owner.signIn('julian@accurova.local');
    const p = await owner.createProject({
      name: 'Acme Field Watch — Launch',
      client: 'Acme',
      template: 'campaign',
      brief: { product: 'Field watch', audience: 'Urban professionals', objective: 'Launch campaign', deliverables: '6 stills, 4:5 + 9:16' },
    });
    let b = await owner.loadProject(p.id);

    // Upload a real product photo and a reference
    const product = await owner.uploadAsset(p.id, pngBlob(), { role: 'product', filename: 'watch.png' });
    const ref = await owner.uploadAsset(p.id, pngBlob(), { role: 'reference', filename: 'mood.png' });
    const productNode = byType(b.nodes, 'image_asset', 0);
    const refNode = byType(b.nodes, 'image_asset', 1);
    let nodes = patchNode(b, productNode.id, { assetIds: [product.id] });
    nodes = nodes.map((n) => (n.id === refNode.id ? { ...n, data: { ...n.data, assetIds: [ref.id] } } : n));
    b = await save(owner, b, nodes);

    // Analyse references, generate directions, pick one, render
    b = await run(owner, b, byType(b.nodes, 'reference_analysis').id, 'analyze');
    const concept = byType(b.nodes, 'concept_generator');
    b = await run(owner, b, concept.id, 'directions');
    b = await save(owner, b, patchNode(b, concept.id, { selectedDirection: 1, variations: 2 }));
    b = await run(owner, b, concept.id, 'render');
    const concepts = b.assets.filter((a) => a.role === 'concept');
    expect(concepts).toHaveLength(2);
    expect(concepts.every((a) => a.sourceType === 'ai_generated' && a.mimeType === 'image/svg+xml')).toBe(true);

    // Pose variations from the first concept, keeping product/lighting
    const pose = byType(b.nodes, 'pose_generator');
    b = await save(owner, b, patchNode(b, pose.id, { sourceAssetId: concepts[0]!.id, variations: 3 }));
    b = await run(owner, b, pose.id, 'poses');
    const poses = b.assets.filter((a) => a.role === 'pose');
    expect(poses).toHaveLength(3);
    expect(poses.every((a) => a.parentAssetId === concepts[0]!.id)).toBe(true);

    // Shot plan
    b = await run(owner, b, byType(b.nodes, 'shot_planner').id, 'plan');
    const planRun = b.runs.find((r) => r.operation === 'plan')!;
    expect((planRun.output as { shots: unknown[] }).shots).toHaveLength(6);

    // Invite the client; they approve one concept and request changes on a pose
    const inv = await owner.createInvitation(p.id, 'marketing@acme.com', 'reviewer');
    const client = make();
    await client.signIn('marketing@acme.com');
    await client.acceptInvitation(inv.token);
    await client.recordApproval(p.id, concepts[0]!.id, 'approved');
    await expect(client.recordApproval(p.id, poses[0]!.id, 'changes_requested')).rejects.toThrow(/change/);
    await client.recordApproval(p.id, poses[0]!.id, 'changes_requested', 'Softer smile please');
    await client.addComment(p.id, { assetId: poses[0]!.id, body: 'Watch face should be visible' });

    b = await owner.loadProject(p.id);
    const approvalNode = byType(b.nodes, 'approval');
    const approvedBundle = (() => {
      const ctx = { nodes: b.nodes, edges: b.edges, assets: b.assets, runs: b.runs, approvals: b.approvals };
      const exportNode = byType(b.nodes, 'export');
      return resolveInputs(ctx, exportNode.id).approved as ApprovedBundle;
    })();
    expect(approvedBundle.approvalNodeId).toBe(approvalNode.id);
    expect(approvedBundle.assetIds).toEqual([concepts[0]!.id]);
    expect(approvedBundle.changesRequestedAssetIds).toEqual([poses[0]!.id]);
    expect(approvedBundle.shotplan?.shots.length).toBe(6);

    // Revise the pose: edit creates v2 in the same lineage; old decision retained, v2 pending
    const editNodeData = { sourceAssetId: poses[0]!.id, instruction: 'Softer smile, show watch face' };
    const editNode = { ...byType(b.nodes, 'pose_generator'), id: crypto.randomUUID(), type: 'image_edit' as const, data: {} };
    const { normalizeNodeData } = await import('@/core/nodeRegistry');
    editNode.data = { ...normalizeNodeData('image_edit', editNodeData).data };
    const pose2 = byType(b.nodes, 'pose_generator');
    const edges = [
      ...b.edges,
      { id: crypto.randomUUID(), projectId: p.id, source: pose2.id, sourcePort: 'images', target: editNode.id, targetPort: 'images' },
      { id: crypto.randomUUID(), projectId: p.id, source: editNode.id, sourcePort: 'images', target: approvalNode.id, targetPort: 'images' },
    ];
    await owner.saveGraph(p.id, { nodes: [...b.nodes, editNode], edges }, b.project.graphRevision);
    b = await owner.loadProject(p.id);
    b = await run(owner, b, editNode.id, 'edit');
    const v2 = b.assets.find((a) => a.role === 'edit')!;
    expect(v2.versionOf).toBe(poses[0]!.id);
    expect(v2.version).toBe(2);
    expect(v2.parentAssetId).toBe(poses[0]!.id);
    const ctx = { nodes: b.nodes, edges: b.edges, assets: b.assets, runs: b.runs, approvals: b.approvals };
    const imgs = resolveInputs(ctx, approvalNode.id).images as ImageRef[];
    expect(imgs.map((i) => i.assetId)).toContain(v2.id);
    const bundle2 = resolveInputs(ctx, byType(b.nodes, 'export').id).approved as ApprovedBundle;
    expect(bundle2.pendingAssetIds).toContain(v2.id);
    expect(bundle2.changesRequestedAssetIds).not.toContain(poses[0]!.id);
    expect(b.approvals.filter((a) => a.assetId === poses[0]!.id)).toHaveLength(1);

    await client.recordApproval(p.id, v2.id, 'approved');

    // Export runs as a job: the PDF is stored before the job succeeds.
    const exportNode = byType(b.nodes, 'export');
    b = await save(owner, b, patchNode(b, exportNode.id, { mode: 'final' }));
    b = await run(owner, b, exportNode.id, 'export');
    const pdf = b.assets.find((a) => a.role === 'export')!;
    expect(pdf.mimeType).toBe('application/pdf');
    expect(pdf.sourceType).toBe('export');
    const bytes = await owner.assetBytes(pdf);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const exportRun = b.runs.find((r) => r.operation === 'export')!;
    expect(exportRun.outputAssetIds).toEqual([pdf.id]);
    expect((exportRun.output as { mode: string }).mode).toBe('final');
    expect(b.activity.map((a) => a.action)).toEqual(
      expect.arrayContaining(['project.create', 'asset.upload', 'job.succeeded', 'approval.approved', 'approval.changes_requested', 'member.join', 'export.create']),
    );

    // Reviewers cannot export.
    await expect(client.runNode(p.id, exportNode.id, 'export', { idempotencyKey: 'x' })).rejects.toBeInstanceOf(PermissionError);
  });

  it('refuses a final export when nothing is approved', async () => {
    const { make } = makeWorld();
    const owner = make();
    await owner.signIn('julian@accurova.local');
    const p = await owner.createProject({ name: 'P', client: 'C', template: 'campaign' });
    let b = await owner.loadProject(p.id);
    const exportNode = byType(b.nodes, 'export');
    b = await save(owner, b, patchNode(b, exportNode.id, { mode: 'final' }));
    const r = await owner.runNode(p.id, exportNode.id, 'export', { idempotencyKey: 'f' });
    await owner.engine.whenIdle();
    const job = (await owner.loadProject(p.id)).jobs.find((j) => j.id === r.job.id)!;
    expect(job.status).toBe('failed');
    expect(job.error?.message).toMatch(/final pack needs/);
    // A draft is fine.
    b = await save(owner, await owner.loadProject(p.id), patchNode(await owner.loadProject(p.id), exportNode.id, { mode: 'draft' }));
    b = await run(owner, b, exportNode.id, 'export');
    expect(b.assets.some((a) => a.role === 'export')).toBe(true);
  });

  it('refuses to edit original product photographs', async () => {
    const { make } = makeWorld();
    const owner = make();
    await owner.signIn('julian@accurova.local');
    const p = await owner.createProject({ name: 'P', client: 'C', template: 'blank' });
    const product = await owner.uploadAsset(p.id, pngBlob(), { role: 'product', filename: 'w.png' });
    const b = await owner.loadProject(p.id);
    const { makeNode, makeEdge } = await import('@/data/templates');
    const img = makeNode(p.id, 'image_asset', { x: 0, y: 0 }, b.project.ownerId, { role: 'product', assetIds: [product.id] });
    const edit = makeNode(p.id, 'image_edit', { x: 300, y: 0 }, b.project.ownerId, { instruction: 'make it gold' });
    await owner.saveGraph(p.id, { nodes: [...b.nodes, img, edit], edges: [makeEdge(p.id, img, 'images', edit, 'images')] }, b.project.graphRevision);
    const r = await owner.runNode(p.id, edit.id, 'edit', { idempotencyKey: 'e' });
    await owner.engine.whenIdle();
    const job = (await owner.loadProject(p.id)).jobs.find((j) => j.id === r.job.id)!;
    expect(job.status).toBe('failed');
    expect(job.error?.message).toMatch(/never edited/);
  });
});
