-- imaginarium:supabase-only
-- Private bucket for originals, generated images and PDF exports.
-- Object keys are "<project_id>/<...>", so policies can scope by project.
-- The API uses the service role and hands out short-lived signed URLs; these
-- policies protect direct access with a user's own token.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-assets', 'project-assets', false, 26214400, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false;

create or replace function public.try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

create policy "imaginarium members read project files" on storage.objects for select to authenticated
  using (bucket_id = 'project-assets' and public.is_project_member(public.try_uuid((storage.foldername(name))[1])));

create policy "imaginarium editors upload project files" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-assets' and public.has_project_role(public.try_uuid((storage.foldername(name))[1]), array['owner', 'editor']));
