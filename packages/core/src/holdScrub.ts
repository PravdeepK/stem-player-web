// What holding an edge pill does, once a press outlasts HOLD_MS
// (./grooveGestures) and stops being a click:
//
//   dots     scrub: the playhead slides, starting slow and speeding up, and
//            the song jumps there on release
//   − / +    keep stepping the volume
//
// No DOM in here, so the tests check the numbers.

// Song seconds per held second: the scrub starts here...
export const SCRUB_START_SPEED = 8;
// ...gains this much per second held...
export const SCRUB_ACCEL = 12;
// ...up to this.
export const SCRUB_MAX_SPEED = 40;

// How often a held volume button takes another step.
export const VOLUME_REPEAT_MS = 150;

const RAMP_S = (SCRUB_MAX_SPEED - SCRUB_START_SPEED) / SCRUB_ACCEL;

/** How far (s) a scrub has travelled after `heldS` seconds of holding. */
export function scrubDistance(heldS: number): number {
  const t = Math.max(0, heldS);
  const ramp = Math.min(t, RAMP_S);
  return SCRUB_START_SPEED * ramp + (SCRUB_ACCEL * ramp * ramp) / 2 + SCRUB_MAX_SPEED * (t - ramp);
}

/** The scrubbed playhead, from `from` in `direction` (±1), kept inside the song. */
export function scrubPosition(from: number, direction: number, heldS: number, duration: number): number {
  const to = from + direction * scrubDistance(heldS);
  return Math.min(Math.max(to, 0), Math.max(0, duration));
}

/** Whether a move from `prev` to `next` crosses a multiple of `every` seconds. */
export function crossesMark(prev: number, next: number, every: number): boolean {
  return Math.floor(prev / every) !== Math.floor(next / every);
}
