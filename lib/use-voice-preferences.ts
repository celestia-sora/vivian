"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { scheduleBackgroundWork } from "@/lib/startup-background";
import { authFetch } from "@/lib/auth/fetch";
import {
  DEFAULT_VOICE_ID,
  DEFAULT_SPEECH_LANGUAGE,
  validVoiceId,
  validSpeechLanguage,
  type SpeechLanguage,
} from "@/lib/voice-preferences";

const LANGUAGE_CACHE_KEY = "vivian-speech-language";
const VOICE_ID_CACHE_KEY = "vivian-voice-id";

function cachedLanguage(): SpeechLanguage {
  if (typeof window === "undefined") return DEFAULT_SPEECH_LANGUAGE;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_CACHE_KEY);
    return validSpeechLanguage(stored) ? stored : DEFAULT_SPEECH_LANGUAGE;
  } catch {
    return DEFAULT_SPEECH_LANGUAGE;
  }
}
function cacheLanguage(value: SpeechLanguage): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(LANGUAGE_CACHE_KEY, value); } catch { /* storage may be unavailable */ }
}

function cachedVoiceId(): string {
  if (typeof window === "undefined") return DEFAULT_VOICE_ID;
  try {
    const stored = window.localStorage.getItem(VOICE_ID_CACHE_KEY);
    return typeof stored === "string" ? stored : DEFAULT_VOICE_ID;
  } catch {
    return DEFAULT_VOICE_ID;
  }
}
function cacheVoiceId(value: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(VOICE_ID_CACHE_KEY, value); } catch { /* storage may be unavailable */ }
}

export function useVoicePreferences() {
  const [voiceId, setVoiceId] = useState<string>(cachedVoiceId);
  const [language, setLanguage] = useState<SpeechLanguage>(cachedLanguage);
  const [notice, setNotice] = useState("");
  const voiceIdRevision = useRef(0);
  const languageRevision = useRef(0);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const alive = useRef(false);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    const voiceVersion = voiceIdRevision.current;
    const languageVersion = languageRevision.current;
    try {
      const response = await authFetch("/api/voice/preferences", { cache: "no-store", signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      const remoteVoiceId = typeof data.voiceId === "string" ? data.voiceId : null;
      const remoteLanguage = validSpeechLanguage(data.speechLanguage) ? data.speechLanguage : null;
      if (alive.current && voiceVersion === voiceIdRevision.current && languageVersion === languageRevision.current && !pending.current) {
        if (remoteVoiceId !== null) {
          setVoiceId(remoteVoiceId);
          cacheVoiceId(remoteVoiceId);
        }
        if (remoteLanguage) {
          setLanguage(remoteLanguage);
          cacheLanguage(remoteLanguage);
        }
        setNotice("");
      }
    } catch {
      if (alive.current && voiceVersion === voiceIdRevision.current) setNotice("โหลดค่ากลางไม่ได้ กรุณาลองใหม่");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const cancelInitial = scheduleBackgroundWork(() => { if (alive.current) void refresh(); });
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 15000);
    return () => {
      cancelInitial();
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  const saveVoiceId = useCallback((value: string) => {
    const trimmed = value.trim();
    const version = ++voiceIdRevision.current;
    setVoiceId(trimmed);
    cacheVoiceId(trimmed);
    setNotice("กำลังบันทึก…");
    pending.current++;
    queue.current = queue.current.then(async () => {
      if (version !== voiceIdRevision.current) { pending.current--; return; }
      try {
        const response = await authFetch("/api/voice/preferences", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId: trimmed }), signal: AbortSignal.timeout(9000), keepalive: true,
        });
        if (!response.ok) throw new Error();
        if (alive.current && version === voiceIdRevision.current) setNotice("บันทึก Voice ID แล้ว · ใช้ร่วมกันทุกบัญชี (Global)");
      } catch {
        if (alive.current && version === voiceIdRevision.current) setNotice("บันทึกไม่สำเร็จ กรุณาลองใหม่");
      }
      finally { pending.current--; }
    });
  }, []);

  const saveLanguage = useCallback((value: SpeechLanguage) => {
    if (!validSpeechLanguage(value)) return;
    const version = ++languageRevision.current;
    setLanguage(value);
    cacheLanguage(value);
    setNotice("กำลังบันทึก…");
    pending.current++;
    queue.current = queue.current.then(async () => {
      if (version !== languageRevision.current) { pending.current--; return; }
      try {
        const response = await authFetch("/api/voice/preferences", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ speechLanguage: value }), signal: AbortSignal.timeout(9000), keepalive: true,
        });
        if (!response.ok) throw new Error();
        if (alive.current && version === languageRevision.current) setNotice("บันทึกแล้ว · ภาษาเดียวกันทุกเครื่อง");
      } catch {
        if (alive.current && version === languageRevision.current) setNotice("บันทึกไม่สำเร็จ ภาษาใหม่จะใช้ในเครื่องนี้ก่อน");
      }
      finally { pending.current--; }
    });
  }, []);

  return { voiceId, language, saveVoiceId, saveLanguage, notice, refresh };
}
