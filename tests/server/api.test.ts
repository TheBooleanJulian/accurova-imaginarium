import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Asset, Invitation, Project, ProjectBundle } from '@/core/types';
import { byType, hasPg, load, patchNode, saveGraph, startServer, testImage, upload, type TestServer } from './helpers';

describe.skipIf(!hasPg)('API: permissions, uploads, graph saves', () => {
  let s: TestServer;
  const t: Record<string, string> = {};
  let project: Project;
  let b: ProjectBundle;
  let concept: Asset;

  beforeAll(async () => {
    s = await startServer();
    for (const who of ['owner', 'editor', 'client', 'viewer', 'outsider']) t[who] = await s.login(`${who}@studio.sg`, who);
    project = (await s.call<Project>('POST', '/api/projects', { token: t.owner, body: { name: 'Perms', client: 'Acme' } })).body;
    for (const [who, role] of [['editor', 'editor'], ['client', 'reviewer'], ['viewer', 'viewer']] as const) {
      const inv = await s.call<Invitation>('POST', `/api/projects/${project.id}/invitations`, { token: t.owner, body: { email: `${who}@studio.sg`, role } });
      expect((await s.call('POST', `/api/invitations/${inv.body.token}/accept`, { token: t[who] })).status).toBe(200);
    }
    b = await load(s, t.owner, project.id);
    // One generated concept to review.
    const cg = byType(b, 'concept_generator');
    await saveGraph(s, t.owner, b, patchNode(b, cg.id, { selectedDirection: 0, variations: 1 }));
    await s.call('POST', `/api/nodes/${cg.id}/run`, { token: t.owner, body: { operation: 'directions' } });
    await s.rt.engine.whenIdle();
    await s.call('POST', `/api/nodes/${cg.id}/run`, { token: t.owner, body: { operation: 'render' } });
    await s.rt.engine.whenIdle();
    b = await load(s, t.owner, project.id);
    concept = b.assets.find((a) => a.role === 'concept')!;
  });
  afterAll(async () => s?.close());

  it('requires authentication', async () => {
    expect((await s.call('GET', '/api/projects')).status).toBe(401);
    expect((await s.call('GET', '/api/projects', { token: 'garbage' })).status).toBe(401);
    expect((await s.call('GET', '/api/health')).status).toBe(200);
    const cfg = await s.call<{ authMode: string; providerLabel: string }>('GET', '/api/config');
    expect(cfg.body).toMatchObject({ authMode: 'dev', providerLabel: 'Mock (test)' });
    // Server secrets and provider credentials never appear in public config.
    const pub = JSON.stringify(cfg.body);
    for (const secret of [s.rt.cfg.devAuthSecret, s.rt.cfg.signingSecret]) expect(pub).not.toContain(secret);
    expect(pub).not.toMatch(/service.?role|openai.?api|sk-/i);
  });

  it('hides projects from outsiders with 404 (no existence leak)', async () => {
    expect((await s.call('GET', `/api/projects/${project.id}`, { token: t.outsider })).status).toBe(404);
    expect((await s.call('GET', `/api/projects/${project.id}/changes`, { token: t.outsider })).status).toBe(404);
    expect((await s.call('GET', `/api/assets/${concept.id}/url`, { token: t.outsider })).status).toBe(404);
    expect((await s.call('POST', `/api/assets/${concept.id}/approvals`, { token: t.outsider, body: { decision: 'approved' } })).status).toBe(404);
    expect((await s.call('POST', `/api/assets/${concept.id}/comments`, { token: t.outsider, body: { body: 'hi' } })).status).toBe(404);
    expect((await s.call('GET', `/api/projects`, { token: t.outsider })).body).toEqual([]);
    const job = b.jobs[0]!;
    expect((await s.call('GET', `/api/jobs/${job.id}`, { token: t.outsider })).status).toBe(404);
    expect((await s.call('GET', `/api/projects/not-a-uuid`, { token: t.owner })).status).toBe(404);
  });

  it('enforces the role matrix on every write', async () => {
    const cg = byType(b, 'concept_generator');
    const run = (who: string) => s.call('POST', `/api/nodes/${cg.id}/run`, { token: t[who], body: { operation: 'directions', force: true } });
    expect((await run('client')).status).toBe(403);
    expect((await run('viewer')).status).toBe(403);
    expect([200, 202]).toContain((await run('editor')).status);
    await s.rt.engine.whenIdle();

    const rename = (who: string) => s.call('PATCH', `/api/projects/${project.id}`, { token: t[who], body: { name: `By ${who}` } });
    expect((await rename('client')).status).toBe(403);
    expect((await rename('editor')).status).toBe(200);

    const invite = (who: string) => s.call('POST', `/api/projects/${project.id}/invitations`, { token: t[who], body: { email: 'new@x.sg', role: 'viewer' } });
    expect((await invite('editor')).status).toBe(403);
    expect((await invite('client')).status).toBe(403);

    const comment = (who: string) => s.call('POST', `/api/assets/${concept.id}/comments`, { token: t[who], body: { body: `from ${who}` } });
    expect((await comment('viewer')).status).toBe(403);
    expect((await comment('client')).status).toBe(201);

    const approve = (who: string) => s.call('POST', `/api/assets/${concept.id}/approvals`, { token: t[who], body: { decision: 'approved' } });
    expect((await approve('viewer')).status).toBe(403);
    expect((await approve('client')).status).toBe(201);

    expect((await s.call('DELETE', `/api/projects/${project.id}`, { token: t.editor })).status).toBe(403);

    const up = await upload(s, t.client, project.id, await testImage(), { role: 'product' });
    expect(up.status).toBe(403);

    // Viewers read, but see no jobs.
    const vb = await load(s, t.viewer, project.id);
    expect(vb.myRole).toBe('viewer');
    expect(vb.jobs).toEqual([]);
    expect(vb.assets.some((a) => a.id === concept.id)).toBe(true);
  });

  it('lets only the owner manage members, never removing the owner', async () => {
    const ob = await load(s, t.owner, project.id);
    const viewer = ob.members.find((m) => m.role === 'viewer')!;
    const owner = ob.members.find((m) => m.role === 'owner')!;
    expect((await s.call('PATCH', `/api/members/${viewer.id}`, { token: t.editor, body: { role: 'editor' } })).status).toBe(403);
    expect((await s.call('PATCH', `/api/members/${viewer.id}`, { token: t.owner, body: { role: 'owner' } })).status).toBe(400);
    expect((await s.call('DELETE', `/api/members/${owner.id}`, { token: t.owner })).status).toBe(400);
    expect((await s.call('PATCH', `/api/members/${viewer.id}`, { token: t.owner, body: { role: 'reviewer' } })).status).toBe(204);
    expect((await load(s, t.viewer, project.id)).myRole).toBe('reviewer');
    expect((await s.call('DELETE', `/api/members/${viewer.id}`, { token: t.owner })).status).toBe(204);
    expect((await s.call('GET', `/api/projects/${project.id}`, { token: t.viewer })).status).toBe(404);
  });

  it('handles invitations: wrong email, revoked, re-invite', async () => {
    const inv = (await s.call<Invitation>('POST', `/api/projects/${project.id}/invitations`, { token: t.owner, body: { email: 'outsider@studio.sg', role: 'reviewer' } })).body;
    expect(inv.token.length).toBeGreaterThanOrEqual(40);
    expect((await s.call('POST', `/api/invitations/${inv.token}/accept`, { token: t.client })).status).toBe(403);
    expect((await s.call('DELETE', `/api/invitations/${inv.id}`, { token: t.owner })).status).toBe(204);
    expect((await s.call<{ status: string }>('GET', `/api/invitations/${inv.token}`)).body.status).toBe('revoked');
    expect((await s.call('POST', `/api/invitations/${inv.token}/accept`, { token: t.outsider })).status).toBe(400);
    expect((await s.call('GET', `/api/invitations/${'x'.repeat(43)}`)).status).toBe(404);
    // Existing members can't be invited again.
    expect((await s.call('POST', `/api/projects/${project.id}/invitations`, { token: t.owner, body: { email: 'editor@studio.sg', role: 'viewer' } })).status).toBe(400);
  });

  describe('uploads', () => {
    it('accepts real images, records dimensions, makes a thumbnail', async () => {
      const r = await upload(s, t.editor, project.id, await testImage('png', 300, 200), { role: 'reference', contentType: 'image/png', filename: 'ref.png' });
      expect(r.status).toBe(201);
      const a = r.body as Asset & { thumbKey?: string };
      expect(a).toMatchObject({ mimeType: 'image/png', width: 300, height: 200, sourceType: 'upload', role: 'reference', originalFilename: 'ref.png' });
      expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const thumb = await s.call<{ url: string }>('GET', `/api/assets/${a.id}/url?variant=thumb`, { token: t.client });
      const res = await s.rt.app.request(thumb.body.url);
      expect(res.headers.get('content-type')).toBe('image/webp');
    });

    it('rejects files that are not really JPEG/PNG/WebP, whatever they claim', async () => {
      const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
      const r1 = await upload(s, t.editor, project.id, html, { contentType: 'image/png', filename: 'evil.png' });
      expect(r1.status).toBe(400);
      expect(JSON.stringify(r1.body)).toMatch(/not a readable image|Unsupported/);
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>');
      const r2 = await upload(s, t.editor, project.id, svg, { contentType: 'image/png', filename: 'vector.png' });
      expect(r2.status).toBe(400);
      // Declared types other than JPEG/PNG/WebP are refused before upload.
      const r3 = await s.call('POST', `/api/projects/${project.id}/assets/upload-url`, { token: t.editor, body: { filename: 'x.gif', contentType: 'image/gif', size: 10, role: 'reference' } });
      expect(r3.status).toBe(400);
    });

    it('enforces the size limit and upload token ownership', async () => {
      const big = await s.call('POST', `/api/projects/${project.id}/assets/upload-url`, { token: t.editor, body: { filename: 'big.jpg', contentType: 'image/jpeg', size: 50 * 1024 * 1024, role: 'product' } });
      expect(big.status).toBe(400);
      const ok = await s.call<{ uploadToken: string; upload: { url: string } }>('POST', `/api/projects/${project.id}/assets/upload-url`, {
        token: t.editor,
        body: { filename: 'a.jpg', contentType: 'image/jpeg', size: 1000, role: 'product' },
      });
      // Someone else cannot finalize my upload.
      expect((await s.call('POST', `/api/projects/${project.id}/assets`, { token: t.owner, body: { uploadToken: ok.body.uploadToken } })).status).toBe(403);
      // Tampered tokens are refused.
      expect((await s.call('POST', `/api/projects/${project.id}/assets`, { token: t.editor, body: { uploadToken: ok.body.uploadToken.replace(/.$/, 'x') } })).status).toBe(400);
      // A signed upload URL caps the body size.
      const tooBig = new Uint8Array(21 * 1024 * 1024);
      const put = await s.rt.app.request(ok.body.upload.url, { method: 'PUT', body: tooBig });
      expect(put.status).toBe(413);
    });

    it('signed file URLs expire and cannot be altered', async () => {
      const r = await s.call<{ url: string }>('GET', `/api/assets/${concept.id}/url`, { token: t.client });
      expect((await s.rt.app.request(r.body.url)).status).toBe(200);
      expect((await s.rt.app.request(r.body.url.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
      expect((await s.rt.app.request(r.body.url.replace(/exp=\d+/, 'exp=1'))).status).toBe(403);
      const other = r.body.url.replace(/\/api\/files\/[^?]+/, `/api/files/${project.id}/uploads/../../etc/passwd`);
      expect([400, 403, 404]).toContain((await s.rt.app.request(other)).status);
    });
  });

  describe('graph saves', () => {
    it('rejects a stale revision with 409 and the current revision', async () => {
      const cur = await load(s, t.owner, project.id);
      expect((await saveGraph(s, t.owner, cur, cur.nodes)).status).toBe(200);
      const r = await saveGraph(s, t.editor, cur, cur.nodes);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'conflict', serverRevision: cur.project.graphRevision + 1 });
    });

    it('validates node settings, port types and cycles on the server', async () => {
      const cur = await load(s, t.owner, project.id);
      const cg = byType(cur, 'concept_generator');
      expect((await saveGraph(s, t.owner, cur, patchNode(cur, cg.id, { variations: 99 }))).status).toBe(400);
      const pose = byType(cur, 'pose_generator');
      const cyclic = [...cur.edges, { id: crypto.randomUUID(), projectId: cur.project.id, source: pose.id, sourcePort: 'images', target: cg.id, targetPort: 'images' }];
      const r1 = await saveGraph(s, t.owner, cur, cur.nodes, cyclic);
      expect(r1.status).toBe(400);
      expect(JSON.stringify(r1.body)).toMatch(/cycle/);
      const wrongType = [...cur.edges, { id: crypto.randomUUID(), projectId: cur.project.id, source: byType(cur, 'brief').id, sourcePort: 'brief', target: pose.id, targetPort: 'images' }];
      expect((await saveGraph(s, t.owner, cur, cur.nodes, wrongType)).status).toBe(400);
      const changedType = cur.nodes.map((n) => (n.id === cg.id ? { ...n, type: 'text' as const, data: {} } : n));
      expect((await saveGraph(s, t.owner, cur, changedType, [])).status).toBe(400);
    });

    it('refuses node ids that belong to another project', async () => {
      const other = (await s.call<Project>('POST', '/api/projects', { token: t.outsider, body: { name: 'Other', client: 'X' } })).body;
      const ob = await load(s, t.outsider, other.id);
      const cur = await load(s, t.owner, project.id);
      const hijack = [...cur.nodes, { ...ob.nodes[0]!, position: { x: 1, y: 1 } }];
      const r = await saveGraph(s, t.owner, cur, hijack);
      expect(r.status).toBe(400);
      const after = await load(s, t.outsider, other.id);
      expect(after.nodes[0]!.position).toEqual(ob.nodes[0]!.position);
    });

    it('persists positions, sizes and data exactly, and restores them', async () => {
      const cur = await load(s, t.owner, project.id);
      const nodes = cur.nodes.map((n, i) => ({ ...n, position: { x: 100 * i, y: 50 * i }, size: n.type === 'text' ? { width: 400, height: 300 } : n.size }));
      const brief = byType(cur, 'brief');
      const withData = nodes.map((n) => (n.id === brief.id ? { ...n, data: { ...n.data, constraints: 'No drones · 无人机' } } : n));
      expect((await saveGraph(s, t.owner, cur, withData)).status).toBe(200);
      const again = await load(s, t.owner, project.id);
      expect(again.nodes.map((n) => n.position)).toEqual(withData.map((n) => n.position));
      expect(byType(again, 'brief').data.constraints).toBe('No drones · 无人机');
    });
  });
});
