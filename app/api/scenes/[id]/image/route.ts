import { getSceneImagePublic, sceneClient } from "@/lib/scene-store";
import { SceneError } from "@/lib/scenes";

export const runtime = "nodejs";

// Scene images are public: anyone with the (unguessable UUID) scene id can
// fetch the image without signing in. Listing, saving, and deleting scenes
// remain authenticated in their own routes.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const image = await getSceneImagePublic(sceneClient(), (await context.params).id, new URL(request.url).searchParams.get("thumbnail") === "1");
    return new Response(image, {
      headers: { "Content-Type": image.type, "Cache-Control": "public, max-age=3600, must-revalidate", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", Vary: "Accept" },
    });
  } catch (error) {
    const status = error instanceof SceneError ? error.status : 503;
    return Response.json({ error: error instanceof SceneError ? error.message : "Scene image unavailable.", status }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
