import { STEM_NAMES, type StemMap, type StemName, type StemSource } from "../types";
import { planChannels, type MemoryLimits, type StemSize } from "./budget";
import { probeSeconds } from "./probe";

export class StemsTooLongError extends Error {
  constructor() {
    super("These stems are too long for this device.");
    this.name = "StemsTooLongError";
  }
}

export interface DecodeOptions {
  context: BaseAudioContext;
  stems: StemMap<StemSource>;
  readStem: (source: StemSource) => Promise<ArrayBuffer>;
  // null decodes the stems as they are, with no limit.
  limits: MemoryLimits | null;
  // Checked after every await, so a newer load stops this one early.
  superseded: () => boolean;
}

type Settled<T> = { value: T } | { error: unknown };

// The next stem's bytes are read while the current one decodes. If that
// decode throws, the read is left behind, and settling it up front keeps its
// own failure from surfacing as an unhandled rejection.
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

function unwrap<T>(result: Settled<T>): T {
  if ("error" in result) throw result.error;
  return result.value;
}

export function downmix(context: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels === 1) return buffer;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const mono = context.createBuffer(1, buffer.length, buffer.sampleRate);
  const out = mono.getChannelData(0);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return mono;
}

// Stems that haven't been measured yet are taken to be as long as the longest
// one that has, and stereo. Separated stems all share one length.
function estimate(sizes: ReadonlyMap<StemName, StemSize>): StemSize[] | null {
  let longest = 0;
  for (const { seconds } of sizes.values()) longest = Math.max(longest, seconds);
  if (!sizes.size) return null;
  return STEM_NAMES.map((name) => sizes.get(name) ?? { seconds: longest, channels: 2 });
}

// One stem at a time: a decode briefly needs its compressed bytes and the
// whole PCM result at once, and four in parallel would put four of those
// peaks on top of each other.
export async function decodeStems(options: DecodeOptions): Promise<StemMap<AudioBuffer> | null> {
  const { context, stems, readStem, limits, superseded } = options;
  const sizes = new Map<StemName, StemSize>();
  const buffers = new Map<StemName, AudioBuffer>();
  let mono = false;

  const check = () => {
    if (!limits) return;
    const all = estimate(sizes);
    if (!all) return;
    const plan = planChannels(all, context.sampleRate, limits);
    if (plan === "refuse") throw new StemsTooLongError();
    if (plan === "mono" && !mono) {
      mono = true;
      for (const [name, buffer] of buffers) buffers.set(name, downmix(context, buffer));
    }
  };

  const read = (name: StemName) => settle(readStem(stems[name]));
  let next = read(STEM_NAMES[0]);

  for (const [i, name] of STEM_NAMES.entries()) {
    const bytes = unwrap(await next);
    if (superseded()) return null;
    const following = STEM_NAMES[i + 1];
    if (following) next = read(following);

    if (limits) {
      const seconds = probeSeconds(bytes);
      if (seconds !== null) sizes.set(name, { seconds, channels: 2 });
      check();
    }

    const decoded = await context.decodeAudioData(bytes);
    if (superseded()) return null;
    sizes.set(name, { seconds: decoded.duration, channels: decoded.numberOfChannels });
    check();
    buffers.set(name, mono ? downmix(context, decoded) : decoded);
  }

  const result = {} as StemMap<AudioBuffer>;
  for (const [name, buffer] of buffers) result[name] = buffer;
  return result;
}
