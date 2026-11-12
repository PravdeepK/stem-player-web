import { assert, test } from "vitest";
import { createGrooveGestures, HOLD_MS, type GrooveGestures, type GrooveTimers } from "./grooveGestures";
import type { StemName } from "./types";

// A fake clock: timers only fire when the test advances time.
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const queue = new Map<unknown, { fn: () => void; at: number }>();
  return {
    set(fn: () => void, ms: number) {
      const id = nextId++;
      queue.set(id, { fn, at: now + ms });
      return id;
    },
    clear(id: unknown) {
      queue.delete(id);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        queue.delete(id);
        t.fn();
      }
      now = until;
    },
  };
}

const DOUBLE = 350;

function setup() {
  const timers = fakeTimers();
  const events: string[] = [];
  const g = createGrooveGestures({
    onMute: (stem) => events.push(`mute ${stem}`),
    onSolo: (stem) => events.push(`solo ${stem}`),
    onHoldStart: (stem) => events.push(`hold ${stem}`),
    onHoldEnd: (stem) => events.push(`release ${stem}`),
    doubleClickMs: DOUBLE,
    timers,
  });
  return { g, timers, events };
}

function click(
  g: GrooveGestures,
  timers: GrooveTimers & { advance(ms: number): void },
  stem: StemName,
  opts?: { alt?: boolean; atEnd?: boolean },
  heldMs = 60,
) {
  g.down(stem, opts);
  timers.advance(heldMs);
  g.up();
}

test("a click mutes once the double-click interval has passed", () => {
  const { g, timers, events } = setup();
  click(g, timers, "vocals");
  timers.advance(DOUBLE - 1);
  assert.deepEqual(events, [], "not before the interval ends");
  timers.advance(1);
  assert.deepEqual(events, ["mute vocals"]);
});

test("a double-click solos and never mutes", () => {
  const { g, timers, events } = setup();
  click(g, timers, "drums");
  timers.advance(120);
  click(g, timers, "drums");
  timers.advance(2000);
  assert.deepEqual(events, ["solo drums"]);
});

test("two clicks slower than the interval are two mutes", () => {
  const { g, timers, events } = setup();
  click(g, timers, "bass");
  timers.advance(DOUBLE + 50);
  click(g, timers, "bass");
  timers.advance(DOUBLE);
  assert.deepEqual(events, ["mute bass", "mute bass"]);
});

test("holding the outer end solos only while held, as on the hardware", () => {
  const { g, timers, events } = setup();
  g.down("vocals", { atEnd: true });
  timers.advance(HOLD_MS - 1);
  assert.deepEqual(events, []);
  timers.advance(1);
  assert.deepEqual(events, ["hold vocals"], "starts without waiting for release");
  timers.advance(2000);
  assert.deepEqual(events, ["hold vocals"], "lasts as long as the hold");
  g.up();
  assert.deepEqual(events, ["hold vocals", "release vocals"], "ends the moment it's released");
  timers.advance(DOUBLE * 2);
  assert.deepEqual(events, ["hold vocals", "release vocals"], "and adds nothing after");
});

test("a held press that's interrupted still lets go", () => {
  const { g, timers, events } = setup();
  g.down("drums", { atEnd: true });
  timers.advance(HOLD_MS);
  g.cancel();
  assert.deepEqual(events, ["hold drums", "release drums"]);
});

test("disposing mid-hold lets go", () => {
  const { g, timers, events } = setup();
  g.down("bass", { atEnd: true });
  timers.advance(HOLD_MS);
  g.dispose();
  assert.deepEqual(events, ["hold bass", "release bass"]);
});

test("a new press while holding lets the hold go first", () => {
  const { g, timers, events } = setup();
  g.down("bass", { atEnd: true });
  timers.advance(HOLD_MS);
  g.down("drums");
  assert.deepEqual(events, ["hold bass", "release bass"]);
});

test("a long press away from the end does nothing", () => {
  const { g, timers, events } = setup();
  g.down("vocals", { atEnd: false });
  timers.advance(HOLD_MS + 300);
  g.up();
  timers.advance(DOUBLE * 2);
  assert.deepEqual(events, []);
});

test("Option-click solos straight away", () => {
  const { g, timers, events } = setup();
  click(g, timers, "instrumental", { alt: true });
  assert.deepEqual(events, ["solo instrumental"]);
  timers.advance(DOUBLE * 2);
  assert.deepEqual(events, ["solo instrumental"]);
});

test("a drag is only a drag: no mute, no solo", () => {
  const { g, timers, events } = setup();
  g.down("drums", { atEnd: true });
  timers.advance(100);
  g.drag();
  assert.strictEqual(g.isDragging(), true);
  timers.advance(HOLD_MS * 2);
  g.up();
  timers.advance(DOUBLE * 2);
  assert.deepEqual(events, [], "the hold timer is cancelled by the drag");
  assert.strictEqual(g.isDragging(), false);
});

test("moving during a hold doesn't turn it into a drag", () => {
  const { g, timers, events } = setup();
  g.down("drums", { atEnd: true });
  timers.advance(HOLD_MS);
  g.drag();
  assert.strictEqual(g.isDragging(), false, "a held press doesn't become a volume drag");
  g.up();
  assert.deepEqual(events, ["hold drums", "release drums"]);
});

test("click, then a quick drag on the same groove: the click still mutes", () => {
  const { g, timers, events } = setup();
  click(g, timers, "vocals");
  timers.advance(100);
  g.down("vocals");
  g.drag();
  assert.deepEqual(events, ["mute vocals"]);
  g.up();
  timers.advance(DOUBLE * 2);
  assert.deepEqual(events, ["mute vocals"]);
});

test("a quick click on another groove keeps both mutes", () => {
  const { g, timers, events } = setup();
  click(g, timers, "vocals");
  timers.advance(80);
  click(g, timers, "drums");
  assert.deepEqual(events, ["mute vocals"], "the first fires as the second starts");
  timers.advance(DOUBLE);
  assert.deepEqual(events, ["mute vocals", "mute drums"]);
});

test("the second press of a double-click solos and stays, even when held", () => {
  const { g, timers, events } = setup();
  click(g, timers, "bass");
  timers.advance(100);
  g.down("bass", { atEnd: true });
  timers.advance(HOLD_MS);
  assert.deepEqual(events, ["solo bass"], "a double-click, not a hold");
  g.up();
  timers.advance(DOUBLE * 2);
  assert.deepEqual(events, ["solo bass"], "no release: it stays on");
});

test("a tap-to-click 'hold' is just a click", () => {
  // With tap to click, the Mac sends down and up together however long the
  // finger rests, so the hold timer never gets to fire.
  const { g, timers, events } = setup();
  g.down("vocals", { atEnd: true });
  timers.advance(20);
  g.up();
  timers.advance(HOLD_MS + DOUBLE);
  assert.deepEqual(events, ["mute vocals"]);
});

test("a cancelled press does nothing", () => {
  const { g, timers, events } = setup();
  g.down("drums", { atEnd: true });
  timers.advance(100);
  g.cancel();
  timers.advance(HOLD_MS * 2);
  g.up();
  timers.advance(DOUBLE * 2);
  assert.deepEqual(events, []);
});

test("dispose drops a waiting click and a press that hasn't become a hold", () => {
  const { g, timers, events } = setup();
  click(g, timers, "vocals");
  g.down("drums", { atEnd: true });
  g.dispose();
  timers.advance(5000);
  assert.deepEqual(events, ["mute vocals"], "only the click already flushed by the second press");
});

test("triple-click: a solo, then the third click waits to mute", () => {
  const { g, timers, events } = setup();
  click(g, timers, "drums");
  timers.advance(80);
  click(g, timers, "drums");
  timers.advance(80);
  click(g, timers, "drums");
  timers.advance(DOUBLE);
  assert.deepEqual(events, ["solo drums", "mute drums"]);
});
