import type { CacheEntry, ModelId, Result, Stage } from "@stem-player-web/core";

export async function separate(
  _file: File,
  _model: ModelId,
  _turnstileToken: string,
): Promise<Result<{ entry: CacheEntry }>> {
  return { ok: false, message: "Making stems isn't available yet." };
}

export const onStage = (_handler: (stage: Stage) => void) => () => {};
export const onProgress = (_handler: (value: number) => void) => () => {};
