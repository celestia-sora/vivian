"use client";
import { createClient } from "@supabase/supabase-js";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { authFetch } from "@/lib/auth/fetch";

export function subscribeModelLibrary(onChanged: () => void): () => void {
  let disposed = false;
  let client: SupabaseClient | undefined;
  let channel: RealtimeChannel | undefined;
  void (async () => {
    try {
      const response = await authFetch("/api/realtime/config", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const config = await response.json() as { url?: unknown; publishableKey?: unknown };
      if (typeof config.url !== "string" || typeof config.publishableKey !== "string" || disposed) return;
      client = createClient(config.url, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
      channel = client.channel("vivian:model-library", { config: { private: false } })
        .on("broadcast", { event: "changed" }, () => { if (!disposed) onChanged(); })
        .subscribe();
    } catch { /* Poll/focus refresh and startup remain the fallback. */ }
  })();
  return () => {
    disposed = true;
    if (client && channel) void client.removeChannel(channel);
  };
}
