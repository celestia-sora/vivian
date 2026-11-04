import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StorageError, storageId, modelSize, modelManifests, STORAGE_LIMITS, r2ObjectCategory, type StorageCategory, type StorageUsage, type CloudModel } from "@/lib/cloud-storage";
import { sceneThumbnailKey } from "@/lib/scenes";
import { r2Configuration, r2Inventory, startModelUpload, signModelParts, completeModelUpload, deleteR2Object, signModelDownload, putR2Image } from "@/lib/r2";

export interface StorageObject { id: string; user_id: string | null; category: StorageCategory; object_key: string; byte_size: number; state: "pending" | "ready" | "deleting"; upload_id: string | null; library_scope?: "private" | "shared"; metadata: { manifests?: CloudModel["manifests"] }; created_at: string }
export interface ModelPreference { modelId: string; lastSelectedAt: string; revision: string }
function check(error: { code?: string } | null): void {
  if (error?.code === "23514") throw new StorageError("Storage quota exceeded. Delete unused files before uploading.", 409);
  if (error) throw new StorageError("Cloud storage is temporarily unavailable.", 503);
}
// Shared Live2D library for the beta. The column is stored per object so the
// beta window can be closed with an env change instead of a data migration.
export const sharedModelLibrary = (): boolean => process.env.MODEL_LIBRARY_SHARED !== "false";
// Deployment can briefly run ahead of the shared-library migration. Treat only
// the specific missing column/table failures as "feature not available yet" so
// real outages and quota errors keep surfacing.
function missingSharedSupport(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "42P01" || error.code === "PGRST204") return true;
  return typeof error.message === "string" && /library_scope|vivian_model_deletions|vivian_model_preferences/i.test(error.message);
}
export async function storageUsage(db: SupabaseClient): Promise<StorageUsage> {
  const { data, error } = await db.from("vivian_storage_quotas").select("category,used_bytes,external_bytes,limit_bytes"); check(error);
  if (!data || data.length !== 2) throw new StorageError("Cloud storage setup is incomplete.", 503);
  const result: StorageUsage = { live2d: { used: 0, limit: STORAGE_LIMITS.live2d }, other: { used: 0, limit: STORAGE_LIMITS.other } };
  for (const row of data) {
    const category = row.category as StorageCategory;
    if (!(category in STORAGE_LIMITS) || Number(row.limit_bytes) !== STORAGE_LIMITS[category]) throw new StorageError("Cloud storage quotas do not match the configured limits.", 503);
    result[category].used = Number(row.used_bytes) + Number(row.external_bytes ?? 0);
  }
  return result;
}
/** Measure R2 before each new upload; preserve transactional reservations. */
export async function observedR2Accounting(db: SupabaseClient, observed: Map<string, number>) {
  const reserved = new Map<string, number>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from("vivian_storage_objects").select("object_key,byte_size").order("id").range(offset, offset + 999); check(error);
    if (!data) throw new StorageError("Storage reservations could not be checked.", 503);
    for (const row of data) reserved.set(row.object_key, Number(row.byte_size));
    if (data.length < 1000) break;
  }
  const external = { live2d: 0, other: 0 };
  for (const [key, size] of observed) external[r2ObjectCategory(key)] += Math.max(0, size - (reserved.get(key) ?? 0));
  const usage: StorageUsage = { live2d: { used: external.live2d, limit: STORAGE_LIMITS.live2d }, other: { used: external.other, limit: STORAGE_LIMITS.other } };
  for (const [key, size] of reserved) usage[r2ObjectCategory(key)].used += size;
  if (!Object.values(usage).every(meter => Number.isSafeInteger(meter.used) && meter.used >= 0)) throw new StorageError("Storage usage could not be verified.", 503);
  return { external, usage };
}
export async function refreshR2Accounting(db: SupabaseClient): Promise<void> {
  const { external } = await observedR2Accounting(db, await r2Inventory());
  // Extra bucket bytes participate in the same locked SQL quota check as uploads.
  check((await db.rpc("vivian_storage_observe", { live2d_bytes: external.live2d, other_bytes: external.other })).error);
}
export async function ownedObject(db: SupabaseClient, userId: string, id: string): Promise<StorageObject> {
  storageId(id);
  const { data, error } = await db.from("vivian_storage_objects").select("*").eq("user_id", userId).eq("id", id).maybeSingle(); check(error);
  if (!data) throw new StorageError("File not found.", 404);
  return data as StorageObject;
}
/** A model the account may read: its own, or a ready shared model during beta. */
export async function readableModel(db: SupabaseClient, userId: string, id: string): Promise<StorageObject> {
  storageId(id);
  const { data, error } = await db.from("vivian_storage_objects").select("*").eq("id", id).maybeSingle(); check(error);
  const row = data as StorageObject | null;
  if (!row || row.category !== "live2d") throw new StorageError("Model not found.", 404);
  if (row.user_id === userId) return row;
  if (row.state === "ready" && row.library_scope === "shared" && sharedModelLibrary()) return row;
  throw new StorageError("Model not found.", 404);
}
function present(row: StorageObject): CloudModel { return { id: row.id, byteSize: Number(row.byte_size), manifests: modelManifests(row.metadata.manifests), scope: row.library_scope ?? "private" }; }
export async function cloudModels(db: SupabaseClient, userId: string) {
  r2Configuration();
  const own = await db.from("vivian_storage_objects").select("*").eq("user_id", userId).eq("category", "live2d").eq("state", "ready").order("created_at", { ascending: true }); check(own.error);
  const rows = (own.data ?? []) as StorageObject[];
  if (sharedModelLibrary()) {
    // Readable by every verified account; own rows are kept from the first
    // query so an owner still sees a model that is not shared.
    const shared = await db.from("vivian_storage_objects").select("*").eq("category", "live2d").eq("state", "ready").eq("library_scope", "shared").order("created_at", { ascending: true });
    if (!shared.error) {
      const seen = new Set(rows.map((row) => row.id));
      for (const row of (shared.data ?? []) as StorageObject[]) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    } else if (!missingSharedSupport(shared.error)) check(shared.error);
  }
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const preferenceResult = await db.from("vivian_model_preferences").select("selected_model_id,last_selected_at,revision").eq("id", "global").maybeSingle();
  if (preferenceResult.error && !missingSharedSupport(preferenceResult.error)) check(preferenceResult.error);
  const preferenceRow = preferenceResult.data as { selected_model_id: string; last_selected_at: string; revision: string } | null;
  const preference = preferenceRow && rows.some((row) => row.id === preferenceRow.selected_model_id.split(":", 1)[0])
    ? { modelId: preferenceRow.selected_model_id, lastSelectedAt: preferenceRow.last_selected_at, revision: preferenceRow.revision }
    : null;
  return { userId, models: rows.map(present), usage: await storageUsage(db), preference };
}
export async function saveCloudModelPreference(db: SupabaseClient, userId: string, input: unknown): Promise<ModelPreference> {
  if (typeof input !== "string" || input.length > 2048 || !input.includes(":")) throw new StorageError("Invalid model selection.", 400);
  const separator = input.indexOf(":");
  const packageId = input.slice(0, separator);
  const manifestPath = input.slice(separator + 1);
  storageId(packageId);
  const row = await readableModel(db, userId, packageId);
  if (!sharedModelLibrary() || row.library_scope !== "shared" || !modelManifests(row.metadata.manifests).some((manifest) => manifest.path === manifestPath)) throw new StorageError("Select a model from the shared library.", 404);
  const lastSelectedAt = new Date().toISOString();
  const revision = randomUUID();
  const { error } = await db.from("vivian_model_preferences").upsert({ id: "global", selected_model_id: input, last_selected_at: lastSelectedAt, revision, updated_at: lastSelectedAt }, { onConflict: "id" });
  check(error);
  return { modelId: input, lastSelectedAt, revision };
}
export async function beginCloudModel(db: SupabaseClient, userId: string, input: unknown) {
  r2Configuration();
  if (!input || typeof input !== "object") throw new StorageError("Invalid model upload.");
  const body = input as Record<string, unknown>;
  const bytes = modelSize(body.byteSize), manifests = modelManifests(body.manifests);
  const id = randomUUID(), key = `live2d/${userId}/${id}.zip`;
  await refreshR2Accounting(db);
  // Reserve before making any remote write. SQL enforces the global budget.
  const reservation = { id, user_id: userId, category: "live2d", object_key: key, byte_size: bytes, metadata: { manifests } };
  const shared = sharedModelLibrary() ? { ...reservation, library_scope: "shared" } : reservation;
  let error = (await db.from("vivian_storage_objects").insert(shared)).error;
  if (error && sharedModelLibrary() && missingSharedSupport(error)) error = (await db.from("vivian_storage_objects").insert(reservation)).error;
  check(error);
  const uploadId = await startModelUpload(key);
  check((await db.from("vivian_storage_objects").update({ upload_id: uploadId }).eq("id", id).eq("user_id", userId).eq("state", "pending")).error);
  return { id, userId, scope: sharedModelLibrary() ? "shared" : "private", usage: await storageUsage(db) };
}
export async function cloudModelParts(db: SupabaseClient, userId: string, id: string, first: number) {
  const row = await ownedObject(db, userId, id);
  if (row.category !== "live2d" || row.state !== "pending" || !row.upload_id) throw new StorageError("Upload is not available.", 409);
  if (Date.now() - new Date(row.created_at).getTime() > 3600_000) throw new StorageError("Upload expired. Import the model again.", 409);
  return { parts: await signModelParts(row.object_key, row.upload_id, Number(row.byte_size), first) };
}
export async function finishCloudModel(db: SupabaseClient, userId: string, id: string) {
  const row = await ownedObject(db, userId, id);
  if (row.category !== "live2d" || row.state === "deleting") throw new StorageError("Upload is not available.", 409);
  if (row.state !== "ready") {
    if (!row.upload_id) throw new StorageError("Upload is not available.", 409);
    await completeModelUpload(row.object_key, row.upload_id, Number(row.byte_size));
    const { data, error } = await db.from("vivian_storage_objects").update({ state: "ready", updated_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId).eq("state", "pending").select("id"); check(error);
    if (!data?.length) throw new StorageError("Upload changed. Refresh your library.", 409);
  }
  return { model: present(row), usage: await storageUsage(db) };
}
export async function cloudModelDownload(db: SupabaseClient, userId: string, id: string) {
  const row = await readableModel(db, userId, id);
  if (row.category !== "live2d" || row.state !== "ready") throw new StorageError("Model not found.", 404);
  return { url: await signModelDownload(row.object_key), byteSize: Number(row.byte_size) };
}
async function auditModelDeletion(db: SupabaseClient, row: StorageObject, deletedBy: string): Promise<void> {
  // Best effort: the remote object is already gone, so an audit hiccup must not
  // resurrect it. The row records who removed a shared model and from whom.
  const { error } = await db.from("vivian_model_deletions").insert({
    object_id: row.id, object_key: row.object_key, owner_id: row.user_id,
    deleted_by: deletedBy, byte_size: Number(row.byte_size),
  });
  if (error && !missingSharedSupport(error)) console.warn("Model deletion audit failed:", error.message);
}
/** Delete a model the account can read, including a shared model it does not own. */
export async function removeCloudModel(db: SupabaseClient, userId: string, id: string): Promise<void> {
  const row = await readableModel(db, userId, id);
  const shared = row.user_id !== userId;
  check((await db.from("vivian_storage_objects").update({ state: "deleting" }).eq("id", id)).error);
  await deleteR2Object(row.object_key, row.upload_id);
  // Only verified remote deletion releases the reservation. Failures keep it.
  check((await db.from("vivian_storage_objects").delete().eq("id", id).eq("state", "deleting")).error);
  if (shared) await auditModelDeletion(db, row, userId);
}
export async function removeCloudObject(db: SupabaseClient, userId: string, id: string): Promise<void> {
  const row = await ownedObject(db, userId, id);
  check((await db.from("vivian_storage_objects").update({ state: "deleting" }).eq("id", id).eq("user_id", userId)).error);
  await deleteR2Object(row.object_key, row.upload_id);
  // Only verified remote deletion releases the reservation. Failures keep it.
  check((await db.from("vivian_storage_objects").delete().eq("id", id).eq("user_id", userId).eq("state", "deleting")).error);
}
export async function saveCloudSceneImages(db: SupabaseClient, userId: string, key: string, image: Buffer, thumbnail: Buffer, mime = "image/webp"): Promise<void> {
  r2Configuration();
  const values = [{ key, bytes: image, mime }, { key: sceneThumbnailKey(key), bytes: thumbnail, mime: "image/webp" }];
  await refreshR2Accounting(db);
  // Reserve both files in one DB transaction before writing either one.
  check((await db.from("vivian_storage_objects").insert(values.map((value) => ({ id: randomUUID(), user_id: userId, category: "other", object_key: value.key, byte_size: value.bytes.length })))).error);
  for (const value of values) await putR2Image(value.key, value.bytes, value.mime);
  check((await db.from("vivian_storage_objects").update({ state: "ready" }).eq("user_id", userId).in("object_key", values.map((value) => value.key))).error);
}
export async function removeCloudSceneImages(db: SupabaseClient, userId: string, key: string): Promise<void> {
  const { data, error } = await db.from("vivian_storage_objects").select("id").eq("user_id", userId).eq("category", "other").in("object_key", [key, sceneThumbnailKey(key)]); check(error);
  for (const row of data ?? []) await removeCloudObject(db, userId, row.id);
}
export async function cleanupCloudModels(db: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await db.from("vivian_storage_objects").select("id,state,created_at").eq("user_id", userId).eq("category", "live2d").in("state", ["pending", "deleting"]).limit(20); check(error);
  for (const row of data ?? []) if (row.state === "deleting" || Date.now() - new Date(row.created_at).getTime() > 3600_000) {
    try { await removeCloudObject(db, userId, row.id); } catch { /* Keep reservation; next library refresh retries. */ }
  }
}
