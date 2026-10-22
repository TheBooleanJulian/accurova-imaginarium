import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../server/db/index';
import { freshDatabase, hasPg } from './helpers';

/**
 * Row-level security, tested directly against Postgres as the Supabase
 * `authenticated` role, i.e. what a client holding a valid JWT could do even
 * if it bypassed the API entirely.
 */
describe.skipIf(!hasPg)('row level security', () => {
  let db: Db;
  let drop: () => Promise<void>;
  const u: Record<string, string> = {};
  let projA: string;
  let projB: string;
  let nodeA: string;
  let assetA: string;
  let jobA: string;

  const as = <T>(who: string, sql: string, params: unknown[] = []) => db.asUser(u[who]!, (q) => q.query<Record<string, T>>(sql, params));
  const denied = async (who: string, sql: string, params: unknown[] = []) => {
    try {
      const rows = await as(who, sql, params);
      return rows.length === 0 ? 'no-rows' : 'allowed';
    } catch (e) {
      return /row-level security|permission denied/.test((e as Error).message) ? 'denied' : `error: ${(e as Error).message}`;
    }
  };

  beforeAll(async () => {
    ({ db, drop } = await freshDatabase());
    for (const name of ['owner', 'editor', 'client', 'viewer', 'outsider']) {
      const [r] = await db.query<{ id: string }>(`insert into auth.users (email) values ($1) returning id`, [`${name}@test.sg`]);
      u[name] = r!.id;
    }
    projA = String((await as('owner', `insert into projects (owner_id, name) values ($1, 'A') returning id`, [u.owner]))[0]!.id);
    projB = String((await as('outsider', `insert into projects (owner_id, name) values ($1, 'B') returning id`, [u.outsider]))[0]!.id);
    for (const [who, role] of [['editor', 'editor'], ['client', 'reviewer'], ['viewer', 'viewer']] as const) {
      await db.query(`insert into project_members (project_id, user_id, role) values ($1, $2, $3)`, [projA, u[who], role]);
    }
    nodeA = String((await as('editor', `insert into nodes (id, project_id, type) values (gen_random_uuid(), $1, 'brief') returning id`, [projA]))[0]!.id);
    assetA = String(
      (
        await db.query(
          `insert into assets (project_id, storage_key, mime_type, size_bytes, role, source_type, content_hash, created_by)
           values ($1, $2, 'image/png', 10, 'concept', 'ai_generated', 'h', $3) returning id`,
          [projA, `${projA}/generated/x.png`, u.owner],
        )
      )[0]!.id,
    );
    jobA = String(
      (
        await db.query(
          `insert into generation_jobs (id, project_id, node_id, node_type, operation, status, provider, model, input_snapshot, input_hash, prompt_version, idempotency_key, requested_by)
           values (gen_random_uuid(), $1, $2, 'brief', 'x', 'succeeded', 'mock', 'm', '{}', 'h', 'v', 'k1', $3) returning id`,
          [projA, nodeA, u.owner],
        )
      )[0]!.id,
    );
    await db.query(`insert into node_runs (id, job_id, project_id, node_id, operation, input_hash) values (gen_random_uuid(), $1, $2, $3, 'x', 'h')`, [jobA, projA, nodeA]);
  });
  afterAll(async () => drop?.());

  it('the creator becomes the single owner member', async () => {
    const rows = await db.query(`select user_id, role from project_members where project_id = $1 and role = 'owner'`, [projA]);
    expect(rows).toEqual([{ user_id: u.owner, role: 'owner' }]);
    // A second owner is impossible.
    await expect(db.query(`insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')`, [projA, u.outsider])).rejects.toThrow();
  });

  it('outsiders see nothing from another client’s project', async () => {
    for (const table of ['projects', 'project_members', 'nodes', 'edges', 'assets', 'generation_jobs', 'node_runs', 'comments', 'approvals', 'activity_events', 'project_invitations']) {
      const col = table === 'projects' ? 'id' : 'project_id';
      const rows = await as('outsider', `select * from ${table} where ${col} = $1`, [projA]);
      expect(rows, table).toHaveLength(0);
    }
    // ...and every member sees their own project.
    for (const who of ['owner', 'editor', 'client', 'viewer']) expect(await as(who, `select id from projects`)).toHaveLength(1);
    expect((await as('owner', `select id from projects where id = $1`, [projB])).length).toBe(0);
  });

  it('outsiders cannot write into another project', async () => {
    expect(await denied('outsider', `insert into nodes (id, project_id, type) values (gen_random_uuid(), $1, 'brief') returning id`, [projA])).toBe('denied');
    expect(await denied('outsider', `insert into comments (project_id, author_id, body) values ($1, $2, 'hi') returning id`, [projA, u.outsider])).toBe('denied');
    expect(await denied('outsider', `update projects set name = 'pwned' where id = $1 returning id`, [projA])).toBe('no-rows');
    expect(await denied('outsider', `delete from nodes where project_id = $1 returning id`, [projA])).toBe('no-rows');
    expect(await denied('outsider', `insert into project_members (project_id, user_id, role) values ($1, $2, 'editor') returning id`, [projA, u.outsider])).toBe('denied');
  });

  it('only owners and editors change the graph', async () => {
    expect(await denied('editor', `update nodes set data = '{"x":1}' where id = $1 returning id`, [nodeA])).toBe('allowed');
    for (const who of ['client', 'viewer']) {
      expect(await denied(who, `update nodes set data = '{"x":2}' where id = $1 returning id`, [nodeA]), who).toBe('no-rows');
      expect(await denied(who, `insert into nodes (id, project_id, type) values (gen_random_uuid(), $1, 'text') returning id`, [projA]), who).toBe('denied');
    }
  });

  it('jobs are visible to owners and editors only; nobody can write them directly', async () => {
    expect(await as('editor', `select id from generation_jobs`)).toHaveLength(1);
    expect(await as('client', `select id from generation_jobs`)).toHaveLength(0);
    expect(await as('viewer', `select id from generation_jobs`)).toHaveLength(0);
    // Run outputs are visible to every member (the review screen needs them).
    expect(await as('client', `select id from node_runs`)).toHaveLength(1);
    expect(
      await denied('editor', `insert into generation_jobs (id, project_id, node_id, node_type, operation, status, provider, model, input_snapshot, input_hash, prompt_version, idempotency_key, requested_by) values (gen_random_uuid(), $1, $2, 'brief', 'x', 'queued', 'mock', 'm', '{}', 'h', 'v', 'k2', $3) returning id`, [projA, nodeA, u.editor]),
    ).toBe('denied');
    expect(await denied('editor', `update generation_jobs set status = 'succeeded' where id = $1 returning id`, [jobA])).toBe('no-rows');
  });

  it('clients comment and approve as themselves; viewers cannot', async () => {
    expect(await denied('client', `insert into comments (project_id, asset_id, author_id, body) values ($1, $2, $3, 'nice') returning id`, [projA, assetA, u.client])).toBe('allowed');
    expect(await denied('client', `insert into comments (project_id, author_id, body) values ($1, $2, 'spoofed') returning id`, [projA, u.owner])).toBe('denied');
    expect(await denied('viewer', `insert into comments (project_id, author_id, body) values ($1, $2, 'hi') returning id`, [projA, u.viewer])).toBe('denied');
    expect(
      await denied('client', `insert into approvals (project_id, asset_id, asset_version, reviewer_id, reviewer_role, decision) values ($1, $2, 1, $3, 'reviewer', 'approved') returning id`, [projA, assetA, u.client]),
    ).toBe('allowed');
    // Cannot claim a more powerful role on the approval record.
    expect(
      await denied('client', `insert into approvals (project_id, asset_id, asset_version, reviewer_id, reviewer_role, decision) values ($1, $2, 1, $3, 'owner', 'approved') returning id`, [projA, assetA, u.client]),
    ).toBe('denied');
    expect(
      await denied('viewer', `insert into approvals (project_id, asset_id, asset_version, reviewer_id, reviewer_role, decision) values ($1, $2, 1, $3, 'reviewer', 'approved') returning id`, [projA, assetA, u.viewer]),
    ).toBe('denied');
    // Approval history is append-only, even for the owner.
    expect(await denied('owner', `update approvals set decision = 'changes_requested' where project_id = $1 returning id`, [projA])).toBe('no-rows');
    expect(await denied('owner', `delete from approvals where project_id = $1 returning id`, [projA])).toBe('no-rows');
    // Changes requested must say what to change.
    await expect(
      as('client', `insert into approvals (project_id, asset_id, asset_version, reviewer_id, reviewer_role, decision) values ($1, $2, 1, $3, 'reviewer', 'changes_requested')`, [projA, assetA, u.client]),
    ).rejects.toThrow(/check constraint/);
  });

  it('a reviewer cannot resolve comments or upload; an editor can', async () => {
    expect(await denied('client', `update comments set resolved = true where project_id = $1 returning id`, [projA])).toBe('no-rows');
    expect(await denied('editor', `update comments set resolved = true where project_id = $1 returning id`, [projA])).toBe('allowed');
    const up = (who: string) =>
      denied(who, `insert into assets (project_id, storage_key, mime_type, size_bytes, role, source_type, content_hash, created_by) values ($1, $2, 'image/jpeg', 1, 'product', 'upload', 'h', $3) returning id`, [
        projA,
        `${projA}/uploads/${who}`,
        u[who],
      ]);
    expect(await up('client')).toBe('denied');
    expect(await up('editor')).toBe('allowed');
    // Nobody can insert "AI generated" assets directly: only the worker writes those.
    expect(
      await denied('editor', `insert into assets (project_id, storage_key, mime_type, size_bytes, role, source_type, content_hash, created_by) values ($1, $2, 'image/png', 1, 'concept', 'ai_generated', 'h', $3) returning id`, [projA, `${projA}/generated/fake`, u.editor]),
    ).toBe('denied');
  });

  it('only the owner manages membership, and the owner row is untouchable', async () => {
    expect(await denied('editor', `update project_members set role = 'owner' where user_id = $1 returning id`, [u.editor])).toBe('no-rows');
    expect(await denied('client', `update project_members set role = 'editor' where user_id = $1 returning id`, [u.client])).toBe('no-rows');
    expect(await denied('owner', `update project_members set role = 'viewer' where user_id = $1 returning id`, [u.owner])).toBe('no-rows');
    expect(await denied('owner', `update project_members set role = 'editor' where user_id = $1 returning id`, [u.viewer])).toBe('allowed');
    expect(await denied('editor', `insert into project_invitations (project_id, email, role, token, created_by) values ($1, 'x@y.sg', 'reviewer', repeat('a', 40), $2) returning id`, [projA, u.editor])).toBe('denied');
    expect(await denied('owner', `insert into project_invitations (project_id, email, role, token, created_by) values ($1, 'x@y.sg', 'reviewer', repeat('b', 40), $2) returning id`, [projA, u.owner])).toBe('allowed');
    expect(await as('editor', `select id from project_invitations`)).toHaveLength(0);
  });

  it('invitations can only be accepted by the invited email, once', async () => {
    await db.query(`insert into project_invitations (project_id, email, role, token, created_by) values ($1, 'outsider@test.sg', 'viewer', repeat('c', 40), $2)`, [projA, u.owner]);
    await expect(as('editor', `select * from accept_invitation(repeat('c', 40))`)).rejects.toThrow(/for outsider@test.sg/);
    const r = await as('outsider', `select * from accept_invitation(repeat('c', 40))`);
    expect(r).toEqual([{ project_id: projA, role: 'viewer' }]);
    await expect(as('outsider', `select * from accept_invitation(repeat('c', 40))`)).rejects.toThrow(/has been accepted/);
    expect(await as('outsider', `select id from projects where id = $1`, [projA])).toHaveLength(1);
    // Expired links are refused.
    await db.query(`insert into project_invitations (project_id, email, role, token, created_by, expires_at) values ($1, 'late@test.sg', 'viewer', repeat('d', 40), $2, now() - interval '1 day')`, [projA, u.owner]);
    const [late] = await db.query<{ id: string }>(`insert into auth.users (email) values ('late@test.sg') returning id`);
    await expect(db.asUser(late!.id, (q) => q.query(`select * from accept_invitation(repeat('d', 40))`))).rejects.toThrow(/expired/);
  });

  it('composite keys stop rows pointing across projects', async () => {
    const [nodeB] = await db.query<{ id: string }>(`insert into nodes (id, project_id, type) values (gen_random_uuid(), $1, 'text') returning id`, [projB]);
    await expect(
      db.query(`insert into edges (id, project_id, source_node_id, source_port, target_node_id, target_port) values (gen_random_uuid(), $1, $2, 'brief', $3, 'text')`, [projA, nodeA, nodeB!.id]),
    ).rejects.toThrow(/foreign key/);
    await expect(db.query(`insert into comments (project_id, asset_id, author_id, body) values ($1, $2, $3, 'x')`, [projB, assetA, u.outsider])).rejects.toThrow(/foreign key/);
  });
});
