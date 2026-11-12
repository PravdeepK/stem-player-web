// Trackpad taps on the beat, as a test.
//
// A song's beats are found once, from the decoded stem, so the taps never
// depend on the live meters (which jitter by a frame and run ahead of the
// speakers). Playback then only asks "did the heard playhead cross a beat
// since last frame?", which is a binary search.
//
// The trackpad can't tap harder or softer, so volume sets how many beats get
// through instead: each beat has a strength, its loudness ranked among the
// stem's other hits, and turning the volume down drops the softer hits first.
//
// No DOM or Web Audio in here, so the tests drive it with synthetic signals.

import type { StemMap, StemName, StemSetting } from "./types";

// Which band each stem's beats are found in. The kick and the bass live under
// ~150–250 Hz, so filtering there ignores hats and cymbals; vocals and the
// instrumental have no such band, so they use everything.
export const STEM_BAND_HZ: StemMap<number | null> = { drums: 150, bass: 250, instrumental: null, vocals: null };

// Taps closer than this blur into a buzz on the trackpad.
export const MIN_GAP_S = 0.11;

const HOP = 256; // samples per analysis frame, ~6 ms at 44.1 kHz
const ENV_HZ = 30; // envelope smoothing: kills the ripple of a single low cycle
const LOOKBACK_S = 0.04; // a rise is measured against this much of the past
const FLOOR_DB = 50; // anything this far under the loudest frame is silence
const GATE_DB = 30; // a beat has to be within this of the loudest frame
const MIN_RISE_DB = 6; // and jump at least this much
const LOCAL_S = 0.75; // ...and well above the rises around it
const LOCAL_FACTOR = 2;
const HIT_S = 0.05; // a hit's loudness is its loudest frame this soon after it starts
// Hits this close in loudness count as equally strong, so a steady kick never
// thins out into an uneven rhythm over differences nobody can hear.
const SAME_DB = 1;

// A frame-to-frame jump bigger than this is a seek or a stall, not playback.
const MAX_STEP_S = 0.25;

export interface Beats {
  times: number[];
  strengths: number[];
}

export interface FindBeatsOptions {
  lowpassHz?: number | null;
  minGap?: number;
}

/**
 * The beats in a stem: sudden rises in its energy, in `lowpassHz`'s band when
 * given, at least `minGap` apart. `times` are in seconds; `strengths` are in
 * (0, 1], the share of the stem's beats that hit no harder, so the loudest
 * hit is 1.
 */
export function findBeats(
  channels: readonly Float32Array[],
  sampleRate: number,
  { lowpassHz = null, minGap = MIN_GAP_S }: FindBeatsOptions = {},
): Beats {
  const first = channels[0];
  if (!first || !first.length) return { times: [], strengths: [] };
  const n = first.length;
  const nch = channels.length;
  const lp = lowpassHz ? 1 - Math.exp((-2 * Math.PI * lowpassHz) / sampleRate) : 0;
  const ev = 1 - Math.exp((-2 * Math.PI * ENV_HZ) / sampleRate);

  // The energy envelope, one value per hop, in dB.
  const frames = Math.floor(n / HOP);
  const db = new Float32Array(frames);
  let y1 = 0;
  let y2 = 0;
  let env = 0;
  let f = 0;
  for (let i = 0; i < frames * HOP; i++) {
    let x = 0;
    for (const channel of channels) x += channel[i]!;
    x /= nch;
    if (lp) {
      // Two one-pole stages, so a hi-hat's top end really is gone.
      y1 += lp * (x - y1);
      y2 += lp * (y1 - y2);
      x = y2;
    }
    env += ev * (x * x - env);
    if (i % HOP === HOP - 1) db[f++] = 10 * Math.log10(env + 1e-12);
  }

  let peak = -Infinity;
  for (const v of db) if (v > peak) peak = v;
  const floor = peak - FLOOR_DB;
  for (let i = 0; i < frames; i++) if (db[i]! < floor) db[i] = floor;

  // How far each frame rises over the mean of the frames just before it.
  const back = Math.max(1, Math.round((LOOKBACK_S * sampleRate) / HOP));
  const rise = new Float32Array(frames);
  let sum = 0;
  for (let i = 0; i < frames; i++) {
    if (i >= back) rise[i] = Math.max(0, db[i]! - sum / back);
    sum += db[i]!;
    if (i >= back) sum -= db[i - back]!;
  }

  // The local average rise, from a prefix sum, for the adaptive threshold.
  const prefix = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i]! + rise[i]!;
  const half = Math.round((LOCAL_S * sampleRate) / HOP);

  const hits: { time: number; rise: number; frame: number }[] = [];
  for (let i = 1; i < frames - 1; i++) {
    const r = rise[i]!;
    if (r < MIN_RISE_DB || r < rise[i - 1]! || r <= rise[i + 1]!) continue;
    if (db[i]! < peak - GATE_DB) continue;
    const lo = Math.max(0, i - half);
    const hi = Math.min(frames, i + half + 1);
    if (r < (LOCAL_FACTOR * (prefix[hi]! - prefix[lo]!)) / (hi - lo)) continue;

    const t = (i * HOP) / sampleRate;
    const last = hits.at(-1);
    if (last && t - last.time < minGap) {
      // Too close to the last one: keep whichever rose more.
      if (r > last.rise) {
        last.time = t;
        last.rise = r;
        last.frame = i;
      }
      continue;
    }
    hits.push({ time: t, rise: r, frame: i });
  }

  // Rank each hit's loudness; hits within SAME_DB share the top of their rank.
  const span = Math.max(1, Math.round((HIT_S * sampleRate) / HOP));
  const loud = hits.map(({ frame }) => Math.max(...db.subarray(frame, Math.min(frames, frame + span))));
  const order = loud.map((_, k) => k).sort((a, b) => loud[a]! - loud[b]!);
  const strengths = new Array<number>(hits.length);
  for (let k = 0; k < order.length; ) {
    let end = k;
    while (end + 1 < order.length && loud[order[end + 1]!]! - loud[order[k]!]! <= SAME_DB) end++;
    for (let j = k; j <= end; j++) strengths[order[j]!] = (end + 1) / order.length;
    k = end + 1;
  }
  return { times: hits.map((h) => h.time), strengths };
}

const FOLLOW_ORDER: readonly StemName[] = ["drums", "bass", "instrumental", "vocals"];
const MIN_GAIN = 0.05;

export interface TapSource {
  stem: StemName;
  gain: number;
}

/**
 * What the taps follow, given the mixer's settings: `{ stem, gain }`, or null
 * for no taps. The stem is the drums whenever they can be heard, otherwise
 * whatever is soloed; muting the drums with nothing soloed stops the taps, the
 * same way the meter dots go quiet. `gain` is the master volume times that
 * stem's volume.
 */
export function tapSource(settings: StemMap<StemSetting>, masterVolume: number): TapSource | null {
  if (masterVolume <= MIN_GAIN) return null;
  const anySolo = FOLLOW_ORDER.some((n) => settings[n].solo);
  const audible = (n: StemName) => {
    const s = settings[n];
    if (s.volume <= MIN_GAIN) return false;
    return anySolo ? s.solo : !s.muted;
  };
  const stem = audible("drums") ? "drums" : anySolo ? FOLLOW_ORDER.find(audible) : null;
  if (!stem) return null;
  const gain = masterVolume * settings[stem].volume;
  return gain > MIN_GAIN ? { stem, gain } : null;
}

export interface BeatClock {
  advance(beats: Beats, heard: number, gain?: number): boolean;
  reset(): void;
}

/**
 * Tracks the heard playhead between frames. `advance(beats, heard, gain)` is
 * true when a beat strong enough for `gain` lies in (last heard, heard]: at
 * gain 1 every beat, at 0.5 the harder half. A backwards or oversized jump (a
 * seek, a stall) re-anchors without tapping, so a seek never fires a burst.
 */
export function createBeatClock(): BeatClock {
  let last: number | null = null;
  return {
    advance({ times, strengths }, heard, gain = 1) {
      const prev = last;
      last = heard;
      if (prev === null || heard < prev || heard - prev > MAX_STEP_S) return false;
      for (let i = firstAfter(times, prev); i < times.length && times[i]! <= heard; i++) {
        if (strengths[i]! > 1 - gain) return true;
      }
      return false;
    },
    reset() {
      last = null;
    },
  };
}

// Index of the first beat strictly after t.
function firstAfter(beats: readonly number[], t: number): number {
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
