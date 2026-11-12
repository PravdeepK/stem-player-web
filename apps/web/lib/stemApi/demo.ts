import { STEM_NAMES, demoStemKey, type CacheEntry, type Result, type StemName, type StemSource } from "@stem-player-web/core";

// Where the bucket's keys resolve, so the demo is at <base>demo/vocals.m4a. It
// can be absolute (a domain in front of the bucket) or a path on this site.
const DEMO_BASE_URL = process.env.NEXT_PUBLIC_DEMO_BASE_URL;

// The SHA-256 of the released mp3, cut like any cache id, so the demo's id is
// the one the site would give that file.
const DEMO_ID = "8dadfc64562b8234f5bf3b3c2ea536cb-htdemucs";
const DEMO_TITLE = "Cartoon, Jéja - On & On (feat. Daniel Levi)";

function demoStemUrl(stem: StemName): URL | null {
  if (!DEMO_BASE_URL) return null;
  // Without the slash, new URL() would drop the base's last path segment.
  const base = DEMO_BASE_URL.endsWith("/") ? DEMO_BASE_URL : `${DEMO_BASE_URL}/`;
  return new URL(demoStemKey(stem), new URL(base, location.href));
}

export function isDemoStem(source: StemSource, stem: StemName): boolean {
  return source instanceof URL && source.href === demoStemUrl(stem)?.href;
}

export async function openDemo(): Promise<Result<{ entry: CacheEntry }>> {
  const urls = STEM_NAMES.map(demoStemUrl);
  if (urls.some((url) => !url)) {
    console.error("[demo] NEXT_PUBLIC_DEMO_BASE_URL isn't set");
    return { ok: false, message: "The demo song isn't available." };
  }
  const [vocals, drums, bass, instrumental] = urls as URL[];
  return {
    ok: true,
    entry: {
      id: DEMO_ID,
      title: DEMO_TITLE,
      model: "htdemucs",
      lastUsed: Date.now(),
      stems: { vocals, drums, bass, instrumental },
      demo: true,
    },
  };
}
