import { MODEL_IDS, type CacheEntry, type ModelId, type StemApi } from "@stem-player-web/core";
import { idFor } from "./cache";
import { openDemo } from "./demo";
import { exportStems } from "./export";
import { openCache } from "./opfs";
import { pickFile, pickStemsFolder } from "./pickers";
import { onProgress, onStage, separate } from "./separate";
import { readStem } from "./stems";

// A cache that can't be read behaves like an empty one, so a storage problem
// never stops the page from playing a song.
async function findCached(file: File, model: ModelId): Promise<CacheEntry | null> {
  const cache = await openCache();
  if (!cache) return null;
  try {
    return await cache.touch(await idFor(file, model));
  } catch (err) {
    console.error("[cache] lookup failed:", err);
    return null;
  }
}

async function listRecent(): Promise<CacheEntry[]> {
  const cache = await openCache();
  if (!cache) return [];
  try {
    return await cache.list();
  } catch (err) {
    console.error("[cache] couldn't list recent songs:", err);
    return [];
  }
}

async function openRecent(id: string): Promise<CacheEntry | null> {
  const cache = await openCache();
  if (!cache) return null;
  try {
    return await cache.touch(id);
  } catch (err) {
    console.error("[cache] couldn't open a recent song:", err);
    return null;
  }
}

export const stemApi: StemApi = {
  pickFile,
  // With one model there is nothing to remember between visits.
  getModel: async () => MODEL_IDS[0],
  separate,
  findCached,
  listRecent,
  openRecent,
  openDemo,
  exportStems,
  pickStemsFolder,
  readStem,
  // The desktop sent taps here to reach its native trackpad addon. On the web,
  // vibration is lib/haptics.ts's job.
  haptic: () => {},
  onStage,
  onProgress,
};
