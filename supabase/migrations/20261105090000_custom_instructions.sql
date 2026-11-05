-- One shared custom-instructions value for all authorized accounts and devices.
-- localStorage remains an offline cache; once a device completes its first
-- sync, the cloud row is authoritative.
create table if not exists public.vivian_custom_instructions (
  id text primary key check (id = 'global'),
  instructions text not null default '' check (char_length(instructions) <= 2000),
  updated_at timestamptz not null default now()
);
alter table public.vivian_custom_instructions enable row level security;
revoke all on public.vivian_custom_instructions from public, anon, authenticated;
grant select, insert, update, delete on public.vivian_custom_instructions to service_role;
insert into public.vivian_custom_instructions (id) values ('global') on conflict (id) do nothing;
