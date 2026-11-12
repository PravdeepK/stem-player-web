import type { Result, StemMap } from "@stem-player-web/core";
import { FOLDER_MESSAGE, matchStems, resolvePicked } from "./stems";

// Chromium only, so it isn't in TypeScript's DOM types.
interface DirectoryPickerOptions {
  // The browser remembers the last folder per id. Opening and exporting share
  // one, like the desktop's single remembered stems folder.
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: "music" | "downloads" | "documents" | "desktop";
}

declare global {
  interface Window {
    showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}

export const STEMS_FOLDER_ID = "stems";

const CANCELED = { ok: false, canceled: true } as const;

export const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

// The same formats the desktop's file dialog allowed.
const SONG_TYPES = ".mp3,.wav,.flac,.m4a,.mp4,audio/mpeg,audio/wav,audio/flac,audio/mp4,video/mp4";

/** Opens a file input and resolves to what was picked, or null on cancel. */
function chooseFiles(setup: (input: HTMLInputElement) => void): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    setup(input);
    const finish = (files: File[] | null) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(input.files ? [...input.files] : []), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    // Some Safari versions ignore click() on an input that isn't in the document.
    document.body.append(input);
    input.click();
  });
}

export async function pickFile(): Promise<File | null> {
  const files = await chooseFiles((input) => {
    input.accept = SONG_TYPES;
  });
  return files?.[0] ?? null;
}

export async function pickStemsFolder(): Promise<Result<{ stems: StemMap<File>; dir: string }>> {
  if (window.showDirectoryPicker) {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker({ id: STEMS_FOLDER_ID, startIn: "music" });
    } catch (err) {
      if (isAbort(err)) return CANCELED;
      console.error("[stems] folder picker failed:", err);
      return { ok: false, message: "Couldn't open that folder." };
    }
    return resolveDirectory(dir);
  }

  // `multiple` matters where webkitdirectory is ignored: the same input then
  // lets the user pick the four files instead.
  const files = await chooseFiles((input) => {
    input.multiple = true;
    input.webkitdirectory = true;
  });
  return files ? resolvePicked(files) : CANCELED;
}

async function resolveDirectory(dir: FileSystemDirectoryHandle): Promise<Result<{ stems: StemMap<File>; dir: string }>> {
  const files: FileSystemFileHandle[] = [];
  let stemsDir: FileSystemDirectoryHandle | undefined;
  for await (const handle of dir.values()) {
    if (handle.kind === "file") files.push(handle);
    else if (handle.name.toLowerCase() === "stems") stemsDir = handle;
  }

  let match = matchStems(files);
  if (!match && stemsDir) {
    const inStems: FileSystemFileHandle[] = [];
    for await (const handle of stemsDir.values()) if (handle.kind === "file") inStems.push(handle);
    match = matchStems(inStems);
  }
  if (!match) {
    console.error("[stems] folder has no complete stem set:", dir.name);
    return { ok: false, message: FOLDER_MESSAGE };
  }

  const { vocals, drums, bass, instrumental } = match;
  const [v, d, b, i] = await Promise.all([vocals, drums, bass, instrumental].map((handle) => handle.getFile()));
  return { ok: true, stems: { vocals: v, drums: d, bass: b, instrumental: i }, dir: dir.name };
}
