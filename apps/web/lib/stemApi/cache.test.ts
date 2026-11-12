import { HASH_PATTERN, STEM_NAMES, type ModelId, type StemMap } from "@stem-player-web/core";
import { describe, expect, it } from "vitest";
import { createStemCache, idFor, type CacheDirectory, type CacheFile } from "./cache";

// OPFS doesn't exist in Node, so the cache runs against a folder in memory that
// fails the way OPFS does: a DOMException named NotFoundError.
const notFound = () => new DOMException("not found", "NotFoundError");

class MemoryFile implements CacheFile {
  blob = new Blob([]);
  constructor(readonly name: string) {}
  async getFile() {
    return new File([this.blob], this.name);
  }
  async createWritable() {
    const parts: (Blob | string)[] = [];
    return {
      write: async (data: Blob | string) => void parts.push(data),
      close: async () => void (this.blob = new Blob(parts)),
      abort: async () => void (parts.length = 0),
    };
  }
}

class MemoryDirectory implements CacheDirectory {
  entries = new Map<string, MemoryDirectory | MemoryFile>();
  async getDirectoryHandle(name: string, { create = false } = {}) {
    const found = this.entries.get(name);
    if (found instanceof MemoryDirectory) return found;
    if (found || !create) throw notFound();
    const dir = new MemoryDirectory();
    this.entries.set(name, dir);
    return dir;
  }
  async getFileHandle(name: string, { create = false } = {}) {
    const found = this.entries.get(name);
    if (found instanceof MemoryFile) return found;
    if (found || !create) throw notFound();
    const file = new MemoryFile(name);
    this.entries.set(name, file);
    return file;
  }
  async removeEntry(name: string) {
    if (!this.entries.delete(name)) throw notFound();
  }
  async *keys() {
    yield* this.entries.keys();
  }
}

const idOf = (c: string) => `${c.repeat(32)}-htdemucs`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const stemsOf = (bytes: number) =>
  Object.fromEntries(STEM_NAMES.map((name) => [name, new Blob([new Uint8Array(bytes)])])) as StemMap<Blob>;

function setup(maxBytes: number) {
  const dir = new MemoryDirectory();
  const cache = createStemCache(dir, maxBytes);
  const add = (id: string, title: string, bytes = 500) => cache.commit(id, title, "htdemucs", stemsOf(bytes));
  return { dir, cache, add };
}

const titles = async (cache: ReturnType<typeof setup>["cache"]) => (await cache.list()).map((e) => e.title);

describe("stem cache", () => {
  it("lists a committed entry with its stems", async () => {
    const { cache, add } = setup(1e9);
    const entry = await add(idOf("a"), "one");
    expect(entry?.title).toBe("one");
    expect(entry?.demo).toBe(false);
    expect(Object.keys(entry!.stems).sort()).toEqual([...STEM_NAMES].sort());
    expect((entry!.stems.vocals as Blob).size).toBe(500);
    expect(await cache.list()).toHaveLength(1);
  });

  it("deletes the oldest entries once over the limit, never the kept one", async () => {
    const { cache, add } = setup(3000);
    await add(idOf("a"), "one");
    await tick();
    await add(idOf("b"), "two");
    await cache.prune(idOf("b"));
    expect(await titles(cache)).toEqual(["two"]);
  });

  it("makes a touched entry the newest", async () => {
    const { cache, add } = setup(1e9);
    await add(idOf("a"), "one");
    await tick();
    await add(idOf("b"), "two");
    await tick();
    await cache.touch(idOf("a"));
    expect(await titles(cache)).toEqual(["one", "two"]);
  });

  it("keeps the kept entry even on its own over the limit", async () => {
    const { cache, add } = setup(1);
    await add(idOf("a"), "big");
    await cache.prune(idOf("a"));
    expect(await cache.list()).toHaveLength(1);
  });

  it("hides an unfinished write and clears it", async () => {
    const { dir, cache } = setup(1e9);
    // What an interrupted commit leaves: stems on disk, no meta.json.
    const entry = await dir.getDirectoryHandle(idOf("c"), { create: true });
    const stems = await entry.getDirectoryHandle("stems", { create: true });
    await stems.getFileHandle("vocals.m4a", { create: true });
    expect(await cache.touch(idOf("c"))).toBeNull();
    expect(await cache.list()).toHaveLength(0);
    await cache.clearIncomplete();
    expect([...dir.entries.keys()]).toEqual([]);
  });

  it("refuses ids that aren't a hash and a model", async () => {
    const { cache } = setup(1e9);
    expect(await cache.touch("../../etc")).toBeNull();
    expect(await cache.touch("aaaa/../../x-htdemucs")).toBeNull();
  });
});

describe("cache ids", () => {
  it("follow the audio, not the filename, and keep models apart", async () => {
    const a = new File(["same bytes"], "song.mp3");
    const b = new File(["same bytes"], "renamed copy.mp3");
    expect(await idFor(a, "htdemucs")).toBe(await idFor(b, "htdemucs"));
    expect(await idFor(a, "htdemucs")).not.toBe(await idFor(a, "htdemucs_ft" as ModelId));
  });

  it("start with the same cut hash the separation API checks", async () => {
    const id = await idFor(new File(["same bytes"], "song.mp3"), "htdemucs");
    const [hash, model] = id.split("-");
    expect(HASH_PATTERN.test(hash)).toBe(true);
    expect(model).toBe("htdemucs");
  });
});
