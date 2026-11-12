import { STEM_NAMES, type Result, type StemMap, type StemSource } from "@stem-player-web/core";
import { isDemoStem } from "./demo";
import { STEMS_FOLDER_ID, isAbort } from "./pickers";
import { readStem, stemExtension } from "./stems";
import { zipStored } from "./zip";

const FAILED = { ok: false, message: "Couldn't export the stems." } as const;

// Like the desktop's path.basename(title), so a title can never point the
// export somewhere else.
function exportName(title: string): string {
  const name = title.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return name === "." || name === ".." || name === "" ? "stems" : name;
}

const stemFileName = (stem: string, source: StemSource) => `${stem}.${stemExtension(source)}`;

const asBlob = async (source: StemSource) => (source instanceof URL ? new Blob([await readStem(source)]) : source);

// A file with the name counts as taken too, as it did for fs.existsSync.
async function exists(base: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await base.getDirectoryHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "TypeMismatchError") return true;
    if (err instanceof DOMException && err.name === "NotFoundError") return false;
    throw err;
  }
}

// Always a new folder, so an export can never replace anything already there.
async function exportToFolder(base: FileSystemDirectoryHandle, stems: StemMap<StemSource>, name: string) {
  let dirName = name;
  for (let n = 2; await exists(base, dirName); n++) dirName = `${name} (${n})`;

  const dir = await base.getDirectoryHandle(dirName, { create: true });
  try {
    for (const stem of STEM_NAMES) {
      const blob = await asBlob(stems[stem]);
      const file = await dir.getFileHandle(stemFileName(stem, stems[stem]), { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (err) {
        // Chromium locks a file while its writable is open, which would make
        // removing the folder below fail and leave a partial export behind.
        await writable.abort();
        throw err;
      }
    }
  } catch (err) {
    await base.removeEntry(dirName, { recursive: true });
    throw err;
  }
  return dirName;
}

async function downloadZip(stems: StemMap<StemSource>, name: string) {
  const files = await Promise.all(
    STEM_NAMES.map(async (stem) => ({
      name: `${name}/${stemFileName(stem, stems[stem])}`,
      data: new Uint8Array(await readStem(stems[stem])),
    })),
  );
  const zipName = `${name}.zip`;
  const url = URL.createObjectURL(zipStored(files));
  const link = document.createElement("a");
  link.href = url;
  link.download = zipName;
  document.body.append(link);
  link.click();
  link.remove();
  // Safari can still be reading the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return zipName;
}

export async function exportStems(stems: StemMap<StemSource>, title: string): Promise<Result<{ name: string }>> {
  // A courtesy to the label, not protection: the browser already has these stems.
  if (STEM_NAMES.some((stem) => isDemoStem(stems[stem], stem))) {
    return { ok: false, message: "The demo song can't be exported." };
  }
  const name = exportName(title);

  if (window.showDirectoryPicker) {
    let base: FileSystemDirectoryHandle | null = null;
    try {
      base = await window.showDirectoryPicker({ id: STEMS_FOLDER_ID, mode: "readwrite", startIn: "music" });
    } catch (err) {
      if (isAbort(err)) return { ok: false, canceled: true };
      // The picker needs a recent click, which a caller that awaited something
      // first may have used up. A download still gets the stems out.
      console.warn("[export] folder picker failed, downloading a zip:", err);
    }
    if (base) {
      try {
        return { ok: true, name: await exportToFolder(base, stems, name) };
      } catch (err) {
        console.error("[export] failed:", err);
        return FAILED;
      }
    }
  }

  try {
    return { ok: true, name: await downloadZip(stems, name) };
  } catch (err) {
    console.error("[export] zip failed:", err);
    return FAILED;
  }
}
