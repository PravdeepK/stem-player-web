import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  STEM_NAMES,
  VOLUME_REPEAT_MS,
  crossesMark,
  scrubPosition,
  type MixerHandle,
  type StemMap,
  type StemName,
  type StemSetting,
} from "@stem-player-web/core";
import type { ButtonName, DeviceScene } from "../lib/deviceScene";
import { detentOnEndpoint, tap } from "../lib/haptics";

// The device as the app's main control surface. All the 3D lives in
// lib/deviceScene.ts; this component only feeds it mixer state and maps the
// physical parts to mixer actions:
//
//   grooves  drag = stem volume, click = mute, hold the end = solo while held,
//            double-click or Option-click = solo
//   centre   play / pause
//   − / +    master volume, hold to keep stepping
//   dots     jump back / forward, hold to scrub
//   plain    open the menu
//
// Volume, hold-the-end solo, play/pause and − / + follow the hardware's manual;
// double-click and Option-click also solo, since a trackpad set to "tap to
// click" can't hold. The manual's next/previous (dots) and loop menu (plain)
// have no equivalent here, and the device has no mute at all, so those are this
// app's own.
//
// Every part also has a hidden button for keyboard access. They only show while
// focused, and pulse the matching part so focus has a visible effect on the
// device.

export interface DeviceStageProps {
  mixer: MixerHandle;
  busy: boolean;
  applyVolume: (name: StemName, volume: number) => void;
  onLoadPress: () => void;
  // Called once if WebGL or the model fails, so the page can show the fallback controls.
  onUnavailable: () => void;
}

const MODEL_URL = "/models/stem-player.glb";

const JUMP_SECONDS = 10;
const VOLUME_STEP = 0.1;

// One short hint at a time: what's under the pointer, or else whatever is most
// useful right now. Click with a mouse or trackpad, tap on a touch screen.
function hintsFor(touch: boolean) {
  const click = touch ? "tap" : "click";
  const Click = touch ? "Tap" : "Click";
  const parts: Record<ButtonName, [string, string?]> = {
    Btn_Center: ["Play/Pause"],
    Btn_Volume: ["Volume", `${Click} − or +, hold to keep going`],
    Btn_Dots: ["Skip Back / Forward", `${JUMP_SECONDS} seconds, hold to scrub`],
    Btn_Load: ["Menu"],
  };
  return {
    parts,
    groove: `Drag for volume, ${click} to mute, double-${click} to solo, hold the end to hear it alone`,
    reset: `Double-${click} the background to reset`,
  };
}
const POINTER_HINTS = hintsFor(false);
const TOUCH_HINTS = hintsFor(true);

// The primary pointer, so a laptop with a touch screen keeps its click wording.
const COARSE_POINTER = "(pointer: coarse)";
function subscribeToPointer(onChange: () => void) {
  const query = window.matchMedia(COARSE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const isTouch = () => window.matchMedia(COARSE_POINTER).matches;

// How long a confirmation ("Drums solo") replaces the hint.
const FLASH_MS = 1400;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ledLevels(settings: StemMap<StemSetting>, isLoaded: boolean) {
  const anySolo = STEM_NAMES.some((n) => settings[n].solo);
  const levels = {} as StemMap<{ volume: number; glow: number }>;
  for (const name of STEM_NAMES) {
    const { volume, muted, solo } = settings[name];
    const quiet = anySolo ? !solo : muted;
    levels[name] = { volume, glow: !isLoaded ? 0 : quiet ? 0.1 : 1 };
  }
  return levels;
}

async function fetchModel() {
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`model fetch failed: ${response.status}`);
  return response.arrayBuffer();
}

// The LED texture appends alpha digits to the colour, so it has to be #rrggbb.
function readStemColors() {
  const css = getComputedStyle(document.documentElement);
  const colors = {} as StemMap<string>;
  for (const name of STEM_NAMES) {
    const value = css.getPropertyValue(`--zone-${name}`).trim();
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--zone-${name} isn't a #rrggbb colour: "${value}"`);
    colors[name] = value;
  }
  return colors;
}

type PillHold =
  | { part: "Btn_Volume"; timer: ReturnType<typeof setInterval> }
  | { part: "Btn_Dots"; pos: number; label: string; raf: number };

export default function DeviceStage({ mixer, busy, applyVolume, onLoadPress, onUnavailable }: DeviceStageProps) {
  const { isLoaded, isPlaying, settings, masterVolume, onTime } = mixer;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<DeviceScene | null>(null);
  const modelRef = useRef<Promise<ArrayBuffer> | null>(null);
  const positionRef = useRef(0);
  // Bumped when the GPU drops the context. A lost context can't be drawn to
  // again until the browser restores it, so a fresh canvas replaces it instead.
  const [generation, setGeneration] = useState(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<ButtonName | StemName | null>(null);
  const [turned, setTurned] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // What a held stem was before its hold-to-solo, to put back on release.
  const heldRef = useRef<{ stem: StemName; muted: boolean; solo: boolean } | null>(null);
  // The pill being held, if any: its repeat timer, or its scrub's frame loop.
  const pillHoldRef = useRef<PillHold | null>(null);
  const touch = useSyncExternalStore(subscribeToPointer, isTouch, () => false);
  const hints = touch ? TOUCH_HINTS : POINTER_HINTS;

  // A short confirmation of what just happened, in place of the hint.
  function showFlash(text: string) {
    clearTimeout(flashTimerRef.current);
    setFlash(text);
    flashTimerRef.current = setTimeout(() => setFlash(null), FLASH_MS);
  }
  useEffect(
    () => () => {
      clearTimeout(flashTimerRef.current);
      const hold = pillHoldRef.current;
      if (hold?.part === "Btn_Volume") clearInterval(hold.timer);
      if (hold?.part === "Btn_Dots") cancelAnimationFrame(hold.raf);
    },
    [],
  );

  useEffect(
    () =>
      onTime((t) => {
        positionRef.current = t;
      }),
    [onTime],
  );

  const actions = {
    togglePlay() {
      if (!isLoaded) return;
      tap();
      if (isPlaying) mixer.pause();
      else void mixer.play();
      showFlash(isPlaying ? "Paused" : "Playing");
    },
    jump(direction: number) {
      if (!isLoaded) return;
      tap();
      mixer.seek(positionRef.current + direction * JUMP_SECONDS);
      showFlash(`${direction > 0 ? "Forward" : "Back"} ${JUMP_SECONDS} seconds`);
    },
    nudgeVolume(direction: number) {
      const next = Math.min(1, Math.max(0, masterVolume + direction * VOLUME_STEP));
      const rounded = Math.round(next * 100) / 100;
      if (rounded === masterVolume) return;
      tap();
      detentOnEndpoint(masterVolume, rounded);
      mixer.setMasterVolume(rounded);
      showFlash(`Volume ${Math.round(rounded * 100)}%`);
    },
    // A held − / + keeps stepping, starting straight away.
    holdStart(part: ButtonName, direction: number) {
      if (part === "Btn_Volume") {
        actionsRef.current.nudgeVolume(direction);
        pillHoldRef.current = {
          part,
          timer: setInterval(() => actionsRef.current.nudgeVolume(direction), VOLUME_REPEAT_MS),
        };
        return;
      }
      if (part !== "Btn_Dots" || !isLoaded) return;
      // A held dot scrubs the playhead; the song jumps there on release, as
      // with the waveform scrub. A tap marks every JUMP_SECONDS passed.
      tap();
      const from = positionRef.current;
      const duration = mixer.duration;
      const startedAt = performance.now();
      const hold: PillHold = { part, pos: from, label: "", raf: 0 };
      const step = () => {
        const pos = scrubPosition(from, direction, (performance.now() - startedAt) / 1000, duration);
        if (crossesMark(hold.pos, pos, JUMP_SECONDS)) tap();
        if (duration > 0) detentOnEndpoint(hold.pos / duration, pos / duration);
        hold.pos = pos;
        mixer.previewTime(pos);
        const label = `${direction > 0 ? "Forward" : "Back"} to ${fmt(pos)}`;
        if (label !== hold.label) {
          hold.label = label;
          clearTimeout(flashTimerRef.current);
          setFlash(label);
        }
        hold.raf = requestAnimationFrame(step);
      };
      pillHoldRef.current = hold;
      step();
    },
    holdEnd(part: ButtonName) {
      const hold = pillHoldRef.current;
      pillHoldRef.current = null;
      if (!hold || hold.part !== part) return;
      if (hold.part === "Btn_Volume") clearInterval(hold.timer);
      else {
        cancelAnimationFrame(hold.raf);
        mixer.seek(hold.pos);
        showFlash(hold.label);
      }
    },
    load() {
      tap();
      onLoadPress();
    },
    toggleMute(stem: StemName) {
      if (!isLoaded) return;
      tap();
      const muted = !settings[stem].muted;
      mixer.setMute(stem, muted);
      showFlash(`${capitalize(stem)} ${muted ? "muted" : "unmuted"}`);
    },
    toggleSolo(stem: StemName) {
      if (!isLoaded) return;
      tap();
      const solo = !settings[stem].solo;
      mixer.setSolo(stem, solo);
      showFlash(`${capitalize(stem)} solo ${solo ? "on" : "off"}`);
    },
    holdSolo(stem: StemName) {
      if (!isLoaded) return;
      tap();
      const { muted, solo } = settings[stem];
      heldRef.current = { stem, muted, solo };
      if (!solo) mixer.setSolo(stem, true);
      clearTimeout(flashTimerRef.current);
      setFlash(`${capitalize(stem)} solo while held`);
    },
    releaseSolo(stem: StemName) {
      const before = heldRef.current;
      heldRef.current = null;
      if (!before || before.stem !== stem) return;
      if (before.muted) mixer.setMute(stem, true);
      else mixer.setSolo(stem, before.solo);
      setFlash(null);
    },
    drag(stem: StemName, volume: number) {
      if (!isLoaded) return;
      applyVolume(stem, volume);
      showFlash(`${capitalize(stem)} ${Math.round(Math.min(1, Math.max(0, volume)) * 100)}%`);
    },
    volumeOf: (stem: StemName) => settings[stem].volume,
  };
  // The scene outlives every render, so its callbacks read the latest actions here.
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  const reportUnavailable = useEffectEvent(() => {
    setFailed(true);
    onUnavailable();
  });

  useEffect(() => {
    let disposed = false;
    let handle: DeviceScene | null = null;

    (async () => {
      try {
        modelRef.current ??= fetchModel();
        const [{ createDeviceScene }, bytes] = await Promise.all([import("../lib/deviceScene"), modelRef.current]);
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;

        const act = () => actionsRef.current;
        const scene = await createDeviceScene(canvas, bytes, readStemColors(), {
          onTap(part, side) {
            const direction = side === "right" ? 1 : -1;
            if (part === "Btn_Center") act().togglePlay();
            else if (part === "Btn_Dots") act().jump(direction);
            else if (part === "Btn_Volume") act().nudgeVolume(direction);
            else if (part === "Btn_Load") act().load();
          },
          onHoldStart: (part, side) => act().holdStart(part, side === "right" ? 1 : -1),
          onHoldEnd: (part) => act().holdEnd(part),
          onGrooveMute: (stem) => act().toggleMute(stem),
          onGrooveSolo: (stem) => act().toggleSolo(stem),
          onGrooveHoldStart: (stem) => act().holdSolo(stem),
          onGrooveHoldEnd: (stem) => act().releaseSolo(stem),
          onGrooveDrag: (stem, volume) => act().drag(stem, volume),
          getStemVolume: (stem) => act().volumeOf(stem),
          onHover: setHover,
          onTurned: (next) => {
            setTurned(next);
            if (next) setFlash(null);
          },
          onContextLost: () => {
            sceneRef.current = null;
            setReady(false);
            setHover(null);
            setTurned(false);
            setGeneration((g) => g + 1);
          },
        });
        if (disposed) {
          scene.dispose();
          return;
        }
        handle = scene;
        sceneRef.current = scene;
        setReady(true);
      } catch (err) {
        if (disposed) return;
        console.error("[device] scene failed:", err);
        reportUnavailable();
      }
    })();

    return () => {
      disposed = true;
      sceneRef.current = null;
      if (handle) handle.dispose();
    };
  }, [generation]);

  useEffect(() => {
    if (ready) sceneRef.current?.setLevels(ledLevels(settings, isLoaded));
  }, [ready, settings, isLoaded]);

  const pressed = (part: ButtonName, fn: () => void) => () => {
    sceneRef.current?.pulse(part);
    fn();
  };

  let caption: [string, string?] = [isLoaded ? "Drag a groove to change a stem’s volume" : ""];
  if (!isLoaded && !busy) caption = ["Open the menu to load a song"];
  if (turned) caption = [hints.reset];
  if (hover) caption = hover in hints.parts ? hints.parts[hover as ButtonName] : [capitalize(hover), hints.groove];
  if (flash) caption = [flash];
  const [captionTitle, captionDetail] = caption;

  return (
    <div className="stage">
      <canvas key={generation} ref={canvasRef} className="stage-canvas" aria-hidden="true" />

      <div className="stage-caption" aria-live="polite">
        {failed ? (
          "Couldn’t load the 3D player. Its controls are in the menu."
        ) : (
          <>
            {captionTitle}
            {captionDetail && <span className="dim"> {captionDetail}</span>}
          </>
        )}
      </div>

      <div className="kbd-controls">
        <button onClick={pressed("Btn_Center", actions.togglePlay)}>{isPlaying ? "Pause" : "Play"}</button>
        <button onClick={pressed("Btn_Dots", () => actions.jump(-1))}>Back {JUMP_SECONDS} seconds</button>
        <button onClick={pressed("Btn_Dots", () => actions.jump(1))}>Forward {JUMP_SECONDS} seconds</button>
        <button onClick={pressed("Btn_Volume", () => actions.nudgeVolume(-1))}>Volume down</button>
        <button onClick={pressed("Btn_Volume", () => actions.nudgeVolume(1))}>Volume up</button>
      </div>
    </div>
  );
}
