-- Add voice_id column to the global voice preferences singleton so the user
-- can override the ElevenLabs voice from the UI without touching Vercel env vars.
alter table public.vivian_voice_preferences
  add column if not exists voice_id text;

