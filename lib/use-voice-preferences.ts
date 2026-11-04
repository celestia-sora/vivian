"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { scheduleBackgroundWork } from "@/lib/startup-background";
import { authFetch } from "@/lib/auth/fetch";
import {
  DEFAULT_SPEAKING_SPEED,
  DEFAULT_SPEECH_LANGUAGE,
  validSpeakingSpeed,
  validSpeechLanguage,
  type SpeechLanguage,
} from "@/lib/voice-preferences";

const LANGUAGE_CACHE_KEY = "vivian-speech-language";

// localStorage is only an offline cache so the first paint and the first
// greeting already use the last known language. The shared cloud row wins on
// the next successful refresh, which is what syncs devices and accounts.
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

export function useVoicePreferences() {
  const [speed, setSpeed] = useState(DEFAULT_SPEAKING_SPEED);
  const [language, setLanguage] = useState<SpeechLanguage>(cachedLanguage);
  const [notice, setNotice] = useState("");
  const speedRevision = useRef(0);
  const languageRevision = useRef(0);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const alive = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    const speedVersion = speedRevision.current;
    const languageVersion = languageRevision.current;
    try {
      const response = await authFetch("/api/voice/preferences", { cache: "no-store", signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!validSpeakingSpeed(data.speakingSpeed)) throw new Error();
      const remoteLanguage = validSpeechLanguage(data.speechLanguage) ? data.speechLanguage : null;
      if (alive.current && speedVersion === speedRevision.current && languageVersion === languageRevision.current && !pending.current) {
        setSpeed(data.speakingSpeed);
        if (remoteLanguage) {
          setLanguage(remoteLanguage);
          cacheLanguage(remoteLanguage);
        }
        setNotice("");
      }
    } catch { if (alive.current && speedVersion === speedRevision.current) setNotice("โหลดค่ากลางไม่ได้ กรุณาลองใหม่"); }
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
  const save = useCallback((value: number) => {
    if (!validSpeakingSpeed(value)) return;
    const version = ++speedRevision.current;
    setSpeed(value);
    setNotice("กำลังบันทึก…");
    pending.current++;
    // Serialize writes so rapid slider changes cannot commit out of order.
    queue.current = queue.current.then(async () => {
      if (version !== speedRevision.current) { pending.current--; return; }
      try {
        const response = await authFetch("/api/voice/preferences", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ speakingSpeed: value }), signal: AbortSignal.timeout(9000), keepalive: true,
        });
        if (!response.ok) throw new Error();
        if (alive.current && version === speedRevision.current) setNotice("บันทึกแล้ว · ใช้ร่วมกันทุกบัญชี");
      } catch { if (alive.current && version === speedRevision.current) setNotice("บันทึกไม่สำเร็จ กรุณาลองใหม่"); }
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
      } catch { if (alive.current && version === languageRevision.current) setNotice("บันทึกไม่สำเร็จ ภาษาใหม่จะใช้ในเครื่องนี้ก่อน"); }
      finally { pending.current--; }
    });
  }, []);
  return { speed, language, save, saveLanguage, notice, refresh };
}
