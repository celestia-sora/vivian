import { requireApiAccess } from "@/lib/auth/server";
import { NextResponse } from "next/server";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { speechText, speechTextWithEmotionTags } from "@/lib/speech";

export const maxDuration = 30;

// Keep the request bounded so a slow provider cannot leave the companion UI
// in its "thinking" state indefinitely.
const upstreamTimeoutMs = 14_000;

export async function POST(request: Request): Promise<Response> {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const quota = rateLimit(request, "tts", 30);
  if (!quota.allowed) return rateLimitedResponse(quota.retryAfter);
  const startedAt = Date.now();
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey) return NextResponse.json({ error: "ELEVENLABS_API_KEY is not configured" }, { status: 500 });
  if (!voiceId) return NextResponse.json({ error: "ELEVENLABS_VOICE_ID is not configured" }, { status: 500 });

  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body", status: 400 }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Text is required", status: 400 }, { status: 400 });
  const { text, language } = body as Record<string, unknown>;
  if (typeof text !== "string" || text.length > 5000) return NextResponse.json({ error: "Text is required and must be under 5000 characters", status: 400 }, { status: 400 });
  const speechLanguage = language === "global" || language === "en" || language === "ja" || language === "ko" || language === "zh" || language === "th" ? language : "global";
  const cleanText = speechText(text, speechLanguage);
  const taggedText = speechTextWithEmotionTags(text, speechLanguage);
  if (!cleanText) return NextResponse.json({ error: "Text must contain spoken words", status: 400 }, { status: 400 });
  if (cleanText.length > 2000 || taggedText.length > 2000) return NextResponse.json({ error: "Prepared speech must be under 2000 characters for ElevenLabs v4", status: 400 }, { status: 400 });
  const providerStarted = Date.now();
  let phase = "request";
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(upstreamTimeoutMs),
      body: JSON.stringify({
        inputs: [{ text: taggedText, voice_id: voiceId }],
        model_id: "eleven_v4",
        language_code: speechLanguage === "th" ? "th" : speechLanguage === "ja" || speechLanguage === "ko" || speechLanguage === "zh" || speechLanguage === "en" ? speechLanguage : undefined,
        apply_text_normalization: "auto",
      }),
    });

    if (!response.ok) {
      console.warn("ElevenLabs TTS rejected", { status: response.status, elapsedMs: Date.now() - startedAt, textLength: cleanText.length });
      return NextResponse.json({ error: "ElevenLabs TTS request failed", code: "TTS_UPSTREAM", status: response.status }, { status: response.status, headers: { "Cache-Control": "no-store" } });
    }
    // fetch resolves at headers; the same timeout also covers the entire body.
    // A stalled/truncated audio stream must use the text-chat fallback too.
    phase = "audio";
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) {
      console.warn("ElevenLabs TTS empty", { elapsedMs: Date.now() - startedAt, textLength: cleanText.length });
      return NextResponse.json({ error: "ElevenLabs returned no audio", code: "TTS_UPSTREAM", status: 502 }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const elapsedMs = Date.now() - startedAt;
    console.info("ElevenLabs TTS ready", { elapsedMs, textLength: cleanText.length, language: speechLanguage, bytes: audio.byteLength });
    return new NextResponse(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Server-Timing": `elevenlabs;dur=${Date.now() - providerStarted}, tts_route;dur=${elapsedMs}` } });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const status = timedOut ? 504 : 502;
    console.warn("ElevenLabs TTS unavailable", { phase, elapsedMs: Date.now() - startedAt, textLength: cleanText.length, error: name });
    return NextResponse.json({
      error: timedOut ? "ผู้ให้บริการเสียงตอบช้าเกินไป ลองใหม่อีกครั้งนะคะ" : "ผู้ให้บริการเสียงขัดข้องชั่วคราว ลองใหม่อีกครั้งนะคะ",
      code: timedOut ? "TTS_TIMEOUT" : "TTS_UPSTREAM",
      status,
    }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
