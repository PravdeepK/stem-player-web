import { assert, test } from "vitest";
import {
  SCRUB_MAX_SPEED,
  SCRUB_START_SPEED,
  crossesMark,
  scrubDistance,
  scrubPosition,
} from "./holdScrub";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("a scrub starts slow and speeds up to its cap", () => {
  near(scrubDistance(0), 0);
  near(scrubDistance(-1), 0);
  // The first instant moves at the start speed...
  near(scrubDistance(0.001) / 0.001, SCRUB_START_SPEED + 0.006);
  // ...each second covers more than the one before...
  const firstSecond = scrubDistance(1);
  const secondSecond = scrubDistance(2) - scrubDistance(1);
  assert.ok(secondSecond > firstSecond, `${firstSecond} then ${secondSecond}`);
  // ...and once at the cap, it holds there.
  near(scrubDistance(11) - scrubDistance(10), SCRUB_MAX_SPEED);
});

test("the distance is continuous where the ramp meets the cap", () => {
  for (let t = 0; t < 6; t += 0.05) {
    const step = scrubDistance(t + 0.05) - scrubDistance(t);
    assert.ok(step > 0 && step <= SCRUB_MAX_SPEED * 0.05 + 1e-9, `at ${t}: ${step}`);
  }
});

test("a scrub goes either way and stays inside the song", () => {
  near(scrubPosition(60, 1, 1, 180), 60 + scrubDistance(1));
  near(scrubPosition(60, -1, 1, 180), 60 - scrubDistance(1));
  assert.strictEqual(scrubPosition(170, 1, 5, 180), 180);
  assert.strictEqual(scrubPosition(5, -1, 5, 180), 0);
  assert.strictEqual(scrubPosition(0, 1, 1, 0), 0);
});

test("marks are crossed either way, once", () => {
  assert.strictEqual(crossesMark(9.9, 10.1, 10), true);
  assert.strictEqual(crossesMark(10.1, 9.9, 10), true);
  assert.strictEqual(crossesMark(10, 10.5, 10), false);
  assert.strictEqual(crossesMark(11, 19.9, 10), false);
});
