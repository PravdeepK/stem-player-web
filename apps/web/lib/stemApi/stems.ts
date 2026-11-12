import { STEM_EXT, type Result, type StemMap, type StemSource } from "@stem-player-web/core";

// Generous for WAV, and guards against a stray huge file freezing the page in
// decodeAudioData.
export const MAX_STEM_BYTES = 200 * 1024 * 1024;

// The desktop exports WAV and the site exports AAC, so a folder from either loads.
const STEM_EXTENSIONS = ["wav", STEM_EXT];

export const FOLDER_MESSAGE = "That folder doesn't contain vocals/drums/bass/instrumental .wav or .m4a files.";
const FILES_MESSAGE = "Those files don't include vocals/drums/bass/instrumental .wav or .m4a files.";

/** The four stems among `files`, matched by name, or null if any is missing. A legacy other.wav counts as instrumental. */
export function matchStems<T extends { name: string }>(files: Iterable<T>): StemMap<T> | null {
  const byName = new Map<string, T>();
  for (const file of files) byName.set(file.name.toLowerCase(), file);
  const pick = (name: string) => {
    for (const ext of STEM_EXTENSIONS) {
      const file = byName.get(`${name}.${ext}`);
      if (file) return file;
    }
    return undefined;
  };
  const vocals = pick("vocals");
  const drums = pick("drums");
  const bass = pick("bass");
  const instrumental = pick("instrumental") ?? pick("other");
  if (!vocals || !drums || !bass || !instrumental) return null;
  return { vocals, drums, bass, instrumental };
}

type PickedFile = { name: string; webkitRelativePath: string };

/**
 * Resolves what a webkitdirectory input handed back. Like the desktop, the
 * picked folder can hold the stems or a stems/ folder that does. A browser that
 * ignores webkitdirectory (iOS before 18.4) lets the user pick files instead,
 * which arrive without a relative path and are matched by name.
 */
export function resolvePicked<T extends PickedFile>(files: T[]): Result<{ stems: StemMap<T>; dir: string }> {
  if (files.length > 0 && files.every((file) => file.webkitRelativePath === "")) {
    const stems = matchStems(files);
    return stems ? { ok: true, stems, dir: "" } : { ok: false, message: FILES_MESSAGE };
  }

  const inFolder: T[] = [];
  const inStems: T[] = [];
  let dir = "";
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/");
    dir = parts[0];
    if (parts.length === 2) inFolder.push(file);
    else if (parts.length === 3 && parts[1].toLowerCase() === "stems") inStems.push(file);
  }
  const stems = matchStems(inFolder) ?? matchStems(inStems);
  return stems ? { ok: true, stems, dir } : { ok: false, message: FOLDER_MESSAGE };
}

/** The extension a stem is exported with: its own, so a picked WAV stays a WAV. */
export function stemExtension(source: StemSource): string {
  const name = source instanceof URL ? source.pathname : source instanceof File ? source.name : "";
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toLowerCase() : STEM_EXT;
}

function tooLarge(label: string): Error {
  return new Error(`stem file too large: ${label}`);
}

export async function readStem(source: StemSource): Promise<ArrayBuffer> {
  if (source instanceof URL) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`stem fetch failed: ${response.status} ${source.pathname}`);
    if (Number(response.headers.get("content-length")) > MAX_STEM_BYTES) {
      await response.body?.cancel();
      throw tooLarge(source.pathname);
    }
    // Content-Length can be missing or describe the compressed body.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_STEM_BYTES) throw tooLarge(source.pathname);
    return buffer;
  }
  if (source.size > MAX_STEM_BYTES) throw tooLarge(source instanceof File ? source.name : "blob");
  return source.arrayBuffer();
}
