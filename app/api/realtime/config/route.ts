import { requireApiAccess } from "@/lib/auth/server";

// Supabase Realtime (data layer) connection values. Sign-in no longer
// involves Supabase, but the realtime channel still reads these public
// values — kept in env (NEXT_PUBLIC_*) on purpose.
export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL)?.trim();
  const publishableKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  if (!url || !publishableKey) return Response.json({ error: "Realtime is not configured" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  return Response.json({ url, publishableKey }, { headers: { "Cache-Control": "private, no-store" } });
}
