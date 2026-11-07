import { cloudApi } from "@/lib/cloud-api";
import { saveCloudModelExpressions } from "@/lib/cloud-store";
import { storageJson } from "@/lib/cloud-storage";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return cloudApi(request, async (db, userId) => {
    const { id } = await params;
    return Response.json(await saveCloudModelExpressions(db, userId, id, await storageJson(request)));
  });
}
