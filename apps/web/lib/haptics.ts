import type { HapticPattern } from "@stem-player-web/core";

// Most devices have no haptics the page can reach: Safari has no
// navigator.vibrate, and desktop Chrome's does nothing. So every call can be a
// no-op, and callers never branch on whether a tap actually happened. Android
// buzzes the motor instead.

// Short enough that a press feels like a tick, not a buzz. The detent runs
// longer so reaching the end of a range feels different from a press.
const VIBRATE_MS: Record<HapticPattern, number> = {
  generic: 10,
  level: 25,
  alignment: 10,
};

function fire(pattern: HapticPattern) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  // Returns false when the page hasn't had a user gesture yet, which is fine to drop.
  navigator.vibrate(VIBRATE_MS[pattern]);
}

/** A button-press tap: mute, solo. */
export function tap() {
  fire("generic");
}

/** A beat in the music. */
export function beat() {
  fire("generic");
}

/** A detent tap: a control arriving at the end of its range. */
export function detent() {
  fire("level");
}

/**
 * Fire a detent only when `next` *arrives* at 0 or 1 from somewhere else, so
 * holding a slider against its endpoint taps once rather than every event.
 */
export function detentOnEndpoint(prev: number, next: number) {
  const atEnd = next <= 0 || next >= 1;
  const wasAtEnd = prev <= 0 || prev >= 1;
  if (atEnd && !wasAtEnd) detent();
}
