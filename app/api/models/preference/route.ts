import { cloudApi } from "@/lib/cloud-api";
import { saveCloudModelPreference } from "@/lib/cloud-store";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  return cloudApi(request, async (db, userId) => {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON", status: 400 }, { status: 400 }); }
    const modelId = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).modelId : undefined;
    const preference = await saveCloudModelPreference(db, userId, modelId);
    return Response.json({ preference });
  });
}
