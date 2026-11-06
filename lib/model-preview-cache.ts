/** Small Live2D render snapshots for Character cards. Disposable like render copies. */

interface PreviewEntry {
  key: string;
  blob: Blob;
  touched: number;
}

const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 60;
let writes: Promise<unknown> = Promise.resolve();

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("vivian-model-previews", 2);
    request.onupgradeneeded = () => {
      // v2 purges v1 center-cropped thumbnails (headless torso captures);
      // faces are re-captured from the live render on next use.
      const db = request.result;
      if (db.objectStoreNames.contains("previews")) db.deleteObjectStore("previews");
      db.createObjectStore("previews");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readAll(): Promise<PreviewEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("previews", "readonly");
    const request = tx.objectStore("previews").getAll();
    tx.oncomplete = () => {
      db.close();
      resolve((request.result as PreviewEntry[] | undefined) ?? []);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

function mutate(operation: (store: IDBObjectStore) => void): Promise<void> {
  const work = writes.then(async () => {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("previews", "readwrite");
      operation(tx.objectStore("previews"));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }).catch(() => {
    /* Quota/private mode must never prevent rendering or chat. */
  });
  writes = work;
  return work;
}

export async function loadModelPreviews(): Promise<Map<string, Blob>> {
  const result = new Map<string, Blob>();
  try {
    await writes;
    const entries = await readAll();
    for (const entry of entries) {
      if (!entry?.key || !entry.blob?.size) continue;
      try {
        await entry.blob.slice(0, 1).arrayBuffer();
      } catch {
        continue;
      }
      result.set(entry.key, entry.blob);
    }
  } catch {
    /* Cache loss only removes card artwork; models still render. */
  }
  return result;
}

export function saveModelPreview(modelId: string, blob: Blob): Promise<void> {
  if (!modelId || !blob.size || blob.size > MAX_CACHE_BYTES) return Promise.resolve();
  const entry: PreviewEntry = { key: modelId, blob, touched: Date.now() };
  return mutate((store) => {
    store.put(entry, modelId);
    const request = store.getAll();
    request.onsuccess = () => {
      const entries = (request.result as PreviewEntry[]).sort((a, b) => a.touched - b.touched);
      let total = entries.reduce((sum, item) => sum + (item.blob?.size ?? 0), 0);
      let count = entries.length;
      for (const item of entries) {
        if (total <= MAX_CACHE_BYTES && count <= MAX_ENTRIES) break;
        if (item.key === modelId) continue;
        store.delete(item.key);
        total -= item.blob?.size ?? 0;
        count--;
      }
    };
  });
}

export function removeModelPreview(modelId: string): Promise<void> {
  return mutate((store) => {
    store.delete(modelId);
  });
}
