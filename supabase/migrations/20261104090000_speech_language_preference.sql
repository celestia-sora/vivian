-- Shared speech language for the global singleton. Like speaking speed, one
-- value is used by all authorized accounts and every device; localStorage
-- stays as an offline cache only.
alter table public.vivian_voice_preferences
  add column if not exists speech_language text not null default 'th'
  check (speech_language in ('global', 'th', 'en', 'ja', 'ko', 'zh'));
