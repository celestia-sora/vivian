import { requireApiAccess } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  DEFAULT_SPEAKING_SPEED,
  DEFAULT_SPEECH_LANGUAGE,
  validSpeakingSpeed,
  validSpeechLanguage,
} from "@/lib/voice-preferences";

const headers = { "Cache-Control": "private, no-store" };
const columns = "speaking_speed,speech_language";
const legacyColumns = "speaking_speed";
// Deployment can briefly run ahead of the speech_language migration. Detect
// that specific failure so speed keeps working and the client keeps its cached
// language instead of being reset to the Thai default.
const missingLanguageColumn = (message: unknown) => typeof message === "string" && /speech_language/i.test(message);

async function preferences(request: Request, write: boolean): Promise<Response> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  let speed: number | undefined;
  let language: string | undefined;
  if (write) {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid voice preferences" }, { status: 400, headers });
    }
    const record = body as Record<string, unknown>;
    // PATCH accepts either field; sending both updates them together so the
    // speed slider and the language selector share one singleton row.
    if (!validSpeakingSpeed(record.speakingSpeed) && !validSpeechLanguage(record.speechLanguage)) {
      return Response.json({ error: "Speaking speed must be 0.8-1.2 and speechLanguage must be global, th, en, ja, ko or zh" }, { status: 400, headers });
    }
    if (validSpeakingSpeed(record.speakingSpeed)) speed = record.speakingSpeed;
    if (validSpeechLanguage(record.speechLanguage)) language = record.speechLanguage;
  }
  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    // One fixed singleton for all authorized accounts; never accept a user key.
    const row: Record<string, unknown> = {
      id: "global",
      ...(speed === undefined ? {} : { speaking_speed: speed }),
      ...(language === undefined ? {} : { speech_language: language }),
      updated_at: new Date().toISOString(),
    };
    let missingLanguage = false;
    let result = write
      ? await db.from("vivian_voice_preferences").upsert(row, { onConflict: "id" }).select(columns).single()
      : await db.from("vivian_voice_preferences").select(columns).eq("id", "global").maybeSingle();
    if (result.error && missingLanguageColumn(result.error.message)) {
      missingLanguage = true;
      const legacyRow = { ...row };
      delete legacyRow.speech_language;
      result = write
        ? await db.from("vivian_voice_preferences").upsert(legacyRow, { onConflict: "id" }).select(legacyColumns).single()
        : await db.from("vivian_voice_preferences").select(legacyColumns).eq("id", "global").maybeSingle();
    }
    if (result.error) throw new Error("Voice preference storage unavailable");
    const payload: { speakingSpeed: number; speechLanguage?: string } = {
      speakingSpeed: result.data?.speaking_speed ?? DEFAULT_SPEAKING_SPEED,
    };
    if (!missingLanguage) {
      payload.speechLanguage = validSpeechLanguage(result.data?.speech_language) ? result.data.speech_language : DEFAULT_SPEECH_LANGUAGE;
    }
    return Response.json(payload, { headers });
  } catch {
    return Response.json({ error: "บันทึกค่าภาษาและความเร็วบนคลาวด์ไม่ได้ กรุณาลองใหม่" }, { status: 503, headers });
  }
}
export const GET = (request: Request) => preferences(request, false);
export const PATCH = (request: Request) => preferences(request, true);
