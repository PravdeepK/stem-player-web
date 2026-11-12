import { useCallback, useEffect, useRef, type PointerEvent, type RefObject } from "react";
import type WaveSurfer from "wavesurfer.js";
import type { MixerHandle, StemName, StemMap, StemSetting } from "@stem-player-web/core";
import { detentOnEndpoint } from "../lib/haptics";

// Per-stem logic shared by the 3D device and the waveform rows, so the two
// surfaces can't drift apart.

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Peak extraction walks every sample, so it's the expensive part of mounting a
// waveform. Cache per AudioBuffer: rows remount when the load panel closes, and
// the entries disappear with the buffers when new stems are loaded.
const PEAKS_CACHE = new WeakMap<AudioBuffer, Float32Array>();

function computePeaks(audioBuffer: AudioBuffer, buckets = 1200) {
  const cached = PEAKS_CACHE.get(audioBuffer);
  if (cached) return cached;

  const chCount = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const block = Math.max(1, Math.floor(len / buckets));
  const peaks = new Float32Array(buckets);
  const chans: Float32Array[] = [];
  for (let c = 0; c < chCount; c++) chans.push(audioBuffer.getChannelData(c));

  for (let i = 0; i < buckets; i++) {
    const start = i * block;
    let max = 0;
    for (let j = 0; j < block; j++) {
      const idx = start + j;
      if (idx >= len) break;
      let sum = 0;
      for (const chan of chans) sum += chan[idx];
      const v = Math.abs(sum / chCount);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }

  PEAKS_CACHE.set(audioBuffer, peaks);
  return peaks;
}

/**
 * Volume writes with an endpoint detent. Returns `applyVolume(name, next)`,
 * which clamps, skips no-op writes, and taps once when a stem *arrives* at 0 or 1.
 */
export function useStemVolumes(
  settings: StemMap<StemSetting>,
  onVolume: (name: StemName, volume: number) => void,
) {
  const volumesRef = useRef<Partial<StemMap<number>>>({});
  useEffect(() => {
    for (const [name, stem] of Object.entries(settings) as [StemName, StemSetting][]) {
      volumesRef.current[name] = stem.volume;
    }
  }, [settings]);

  return useCallback(
    (name: StemName, next: number) => {
      const prev = volumesRef.current[name] ?? 1;
      const v = clamp01(next);
      if (v === prev) return;
      detentOnEndpoint(prev, v);
      volumesRef.current[name] = v;
      onVolume(name, v);
    },
    [onVolume],
  );
}

interface WaveformOptions {
  buffer: AudioBuffer;
  duration: number;
  height: number;
  colorVar: string;
  fallbackColor: string;
  onSeek: (time: number) => void;
  onPreview: (time: number) => void;
  registerTime: MixerHandle["onTime"];
}

/**
 * A static waveform plus an imperatively-driven playhead and pointer scrub.
 *
 * `colorVar` is a CSS custom property name resolved against the container, so
 * each view picks up whatever colour its own subtree defines.
 *
 * The returned `waveHandlers` go on the element that visually owns the
 * waveform. It can't be an ancestor of any other drag target, or the two
 * gestures would start together on one press.
 */
export function useStemWaveform({
  buffer,
  duration,
  height,
  colorVar,
  fallbackColor,
  onSeek,
  onPreview,
  registerTime,
}: WaveformOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const durationRef = useRef(duration);
  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    let disposed = false;
    let ws: WaveSurfer | null = null;
    if (!containerRef.current) return undefined;

    // Loaded on first use so the player's first paint doesn't wait for it.
    void import("wavesurfer.js").then(({ default: WaveSurferClass }) => {
      const container = containerRef.current;
      if (disposed || !container) return;
      const color = getComputedStyle(container).getPropertyValue(colorVar).trim() || fallbackColor;
      ws = WaveSurferClass.create({
        container,
        height,
        normalize: true,
        // Scrubbing is handled on the wrapper, so it works the same without a waveform.
        interact: false,
        cursorWidth: 0,
        waveColor: color,
        progressColor: color,
        peaks: [computePeaks(buffer)],
        duration: buffer.duration,
      });
    });

    return () => {
      disposed = true;
      ws?.destroy();
    };
  }, [buffer, height, colorVar, fallbackColor]);

  // Moved straight in the DOM, so playback never re-renders a row.
  useEffect(() => {
    return registerTime((t) => {
      const el = playheadRef.current;
      const d = durationRef.current;
      if (!el || !d) return;
      el.style.left = `${Math.min(100, Math.max(0, (t / d) * 100))}%`;
    });
  }, [registerTime]);

  const draggingRef = useRef(false);

  const timeFromEvent = (e: PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return frac * durationRef.current;
  };

  // Capture ends by itself on pointerup and pointercancel.
  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!durationRef.current) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onPreview(timeFromEvent(e));
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!draggingRef.current) return;
    onPreview(timeFromEvent(e));
  };
  // Commits once, on release.
  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onSeek(timeFromEvent(e));
  };

  return {
    containerRef,
    playheadRef,
    waveHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

// Levels jump up at once and fall back gently, like a meter.
const RELEASE = 0.18;
// Above 1, quiet passages barely move and loud hits kick harder.
const WAVE_PUNCH = 1.6;

export interface BounceAmount {
  dot: number;
  wave: number;
}

/**
 * Bounces a stem's dot and/or waveform with its live level, written straight to
 * the DOM each frame like the playhead. `amountRef.current` is how far each one
 * stretches at full level, or null to rest. Either element ref may be empty.
 * Reduce Motion always rests.
 */
export function useLevelBounce(
  onLevels: MixerHandle["onLevels"],
  name: StemName,
  dotRef: RefObject<HTMLElement | null>,
  waveRef: RefObject<HTMLElement | null>,
  amountRef: RefObject<BounceAmount | null>,
) {
  useEffect(() => {
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let shown = 0;
    return onLevels((levels, stopped) => {
      const target = levels[name];
      if (stopped) shown = 0;
      else shown = target > shown ? target : shown + (target - shown) * RELEASE;
      const amount = reduceMotion.matches ? null : amountRef.current;
      const dot = dotRef.current;
      const wave = waveRef.current;
      if (dot) {
        dot.style.transform = amount?.dot ? `scale(${1 + amount.dot * shown})` : "";
        dot.style.boxShadow = amount?.dot ? `0 0 ${10 * shown}px ${2 * shown}px var(--zone)` : "";
      }
      if (wave) {
        wave.style.transform = amount?.wave ? `scaleY(${1 + amount.wave * shown ** WAVE_PUNCH})` : "";
      }
    });
  }, [onLevels, name, dotRef, waveRef, amountRef]);
}
