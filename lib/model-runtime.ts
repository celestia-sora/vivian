/** Cubism must exist before importing pixi-live2d-display (it checks at module evaluation). */
export async function waitForCubismCore(signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(globalThis as typeof globalThis & { Live2DCubismCore?: unknown }).Live2DCubismCore) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Live2D runtime did not load. Please reload the model or refresh the page.");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  signal.throwIfAborted();
}

type Live2DModules = [
  typeof import("pixi.js"),
  typeof import("pixi-live2d-display/cubism4"),
];

let modulesPromise: Promise<Live2DModules> | null = null;

/**
 * Fetch pixi.js + the Cubism runtime together. Call this as soon as the
 * companion mounts so the module download overlaps catalog/cloud loading
 * instead of starting only when the first model render begins. The promise
 * is cached for the session; a failure clears the cache so the render path
 * can retry a fresh import.
 */
export function preloadLive2DModules(): Promise<Live2DModules> {
  if (!modulesPromise) {
    modulesPromise = Promise.all([import("pixi.js"), import("pixi-live2d-display/cubism4")]);
    modulesPromise.catch(() => {
      modulesPromise = null;
    });
  }
  return modulesPromise;
}
