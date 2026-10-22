-- Accurova Imaginarium — row level security.
--
-- Mirrors the role matrix in src/core/permissions.ts:
--   owner    everything, incl. members and invitations
--   editor   graph, uploads, runs, exports, comments, approvals
--   reviewer read, comment, approve / request changes (the client)
--   viewer   read only
--
-- The API checks permissions too and runs user requests as the `authenticated`
-- role with the caller's JWT claims, so these policies are a second, independent
-- line of defence. The job worker uses the table-owner connection.

-- ---------------------------------------------------------------- membership helpers

create or replace function public.project_role(p_project uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.project_members where project_id = p_project and user_id = auth.uid()
$$;

create or replace function public.has_project_role(p_project uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.project_role(p_project) = any (p_roles), false)
$$;

create or replace function public.is_project_member(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.project_role(p_project) is not null
$$;

-- People you share at least one project with (so names show up in comments).
create or replace function public.shares_project_with(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.project_members me
    join public.project_members them on them.project_id = me.project_id
    where me.user_id = auth.uid() and them.user_id = p_user
  )
$$;

-- ---------------------------------------------------------------- enable RLS everywhere

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.project_invitations enable row level security;
alter table public.nodes enable row level security;
alter table public.edges enable row level security;
alter table public.assets enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.node_runs enable row level security;
alter table public.comments enable row level security;
alter table public.approvals enable row level security;
alter table public.activity_events enable row level security;

-- ---------------------------------------------------------------- profiles

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_project_with(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------- projects

create policy projects_select on public.projects for select to authenticated
  using (owner_id = auth.uid() or public.is_project_member(id));
create policy projects_insert on public.projects for insert to authenticated
  with check (owner_id = auth.uid());
create policy projects_update on public.projects for update to authenticated
  using (public.has_project_role(id, array['owner', 'editor']))
  with check (public.has_project_role(id, array['owner', 'editor']));
create policy projects_delete on public.projects for delete to authenticated
  using (public.has_project_role(id, array['owner']));

-- ---------------------------------------------------------------- members & invitations (owner manages)

create policy members_select on public.project_members for select to authenticated
  using (public.is_project_member(project_id));
create policy members_update on public.project_members for update to authenticated
  using (public.has_project_role(project_id, array['owner']) and role <> 'owner')
  with check (public.has_project_role(project_id, array['owner']) and role <> 'owner');
create policy members_delete on public.project_members for delete to authenticated
  using (public.has_project_role(project_id, array['owner']) and role <> 'owner');
-- No insert policy: owners are added by trigger, everyone else by accept_invitation().

create policy invitations_select on public.project_invitations for select to authenticated
  using (public.has_project_role(project_id, array['owner']));
create policy invitations_insert on public.project_invitations for insert to authenticated
  with check (public.has_project_role(project_id, array['owner']) and created_by = auth.uid());
create policy invitations_update on public.project_invitations for update to authenticated
  using (public.has_project_role(project_id, array['owner']))
  with check (public.has_project_role(project_id, array['owner']));

-- ---------------------------------------------------------------- graph

create policy nodes_select on public.nodes for select to authenticated using (public.is_project_member(project_id));
create policy nodes_insert on public.nodes for insert to authenticated with check (public.has_project_role(project_id, array['owner', 'editor']));
create policy nodes_update on public.nodes for update to authenticated
  using (public.has_project_role(project_id, array['owner', 'editor']))
  with check (public.has_project_role(project_id, array['owner', 'editor']));
create policy nodes_delete on public.nodes for delete to authenticated using (public.has_project_role(project_id, array['owner', 'editor']));

create policy edges_select on public.edges for select to authenticated using (public.is_project_member(project_id));
create policy edges_insert on public.edges for insert to authenticated with check (public.has_project_role(project_id, array['owner', 'editor']));
create policy edges_delete on public.edges for delete to authenticated using (public.has_project_role(project_id, array['owner', 'editor']));

-- ---------------------------------------------------------------- assets (immutable once written)

create policy assets_select on public.assets for select to authenticated using (public.is_project_member(project_id));
create policy assets_insert on public.assets for insert to authenticated
  with check (public.has_project_role(project_id, array['owner', 'editor']) and created_by = auth.uid() and source_type = 'upload');

-- ---------------------------------------------------------------- jobs & runs (written by the worker)

create policy jobs_select on public.generation_jobs for select to authenticated
  using (public.has_project_role(project_id, array['owner', 'editor']));
create policy runs_select on public.node_runs for select to authenticated using (public.is_project_member(project_id));

-- ---------------------------------------------------------------- review

create policy comments_select on public.comments for select to authenticated using (public.is_project_member(project_id));
create policy comments_insert on public.comments for insert to authenticated
  with check (author_id = auth.uid() and public.has_project_role(project_id, array['owner', 'editor', 'reviewer']));
create policy comments_update on public.comments for update to authenticated
  using (public.has_project_role(project_id, array['owner', 'editor']))
  with check (public.has_project_role(project_id, array['owner', 'editor']));

create policy approvals_select on public.approvals for select to authenticated using (public.is_project_member(project_id));
create policy approvals_insert on public.approvals for insert to authenticated
  with check (
    reviewer_id = auth.uid()
    and public.has_project_role(project_id, array['owner', 'editor', 'reviewer'])
    and reviewer_role = public.project_role(project_id)
  );

create policy activity_select on public.activity_events for select to authenticated using (public.is_project_member(project_id));
create policy activity_insert on public.activity_events for insert to authenticated
  with check (actor_id = auth.uid() and public.is_project_member(project_id));

-- ---------------------------------------------------------------- invitations: preview + accept by token

-- Safe to call before signing in: reveals only what the invite link holder needs.
create or replace function public.preview_invitation(p_token text)
returns table (project_name text, client text, role text, email text, status text)
language sql stable security definer set search_path = public as $$
  select p.name, p.client, i.role, i.email,
         case when i.status = 'pending' and i.expires_at < now() then 'expired' else i.status end
  from public.project_invitations i join public.projects p on p.id = i.project_id
  where i.token = p_token
$$;

create or replace function public.accept_invitation(p_token text)
returns table (project_id uuid, role text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  inv public.project_invitations%rowtype;
  me public.profiles%rowtype;
  existing text;
begin
  select * into me from public.profiles where id = auth.uid();
  if me.id is null then raise exception 'Please sign in first.' using errcode = '28000'; end if;
  select * into inv from public.project_invitations where token = p_token for update;
  if inv.id is null then raise exception 'This invitation link is not valid.' using errcode = 'P0002'; end if;
  if inv.status <> 'pending' then raise exception 'This invitation has been %.', inv.status using errcode = '22023'; end if;
  if inv.expires_at < now() then raise exception 'This invitation has expired. Ask for a new link.' using errcode = '22023'; end if;
  if lower(inv.email) <> lower(me.email) then
    raise exception 'This invitation is for %. Sign in with that email to accept it.', inv.email using errcode = '42501';
  end if;

  select m.role into existing from public.project_members m where m.project_id = inv.project_id and m.user_id = me.id;
  if existing is null then
    insert into public.project_members (project_id, user_id, role) values (inv.project_id, me.id, inv.role);
  end if;
  update public.project_invitations set status = 'accepted', accepted_at = now(), accepted_by = me.id where id = inv.id;
  insert into public.activity_events (project_id, actor_id, action, entity_type, entity_id, meta)
  values (inv.project_id, me.id, 'member.join', 'member', me.id::text, jsonb_build_object('role', coalesce(existing, inv.role)));
  return query select inv.project_id, coalesce(existing, inv.role);
end $$;

revoke all on function public.accept_invitation(text) from public;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.preview_invitation(text) to anon, authenticated;

-- ---------------------------------------------------------------- grants (Supabase sets these by default; explicit for plain Postgres)

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant execute on function public.project_role(uuid), public.has_project_role(uuid, text[]), public.is_project_member(uuid), public.shares_project_with(uuid) to authenticated;
