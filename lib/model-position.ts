export interface ModelTransform {
  x: number;
  y: number;
  scale: number;
}

export const MODEL_TRANSFORM_SCALE_MIN = 0.35;
export const MODEL_TRANSFORM_SCALE_MAX = 2.5;

export const DEFAULT_MODEL_TRANSFORM: ModelTransform = { x: 0, y: 0, scale: 1 };

const STORAGE_PREFIX = "vivian-model-transform:";

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseModelTransform(raw: string | null): ModelTransform {
  if (!raw) return { ...DEFAULT_MODEL_TRANSFORM };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_MODEL_TRANSFORM };
    const item = parsed as Record<string, unknown>;
    return {
      x: finiteNumber(item.x, 0),
      y: finiteNumber(item.y, 0),
      scale: finiteNumber(item.scale, 1),
    };
  } catch {
    return { ...DEFAULT_MODEL_TRANSFORM };
  }
}

export function clampModelTransform(
  transform: ModelTransform,
  stageWidth: number,
  stageHeight: number,
): ModelTransform {
  const width = Number.isFinite(stageWidth) && stageWidth > 0 ? stageWidth : 0;
  const height = Number.isFinite(stageHeight) && stageHeight > 0 ? stageHeight : 0;
  const limitX = width > 0 ? width * 0.75 : 0;
  const limitY = height > 0 ? height * 0.75 : 0;
  return {
    x: limitX > 0 ? Math.max(-limitX, Math.min(limitX, finiteNumber(transform.x, 0))) : 0,
    y: limitY > 0 ? Math.max(-limitY, Math.min(limitY, finiteNumber(transform.y, 0))) : 0,
    scale: Math.max(
      MODEL_TRANSFORM_SCALE_MIN,
      Math.min(MODEL_TRANSFORM_SCALE_MAX, finiteNumber(transform.scale, 1)),
    ),
  };
}

export function resolveModelPlacement(
  stageWidth: number,
  stageHeight: number,
  baseScale: number,
  transform: ModelTransform,
): { x: number; y: number; scale: number } {
  const clamped = clampModelTransform(transform, stageWidth, stageHeight);
  const base = Number.isFinite(baseScale) && baseScale > 0 ? baseScale : 1;
  return {
    x: stageWidth / 2 + clamped.x,
    y: stageHeight * 0.99 + clamped.y,
    scale: base * clamped.scale,
  };
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadModelTransform(modelId: string): ModelTransform {
  if (!modelId) return { ...DEFAULT_MODEL_TRANSFORM };
  const store = storage();
  if (!store) return { ...DEFAULT_MODEL_TRANSFORM };
  try {
    return parseModelTransform(store.getItem(`${STORAGE_PREFIX}${modelId}`));
  } catch {
    return { ...DEFAULT_MODEL_TRANSFORM };
  }
}

export function saveModelTransform(modelId: string, transform: ModelTransform): void {
  if (!modelId) return;
  const store = storage();
  if (!store) return;
  const clampedScale = Math.max(
    MODEL_TRANSFORM_SCALE_MIN,
    Math.min(MODEL_TRANSFORM_SCALE_MAX, finiteNumber(transform.scale, 1)),
  );
  try {
    store.setItem(
      `${STORAGE_PREFIX}${modelId}`,
      JSON.stringify({
        x: finiteNumber(transform.x, 0),
        y: finiteNumber(transform.y, 0),
        scale: clampedScale,
      } satisfies ModelTransform),
    );
  } catch {
    /* Storage restrictions do not block dragging. */
  }
}

export function clearModelTransform(modelId: string): void {
  if (!modelId) return;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(`${STORAGE_PREFIX}${modelId}`);
  } catch {
    /* Ignore unavailable storage. */
  }
}
