// decodeAudioData always hands back 32-bit float PCM at the context's sample
// rate, whatever the file held, so a 4 MB AAC stem can become 100 MB or more.
const BYTES_PER_SAMPLE = 4;

export interface MemoryLimits {
  // Downmix every stem to mono when the decoded stems as they are would pass this.
  monoAbove: number;
  // Refuse the song when even the mono stems would pass this.
  refuseAbove: number;
}

// Bytes, in decimal MB. Measured on an iPhone 18 Pro, where a tab holding more
// decoded audio than this gets killed. At 48 kHz that keeps songs up to about
// 5:25 in stereo and refuses anything past about 15:11.
export const TOUCH_LIMITS: MemoryLimits = { monoAbove: 500e6, refuseAbove: 700e6 };

export interface StemSize {
  seconds: number;
  channels: number;
}

export type ChannelPlan = "keep" | "mono" | "refuse";

export function decodedBytes(seconds: number, sampleRate: number, channels: number) {
  return seconds * sampleRate * channels * BYTES_PER_SAMPLE;
}

export function planChannels(stems: readonly StemSize[], sampleRate: number, limits: MemoryLimits): ChannelPlan {
  let kept = 0;
  let mono = 0;
  for (const { seconds, channels } of stems) {
    kept += decodedBytes(seconds, sampleRate, channels);
    mono += decodedBytes(seconds, sampleRate, 1);
  }
  if (kept <= limits.monoAbove) return "keep";
  if (mono <= limits.refuseAbove) return "mono";
  return "refuse";
}
