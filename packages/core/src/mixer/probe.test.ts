import { describe, expect, it } from "vitest";
import { FakeContext } from "./fakeAudio";
import { probeSeconds } from "./probe";

type Box = { type: string; body: Uint8Array };

function box(type: string, ...children: (Uint8Array | Box)[]): Box {
  const parts = children.map((c) => (c instanceof Uint8Array ? c : encode(c)));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return { type, body };
}

function encode({ type, body }: Box): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function mvhd(version: 0 | 1, timescale: number, duration: number) {
  const body = new Uint8Array(version === 1 ? 32 : 20);
  const view = new DataView(body.buffer);
  view.setUint8(0, version);
  if (version === 1) {
    view.setUint32(20, timescale);
    view.setBigUint64(24, BigInt(duration));
  } else {
    view.setUint32(12, timescale);
    view.setUint32(16, duration);
  }
  return box("mvhd", body);
}

function file(...boxes: Box[]): ArrayBuffer {
  const parts = boxes.map(encode);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
}

describe("probeSeconds", () => {
  it("reads an m4a's length with moov after mdat", () => {
    const bytes = file(box("ftyp", new Uint8Array(8)), box("mdat", new Uint8Array(64)), box("moov", mvhd(0, 44100, 44100 * 245)));
    expect(probeSeconds(bytes)).toBe(245);
  });

  it("reads a version 1 mvhd", () => {
    expect(probeSeconds(file(box("moov", mvhd(1, 1000, 912_500))))).toBe(912.5);
  });

  it("gives up on a fragmented file's placeholder length", () => {
    expect(probeSeconds(file(box("moov", mvhd(0, 1000, 0))))).toBeNull();
    expect(probeSeconds(file(box("moov", mvhd(0, 1000, 0xffffffff))))).toBeNull();
  });

  it("reads a WAV's length from its data chunk", () => {
    expect(probeSeconds(new FakeContext(48000).wav(3, 2))).toBe(3);
  });

  it("returns null for formats it doesn't know and for truncated boxes", () => {
    expect(probeSeconds(new TextEncoder().encode("ID3 and then some mp3 frames").buffer)).toBeNull();
    const truncated = file(box("moov", mvhd(0, 1000, 5000))).slice(0, 20);
    expect(probeSeconds(truncated)).toBeNull();
  });
});
