"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth/fetch";
import { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from "@/lib/custom-instructions";

const CACHE_KEY = "vivian-custom-instructions";
const SYNCED_KEY = "vivian-custom-instructions-synced";

function readCache(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(CACHE_KEY) ?? ""; } catch { return ""; }
}
function writeCache(value: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(CACHE_KEY, value); } catch { /* storage may be unavailable */ }
}
function clearCache(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(CACHE_KEY); } catch { /* storage may be unavailable */ }
}
function hasSynced(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(SYNCED_KEY) === "1"; } catch { return false; }
}
function markSynced(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(SYNCED_KEY, "1"); } catch { /* storage may be unavailable */ }
}

function bounded(value: string): string {
  return value.slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
}

async function writeRemote(value: string): Promise<string | null> {
  try {
    const response = await authFetch("/api/custom-instructions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customInstructions: value }),
      signal: AbortSignal.timeout(9000),
      keepalive: true,
    });
    if (!response.ok) return null;
    const data = await response.json() as { customInstructions?: unknown };
    return typeof data.customInstructions === "string" ? bounded(data.customInstructions) : value;
  } catch {
    return null;
  }
}

export function useCustomInstructions() {
  const [value, setValue] = useState(readCache);
  const [savedValue, setSavedValue] = useState(readCache);
  const [saving, setSaving] = useState(false);
  const [synced, setSynced] = useState(hasSynced);
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const savingRef = useRef(false);
  const revision = useRef(0);
  const valueRef = useRef(value);
  const savedRef = useRef(savedValue);
  useEffect(() => {
    valueRef.current = value;
    savedRef.current = savedValue;
  }, [value, savedValue]);

  const refresh = useCallback(async () => {
    if (savingRef.current) return;
    const version = revision.current;
    try {
      const response = await authFetch("/api/custom-instructions", { cache: "no-store", signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error();
      const data = await response.json() as { customInstructions?: unknown };
      if (typeof data.customInstructions !== "string") throw new Error();
      if (!alive.current || version !== revision.current) return;

      const remote = bounded(data.customInstructions);
      const local = bounded(savedRef.current);
      const hasDraft = valueRef.current !== savedRef.current;
      // A device that existed before cloud sync keeps its instructions: the
      // first successful sync uploads them instead of silently erasing them.
      if (!hasSynced() && !hasDraft && local.trim() && local !== remote) {
        const saved = await writeRemote(local);
        if (saved === null) throw new Error();
        if (!alive.current || version !== revision.current) return;
        markSynced();
        writeCache(saved);
        setSavedValue(saved);
        setSynced(true);
        setValue(saved);
        setNotice("ซิงก์คำแนะนำจากเครื่องนี้แล้ว");
        return;
      }

      // A draft has not been saved yet, so it must not mark the pre-sync local
      // value as already uploaded.
      if (!hasDraft) markSynced();
      setSavedValue(remote);
      setSynced(true);
      if (!hasDraft) {
        setValue(remote);
        writeCache(remote);
      }
      setNotice("");
    } catch {
      if (alive.current && version === revision.current) {
        setNotice("ซิงก์คำแนะนำกับคลาวด์ไม่ได้ · ใช้ค่าบนเครื่องนี้");
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 15000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  const updateCustomInstructions = useCallback((next: string) => {
    revision.current += 1;
    setValue(bounded(next));
    setNotice("");
  }, []);

  const saveCustomInstructions = useCallback(async () => {
    if (savingRef.current) return;
    const target = bounded(valueRef.current);
    const version = ++revision.current;
    savingRef.current = true;
    setSaving(true);
    setNotice("กำลังบันทึก…");
    try {
      const saved = await writeRemote(target);
      if (saved === null) throw new Error();
      if (!alive.current || version !== revision.current) return;
      markSynced();
      writeCache(saved);
      setSavedValue(saved);
      setValue(saved);
      setSynced(true);
      setNotice("บันทึกแล้ว");
    } catch {
      if (alive.current && version === revision.current) setNotice("บันทึกไม่สำเร็จ · ลองอีกครั้ง");
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }, []);

  const resetCustomInstructions = useCallback(() => {
    revision.current += 1;
    clearCache();
    markSynced();
    setValue("");
    setSavedValue("");
    setSynced(true);
    setNotice("");
  }, []);

  return {
    customInstructions: value,
    savedCustomInstructions: savedValue,
    updateCustomInstructions,
    saveCustomInstructions,
    resetCustomInstructions,
    refreshCustomInstructions: refresh,
    savingCustomInstructions: saving,
    customInstructionsDirty: value !== savedValue,
    customInstructionsSynced: synced,
    customInstructionsNotice: notice,
  };
}
