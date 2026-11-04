export const DEFAULT_SPEAKING_SPEED = .98;
export function validSpeakingSpeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= .8 && value <= 1.2;
}

export type SpeechLanguage = "global" | "th" | "en" | "ja" | "ko" | "zh";
export const SPEECH_LANGUAGES: readonly SpeechLanguage[] = ["global", "th", "en", "ja", "ko", "zh"];
export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguage = "th";
export function validSpeechLanguage(value: unknown): value is SpeechLanguage {
  return typeof value === "string" && (SPEECH_LANGUAGES as readonly string[]).includes(value);
}
