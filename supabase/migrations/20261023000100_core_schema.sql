-- Accurova Imaginarium — core schema.
--
-- Three kinds of state are kept apart on purpose:
--   visual state     → nodes.position / nodes.size
--   creative config  → nodes.data (validated per node type by the API)
--   execution state  → generation_jobs / node_runs (never stored on a node)
--
-- Every child table carries project_id and uses composite foreign keys, so a
-- row can never point at another project's node or asset.


-- ---------------------------------------------------------------- helpers

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (lower(email));
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
comment on table public.profiles is 'One row per Supabase Auth user; display data only.';

-- Create a profile whenever an auth user is created (Supabase sign-up, invite, dev login).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- projects & membership

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 200),
  client text not null default '' check (length(client) <= 200),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'archived')),
  -- Optimistic concurrency for graph saves: PUT /graph must send the revision it started from.
  graph_revision integer not null default 1 check (graph_revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_owner_idx on public.projects (owner_id);
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);
create index project_members_user_idx on public.project_members (user_id);
-- Exactly one owner per project.
create unique index project_members_one_owner on public.project_members (project_id) where role = 'owner';

-- The creator becomes the owner member in the same transaction.
create or replace function public.add_owner_membership() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.project_members (project_id, user_id, role) values (new.id, new.owner_id, 'owner')
  on conflict (project_id, user_id) do update set role = 'owner';
  return new;
end $$;
create trigger projects_owner_member after insert on public.projects for each row execute function public.add_owner_membership();

create table public.project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('editor', 'reviewer', 'viewer')),
  -- 256-bit random token. Readable only by the project owner (RLS); accepted via accept_invitation().
  token text not null unique check (length(token) >= 32),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id) on delete set null
);
create index project_invitations_project_idx on public.project_invitations (project_id);

-- ---------------------------------------------------------------- graph

create table public.nodes (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  type text not null check (type in (
    'brief', 'image_asset', 'reference_analysis', 'text', 'concept_generator',
    'pose_generator', 'image_edit', 'shot_planner', 'approval', 'export'
  )),
  schema_version integer not null default 1 check (schema_version >= 1),
  position jsonb not null default '{"x": 0, "y": 0}',
  size jsonb,
  data jsonb not null default '{}',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, id)
);
create index nodes_project_idx on public.nodes (project_id);

create table public.edges (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  source_node_id uuid not null,
  source_port text not null,
  target_node_id uuid not null,
  target_port text not null,
  created_at timestamptz not null default now(),
  foreign key (project_id, source_node_id) references public.nodes (project_id, id) on delete cascade,
  foreign key (project_id, target_node_id) references public.nodes (project_id, id) on delete cascade,
  unique (project_id, source_node_id, source_port, target_node_id, target_port),
  check (source_node_id <> target_node_id)
);
create index edges_project_idx on public.edges (project_id);

-- ---------------------------------------------------------------- assets (binary data lives in object storage)

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  storage_key text not null unique,
  thumb_key text,
  mime_type text not null,
  width integer check (width > 0),
  height integer check (height > 0),
  size_bytes bigint not null check (size_bytes >= 0),
  -- What it IS (drives fidelity labels): real product photo vs reference vs AI concept.
  role text not null check (role in ('product', 'brand', 'reference', 'concept', 'pose', 'edit', 'export')),
  -- Where it CAME FROM. ai_generated assets are never presented as facts about the real product.
  source_type text not null check (source_type in ('upload', 'ai_generated', 'export')),
  parent_asset_id uuid,
  version_of uuid,
  version integer not null default 1 check (version >= 1),
  node_id uuid,
  job_id uuid,
  label text,
  prompt text,
  original_filename text,
  content_hash text not null,
  provenance jsonb not null default '{}',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, id),
  foreign key (project_id, parent_asset_id) references public.assets (project_id, id),
  foreign key (project_id, version_of) references public.assets (project_id, id),
  check ((source_type = 'upload') = (role in ('product', 'brand', 'reference')))
);
create index assets_project_idx on public.assets (project_id, created_at);
create index assets_lineage_idx on public.assets (version_of);

-- ---------------------------------------------------------------- jobs (durable queue) & runs

create table public.generation_jobs (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  -- No FK: a job's history outlives the node it ran for.
  node_id uuid not null,
  node_type text not null,
  operation text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  provider text not null,
  model text not null,
  input_snapshot jsonb not null,
  input_hash text not null,
  prompt_version text not null,
  idempotency_key text not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts >= 1),
  error jsonb,
  output_asset_ids jsonb not null default '[]',
  usage jsonb,
  requested_by uuid not null references public.profiles (id),
  cancel_requested boolean not null default false,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (project_id, idempotency_key)
);
-- Duplicate-request prevention: at most one live job per node operation.
create unique index generation_jobs_one_active on public.generation_jobs (node_id, operation) where status in ('queued', 'running');
create index generation_jobs_claim_idx on public.generation_jobs (run_after) where status = 'queued';
create index generation_jobs_project_idx on public.generation_jobs (project_id, created_at desc);
create index generation_jobs_usage_idx on public.generation_jobs (requested_by, created_at) where provider <> 'internal';

alter table public.assets
  add constraint assets_job_fk foreign key (job_id) references public.generation_jobs (id) on delete set null;

create table public.node_runs (
  id uuid primary key,
  job_id uuid not null unique references public.generation_jobs (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  node_id uuid not null,
  operation text not null,
  input_hash text not null,
  output_asset_ids jsonb not null default '[]',
  output jsonb,
  completed_at timestamptz not null default now()
);
create index node_runs_project_idx on public.node_runs (project_id, completed_at);

-- ---------------------------------------------------------------- review

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  asset_id uuid,
  node_id uuid,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 4000),
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, asset_id) references public.assets (project_id, id) on delete cascade
);
create index comments_project_idx on public.comments (project_id, created_at);
create trigger comments_touch before update on public.comments for each row execute function public.touch_updated_at();

-- Append-only: a new decision is a new row; history is never rewritten.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  asset_id uuid not null,
  asset_version integer not null,
  reviewer_id uuid not null references public.profiles (id) on delete cascade,
  reviewer_role text not null check (reviewer_role in ('owner', 'editor', 'reviewer')),
  decision text not null check (decision in ('approved', 'changes_requested')),
  comment text check (comment is null or length(comment) <= 4000),
  created_at timestamptz not null default now(),
  foreign key (project_id, asset_id) references public.assets (project_id, id) on delete cascade,
  check (decision = 'approved' or length(btrim(coalesce(comment, ''))) > 0)
);
create index approvals_project_idx on public.approvals (project_id, created_at);
create index approvals_asset_idx on public.approvals (asset_id, created_at);

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index activity_events_project_idx on public.activity_events (project_id, created_at desc);
