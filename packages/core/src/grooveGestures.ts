// What a press on a groove means:
//
//   click                                        mute (toggle)
//   hold the outer end                           solo only while held, as on the hardware
//   double-click or Option-click, anywhere       solo (toggle, stays on)
//   moving past the slop                         a volume drag (the caller does it)
//
// The hardware's manual says "Solo stem: hold end of slider", so a hold only
// solos at the end, and lets go when the press does (onHoldStart / onHoldEnd);
// a long press anywhere else does nothing. Holding needs the
// button physically held, though: with "tap to click", a resting finger is
// already a finished click, which is why double-click is there too. A click
// waits out the double-click interval before it mutes, so a double-click never
// mutes on its way to soloing.
//
// Timers are injected, so the tests drive it with a fake clock.

import type { StemName } from "./types";

export const HOLD_MS = 450;
export const DEFAULT_DOUBLE_CLICK_MS = 350;

// The handle is whatever `set` returned; only `clear` ever looks at it.
export interface GrooveTimers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

export interface GrooveGestureOptions {
  onMute(stem: StemName): void;
  onSolo(stem: StemName): void;
  onHoldStart(stem: StemName): void;
  onHoldEnd(stem: StemName): void;
  doubleClickMs?: number;
  holdMs?: number;
  timers?: GrooveTimers;
}

export interface GrooveGestures {
  /** Pointer down on a groove. `alt` is the Option key; `atEnd` is the outer end. */
  down(stem: StemName, opts?: { alt?: boolean; atEnd?: boolean }): void;
  /** The pointer moved past the slop: from here on it's a volume drag. */
  drag(): void;
  /** Whether the current press should move the volume. */
  isDragging(): boolean;
  up(): void;
  /** The press was interrupted; nothing happens, and a hold lets go. */
  cancel(): void;
  dispose(): void;
}

interface Press {
  stem: StemName;
  alt: boolean;
  atEnd: boolean;
  second: boolean;
  held: boolean;
  holding: boolean;
  dragging: boolean;
  holdTimer: unknown;
}

const realTimers: GrooveTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function createGrooveGestures({
  onMute,
  onSolo,
  onHoldStart,
  onHoldEnd,
  doubleClickMs = DEFAULT_DOUBLE_CLICK_MS,
  holdMs = HOLD_MS,
  timers = realTimers,
}: GrooveGestureOptions): GrooveGestures {
  let press: Press | null = null;
  // A click waiting to become a mute.
  let pending: { stem: StemName; timer: unknown } | null = null;

  // A waiting click on another groove is a click in its own right.
  function flushPending() {
    if (!pending) return;
    const { stem, timer } = pending;
    timers.clear(timer);
    pending = null;
    onMute(stem);
  }

  // Ends a press; a hold-to-solo always lets go, however the press ends.
  function release(current: Press) {
    press = null;
    timers.clear(current.holdTimer);
    if (current.holding) onHoldEnd(current.stem);
  }

  function cancel() {
    if (press) release(press);
  }

  return {
    down(stem, { alt = false, atEnd = false } = {}) {
      cancel();
      let second = false;
      if (pending && pending.stem === stem) {
        timers.clear(pending.timer);
        pending = null;
        second = true;
      } else {
        flushPending();
      }
      const current: Press = {
        stem,
        alt,
        atEnd,
        second,
        held: false,
        holding: false,
        dragging: false,
        holdTimer: null,
      };
      current.holdTimer = timers.set(() => {
        if (press !== current || current.dragging) return;
        current.held = true;
        // The second press of a double-click is a double-click, even if held.
        if (current.second) {
          onSolo(stem);
        } else if (current.atEnd) {
          current.holding = true;
          onHoldStart(stem);
        }
      }, holdMs);
      press = current;
    },

    drag() {
      if (!press || press.held || press.dragging) return;
      timers.clear(press.holdTimer);
      press.dragging = true;
      // A click and then a drag: the first click still counts.
      if (press.second) onMute(press.stem);
    },

    isDragging: () => !!press && press.dragging,

    up() {
      const current = press;
      if (!current) return;
      release(current);
      if (current.held || current.dragging) return;
      if (current.second || current.alt) {
        onSolo(current.stem);
        return;
      }
      pending = {
        stem: current.stem,
        timer: timers.set(() => {
          pending = null;
          onMute(current.stem);
        }, doubleClickMs),
      };
    },

    cancel,

    dispose() {
      cancel();
      if (pending) timers.clear(pending.timer);
      pending = null;
    },
  };
}
