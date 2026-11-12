import { describe, expect, it } from "vitest";
import { TOUCH_LIMITS, decodedBytes, planChannels } from "./budget";

const song = (minutes: number) => Array.from({ length: 4 }, () => ({ seconds: minutes * 60, channels: 2 }));
const MB = 1e6;

describe("decoded size", () => {
  it("counts 4 bytes per sample per channel", () => {
    expect(decodedBytes(300, 44100, 2) / MB).toBeCloseTo(105.84);
    expect(decodedBytes(300, 48000, 2) / MB).toBeCloseTo(115.2);
    expect(decodedBytes(300, 48000, 1) / MB).toBeCloseTo(57.6);
  });
});

describe("touch budget at 48 kHz", () => {
  it("keeps a 5-minute song in stereo", () => {
    expect(4 * decodedBytes(300, 48000, 2) / MB).toBeCloseTo(460.8);
    expect(planChannels(song(5), 48000, TOUCH_LIMITS)).toBe("keep");
  });

  it("plays a 10-minute song in mono", () => {
    expect(planChannels(song(10), 48000, TOUCH_LIMITS)).toBe("mono");
  });

  it("still plays 15 minutes in mono, and refuses 15:12", () => {
    expect(planChannels(song(15), 48000, TOUCH_LIMITS)).toBe("mono");
    expect(planChannels(song(15.2), 48000, TOUCH_LIMITS)).toBe("refuse");
  });

  it("switches to mono just past 5:25", () => {
    expect(planChannels(song(325 / 60), 48000, TOUCH_LIMITS)).toBe("keep");
    expect(planChannels(song(326 / 60), 48000, TOUCH_LIMITS)).toBe("mono");
  });
});

describe("sample rate", () => {
  it("decides from the context's rate, not 44.1 kHz", () => {
    const minutes = 340 / 60;
    expect(planChannels(song(minutes), 44100, TOUCH_LIMITS)).toBe("keep");
    expect(planChannels(song(minutes), 48000, TOUCH_LIMITS)).toBe("mono");
  });

  it("leaves a mono source alone when it fits", () => {
    const stems = Array.from({ length: 4 }, () => ({ seconds: 600, channels: 1 }));
    expect(planChannels(stems, 48000, TOUCH_LIMITS)).toBe("keep");
  });
});
