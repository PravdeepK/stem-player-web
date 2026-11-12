import { assert, test } from "vitest";
import { createBeatClock, findBeats, MIN_GAP_S, STEM_BAND_HZ, tapSource } from "./beatTaps";
import type { StemMap, StemSetting } from "./types";

const SR = 44100;

// A seeded noise source, so the tests are the same every run.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

// A drum stem: a 55 Hz kick on every beat and a noisy hi-hat between them.
// With `accent`, every other kick is the loud one and the rest are soft.
function drumLoop({ bpm = 120, seconds = 8, hats = true, hatAmp = 0.35, accent = false } = {}) {
  const out = new Float32Array(SR * seconds);
  const noise = rng(7);
  const beat = 60 / bpm;
  const kicks: number[] = [];
  for (let t = 0.25; t < seconds - 0.5; t += beat) kicks.push(t);
  for (const [k, t] of kicks.entries()) {
    const start = Math.round(t * SR);
    const amp = accent && k % 2 ? 0.3 : 0.8;
    for (let i = 0; i < SR * 0.4 && start + i < out.length; i++) {
      const s = i / SR;
      out[start + i]! += amp * Math.exp(-s / 0.08) * Math.sin(2 * Math.PI * 55 * s);
    }
    if (!hats) continue;
    const hat = Math.round((t + beat / 2) * SR);
    for (let i = 0; i < SR * 0.05 && hat + i < out.length; i++) {
      out[hat + i]! += hatAmp * Math.exp(-i / SR / 0.01) * noise();
    }
  }
  return { out, kicks };
}

function assertNear(found: number[], expected: number[], tolerance: number) {
  assert.strictEqual(found.length, expected.length, `found ${found.length} beats, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(found[i]! - expected[i]!) <= tolerance,
      `beat ${i} at ${found[i]!.toFixed(3)}s, expected ${expected[i]!.toFixed(3)}s`,
    );
  }
}

test("finds each kick and ignores the hi-hats between them", () => {
  const { out, kicks } = drumLoop({ hatAmp: 1 });
  const { times } = findBeats([out], SR, { lowpassHz: STEM_BAND_HZ.drums });
  assertNear(times, kicks, 0.02);
  // Without the band, hats as loud as the kicks are beats too.
  assert.strictEqual(findBeats([out], SR).times.length, kicks.length * 2);
});

test("averages stereo channels", () => {
  const { out, kicks } = drumLoop({ hats: false });
  const { times } = findBeats([out, out], SR, { lowpassHz: STEM_BAND_HZ.drums });
  assertNear(times, kicks, 0.02);
});

test("keeps fast kicks apart by at least the minimum gap", () => {
  const { out } = drumLoop({ bpm: 600, hats: false }); // a kick every 100 ms
  const { times } = findBeats([out], SR, { lowpassHz: STEM_BAND_HZ.drums });
  assert.ok(times.length > 0);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i]! - times[i - 1]! >= MIN_GAP_S, `gap ${times[i]! - times[i - 1]!}`);
  }
});

test("silence and steady tones have no beats", () => {
  const none = { times: [], strengths: [] };
  assert.deepEqual(findBeats([new Float32Array(SR * 4)], SR), none);
  const tone = new Float32Array(SR * 4);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 80 * i) / SR);
  // A tone's start is its one rise.
  assert.ok(findBeats([tone], SR, { lowpassHz: 150 }).times.length <= 1);
  assert.deepEqual(findBeats([], SR), none);
});

test("full-band stems find onsets too", () => {
  const { out, kicks } = drumLoop({ hats: false });
  assertNear(findBeats([out], SR).times, kicks, 0.02);
});

test("louder hits are stronger, and equally loud hits are equally strong", () => {
  const { out, kicks } = drumLoop({ accent: true, hats: false });
  const { times, strengths } = findBeats([out], SR, { lowpassHz: STEM_BAND_HZ.drums });
  assertNear(times, kicks, 0.02);
  const loud = strengths.filter((_, k) => k % 2 === 0);
  const soft = strengths.filter((_, k) => k % 2 === 1);
  assert.ok(Math.min(...loud) > Math.max(...soft), `loud ${loud} soft ${soft}`);
  assert.strictEqual(Math.max(...strengths), 1);
  // The kicks in the uniform loop all hit alike.
  const even = findBeats([drumLoop({ hats: false }).out], SR, { lowpassHz: STEM_BAND_HZ.drums });
  assert.ok(even.strengths.every((x) => x > 0.9), `${even.strengths}`);
});

function settings(patch: Partial<StemMap<Partial<StemSetting>>> = {}) {
  const base = {} as StemMap<StemSetting>;
  for (const n of ["vocals", "drums", "bass", "instrumental"] as const) {
    base[n] = { volume: 1, muted: false, solo: false, ...patch[n] };
  }
  return base;
}

const stemOf = (...args: Parameters<typeof tapSource>) => tapSource(...args)?.stem ?? null;

test("taps follow the drums while they can be heard", () => {
  assert.strictEqual(stemOf(settings(), 1), "drums");
  assert.strictEqual(stemOf(settings({ drums: { solo: true } }), 1), "drums");
  assert.strictEqual(stemOf(settings({ drums: { solo: true }, bass: { solo: true } }), 1), "drums");
});

test("taps stop when the drums are muted, turned down or the master is off", () => {
  assert.strictEqual(stemOf(settings({ drums: { muted: true } }), 1), null);
  assert.strictEqual(stemOf(settings({ drums: { volume: 0 } }), 1), null);
  assert.strictEqual(stemOf(settings(), 0), null);
  // Each above the floor on its own, but not together.
  assert.strictEqual(stemOf(settings({ drums: { volume: 0.2 } }), 0.2), null);
});

test("taps switch to a soloed stem when the drums aren't in the solo", () => {
  assert.strictEqual(stemOf(settings({ vocals: { solo: true } }), 1), "vocals");
  assert.strictEqual(stemOf(settings({ vocals: { solo: true }, bass: { solo: true } }), 1), "bass");
  assert.strictEqual(stemOf(settings({ vocals: { solo: true, volume: 0 } }), 1), null);
});

test("the taps' gain is the master volume times the followed stem's", () => {
  assert.deepEqual(tapSource(settings(), 1), { stem: "drums", gain: 1 });
  assert.deepEqual(tapSource(settings({ drums: { volume: 0.5 } }), 0.6), { stem: "drums", gain: 0.3 });
  // Another stem's volume doesn't matter.
  assert.deepEqual(tapSource(settings({ bass: { volume: 0.1 } }), 1), { stem: "drums", gain: 1 });
});

test("the clock taps once per beat crossed and never on a seek", () => {
  const beats = { times: [1, 2, 3, 10], strengths: [1, 1, 1, 1] };
  const clock = createBeatClock();
  assert.strictEqual(clock.advance(beats, 0.9), false); // first frame only anchors
  assert.strictEqual(clock.advance(beats, 0.98), false);
  assert.strictEqual(clock.advance(beats, 1.0), true); // lands exactly on it
  assert.strictEqual(clock.advance(beats, 1.016), false); // already tapped
  assert.strictEqual(clock.advance(beats, 1.99), false);
  assert.strictEqual(clock.advance(beats, 2.01), true);
  assert.strictEqual(clock.advance(beats, 9.99), false); // forward seek past beat 3
  assert.strictEqual(clock.advance(beats, 10.01), true);
  assert.strictEqual(clock.advance(beats, 0.5), false); // backward seek
  assert.strictEqual(clock.advance(beats, 1.01), false); // 0.51 s in one frame is a stall
  clock.reset();
  assert.strictEqual(clock.advance(beats, 2.0), false); // after a reset, anchor again
});

test("turning the volume down lets only the harder beats through", () => {
  // Alternating loud and soft beats, a second apart.
  const beats = { times: [1, 2, 3, 4], strengths: [1, 0.5, 1, 0.5] };
  const tapsAt = (gain: number) => {
    const clock = createBeatClock();
    let n = 0;
    for (let t = 0.5; t <= 4.5; t += 0.016) if (clock.advance(beats, t, gain)) n++;
    return n;
  };
  assert.strictEqual(tapsAt(1), 4);
  assert.strictEqual(tapsAt(0.6), 4);
  assert.strictEqual(tapsAt(0.5), 2); // only the loud ones
  assert.strictEqual(tapsAt(0.1), 2);
  assert.strictEqual(tapsAt(0), 0);
});
