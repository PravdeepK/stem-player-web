import type { StemApi, StemSource } from "@stem-player-web/core";

const unavailable = { ok: false, message: "Not available yet." } as const;
const noSubscription = () => () => {};

async function readStem(source: StemSource): Promise<ArrayBuffer> {
  if (source instanceof URL) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`stem fetch failed: ${response.status} ${source.pathname}`);
    return response.arrayBuffer();
  }
  return source.arrayBuffer();
}

// Answers every call the way a fresh browser with nothing picked or cached would.
export const stubStemApi: StemApi = {
  pickFile: async () => null,
  getModel: async () => "htdemucs",
  separate: async () => unavailable,
  findCached: async () => null,
  listRecent: async () => [],
  openRecent: async () => null,
  openDemo: async () => unavailable,
  exportStems: async () => unavailable,
  pickStemsFolder: async () => ({ ok: false, canceled: true }),
  readStem,
  haptic: () => {},
  onStage: noSubscription,
  onProgress: noSubscription,
};
