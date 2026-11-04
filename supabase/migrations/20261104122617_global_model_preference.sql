-- One shared model choice across all authenticated accounts and devices.
create table if not exists public.vivian_model_preferences (
  id text primary key check (id = 'global'),
  selected_model_id text not null,
  last_selected_at timestamptz not null default now(),
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now()
);

alter table public.vivian_model_preferences enable row level security;
revoke all on public.vivian_model_preferences from public, anon, authenticated;
grant select, insert, update on public.vivian_model_preferences to service_role;
