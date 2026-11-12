import type { CacheEntry, ModelId, StemMap } from "@stem-player-web/core";
import { MAX_CACHE_BYTES, createStemCache, type StemCache } from "./cache";

let opening: Promise<StemCache | null> | undefined;

/**
 * The cache in the origin private file system, or null when there isn't one to
 * use: an insecure origin (a phone on the dev server over http://192.168...)
 * has neither OPFS nor crypto.subtle, private browsing can refuse OPFS, and
 * Safari before 26 can open it but has no createWritable to write from the page.
 */
export function openCache(): Promise<StemCache | null> {
  opening ??= open();
  return opening;
}

async function open(): Promise<StemCache | null> {
  if (!isSecureContext || !navigator.storage?.getDirectory || !crypto.subtle) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("stem-cache", { create: true });
    // Some browsers open and read OPFS but can't write to it, which is better
    // found out here than halfway through a song's stems.
    const probe = await dir.getFileHandle(".probe", { create: true });
    const writable = await probe.createWritable();
    await writable.close();
    await dir.removeEntry(".probe");

    const cache = createStemCache(dir, MAX_CACHE_BYTES);
    await cache.clearIncomplete();
    return cache;
  } catch (err) {
    console.warn("[cache] no stem cache in this browser:", err);
    return null;
  }
}

/**
 * Stores a separated song and returns its entry. With no cache, or a write that
 * fails (usually the quota), the song still opens from the stems in memory; it
 * just won't be in Recent next time.
 */
export async function saveToCache(
  id: string,
  title: string,
  model: ModelId,
  stems: StemMap<Blob>,
): Promise<CacheEntry> {
  const uncached: CacheEntry = { id, title, model, lastUsed: Date.now(), stems, demo: false };
  const cache = await openCache();
  if (!cache) return uncached;
  try {
    const entry = await cache.commit(id, title, model, stems);
    await cache.prune(id);
    await keepStorage();
    return entry ?? uncached;
  } catch (err) {
    console.error("[cache] couldn't save the stems:", err);
    return uncached;
  }
}

// Without this the browser may clear the cache under storage pressure. Asked on
// the first save rather than on load, where Firefox would show a prompt with
// nothing yet to explain it.
async function keepStorage(): Promise<void> {
  if (!(await navigator.storage.persisted())) await navigator.storage.persist();
}
