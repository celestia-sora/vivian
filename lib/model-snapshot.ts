/** Extract a small JPEG snapshot from already-rendered Live2D for card thumbnails. */

/** Sentinel stored in the preview-url map so a supplied preview can replace a snapshot. */
export const SNAPSHOT_PREVIEW_PATH = "__snapshot__";

export interface SnapshotSize {
  width: number;
  height: number;
}

export function snapshotTargetSize(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth = 360,
): SnapshotSize {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("Invalid snapshot source size.");
  }
  if (!Number.isFinite(targetWidth) || targetWidth < 32 || targetWidth > 1024) {
    throw new Error("Invalid snapshot target size.");
  }
  if (sourceWidth <= targetWidth) return { width: Math.floor(sourceWidth), height: Math.floor(sourceHeight) };
  const scale = targetWidth / sourceWidth;
  return { width: Math.floor(targetWidth), height: Math.max(1, Math.floor(sourceHeight * scale)) };
}

/**
 * Downscale a rendered canvas to a JPEG blob. Returns null outside the browser,
 * on failure, or when the canvas is empty — the card then keeps its pink name fallback.
 * The source canvas is never mutated.
 */
export async function snapshotToBlob(
  source: HTMLCanvasElement,
  targetWidth = 360,
  quality = 0.72,
): Promise<Blob | null> {
  if (typeof document === "undefined" || !source?.width || !source?.height) return null;
  let size: SnapshotSize;
  try {
    size = snapshotTargetSize(source.width, source.height, targetWidth);
  } catch {
    return null;
  }
  if (size.width === source.width && size.height === source.height) {
    const direct = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, "image/jpeg", quality));
    return direct?.size ? direct : null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(source, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob?.size ? blob : null;
  } catch {
    return null;
  } finally {
    canvas.width = canvas.height = 1;
  }
}
