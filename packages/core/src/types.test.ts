import { describe, expect, it } from "vitest";
import { HASH_PATTERN, JOB_ID_PATTERN, demoStemKey, stemKey, uploadKey } from "./types";

describe("storage keys", () => {
  it("lays out uploads, stems and the demo song", () => {
    const hash = "0123456789abcdef0123456789abcdef";
    expect(uploadKey("job-1")).toBe("uploads/job-1");
    expect(stemKey(hash, "drums")).toBe(`stems/${hash}/drums.m4a`);
    expect(demoStemKey("vocals")).toBe("demo/vocals.m4a");
  });

  it("only accepts a hash that can't escape its folder", () => {
    expect(HASH_PATTERN.test("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(HASH_PATTERN.test("../../demo/0123456789abcdef01234")).toBe(false);
    expect(HASH_PATTERN.test("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(HASH_PATTERN.test("0123456789abcdef0123456789abcdef0")).toBe(false);
  });

  it("only accepts a v4 UUID as a job id", () => {
    expect(JOB_ID_PATTERN.test(crypto.randomUUID())).toBe(true);
    expect(JOB_ID_PATTERN.test("uploads/other")).toBe(false);
  });
});
