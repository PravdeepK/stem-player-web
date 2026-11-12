import {
  STEM_NAMES,
  type MixerHandle,
  type StemLevels,
  type StemMap,
  type StemName,
  type StemSetting,
  type StemSource,
} from "../types";
import type { MemoryLimits } from "./budget";
import { StemsTooLongError, decodeStems } from "./decode";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// 4 stems reconstruct a near-0 dBFS master, so summing them at unity clips on
// transients. The master bus never rises above this, ~6 dB down.
const HEADROOM = 0.5;

// Far enough ahead that all four sources are created before the shared start
// time arrives, so none of them begins a render quantum late.
const START_LEAD_S = 0.06;

// React re-renders the whole page on a currentTime change; the playhead and
// seek fill follow onTime every frame instead.
const STATE_TIME_INTERVAL_MS = 60;

export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(id: number): void;
}

export interface MixerDeps {
  // Called on the first load or play, never before, so rendering on the
  // server and loading the page touch no audio.
  createContext: () => AudioContext;
  readStem: (source: StemSource) => Promise<ArrayBuffer>;
  frames: FrameScheduler;
  // Read at the start of each load. null means no memory limit.
  limits: () => MemoryLimits | null;
}

export type MixerState = Pick<
  MixerHandle,
  "isLoaded" | "isLoading" | "isPlaying" | "currentTime" | "duration" | "error" | "settings" | "masterVolume" | "buffers"
>;

export interface Mixer extends Omit<MixerHandle, keyof MixerState> {
  getState(): MixerState;
  subscribe(listener: () => void): () => void;
  // Stops playback and closes the context. The mixer can still be used
  // afterwards; the next load starts from scratch.
  dispose(): void;
}

function emptySettings(): StemMap<StemSetting> {
  const out = {} as StemMap<StemSetting>;
  for (const name of STEM_NAMES) out[name] = { volume: 1, muted: false, solo: false };
  return out;
}

const INITIAL_STATE: MixerState = {
  isLoaded: false,
  isLoading: false,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  error: "",
  settings: emptySettings(),
  masterVolume: 1,
  buffers: null,
};

/**
 * Owns the Web Audio graph and transport for the 4 stems. The graph lives in
 * this closure; the state snapshot is a read-only mirror for rendering, so a
 * re-render never touches or restarts playback.
 *
 * Graph: AudioBufferSourceNode (per stem, recreated per play/seek)
 *          -> GainNode (per stem, persistent) -> master -> destination
 *                \-> AnalyserNode (per stem, a tap for level meters only)
 * Sync: all 4 sources are scheduled with a single shared `start(when, offset)`.
 */
export function createMixer(deps: MixerDeps): Mixer {
  let context: AudioContext | null = null;
  let buffers: Partial<StemMap<AudioBuffer>> = {};
  let gains: Partial<StemMap<GainNode>> = {};
  let analysers: Partial<StemMap<AnalyserNode>> = {};
  let master: GainNode | null = null;
  let sources: AudioBufferSourceNode[] = [];
  let levelBuffer: Float32Array<ArrayBuffer> | null = null;
  // context.currentTime when the current segment was scheduled, and the track
  // position it starts from.
  let startTime = 0;
  let offset = 0;
  let duration = 0;
  let playing = false;
  let loaded = false;
  // While a seek control is dragged, previewTime owns the playhead and the
  // audio keeps playing underneath.
  let scrubbing = false;
  let frame = 0;
  let lastStatePush = 0;
  let settings = emptySettings();
  let masterVolume = 1;
  let loadToken = 0;

  let state = INITIAL_STATE;
  const stateListeners = new Set<() => void>();
  const timeListeners = new Set<(time: number) => void>();
  const levelListeners = new Set<(levels: StemLevels, stopped: boolean) => void>();

  const setState = (patch: Partial<MixerState>) => {
    state = { ...state, ...patch };
    for (const listener of stateListeners) listener();
  };

  const getContext = () => {
    context ??= deps.createContext();
    return context;
  };

  const positionNow = () => (playing && context ? offset + (context.currentTime - startTime) : offset);

  const pushTime = (time: number) => {
    for (const listener of timeListeners) listener(time);
  };

  // Each stem's loudness after volume, mute and solo, as 0..1 on a dB scale.
  // Measured after the gain, so a muted or soloed-out stem reads silent.
  const pushLevels = (silent: boolean) => {
    if (!levelListeners.size) return;
    const levels = {} as StemLevels;
    for (const name of STEM_NAMES) {
      const analyser = analysers[name];
      if (silent || !analyser) {
        levels[name] = 0;
        continue;
      }
      levelBuffer ??= new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(levelBuffer);
      let sum = 0;
      for (const sample of levelBuffer) sum += sample * sample;
      const rms = Math.sqrt(sum / levelBuffer.length);
      levels[name] = rms > 0 ? clamp((20 * Math.log10(rms) + 48) / 42, 0, 1) : 0;
    }
    for (const listener of levelListeners) listener(levels, silent);
  };

  const applyGains = () => {
    if (!context) return;
    const anySolo = STEM_NAMES.some((name) => settings[name].solo);
    const t = context.currentTime;
    for (const name of STEM_NAMES) {
      const gain = gains[name];
      if (!gain) continue;
      const stem = settings[name];
      let v = stem.volume;
      if (anySolo) v = stem.solo ? v : 0;
      else if (stem.muted) v = 0;
      // An exponential glide, so a change never clicks...
      gain.gain.setTargetAtTime(v, t, 0.012);
      // ...then a silenced stem is pinned to exactly 0 once the glide has
      // settled, because setTargetAtTime only approaches its target and the
      // tail would stay faintly audible.
      if (v === 0) gain.gain.setValueAtTime(0, t + 0.09);
    }
  };

  // Every source in the list was started, so stop() can't throw.
  const stopSources = () => {
    for (const source of sources) {
      source.stop();
      source.disconnect();
    }
    sources = [];
  };

  const startSourcesAt = (from: number) => {
    const ctx = getContext();
    const when = ctx.currentTime + START_LEAD_S;
    for (const name of STEM_NAMES) {
      const buffer = buffers[name];
      const gain = gains[name];
      if (!buffer || !gain) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(when, from);
      sources.push(source);
    }
    startTime = when;
    offset = from;
  };

  const cancelFrame = () => {
    if (!frame) return;
    deps.frames.cancel(frame);
    frame = 0;
  };

  const tick = (now: number) => {
    const pos = positionNow();
    const clamped = clamp(pos, 0, duration);

    pushLevels(false);
    if (!scrubbing) {
      pushTime(clamped);
      if (now - lastStatePush > STATE_TIME_INTERVAL_MS) {
        lastStatePush = now;
        setState({ currentTime: clamped });
      }
    }

    if (duration > 0 && pos >= duration) {
      stopSources();
      playing = false;
      offset = 0;
      frame = 0;
      setState({ isPlaying: false, currentTime: 0 });
      pushTime(0);
      pushLevels(true);
      return;
    }
    frame = deps.frames.request(tick);
  };

  const play = async () => {
    if (!loaded || playing) return;
    scrubbing = false;
    const ctx = getContext();
    // iOS adds "interrupted" (a call, Siri, another app taking the audio),
    // which needs the same resume as "suspended".
    if (ctx.state !== "running") await ctx.resume();
    // dispose() during the resume has closed this context. Carrying on would
    // open a new one after unmount and run the frame loop with no song.
    if (context !== ctx) return;
    startSourcesAt(clamp(offset, 0, duration));
    playing = true;
    setState({ isPlaying: true });
    if (!frame) frame = deps.frames.request(tick);
  };

  const pause = () => {
    if (!playing) return;
    scrubbing = false;
    const pos = clamp(positionNow(), 0, duration);
    stopSources();
    playing = false;
    offset = pos;
    setState({ isPlaying: false, currentTime: pos });
    pushTime(pos);
    pushLevels(true);
    cancelFrame();
  };

  const seek = (time: number) => {
    const target = clamp(time, 0, duration);
    scrubbing = false;
    offset = target;
    setState({ currentTime: target });
    pushTime(target);
    if (playing) {
      stopSources();
      startSourcesAt(target);
    }
  };

  // Moves the playhead and time readout without touching the transport, while
  // a seek control is dragged. The tick loop leaves the playhead alone until
  // seek() commits.
  const previewTime = (time: number) => {
    scrubbing = true;
    const target = clamp(time, 0, duration);
    pushTime(target);
    setState({ currentTime: target });
  };

  const updateStem = (name: StemName, patch: Partial<StemSetting>) => {
    settings = { ...settings, [name]: { ...settings[name], ...patch } };
    setState({ settings });
    applyGains();
  };

  const setVolume = (name: StemName, volume: number) => updateStem(name, { volume: clamp(volume, 0, 1) });
  // Mute and solo are mutually exclusive per stem; turning one on clears the other.
  const setMute = (name: StemName, muted: boolean) =>
    updateStem(name, muted ? { muted: true, solo: false } : { muted: false });
  const setSolo = (name: StemName, solo: boolean) =>
    updateStem(name, solo ? { solo: true, muted: false } : { solo: false });

  const setMasterVolume = (volume: number) => {
    masterVolume = clamp(volume, 0, 1);
    setState({ masterVolume });
    if (!context || !master) return;
    const t = context.currentTime;
    master.gain.setTargetAtTime(HEADROOM * masterVolume, t, 0.012);
    if (masterVolume === 0) master.gain.setValueAtTime(0, t + 0.09);
  };

  const onLevels = (listener: (levels: StemLevels, stopped: boolean) => void) => {
    levelListeners.add(listener);
    return () => {
      levelListeners.delete(listener);
    };
  };

  const onTime = (listener: (time: number) => void) => {
    timeListeners.add(listener);
    listener(positionNow());
    return () => {
      timeListeners.delete(listener);
    };
  };

  // Seconds from the graph to the speakers, large on Bluetooth. Not every
  // browser fills in outputLatency.
  const getOutputLatency = () => (context ? (context.outputLatency || 0) + (context.baseLatency || 0) : 0);

  const teardownPlayback = () => {
    cancelFrame();
    stopSources();
    playing = false;
    offset = 0;
  };

  const disconnectGraph = () => {
    for (const gain of Object.values(gains)) gain.disconnect();
    master?.disconnect();
    gains = {};
    analysers = {};
    master = null;
  };

  const buildGraph = (ctx: AudioContext) => {
    master = ctx.createGain();
    master.gain.value = HEADROOM * masterVolume;
    master.connect(ctx.destination);
    for (const name of STEM_NAMES) {
      const gain = ctx.createGain();
      gain.gain.value = settings[name].volume;
      gain.connect(master);
      gains[name] = gain;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(analyser);
      analysers[name] = analyser;
    }
  };

  // The single load path: a new song, a recent one, a picked folder and the
  // demo all arrive here with the same shape.
  const load = async (stems: StemMap<StemSource>) => {
    const token = ++loadToken;
    const superseded = () => token !== loadToken;
    loaded = false;
    teardownPlayback();
    // The old song's buffers go before the new one decodes, so the two are
    // never in memory together.
    buffers = {};
    disconnectGraph();
    setState({ error: "", isLoading: true, isLoaded: false, isPlaying: false, currentTime: 0, buffers: null });
    pushTime(0);

    try {
      const ctx = getContext();
      const decoded = await decodeStems({
        context: ctx,
        stems,
        readStem: deps.readStem,
        limits: deps.limits(),
        superseded,
      });
      if (!decoded || superseded()) return;

      buildGraph(ctx);
      buffers = decoded;
      duration = Math.max(...STEM_NAMES.map((name) => decoded[name].duration));
      loaded = true;
      applyGains();
      setState({ buffers: decoded, duration, isLoaded: true });
    } catch (err) {
      if (superseded()) return;
      if (err instanceof StemsTooLongError) {
        setState({ error: err.message });
      } else {
        console.error("[mixer] load failed:", err);
        setState({ error: "Couldn't load the stems for playback. See the console for details." });
      }
    } finally {
      if (!superseded()) setState({ isLoading: false });
    }
  };

  const dispose = () => {
    loadToken++;
    loaded = false;
    teardownPlayback();
    disconnectGraph();
    buffers = {};
    duration = 0;
    if (context && context.state !== "closed") void context.close();
    context = null;
    setState({ ...INITIAL_STATE, settings, masterVolume });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    dispose,
    load,
    play,
    pause,
    seek,
    previewTime,
    setVolume,
    setMute,
    setSolo,
    setMasterVolume,
    onTime,
    onLevels,
    // The playhead read from the audio clock, not the throttled state.
    getPosition: positionNow,
    getOutputLatency,
  };
}
