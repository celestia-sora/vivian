import type { ModelPackage } from "./local-models";

interface Flight<T> {
  controller: AbortController;
  promise: Promise<T>;
  consumers: number;
  settled: boolean;
}

const flights = new Map<string, Flight<unknown>>();

/** Share one package hydration/download between startup preload and rendering. */
export function singleFlightModel<T>(
  key: string,
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  let flight = flights.get(key) as Flight<T> | undefined;
  if (!flight) {
    const controller = new AbortController();
    const created: Flight<T> = { controller, consumers: 0, settled: false, promise: Promise.resolve().then(() => operation(controller.signal)) };
    flight = created;
    flights.set(key, created as Flight<unknown>);
    void created.promise.finally(() => {
      created.settled = true;
      if (flights.get(key) === created) flights.delete(key);
    }).catch(() => {});
  }
  const shared = flight;
  shared.consumers++;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      shared.consumers--;
      if (!shared.settled && shared.consumers === 0) shared.controller.abort();
    };
    const abort = () => {
      release();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    shared.promise.then((value) => { if (!finished) { release(); resolve(value); } }, (error) => { if (!finished) { release(); reject(error); } });
  });
}

/** Warm the latest selected package first, then the newest cloud packages serially. */
export async function preloadModelPackages(
  packages: ModelPackage[], selectedModelId: string | null,
  load: (pack: ModelPackage, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal,
): Promise<void> {
  const ordered = packages.map((pack, index) => ({ pack, index })).sort((a, b) => {
    const selectedA = a.pack.models.some((model) => model.id === selectedModelId);
    const selectedB = b.pack.models.some((model) => model.id === selectedModelId);
    if (selectedA !== selectedB) return selectedA ? -1 : 1;
    return b.index - a.index;
  }).map(({ pack }) => pack);
  for (const pack of ordered) {
    signal.throwIfAborted();
    await load(pack, signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      // One unavailable package must not block the rest of the shared library.
    });
  }
}
