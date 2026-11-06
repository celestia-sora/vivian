/** Extract a small JPEG snapshot from already-rendered Live2D for card thumbnails. */

/** Sentinel stored in the preview-url map so a supplied preview can replace a snapshot. */
export const SNAPSHOT_PREVIEW_PATH = "__snapshot__";

/** Coverflow card aspect (280 × 220). Thumbnails are cropped to match it exactly. */
export const SNAPSHOT_CARD_ASPECT = 280 / 220;

/** Backdrop baked into every thumbnail JPEG (JPEG has no transparency). */
export const SNAPSHOT_BACKGROUND = "#c9c9ff";

export interface SnapshotSize {
  width: number;
  height: number;
}

export interface SnapshotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Pick a face-first region out of a full-stage render. The model's world bounds
 * give a tight head-to-toe box; the crop keeps the full model width, anchors to
 * the top of the model (where the face is), and takes just enough height to
 * match the card aspect. Returns null for invalid input so callers fall back
 * to the whole frame.
 */
export function faceCrop(
  bounds: SnapshotBounds | null | undefined,
  sourceWidth: number,
  sourceHeight: number,
  aspect: number = SNAPSHOT_CARD_ASPECT,
): SnapshotCrop | null {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) return null;
  if (!bounds || !Number.isFinite(bounds.width) || bounds.width < 1 || !Number.isFinite(bounds.height) || bounds.height < 1) return null;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
  if (!Number.isFinite(aspect) || aspect <= 0) aspect = SNAPSHOT_CARD_ASPECT;
  const width = Math.min(bounds.width, sourceWidth);
  const height = Math.max(1, Math.min(width / aspect, bounds.height, sourceHeight));
  const x = Math.min(Math.max(bounds.x, 0), Math.max(0, sourceWidth - width));
  const y = Math.min(Math.max(bounds.y, 0), Math.max(0, sourceHeight - height));
  return { x, y, width, height };
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
 * Downscale a rendered canvas to a JPEG blob on the thumbnail backdrop,
 * optionally drawing only the given source crop first. Returns null outside
 * the browser, on failure, or when the canvas is empty — the card then keeps
 * its pink name fallback. The source canvas is never mutated.
 */
export async function snapshotToBlob(
  source: HTMLCanvasElement,
  targetWidth = 360,
  quality = 0.72,
  crop?: SnapshotCrop,
): Promise<Blob | null> {
  if (typeof document === "undefined" || !source?.width || !source?.height) return null;
  if (crop && (crop.width < 1 || crop.height < 1)) return null;
  let size: SnapshotSize;
  try {
    size = snapshotTargetSize(crop?.width ?? source.width, crop?.height ?? source.height, targetWidth);
  } catch {
    return null;
  }
  const region = crop
    ? {
        x: Math.min(Math.max(crop.x, 0), source.width - 1),
        y: Math.min(Math.max(crop.y, 0), source.height - 1),
        width: Math.min(crop.width, source.width),
        height: Math.min(crop.height, source.height),
      }
    : { x: 0, y: 0, width: source.width, height: source.height };
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.fillStyle = SNAPSHOT_BACKGROUND;
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob?.size ? blob : null;
  } catch {
    return null;
  } finally {
    canvas.width = canvas.height = 1;
  }
}
