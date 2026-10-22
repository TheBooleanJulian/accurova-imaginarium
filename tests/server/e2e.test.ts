import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Asset, Invitation, Project, ProjectBundle } from '@/core/types';
import { opStatus } from '@/core/graph';
import { getNodeDef } from '@/core/nodeRegistry';
import type { DirectionsOutput, ShotPlan } from '@/core/schemas';
import { makeEdge, makeNode } from '@/data/templates';
import { byType, hasPg, load, patchNode, runOp, saveGraph, startServer, testImage, upload, type TestServer } from './helpers';

/**
 * The acceptance path from the brief: brief → references → analysis → three
 * directions → concepts → pose variations → shot plan → client invited →
 * client approval (incl. a revision) → final PDF, entirely through the HTTP API.
 */
describe.skipIf(!hasPg)('end-to-end campaign workflow (API + Postgres)', () => {
  let s: TestServer;
  let owner: string;
  let client: string;
  let project: Project;
  let b: ProjectBundle;

  beforeAll(async () => {
    s = await startServer();
    owner = await s.login('julian@accurova.sg', 'Julian');
    client = await s.login('marketing@acme.sg', 'Acme Marketing');
  });
  afterAll(async () => s?.close());

  it('creates a campaign project from the template', async () => {
    const r = await s.call<Project>('POST', '/api/projects', {
      token: owner,
      body: { name: 'Field Watch Q1', client: 'Acme Timepieces', brief: { product: 'Field Watch 40mm', objective: 'Launch to urban professionals' } },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    project = r.body;
    b = await load(s, owner, project.id);
    expect(b.myRole).toBe('owner');
    expect(b.nodes.map((n) => n.type).sort()).toEqual(
      ['approval', 'brief', 'concept_generator', 'export', 'image_asset', 'image_asset', 'pose_generator', 'reference_analysis', 'shot_planner'].sort(),
    );
    expect(byType(b, 'brief').data.client).toBe('Acme Timepieces');
  });

  it('uploads real product photos and references, preserving originals', async () => {
    const productNode = b.nodes.find((n) => n.type === 'image_asset' && n.data.role === 'product')!;
    const refNode = b.nodes.find((n) => n.type === 'image_asset' && n.data.role === 'reference')!;
    const original = await testImage('jpeg', 900, 1200);
    const p = await upload(s, owner, project.id, original, { role: 'product', filename: 'watch-front.jpg', nodeId: productNode.id });
    expect(p.status).toBe(201);
    const r1 = await upload(s, owner, project.id, await testImage('png', 800, 800, '#2b4a3a'), { role: 'reference', filename: 'mood.png', contentType: 'image/png' });
    const r2 = await upload(s, owner, project.id, await testImage('webp', 1200, 800, '#3a2a4a'), { role: 'reference', filename: 'light.webp', contentType: 'image/webp' });
    const product = p.body as Asset;
    expect(product).toMatchObject({ role: 'product', sourceType: 'upload', mimeType: 'image/jpeg', width: 900, height: 1200, version: 1 });
    // The stored original is byte-for-byte what was uploaded.
    const stored = await s.rt.storage.get(product.storageKey);
    expect(Buffer.from(stored).equals(Buffer.from(original))).toBe(true);

    const nodes = patchNode(b, productNode.id, { assetIds: [product.id] }).map((n) =>
      n.id === refNode.id ? { ...n, data: { ...n.data, assetIds: [(r1.body as Asset).id, (r2.body as Asset).id] } } : n,
    );
    const briefId = byType(b, 'brief').id;
    const withBrief = nodes.map((n) =>
      n.id === briefId ? { ...n, data: { ...n.data, audience: 'Professionals 28-45', visualStyle: 'Premium, understated', deliverables: '6 stills', constraints: 'One studio day' } } : n,
    );
    expect((await saveGraph(s, owner, b, withBrief)).status).toBe(200);
    b = await load(s, owner, project.id);
    expect(b.assets.filter((a) => a.sourceType === 'upload')).toHaveLength(3);
  });

  it('analyses references, then generates exactly three distinct directions', async () => {
    const a = await runOp(s, owner, byType(b, 'reference_analysis').id, 'analyze');
    expect(a.job.status).toBe('succeeded');
    const d = await runOp(s, owner, byType(b, 'concept_generator').id, 'directions');
    expect(d.job.status).toBe('succeeded');
    b = await load(s, owner, project.id);
    const run = b.runs.find((r) => r.operation === 'directions')!;
    const out = run.output as DirectionsOutput;
    expect(out.directions).toHaveLength(3);
    expect(new Set(out.directions.map((x) => x.title)).size).toBe(3);
    // The job records what it ran on.
    const job = b.jobs.find((j) => j.id === run.jobId)!;
    expect(job).toMatchObject({ provider: 'mock', promptVersion: 'directions.v1', attempts: 1 });
    expect(job.inputHash).toBe(run.inputHash);
    expect((job.inputSnapshot as { inputs: Record<string, unknown> }).inputs.brief).toBeTruthy();
  });

  it('renders concepts for the chosen direction and stores PNGs before success', async () => {
    const cg = byType(b, 'concept_generator');
    expect((await saveGraph(s, owner, b, patchNode(b, cg.id, { selectedDirection: 1, variations: 3, aspectRatio: '4:5' }))).status).toBe(200);
    b = await load(s, owner, project.id);
    const r = await runOp(s, owner, cg.id, 'render');
    expect(r.job.status).toBe('succeeded');
    b = await load(s, owner, project.id);
    const concepts = b.assets.filter((a) => a.role === 'concept');
    expect(concepts).toHaveLength(3);
    for (const c of concepts) {
      expect(c).toMatchObject({ sourceType: 'ai_generated', mimeType: 'image/png', width: 640, height: 800 });
      const bytes = await s.rt.storage.get(c.storageKey);
      expect(bytes[0]).toBe(0x89); // PNG, never SVG
    }
  });

  it('generates pose variations from a chosen source, keeping lineage', async () => {
    const pose = byType(b, 'pose_generator');
    const source = b.assets.find((a) => a.role === 'concept')!;
    await saveGraph(s, owner, b, patchNode(b, pose.id, { sourceAssetId: source.id, variations: 3, change: ['hand positions', 'head angle'] }));
    b = await load(s, owner, project.id);
    expect((await runOp(s, owner, pose.id, 'poses')).job.status).toBe('succeeded');
    b = await load(s, owner, project.id);
    const poses = b.assets.filter((a) => a.role === 'pose');
    expect(poses).toHaveLength(3);
    expect(poses.every((p) => p.parentAssetId === source.id)).toBe(true);
  });

  it('plans the shoot with practical, editable instructions', async () => {
    expect((await runOp(s, owner, byType(b, 'shot_planner').id, 'plan')).job.status).toBe('succeeded');
    b = await load(s, owner, project.id);
    const plan = b.runs.find((r) => r.operation === 'plan')!.output as ShotPlan;
    expect(plan.shots.length).toBe(6);
    expect(plan.shots[0]).toMatchObject({ id: 'S01', approvalStatus: 'pending' });
    expect(plan.shots.every((sh) => sh.lens && sh.lighting && sh.cameraPosition && sh.setupMinutes >= 0)).toBe(true);
  });

  it('marks downstream nodes stale when the brief changes, without touching outputs', async () => {
    const ctx = { nodes: b.nodes, edges: b.edges, assets: b.assets, runs: b.runs, approvals: b.approvals };
    const cg = byType(b, 'concept_generator').id;
    expect(opStatus(ctx, cg, 'directions').freshness).toBe('fresh');
    const changed = patchNode(b, byType(b, 'brief').id, { objective: 'Launch AND drive pre-orders' });
    expect((await saveGraph(s, owner, b, changed)).status).toBe(200);
    const after = await load(s, owner, project.id);
    const ctx2 = { nodes: after.nodes, edges: after.edges, assets: after.assets, runs: after.runs, approvals: after.approvals };
    expect(opStatus(ctx2, cg, 'directions').freshness).toBe('stale');
    expect(opStatus(ctx2, byType(after, 'shot_planner').id, 'plan').freshness).toBe('stale');
    // Moving a node is visual only: no freshness changes and nothing runs.
    const jobsBefore = after.jobs.length;
    const freshness = (bb: ProjectBundle) => {
      const c = { nodes: bb.nodes, edges: bb.edges, assets: bb.assets, runs: bb.runs, approvals: bb.approvals };
      return bb.nodes.flatMap((n) => getNodeDef(n.type).operations.map((o) => `${n.type}:${o.id}:${opStatus(c, n.id, o.id).freshness}`)).sort();
    };
    const before = freshness(after);
    const moved = after.nodes.map((n) => ({ ...n, position: { x: n.position.x + 300, y: n.position.y - 40 } }));
    expect((await saveGraph(s, owner, after, moved)).status).toBe(200);
    b = await load(s, owner, project.id);
    expect(freshness(b)).toEqual(before);
    expect(b.jobs.length).toBe(jobsBefore);
    expect(b.assets.filter((a) => a.role === 'concept')).toHaveLength(3);
  });

  it('invites the client, who sees the review but not jobs or the editor controls', async () => {
    const inv = await s.call<Invitation>('POST', `/api/projects/${project.id}/invitations`, { token: owner, body: { email: 'Marketing@Acme.sg', role: 'reviewer' } });
    expect(inv.status).toBe(201);
    const preview = await s.call<{ projectName: string; role: string; status: string }>('GET', `/api/invitations/${inv.body.token}`);
    expect(preview.body).toMatchObject({ projectName: 'Field Watch Q1', role: 'reviewer', status: 'pending' });
    const accepted = await s.call<{ projectId: string; role: string }>('POST', `/api/invitations/${inv.body.token}/accept`, { token: client });
    expect(accepted.body).toEqual({ projectId: project.id, role: 'reviewer' });
    const cb = await load(s, client, project.id);
    expect(cb.myRole).toBe('reviewer');
    expect(cb.jobs).toEqual([]); // RLS: reviewers never see job internals
    expect(cb.invitations).toEqual([]);
    expect(cb.assets.length).toBeGreaterThan(0);
    // ...and cannot run AI or edit the graph.
    expect((await s.call('POST', `/api/nodes/${byType(cb, 'concept_generator').id}/run`, { token: client, body: { operation: 'directions' } })).status).toBe(403);
    expect((await saveGraph(s, client, cb, cb.nodes)).status).toBe(403);
  });

  it('records version-specific approvals; an edit needs its own approval', async () => {
    const concepts = b.assets.filter((a) => a.role === 'concept');
    const poses = b.assets.filter((a) => a.role === 'pose');
    expect((await s.call('POST', `/api/assets/${concepts[0]!.id}/approvals`, { token: client, body: { decision: 'approved' } })).status).toBe(201);
    expect((await s.call('POST', `/api/assets/${poses[0]!.id}/approvals`, { token: client, body: { decision: 'approved', comment: 'Love this' } })).status).toBe(201);
    const noComment = await s.call('POST', `/api/assets/${concepts[1]!.id}/approvals`, { token: client, body: { decision: 'changes_requested' } });
    expect(noComment.status).toBe(400);
    expect((await s.call('POST', `/api/assets/${concepts[1]!.id}/approvals`, { token: client, body: { decision: 'changes_requested', comment: 'Warmer background please' } })).status).toBe(201);
    // Uploaded originals are not up for approval.
    const upload = b.assets.find((a) => a.sourceType === 'upload')!;
    expect((await s.call('POST', `/api/assets/${upload.id}/approvals`, { token: client, body: { decision: 'approved' } })).status).toBe(400);
    expect((await s.call('POST', `/api/assets/${concepts[1]!.id}/comments`, { token: client, body: { body: 'Maybe golden hour?' } })).status).toBe(201);

    // Editor responds with an edit of the rejected concept → v2 of that lineage.
    const edit = makeNode(project.id, 'image_edit', { x: 1300, y: 900 }, b.project.ownerId, { sourceAssetId: concepts[1]!.id, instruction: 'warmer background' });
    const cg = byType(b, 'concept_generator');
    const approval = byType(b, 'approval');
    const edges = [...b.edges, makeEdge(project.id, cg, 'images', edit, 'images'), makeEdge(project.id, edit, 'images', approval, 'images')];
    expect((await saveGraph(s, owner, b, [...b.nodes, edit], edges)).status).toBe(200);
    b = await load(s, owner, project.id);
    expect((await runOp(s, owner, edit.id, 'edit')).job.status).toBe('succeeded');
    b = await load(s, owner, project.id);
    const v2 = b.assets.find((a) => a.role === 'edit')!;
    expect(v2).toMatchObject({ version: 2, versionOf: concepts[1]!.id, parentAssetId: concepts[1]!.id });
    // The old decision is kept on record; the new version starts pending.
    expect(b.approvals.filter((a) => a.assetId === concepts[1]!.id)).toHaveLength(1);
    expect(b.approvals.some((a) => a.assetId === v2.id)).toBe(false);
    expect((await s.call('POST', `/api/assets/${v2.id}/approvals`, { token: client, body: { decision: 'approved' } })).status).toBe(201);
  });

  it('exports a final PDF with only approved work, stored before success', async () => {
    const exportNode = byType(b, 'export');
    expect((await saveGraph(s, owner, b, patchNode(b, exportNode.id, { mode: 'final', title: 'Field Watch preshoot pack' }))).status).toBe(200);
    b = await load(s, owner, project.id);
    const r = await s.call<{ job: { id: string } }>('POST', `/api/projects/${project.id}/exports`, { token: owner, body: {} });
    expect(r.status).toBe(202);
    await s.rt.engine.whenIdle();
    const ex = await s.call<{ job: { status: string; error: unknown }; url: string; assetId: string }>('GET', `/api/exports/${r.body.job.id}`, { token: owner });
    expect(ex.body.job.status).toBe('succeeded');
    expect(ex.body.url).toMatch(/^\/api\/files\/.+\.pdf\?/);
    const pdf = await s.rt.app.request(ex.body.url);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toMatch(/attachment; filename=".+\.pdf"/);
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    const pages = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(6);
    // Images were embedded (JPEG via sharp) and the draft watermark is absent from a final pack.
    expect(text).toMatch(/\/Subtype \/Image/);
    expect(text).not.toMatch(/\(DRAFT\)/);

    // The client can download the final pack too, but cannot create one.
    const cb = await load(s, client, project.id);
    const pack = cb.assets.find((a) => a.role === 'export')!;
    expect((await s.call<{ url: string }>('GET', `/api/assets/${pack.id}/url?download=1`, { token: client })).status).toBe(200);
    expect((await s.call('POST', `/api/projects/${project.id}/exports`, { token: client, body: {} })).status).toBe(403);
  });

  it('keeps an activity history of the whole workflow', async () => {
    const final = await load(s, owner, project.id);
    const actions = new Set(final.activity.map((a) => a.action));
    for (const a of ['project.create', 'asset.upload', 'graph.update', 'job.submit', 'job.succeeded', 'member.invite', 'member.join', 'approval.approved', 'approval.changes_requested', 'comment.create', 'export.create'])
      expect(actions, a).toContain(a);
  });
});
