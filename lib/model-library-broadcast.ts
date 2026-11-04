import "server-only";

/** Notify subscribed clients with an opaque event; clients refetch via Auth APIs. */
export async function publishModelLibraryChange(): Promise<void> {
  if (process.env.MODEL_LIBRARY_SHARED === "false") return;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: "vivian:model-library", event: "changed", payload: { revision: crypto.randomUUID() } }] }),
      cache: "no-store", signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) console.warn("Model library Realtime broadcast failed:", response.status);
  } catch { /* Realtime is a hint; authenticated startup sync remains authoritative. */ }
}
