-- Shared Live2D model library for the beta window.
--
-- Every ready Live2D model becomes readable and deletable by any verified
-- account while MODEL_LIBRARY_SHARED is enabled (default on). The column keeps
-- the decision per object so access can be narrowed again after the beta by
-- setting MODEL_LIBRARY_SHARED=false, without touching data.
alter table public.vivian_storage_objects
  add column if not exists library_scope text not null default 'private'
  check (library_scope in ('private', 'shared'));

update public.vivian_storage_objects
  set library_scope = 'shared'
  where category = 'live2d' and state = 'ready' and library_scope = 'private';

create index if not exists vivian_storage_objects_library
  on public.vivian_storage_objects (library_scope, category, state, created_at);

-- Cross-account deletions are audited because any verified account may delete
-- a shared model. The row survives the object it describes.
create table if not exists public.vivian_model_deletions (
  id uuid primary key default gen_random_uuid(),
  object_id uuid not null,
  object_key text not null,
  owner_id uuid,
  deleted_by uuid not null,
  byte_size bigint not null,
  deleted_at timestamptz not null default now()
);
create index if not exists vivian_model_deletions_recent
  on public.vivian_model_deletions (deleted_at desc);
alter table public.vivian_model_deletions enable row level security;
revoke all on public.vivian_model_deletions from public, anon, authenticated;
grant select, insert on public.vivian_model_deletions to service_role;
