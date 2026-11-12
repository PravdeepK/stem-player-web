// A stem's length read from its container header, so the memory budget can be
// checked before anything is decoded. Covers the two formats stems arrive in:
// MP4/M4A from the separator and the demo, WAV from the desktop app's exports.
// Anything else returns null and the caller learns the length by decoding.

const ascii = (view: DataView, at: number) =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

export function probeSeconds(bytes: ArrayBuffer): number | null {
  const view = new DataView(bytes);
  if (view.byteLength < 12) return null;
  if (ascii(view, 0) === "RIFF" && ascii(view, 8) === "WAVE") return wavSeconds(view);
  return mp4Seconds(view, 0, view.byteLength);
}

function wavSeconds(view: DataView): number | null {
  let byteRate = 0;
  for (let at = 12; at + 8 <= view.byteLength; ) {
    const id = ascii(view, at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 20 <= view.byteLength) byteRate = view.getUint32(at + 16, true);
    if (id === "data") {
      if (!byteRate) return null;
      // A recorder that never went back to fill in the size leaves 0 or
      // 0xFFFFFFFF here, so trust the bytes that are actually present.
      const present = view.byteLength - (at + 8);
      return Math.min(size || present, present) / byteRate;
    }
    // Chunks are padded to an even length.
    at += 8 + size + (size % 2);
  }
  return null;
}

// moov can sit before or after mdat, so walk the top-level boxes rather than
// assuming it comes first.
function mp4Seconds(view: DataView, start: number, end: number): number | null {
  for (let at = start; at + 8 <= end; ) {
    let size = view.getUint32(at);
    const type = ascii(view, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return null;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) return null;
    if (type === "moov") return mp4Seconds(view, at + header, at + size);
    if (type === "mvhd") return mvhdSeconds(view, at + header, at + size);
    at += size;
  }
  return null;
}

function mvhdSeconds(view: DataView, body: number, end: number): number | null {
  const version = view.getUint8(body);
  const long = version === 1;
  if (body + (long ? 32 : 20) > end) return null;
  const timescale = view.getUint32(body + (long ? 20 : 12));
  const duration = long ? view.getBigUint64(body + 24) : BigInt(view.getUint32(body + 16));
  // Fragmented files write 0 or all ones here and keep the real length in
  // their fragments.
  const unknown = long ? 0xffffffffffffffffn : 0xffffffffn;
  if (!timescale || duration === 0n || duration === unknown) return null;
  return Number(duration) / timescale;
}
