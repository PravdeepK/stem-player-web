import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_STEM_BYTES, matchStems, readStem, resolvePicked } from "./stems";

const picked = (webkitRelativePath: string) => ({ name: webkitRelativePath.split("/").pop()!, webkitRelativePath });
const file = (name: string) => ({ name, webkitRelativePath: "" });

describe("matching stems", () => {
  it("takes a legacy other.wav as instrumental and ignores case", () => {
    const stems = matchStems(["Vocals.WAV", "drums.wav", "bass.m4a", "other.wav"].map(file));
    expect(stems?.vocals.name).toBe("Vocals.WAV");
    expect(stems?.instrumental.name).toBe("other.wav");
  });

  it("needs all four", () => {
    expect(matchStems(["vocals.wav", "drums.wav", "bass.wav"].map(file))).toBeNull();
    expect(matchStems(["vocals.mp3", "drums.wav", "bass.wav", "instrumental.wav"].map(file))).toBeNull();
  });

  it("finds the stems in a picked folder or its stems/ folder", () => {
    const flat = resolvePicked(["Song/vocals.wav", "Song/drums.wav", "Song/bass.wav", "Song/instrumental.wav"].map(picked));
    expect(flat).toMatchObject({ ok: true, dir: "Song" });

    const nested = resolvePicked(
      ["Song/cover.jpg", "Song/stems/vocals.m4a", "Song/stems/drums.m4a", "Song/stems/bass.m4a", "Song/stems/instrumental.m4a"].map(picked),
    );
    expect(nested).toMatchObject({ ok: true, dir: "Song" });

    const deeper = resolvePicked(["Music/a/b/vocals.wav", "Music/a/b/drums.wav", "Music/a/b/bass.wav", "Music/a/b/instrumental.wav"].map(picked));
    expect(deeper.ok).toBe(false);
  });

  it("matches files picked without a folder by name", () => {
    const result = resolvePicked(["vocals.wav", "drums.wav", "bass.wav", "instrumental.wav"].map(file));
    expect(result).toMatchObject({ ok: true, dir: "" });
    expect(resolvePicked([file("vocals.wav")]).ok).toBe(false);
  });
});

describe("reading a stem", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a file over the size limit", async () => {
    const huge = Object.defineProperty(new File([], "vocals.wav"), "size", { value: MAX_STEM_BYTES + 1 });
    await expect(readStem(huge)).rejects.toThrow("too large");
  });

  it("refuses a download that says it's over the size limit", async () => {
    const fetch = vi.fn(async () => new Response("x", { headers: { "content-length": String(MAX_STEM_BYTES + 1) } }));
    vi.stubGlobal("fetch", fetch);
    await expect(readStem(new URL("https://example.com/demo/vocals.m4a"))).rejects.toThrow("too large");
  });

  it("reads a file within the limit", async () => {
    const bytes = await readStem(new Blob([new Uint8Array([1, 2, 3])]));
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
