import { crc32 as nodeCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, zipStored } from "./zip";

describe("zip", () => {
  it("computes the same CRC-32 as zlib", () => {
    const bytes = new Uint8Array(4096).map((_, i) => (i * 31) % 256);
    expect(crc32(bytes)).toBe(nodeCrc32(bytes));
  });

  it("stores each file after its header and indexes them at the end", async () => {
    const files = [
      { name: "Jéja/vocals.m4a", data: new Uint8Array([1, 2, 3]) },
      { name: "Jéja/drums.m4a", data: new Uint8Array([4, 5]) },
    ];
    const zip = new Uint8Array(await zipStored(files).arrayBuffer());
    const view = new DataView(zip.buffer);
    const decoder = new TextDecoder();

    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);

    let central = view.getUint32(end + 16, true);
    for (const file of files) {
      expect(view.getUint32(central, true)).toBe(0x02014b50);
      const nameLength = view.getUint16(central + 28, true);
      expect(decoder.decode(zip.subarray(central + 46, central + 46 + nameLength))).toBe(file.name);
      expect(view.getUint32(central + 16, true)).toBe(crc32(file.data));

      const local = view.getUint32(central + 42, true);
      expect(view.getUint32(local, true)).toBe(0x04034b50);
      const start = local + 30 + view.getUint16(local + 26, true);
      expect(zip.subarray(start, start + file.data.length)).toEqual(file.data);
      central += 46 + nameLength;
    }
  });
});
