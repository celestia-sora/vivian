-- Per-account Live2D expression selections sync across the user's devices.
create table if not exists public.vivian_model_expression_preferences (
  user_id uuid not null,
  model_id uuid not null references public.vivian_storage_objects(id) on delete cascade,
  manifest_path text not null,
  expressions jsonb not null default '[]'::jsonb check (jsonb_typeof(expressions) = 'array'),
  updated_at timestamptz not null default now(),
  primary key (user_id, model_id, manifest_path)
);

alter table public.vivian_model_expression_preferences enable row level security;
revoke all on public.vivian_model_expression_preferences from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_model_expression_preferences to service_role;
