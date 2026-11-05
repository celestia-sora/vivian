import { requireApiAccess } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  normalizeCustomInstructions,
  validCustomInstructions,
} from "@/lib/custom-instructions";

const headers = { "Cache-Control": "private, no-store" };
const columns = "instructions";

function readInstructions(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    // One fixed singleton for all authorized accounts; every device shares it.
    const result = await db.from("vivian_custom_instructions").select(columns).eq("id", "global").maybeSingle();
    if (result.error) throw result.error;
    return Response.json({ customInstructions: readInstructions(result.data?.instructions) }, { headers });
  } catch {
    return Response.json({ error: "Custom instructions are unavailable" }, { status: 503, headers });
  }
}

export async function PATCH(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid custom instructions" }, { status: 400, headers });
  }
  const record = body as Record<string, unknown>;
  if (!validCustomInstructions(record.customInstructions)) {
    return Response.json({ error: `customInstructions must be a string of at most ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} characters` }, { status: 400, headers });
  }
  const instructions = normalizeCustomInstructions(record.customInstructions);

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    const result = await db.from("vivian_custom_instructions")
      .upsert({ id: "global", instructions, updated_at: new Date().toISOString() }, { onConflict: "id" })
      .select(columns)
      .single();
    if (result.error) throw result.error;
    return Response.json({ customInstructions: readInstructions(result.data?.instructions) }, { headers });
  } catch {
    return Response.json({ error: "Custom instructions are unavailable" }, { status: 503, headers });
  }
}
