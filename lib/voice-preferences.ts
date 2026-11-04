export const DEFAULT_VOICE_ID = "";

export function validVoiceId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 64;
}

export type SpeechLanguage = "global" | "th" | "en" | "ja" | "ko" | "zh";
export const SPEECH_LANGUAGES: readonly SpeechLanguage[] = ["global", "th", "en", "ja", "ko", "zh"];
export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguage = "th";
export function validSpeechLanguage(value: unknown): value is SpeechLanguage {
  return typeof value === "string" && (SPEECH_LANGUAGES as readonly string[]).includes(value);
}
