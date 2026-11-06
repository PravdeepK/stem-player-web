// Shapes shared by the site, its API routes and the separator worker.

export const STEM_NAMES = ["vocals", "drums", "bass", "instrumental"] as const;
export type StemName = (typeof STEM_NAMES)[number];
export type StemMap<T> = Record<StemName, T>;

// Best (htdemucs_ft) runs four models per song, which is too slow and too
// expensive on a shared GPU, so only Fast exists here.
export const MODEL_IDS = ["htdemucs"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

// What the progress bar is following. "uploading" and "queued" happen before
// the worker sees the song; the GPU container is limited to one at a time, so
// a job can wait. The desktop's "engine" and "model" downloads don't exist on
// the server, where both are baked into the image.
export type Stage = "uploading" | "queued" | "starting" | "separating";

// Same shapes the desktop's IPC handlers return.
export type Result<T extends object> =
  | ({ ok: true } & T)
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; message: string };

// A stem's bytes: a picked or cached file, or a URL (the demo song, or
// separated stems behind a short-lived signed link).
export type StemSource = Blob | URL;

export interface CacheEntry {
  // The first 32 hex characters of the song's SHA-256, then the model.
  id: string;
  title: string;
  model: ModelId;
  lastUsed: number;
  stems: StemMap<StemSource>;
  // The demo song can be played and mixed, but not exported.
  demo: boolean;
}

export type HapticPattern = "generic" | "level" | "alignment";

export type FeedbackType = "bug" | "feature";

export type StemApi = {
  pickFile(): Promise<File | null>;
  getModel(): Promise<ModelId>;
  // The API won't start a job without a Turnstile token from the page.
  separate(file: File, model: ModelId, turnstileToken: string): Promise<Result<{ entry: CacheEntry }>>;
  findCached(file: File, model: ModelId): Promise<CacheEntry | null>;
  // Most recently used first.
  listRecent(): Promise<CacheEntry[]>;
  openRecent(id: string): Promise<CacheEntry | null>;
  openDemo(): Promise<Result<{ entry: CacheEntry }>>;
  // `name` is the folder or zip the stems were saved as.
  exportStems(stems: StemMap<StemSource>, title: string): Promise<Result<{ name: string }>>;
  // `dir` is the picked folder's name, or "" when the stems were picked as files.
  pickStemsFolder(): Promise<Result<{ stems: StemMap<File>; dir: string }>>;
  readStem(source: StemSource): Promise<ArrayBuffer>;
  haptic(pattern: HapticPattern): void;
  onStage(handler: (stage: Stage) => void): () => void;
  onProgress(handler: (value: number) => void): () => void;
};

export interface StemSetting {
  volume: number;
  muted: boolean;
  solo: boolean;
}

export type StemLevels = StemMap<number>;

// What useAudioMixer hands the components.
export interface MixerHandle {
  isLoaded: boolean;
  isLoading: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  error: string;
  settings: StemMap<StemSetting>;
  masterVolume: number;
  buffers: StemMap<AudioBuffer> | null;
  load(stems: StemMap<StemSource>): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(time: number): void;
  previewTime(time: number): void;
  setVolume(name: StemName, volume: number): void;
  setMute(name: StemName, muted: boolean): void;
  setSolo(name: StemName, solo: boolean): void;
  setMasterVolume(volume: number): void;
  onTime(listener: (time: number) => void): () => void;
  // `stopped` is true once, on the frame playback stops.
  onLevels(listener: (levels: StemLevels, stopped: boolean) => void): () => void;
  getPosition(): number;
  getOutputLatency(): number;
}

// --- separation ------------------------------------------------------------
// services/separator mirrors the job, hash and storage shapes below by hand
// in Python. Change both together.

// Why a separation failed, set by the worker. "model" means the weights
// couldn't load, which no retry would fix.
export type SeparationErrorCode = "too_long" | "decode" | "model" | "write" | "timeout" | "internal";

// One line of the worker's progress, the same messages separate.py prints.
// `stems` on "done" holds R2 keys.
export type SeparationEvent =
  | { type: "progress"; value: number }
  | { type: "stage"; value: Extract<Stage, "starting" | "separating"> }
  | { type: "done"; stems: StemMap<string> }
  | { type: "error"; code: SeparationErrorCode; message: string };

// The API's call to the worker, with the shared secret as a Bearer token.
export interface SeparateRequest {
  jobId: string;
  uploadKey: string;
  model: ModelId;
}

// `hash` is always the worker's own hash of the uploaded bytes. A cache hit
// returns the stems straight away and never starts the GPU.
export type SeparateResponse =
  | { ok: true; hash: string; cached: true; stems: StemMap<string> }
  | { ok: true; hash: string; cached: false }
  | { ok: false; code: SeparationErrorCode; message: string };

interface JobFields {
  jobId: string;
  stage: Stage;
  // 0 to 1 within the current stage.
  progress: number;
  // null until the worker has hashed the upload.
  hash: string | null;
  // Milliseconds since the epoch.
  createdAt: number;
  updatedAt: number;
}

// Stored as JSON under jobKey(jobId).
export type JobStatus =
  | (JobFields & { state: "running" })
  | (JobFields & { state: "done"; hash: string; stems: StemMap<string> })
  | (JobFields & { state: "failed"; code: SeparationErrorCode });

// Hashes are lowercase hex, cut to 32 characters like the desktop cache ids.
// The API checks a browser-sent hash against this before it goes near a key.
export const HASH_LENGTH = 32;
export const HASH_PATTERN = /^[0-9a-f]{32}$/;
export const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// --- storage keys ----------------------------------------------------------

// AAC rather than Opus: every browser the site runs in decodes AAC, while
// Safari's Opus support depends on the container and the iOS version.
export const STEM_EXT = "m4a";
export const STEM_CONTENT_TYPE = "audio/mp4";

export const uploadKey = (jobId: string) => `uploads/${jobId}`;
export const stemKey = (hash: string, stem: StemName) => `stems/${hash}/${stem}.${STEM_EXT}`;
export const DEMO_PREFIX = "demo/";
export const demoStemKey = (stem: StemName) => `${DEMO_PREFIX}${stem}.${STEM_EXT}`;

export const jobKey = (jobId: string) => `job:${jobId}`;
// Same lifetime as the R2 files, so a job record never outlives its stems.
export const JOB_TTL_SECONDS = 24 * 60 * 60;

// Prefixes for the rate limiters. The daily counters take a UTC date (YYYY-MM-DD).
export const SEPARATIONS_PER_IP_PREFIX = "limit:separate:ip";
export const separationsTodayKey = (day: string) => `limit:separate:day:${day}`;
export const FEEDBACK_PER_IP_PREFIX = "limit:feedback:ip";
export const feedbackTodayKey = (day: string) => `limit:feedback:day:${day}`;
// A daily counter only matters for its own UTC day. Two days covers a request
// that lands just before midnight, then the key goes.
export const DAILY_COUNTER_TTL_SECONDS = 48 * 60 * 60;

// Any value pauses separation; deleting the key resumes it.
export const SEPARATION_PAUSED_KEY = "separation:paused";
