-- Signs-in are delegated to Cloudflare Workers (vivianAuth, D1 users).
-- Scene and storage rows now store the D1 user UUIDs in plain `user_id`
-- columns. The legacy FKs to Supabase Auth (`auth.users`) reject inserts
-- for those new IDs, which surfaces as "Scene storage is temporarily
-- unavailable" in the UI. Drop those FKs so the app can write rows for
-- D1 identities. RLS and app-level `eq("user_id", ...)` scoping are
-- unchanged; service_role writes bypass RLS anyway.
alter table public.vivian_scenes drop constraint if exists vivian_scenes_user_id_fkey;
alter table public.vivian_scene_preferences drop constraint if exists vivian_scene_preferences_user_id_fkey;
alter table public.vivian_storage_objects drop constraint if exists vivian_storage_objects_user_id_fkey;
