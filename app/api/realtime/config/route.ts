import { requireApiAccess } from "@/lib/auth/server";
import { getAuthConfiguration } from "@/lib/auth/config";

export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  const configuration = getAuthConfiguration();
  if (!configuration) return Response.json({ error: "Realtime is not configured" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  return Response.json({ url: configuration.url, publishableKey: configuration.publishableKey }, { headers: { "Cache-Control": "private, no-store" } });
}
