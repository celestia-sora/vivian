import { requireApiAccess } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  DEFAULT_VOICE_ID,
  DEFAULT_SPEECH_LANGUAGE,
  validSpeechLanguage,
} from "@/lib/voice-preferences";

const headers = { "Cache-Control": "private, no-store" };
const columns = "voice_id,speech_language";

export async function preferences(request: Request, write: boolean): Promise<Response> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;

  const defaultEnvVoiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  let voiceId: string | undefined;
  let language: string | undefined;

  if (write) {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid voice preferences" }, { status: 400, headers });
    }
    const record = body as Record<string, unknown>;
    const hasVoice = typeof record.voiceId === "string";
    const hasLang = validSpeechLanguage(record.speechLanguage);

    if (!hasVoice && !hasLang) {
      return Response.json({ error: "Provide a valid voiceId (string) or speechLanguage" }, { status: 400, headers });
    }
    if (hasVoice) voiceId = (record.voiceId as string).trim();
    if (hasLang) language = record.speechLanguage as string;
  }

  try {
    const db = getSupabaseAdmin(AbortSignal.timeout(8000));
    // One fixed singleton for all authorized accounts; global settings
    const row: Record<string, unknown> = {
      id: "global",
      ...(voiceId === undefined ? {} : { voice_id: voiceId }),
      ...(language === undefined ? {} : { speech_language: language }),
      updated_at: new Date().toISOString(),
    };

    let result = write
      ? await db.from("vivian_voice_preferences").upsert(row, { onConflict: "id" }).select(columns).single()
      : await db.from("vivian_voice_preferences").select(columns).eq("id", "global").maybeSingle();

    // Gracefully handle if voice_id column doesn't exist yet in Supabase schema
    if (result.error && /voice_id/i.test(result.error.message)) {
      const fallbackRow = { ...row };
      delete fallbackRow.voice_id;
      result = write
        ? await db.from("vivian_voice_preferences").upsert(fallbackRow, { onConflict: "id" }).select("speech_language").single()
        : await db.from("vivian_voice_preferences").select("speech_language").eq("id", "global").maybeSingle();
    }

    const savedVoiceId = typeof result.data?.voice_id === "string" && result.data.voice_id
      ? result.data.voice_id
      : (voiceId ?? defaultEnvVoiceId);

    const savedLang = validSpeechLanguage(result.data?.speech_language)
      ? result.data.speech_language
      : (language ?? DEFAULT_SPEECH_LANGUAGE);

    return Response.json({
      voiceId: savedVoiceId,
      defaultVoiceId: defaultEnvVoiceId,
      speechLanguage: savedLang,
    }, { headers });
  } catch {
    return Response.json({
      voiceId: voiceId ?? defaultEnvVoiceId,
      defaultVoiceId: defaultEnvVoiceId,
      speechLanguage: language ?? DEFAULT_SPEECH_LANGUAGE,
    }, { headers });
  }
}

export const GET = (request: Request) => preferences(request, false);
export const PATCH = (request: Request) => preferences(request, true);
