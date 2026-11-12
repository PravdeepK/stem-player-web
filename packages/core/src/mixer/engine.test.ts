import { describe, expect, it, vi } from "vitest";
import { STEM_NAMES, type StemMap, type StemSource } from "../types";
import type { MemoryLimits } from "./budget";
import { createMixer } from "./engine";
import { FakeContext } from "./fakeAudio";

// At 1 kHz a 10-second stereo song decodes to 320 kB, so these limits put
// the thresholds at a size a test can afford to allocate.
const RATE = 1000;
const LIMITS: MemoryLimits = { monoAbove: 400_000, refuseAbove: 600_000 };

function setup({ limits = null as MemoryLimits | null } = {}) {
  const context = new FakeContext(RATE);
  const files = new Map<string, ArrayBuffer>();
  const reads: string[] = [];
  let pending: ((now: number) => void)[] = [];
  let contexts = 0;
  const mixer = createMixer({
    createContext: () => {
      contexts++;
      return context as unknown as AudioContext;
    },
    readStem: async (source: StemSource) => {
      const key = String(source);
      reads.push(key);
      const bytes = files.get(key);
      if (!bytes) throw new Error(`no file ${key}`);
      return bytes;
    },
    frames: {
      request: (callback) => pending.push(callback),
      cancel: () => {
        pending = [];
      },
    },
    limits: () => limits,
  });
  const stems = (make: (name: string) => ArrayBuffer) => {
    const out = {} as StemMap<StemSource>;
    for (const name of STEM_NAMES) {
      const url = new URL(`https://stems.test/${name}`);
      files.set(String(url), make(name));
      out[name] = url;
    }
    return out;
  };
  const frame = (now: number) => {
    const run = pending;
    pending = [];
    for (const callback of run) callback(now);
  };
  return { context, mixer, stems, reads, frame, contexts: () => contexts, frames: () => pending.length };
}

const channelsOf = (buffers: StemMap<AudioBuffer> | null) =>
  STEM_NAMES.map((name) => buffers?.[name].numberOfChannels);

describe("loading", () => {
  it("decodes one stem at a time, reading at most one ahead", async () => {
    const { context, mixer, stems, reads } = setup();
    let maxAhead = 0;
    const original = context.decodeAudioData.bind(context);
    context.decodeAudioData = async (bytes) => {
      maxAhead = Math.max(maxAhead, reads.length - context.decodes);
      return original(bytes);
    };
    await mixer.load(stems(() => context.file(10)));
    expect(context.maxInFlight).toBe(1);
    expect(maxAhead).toBeLessThanOrEqual(2);
    expect(mixer.getState()).toMatchObject({ isLoaded: true, isLoading: false, duration: 10, error: "" });
  });

  it("keeps long stems in stereo without limits", async () => {
    const { context, mixer, stems } = setup();
    await mixer.load(stems(() => context.file(40)));
    expect(channelsOf(mixer.getState().buffers)).toEqual([2, 2, 2, 2]);
  });

  it("keeps stereo under the budget", async () => {
    const { context, mixer, stems } = setup({ limits: LIMITS });
    await mixer.load(stems(() => context.wav(10)));
    expect(channelsOf(mixer.getState().buffers)).toEqual([2, 2, 2, 2]);
  });

  it("downmixes to mono past the first limit", async () => {
    const { context, mixer, stems } = setup({ limits: LIMITS });
    await mixer.load(stems(() => context.wav(15)));
    expect(channelsOf(mixer.getState().buffers)).toEqual([1, 1, 1, 1]);
    expect(mixer.getState().duration).toBe(15);
  });

  it("refuses from the header, before decoding anything", async () => {
    const { context, mixer, stems } = setup({ limits: LIMITS });
    await mixer.load(stems(() => context.wav(40)));
    expect(context.decodes).toBe(0);
    expect(mixer.getState()).toMatchObject({
      isLoaded: false,
      isLoading: false,
      buffers: null,
      error: "These stems are too long for this device.",
    });
  });

  it("refuses after the first decode when the header can't be read", async () => {
    const { context, mixer, stems } = setup({ limits: LIMITS });
    await mixer.load(stems(() => context.file(40)));
    expect(context.decodes).toBe(1);
    expect(mixer.getState().error).toBe("These stems are too long for this device.");
  });

  it("downmixes stems already decoded when a later one tips the total over", async () => {
    const { context, mixer, stems } = setup({ limits: LIMITS });
    await mixer.load(stems((name) => context.file(name === "instrumental" ? 30 : 10)));
    expect(channelsOf(mixer.getState().buffers)).toEqual([1, 1, 1, 1]);
    expect(mixer.getState().duration).toBe(30);
  });

  it("averages the channels when downmixing", async () => {
    const { context, mixer, stems } = setup({ limits: LIMITS });
    const original = context.decodeAudioData.bind(context);
    context.decodeAudioData = async (bytes) => {
      const buffer = await original(bytes);
      buffer.getChannelData(0).fill(0.8);
      buffer.getChannelData(1).fill(0.2);
      return buffer;
    };
    await mixer.load(stems(() => context.wav(15)));
    expect(mixer.getState().buffers?.vocals.getChannelData(0)[100]).toBeCloseTo(0.5);
  });

  it("keeps only the newest of two overlapping loads", async () => {
    const { context, mixer, stems } = setup();
    const first = mixer.load(stems(() => context.file(10)));
    const second = mixer.load(stems(() => context.file(20)));
    await Promise.all([first, second]);
    expect(mixer.getState()).toMatchObject({ isLoaded: true, isLoading: false, duration: 20 });
  });

  it("reports a stem that won't decode", async () => {
    const { mixer, stems } = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await mixer.load(stems(() => new ArrayBuffer(8)));
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
    expect(mixer.getState()).toMatchObject({ isLoaded: false, isLoading: false });
    expect(mixer.getState().error).toMatch(/Couldn't load the stems/);
  });
});

describe("transport", () => {
  async function loaded() {
    const harness = setup();
    await harness.mixer.load(harness.stems(() => harness.context.file(10)));
    return harness;
  }

  it("starts all four sources together from the same offset", async () => {
    const { context, mixer } = await loaded();
    context.currentTime = 3;
    await mixer.play();
    expect(context.state).toBe("running");
    const starts = context.sources.map((s) => s.started);
    expect(starts).toHaveLength(4);
    expect(new Set(starts.map((s) => s?.when))).toEqual(new Set([3.06]));
    expect(starts.every((s) => s?.offset === 0)).toBe(true);
    expect(mixer.getState().isPlaying).toBe(true);
  });

  it("restarts every source at the new offset on seek", async () => {
    const { context, mixer } = await loaded();
    await mixer.play();
    mixer.seek(4);
    const before = context.sources.slice(0, 4);
    const after = context.sources.slice(4);
    expect(before.every((s) => s.stopped)).toBe(true);
    expect(after.map((s) => s.started?.offset)).toEqual([4, 4, 4, 4]);
  });

  it("holds the position from the audio clock on pause", async () => {
    const { context, mixer } = await loaded();
    await mixer.play();
    context.currentTime = 0.06 + 2.5;
    expect(mixer.getPosition()).toBeCloseTo(2.5);
    mixer.pause();
    context.currentTime = 9;
    expect(mixer.getState()).toMatchObject({ isPlaying: false });
    expect(mixer.getState().currentTime).toBeCloseTo(2.5);
    await mixer.play();
    expect(context.sources.at(-1)?.started?.offset).toBeCloseTo(2.5);
  });

  it("moves the playhead on preview without touching the audio", async () => {
    const { context, mixer, frame } = await loaded();
    await mixer.play();
    const times: number[] = [];
    mixer.onTime((t) => times.push(t));
    mixer.previewTime(7);
    context.currentTime = 1;
    frame(100);
    expect(context.sources).toHaveLength(4);
    expect(times.at(-1)).toBe(7);
    mixer.seek(7);
    expect(context.sources).toHaveLength(8);
  });

  it("stops and rewinds at the end of the song", async () => {
    const { context, mixer, frame } = await loaded();
    await mixer.play();
    const stops: boolean[] = [];
    mixer.onLevels((_levels, stopped) => stops.push(stopped));
    context.currentTime = 5;
    frame(100);
    context.currentTime = 11;
    frame(200);
    expect(stops).toEqual([false, false, true]);
    expect(mixer.getState()).toMatchObject({ isPlaying: false, currentTime: 0 });
  });

  it("silences the other stems while one is soloed", async () => {
    const { context, mixer } = await loaded();
    mixer.setSolo("drums", true);
    const stemGains = context.gains.slice(1);
    const last = stemGains.map((g) => g.gain.events.filter((e) => e.type === "target").at(-1)?.value);
    expect(last).toEqual([0, 1, 0, 0]);
    mixer.setMute("drums", true);
    expect(mixer.getState().settings.drums).toEqual({ volume: 1, muted: true, solo: false });
  });

  it("reads the output latency from the context", async () => {
    const { mixer } = await loaded();
    expect(mixer.getOutputLatency()).toBeCloseTo(0.025);
  });

  it("doesn't start playing when disposed during the resume", async () => {
    const { mixer, contexts, frames } = await loaded();
    const playing = mixer.play();
    mixer.dispose();
    await playing;
    expect(contexts()).toBe(1);
    expect(frames()).toBe(0);
    expect(mixer.getState().isPlaying).toBe(false);
  });

  it("closes the context on dispose and starts over on the next load", async () => {
    const { context, mixer, stems } = await loaded();
    mixer.dispose();
    expect(context.closed).toBe(true);
    expect(mixer.getState().isLoaded).toBe(false);
    context.state = "suspended";
    await mixer.load(stems(() => context.file(5)));
    expect(mixer.getState().duration).toBe(5);
  });
});
