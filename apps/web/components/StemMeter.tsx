import { useRef } from "react";
import { STEM_NAMES, type MixerHandle, type StemName } from "@stem-player-web/core";
import type { MeterStyle } from "./Mixer";
import { useLevelBounce, useStemWaveform, type BounceAmount } from "../hooks/useStemControls";

// The stems' live levels in the top-right corner of the main screen, as four
// dots or four small waveforms, never both. The style is picked in the menu.

type Style = Exclude<MeterStyle, "off">;

const AMOUNT: Record<Style, BounceAmount> = { dots: { dot: 1.1, wave: 0 }, wave: { dot: 0, wave: 0.65 } };
const noop = () => {};

interface MeterStemProps {
  name: StemName;
  style: Style;
  buffer: AudioBuffer;
  duration: number;
  onLevels: MixerHandle["onLevels"];
  registerTime: MixerHandle["onTime"];
  dimmed: boolean;
}

function MeterStem({ name, style, buffer, duration, onLevels, registerTime, dimmed }: MeterStemProps) {
  const dotRef = useRef<HTMLSpanElement>(null);
  // A new style remounts the stem, so this never needs to change.
  const amountRef = useRef<BounceAmount | null>(AMOUNT[style]);
  const { containerRef, playheadRef } = useStemWaveform({
    buffer,
    duration,
    height: 16,
    colorVar: "--zone",
    fallbackColor: "#4a4a4a",
    onSeek: noop,
    onPreview: noop,
    registerTime,
  });
  useLevelBounce(onLevels, name, dotRef, containerRef, amountRef);

  return (
    <div className={`meter-stem stem--${name} ${dimmed ? "dimmed" : ""}`} title={name}>
      {style === "dots" ? (
        <span ref={dotRef} className="meter-dot" />
      ) : (
        <div className="meter-wave">
          <div ref={containerRef} className="wave" />
          <div ref={playheadRef} className="playhead" />
        </div>
      )}
    </div>
  );
}

export interface StemMeterProps {
  mixer: MixerHandle;
  style: Style;
}

export default function StemMeter({ mixer, style }: StemMeterProps) {
  const { isLoaded, buffers, duration, settings, onLevels, onTime } = mixer;
  if (!isLoaded || !buffers) return null;
  const anySolo = STEM_NAMES.some((n) => settings[n].solo);

  return (
    <div className="meter" aria-hidden="true">
      <div className={`meter-stems meter-stems--${style}`}>
        {STEM_NAMES.map((name) => {
          const { muted, solo } = settings[name];
          return (
            <MeterStem
              // A new style remounts, so the waveform is drawn into its new box.
              key={`${name}-${style}`}
              name={name}
              style={style}
              buffer={buffers[name]}
              duration={duration}
              onLevels={onLevels}
              registerTime={onTime}
              dimmed={anySolo ? !solo : muted}
            />
          );
        })}
      </div>
    </div>
  );
}
