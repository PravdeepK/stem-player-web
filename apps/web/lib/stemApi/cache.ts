import {
  HASH_LENGTH,
  MODEL_IDS,
  STEM_EXT,
  STEM_NAMES,
  type CacheEntry,
  type ModelId,
  type StemMap,
} from "@stem-player-web/core";

// The site's private store of separated songs, so opening one twice only costs
// one separation. An entry is keyed by the audio's bytes plus the model, so a
// renamed file still matches. The oldest entries are deleted past maxBytes;
// keeping stems for good is what Export is for.
//
//   stem-cache/<id>/meta.json    { title, model, lastUsed }
//   stem-cache/<id>/stems/*.m4a
//
// OPFS can't rename a folder, so the desktop's temp-folder-then-rename becomes
// meta.json-last: an entry without one is unfinished and never listed.

// Same total as the desktop. AAC stems are about a tenth the size of its WAVs,
// so this holds far more songs.
export const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

const ID_PATTERN = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}-[a-z_]+$`);
const META = "meta.json";
const STEMS = "stems";
const LOCK = "stem-cache";

// The parts of the File System API the cache uses, so tests can hand it an
// in-memory folder.
export interface CacheFile {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>;
}

export interface CacheDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<CacheDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<CacheFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

interface Meta {
  title: string;
  model: ModelId;
  lastUsed: number;
}

const isMissing = (err: unknown) =>
  err instanceof DOMException && (err.name === "NotFoundError" || err.name === "TypeMismatchError");

async function getDirectory(parent: CacheDirectory, name: string): Promise<CacheDirectory | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

async function getFile(parent: CacheDirectory, name: string): Promise<File | null> {
  try {
    return await (await parent.getFileHandle(name)).getFile();
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

async function remove(parent: CacheDirectory, name: string): Promise<void> {
  try {
    await parent.removeEntry(name, { recursive: true });
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

async function writeFile(parent: CacheDirectory, name: string, data: Blob | string): Promise<void> {
  const writable = await (await parent.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

function parseMeta(text: string): Meta | null {
  let meta: Partial<Meta>;
  try {
    meta = JSON.parse(text);
  } catch {
    return null;
  }
  const { title, model, lastUsed } = meta;
  if (typeof title !== "string" || typeof lastUsed !== "number") return null;
  if (!MODEL_IDS.includes(model as ModelId)) return null;
  return { title, model: model as ModelId, lastUsed };
}

// Two tabs share one cache. A tab sweeping unfinished entries on load must not
// delete the entry another tab is halfway through writing.
function locked<T>(fn: () => Promise<T>): Promise<T> {
  return "locks" in navigator ? navigator.locks.request(LOCK, fn) : fn();
}

/** The cache id: the first HASH_LENGTH hex characters of the audio's SHA-256, then the model. */
export async function idFor(file: Blob, model: ModelId): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, HASH_LENGTH)}-${model}`;
}

export function createStemCache(dir: CacheDirectory, maxBytes: number) {
  async function read(id: string): Promise<CacheEntry | null> {
    if (!ID_PATTERN.test(id)) return null;
    const entryDir = await getDirectory(dir, id);
    const metaFile = entryDir && (await getFile(entryDir, META));
    const meta = metaFile && parseMeta(await metaFile.text());
    const stemsDir = meta && (await getDirectory(entryDir, STEMS));
    if (!meta || !stemsDir) return null;

    const files = await Promise.all(STEM_NAMES.map((name) => getFile(stemsDir, `${name}.${STEM_EXT}`)));
    if (files.some((file) => !file)) return null;
    const stems = Object.fromEntries(STEM_NAMES.map((name, i) => [name, files[i]])) as StemMap<File>;
    return { id, ...meta, stems, demo: false };
  }

  async function ids(): Promise<string[]> {
    const names: string[] = [];
    for await (const name of dir.keys()) if (ID_PATTERN.test(name)) names.push(name);
    return names;
  }

  /** Every complete entry, most recently used first. */
  async function list(): Promise<CacheEntry[]> {
    const entries = await Promise.all((await ids()).map(read));
    return entries.filter((entry) => entry !== null).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  const sizeOf = (entry: CacheEntry) =>
    STEM_NAMES.reduce((sum, name) => sum + (entry.stems[name] as Blob).size, 0);

  return {
    list,

    /** The entry with its last-used time refreshed, or null. */
    async touch(id: string): Promise<CacheEntry | null> {
      const entry = await read(id);
      if (!entry) return null;
      entry.lastUsed = Date.now();
      const { title, model, lastUsed } = entry;
      await writeFile(await dir.getDirectoryHandle(id), META, JSON.stringify({ title, model, lastUsed }));
      return entry;
    },

    /** Writes a finished song's stems, replacing any older entry with the same id. */
    commit(id: string, title: string, model: ModelId, stems: StemMap<Blob>): Promise<CacheEntry | null> {
      if (!ID_PATTERN.test(id)) throw new Error(`bad cache id: ${id}`);
      return locked(async () => {
        await remove(dir, id);
        try {
          const entryDir = await dir.getDirectoryHandle(id, { create: true });
          const stemsDir = await entryDir.getDirectoryHandle(STEMS, { create: true });
          for (const name of STEM_NAMES) await writeFile(stemsDir, `${name}.${STEM_EXT}`, stems[name]);
          await writeFile(entryDir, META, JSON.stringify({ title, model, lastUsed: Date.now() }));
        } catch (err) {
          await remove(dir, id);
          throw err;
        }
        return read(id);
      });
    },

    /** Delete the oldest entries past the size limit, never `keepId`. */
    async prune(keepId: string): Promise<void> {
      const entries = await list();
      let total = entries.reduce((sum, entry) => sum + sizeOf(entry), 0);
      for (const entry of entries.reverse()) {
        if (total <= maxBytes) return;
        if (entry.id === keepId) continue;
        total -= sizeOf(entry);
        await remove(dir, entry.id);
      }
    },

    /** Remove whatever an interrupted write left behind. */
    clearIncomplete(): Promise<void> {
      return locked(async () => {
        for (const id of await ids()) if (!(await read(id))) await remove(dir, id);
      });
    },
  };
}

export type StemCache = ReturnType<typeof createStemCache>;
