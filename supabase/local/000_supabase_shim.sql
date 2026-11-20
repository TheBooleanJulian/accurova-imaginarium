-- Local stand-in for the parts of Supabase the migrations rely on.
-- Applied by `npm run db:migrate` ONLY when auth.users does not exist (plain
-- Postgres / PGlite). Never runs against a real Supabase project.

create schema if not exists auth;

-- Roles are cluster-wide and parallel test files each run this shim, so a plain
-- "if not exists" check can race. Swallow the duplicate-role error instead.
do $$
begin
  begin create role anon nologin noinherit; exception when duplicate_object or unique_violation then null; end;
  begin create role authenticated nologin noinherit; exception when duplicate_object or unique_violation then null; end;
  begin create role service_role nologin noinherit bypassrls; exception when duplicate_object or unique_violation then null; end;
end $$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Same contract as Supabase: the caller's id comes from the request's JWT claims.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
