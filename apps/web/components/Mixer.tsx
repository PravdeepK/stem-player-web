import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { STEM_NAMES, type FeedbackType, type MixerHandle } from "@stem-player-web/core";
import { useStemVolumes } from "../hooks/useStemControls";
import DeviceStage from "./DeviceStage";
import HelpButton from "./HelpButton";
import SocialLinks from "./SocialLinks";
import StemMeter from "./StemMeter";
import StemRow from "./StemRow";

// The device fills the window, with only the transport under it. Everything
// else lives in the slide-out menu, which opens over the device without moving
// it, and leaves the device usable so stems can be mixed with the waveforms open.

export type MeterStyle = "dots" | "wave" | "off";

export interface MixerProps {
  mixer: MixerHandle;
  title: string;
  // What's happening right now ("Loading stems…"), or "" when idle.
  activity: string;
  menu: ReactNode;
  stemsActions: ReactNode;
  meterStyle: MeterStyle;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuOpen: () => void;
  onMenuClose: () => void;
  onFeedback: (type: FeedbackType) => void;
}

function fmt(t: number) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Mixer({
  mixer,
  title,
  activity,
  menu,
  stemsActions,
  meterStyle,
  menuOpen,
  onMenuToggle,
  onMenuOpen,
  onMenuClose,
  onFeedback,
}: MixerProps) {
  const {
    isLoaded,
    currentTime,
    duration,
    settings,
    masterVolume,
    buffers,
    seek,
    previewTime,
    setVolume,
    setMute,
    setSolo,
    onTime,
    onLevels,
  } = mixer;

  const seekBarRef = useRef<HTMLDivElement>(null);
  const seekFillRef = useRef<HTMLDivElement>(null);
  const seekDragRef = useRef(false);
  const [deviceFailed, setDeviceFailed] = useState(false);

  const applyVolume = useStemVolumes(settings, setVolume);
  const onDeviceUnavailable = useCallback(() => {
    setDeviceFailed(true);
    onMenuOpen();
  }, [onMenuOpen]);

  // Driven straight in the DOM, so playback never re-renders the tree.
  useEffect(() => {
    return onTime((t) => {
      const frac = duration ? Math.min(1, Math.max(0, t / duration)) : 0;
      const fill = seekFillRef.current;
      if (fill) fill.style.width = `${frac * 100}%`;
    });
  }, [onTime, duration]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onMenuClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, onMenuClose]);

  const anySolo = STEM_NAMES.some((n) => settings[n].solo);

  function fracFromEvent(e: PointerEvent<HTMLDivElement>) {
    const el = seekBarRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  // Capture ends by itself on pointerup and pointercancel.
  function onSeekDown(e: PointerEvent<HTMLDivElement>) {
    if (!duration) return;
    seekDragRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    previewTime(fracFromEvent(e) * duration);
  }
  function onSeekMove(e: PointerEvent<HTMLDivElement>) {
    if (!seekDragRef.current || !duration) return;
    previewTime(fracFromEvent(e) * duration);
  }
  function onSeekUp(e: PointerEvent<HTMLDivElement>) {
    if (!seekDragRef.current) return;
    seekDragRef.current = false;
    seek(fracFromEvent(e) * duration);
  }

  return (
    <section className="mixer">
      <DeviceStage
        mixer={mixer}
        busy={!!activity}
        applyVolume={applyVolume}
        onLoadPress={onMenuToggle}
        onUnavailable={onDeviceUnavailable}
      />

      {meterStyle !== "off" && <StemMeter mixer={mixer} style={meterStyle} />}
      <SocialLinks />
      <HelpButton onFeedback={onFeedback} />

      <div className="transport">
        <div className="readout">
          <span className="readout-title" title={title}>
            {activity || (isLoaded && title ? title : "No song")}
          </span>
          <span className="dim">Volume {Math.round(masterVolume * 100)}%</span>
          <span>
            {fmt(currentTime)} <span className="dim">/ {fmt(duration)}</span>
          </span>
        </div>

        <div
          className="seek"
          ref={seekBarRef}
          onPointerDown={onSeekDown}
          onPointerMove={onSeekMove}
          onPointerUp={onSeekUp}
          onPointerCancel={onSeekUp}
        >
          <div className="seek-track">
            <div ref={seekFillRef} className="seek-fill" />
          </div>
        </div>
      </div>

      <aside id="menu" className={`drawer ${menuOpen ? "drawer--open" : ""}`} aria-label="Menu" inert={!menuOpen}>
        {menu}

        {isLoaded && buffers && (
          <div className={`stems ${deviceFailed ? "stems--fallback" : ""}`}>
            {stemsActions}
            {STEM_NAMES.map((name) => (
              <StemRow
                key={name}
                name={name}
                buffer={buffers[name]}
                duration={duration}
                settings={{ ...settings[name], anySolo }}
                onVolume={applyVolume}
                onMute={setMute}
                onSolo={setSolo}
                onSeek={seek}
                onPreview={previewTime}
                registerTime={onTime}
                onLevels={onLevels}
                active={menuOpen}
              />
            ))}
          </div>
        )}
      </aside>

      <button
        className={`menu-toggle ${menuOpen ? "menu-toggle--open" : ""}`}
        aria-label={menuOpen ? "Close menu" : "Open menu"}
        aria-expanded={menuOpen}
        aria-controls="menu"
        onClick={onMenuToggle}
      >
        <span />
        <span />
        <span />
      </button>
    </section>
  );
}
