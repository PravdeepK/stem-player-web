import { describe, expect, test } from "vitest";
import { fence, formatIssueBody, issueLabels, issueTitle, LIMITS, validateReport } from "./issue";

const SYSTEM = { app: "1a2b3c4", browser: "Safari 26.1", os: "macOS", memory: "unknown" };

const goodBug = (extra: Record<string, unknown> = {}) => ({
  type: "bug",
  title: "Vocals drop out",
  description: "The vocals stem goes silent after a minute.",
  steps: "1. Open a song\n2. Wait",
  system: SYSTEM,
  website: "",
  ...extra,
});

function validReport(input: unknown) {
  const checked = validateReport(input);
  if (!checked.ok) throw new Error(`${checked.field}: ${checked.message}`);
  return checked.report;
}

describe("validateReport", () => {
  test("accepts a good bug report and trims it", () => {
    const report = validReport(goodBug({ title: "  Vocals\ndrop   out  ", description: "Line one\r\nline two  " }));
    expect(report.title).toBe("Vocals drop out");
    expect(report.description).toBe("Line one\nline two");
    expect(report.system).toEqual(SYSTEM);
  });

  test("rejects bad types, missing and oversized fields, and unknown keys", () => {
    const cases: [unknown, string][] = [
      [null, "body"],
      [[], "body"],
      [goodBug({ type: "question" }), "type"],
      [goodBug({ type: "constructor" }), "type"],
      [goodBug({ title: undefined }), "title"],
      [goodBug({ title: "  a " }), "title"],
      [goodBug({ title: 42 }), "title"],
      [goodBug({ title: "x".repeat(LIMITS.title.max + 1) }), "title"],
      [goodBug({ description: "" }), "description"],
      [goodBug({ description: "x".repeat(LIMITS.description.max + 1) }), "description"],
      [goodBug({ steps: "x".repeat(LIMITS.steps.max + 1) }), "steps"],
      [goodBug({ type: "feature" }), "steps"],
      [goodBug({ system: "Safari" }), "system"],
      [goodBug({ system: { ...SYSTEM, songs: "Secret Song.mp3" } }), "system"],
      // The desktop's fields are gone from the web.
      [goodBug({ system: { chip: "Apple M2" } }), "system"],
      [goodBug({ system: { python: "stem engine" } }), "system"],
      [goodBug({ system: { browser: 5 } }), "system"],
      [goodBug({ system: { browser: "x".repeat(LIMITS.systemValue + 1) } }), "system"],
      [goodBug({ logs: "..." }), "logs"],
      [goodBug({ website: 1 }), "website"],
    ];
    for (const [input, field] of cases) {
      const checked = validateReport(input);
      expect(checked.ok, JSON.stringify(input)).toBe(false);
      if (!checked.ok) expect(checked.field, JSON.stringify(input)).toBe(field);
    }
  });

  test("feature requests need no steps or system info", () => {
    const report = validReport({ type: "feature", title: "Loop a section", description: "Let me loop the chorus." });
    expect(report.system).toBeNull();
  });
});

test("the title is built from fixed parts only", () => {
  expect(issueTitle("bug", "r1a2b3c")).toBe("Feedback (web): bug r1a2b3c");
  expect(issueTitle("feature", "r1a2b3c")).toBe("Feedback (web): feature r1a2b3c");
});

test("issues are labelled by type and as coming from the site", () => {
  expect(issueLabels("feature")).toEqual(["enhancement", "from-web"]);
  expect(issueLabels("bug")).toEqual(["bug", "from-web"]);
});

// Everything that has turned into a ping, a cross-reference, a link or a
// broken block on GitHub at some point.
const TRICKY = [
  "@octocat",
  "hi `@octocat",
  "@org/team",
  "café@octocat",
  "\\@octocat",
  "&#64;octocat &#0064;octocat &#x40;octocat &#X40;octocat &commat;octocat",
  "owner/repo#1",
  "see #1",
  "GH-1",
  "https://github.com/PravdeepK/stem-player/issues/1",
  "</details><img src=x onerror=alert(1)>",
  "```\nclosed?\n```",
  "````\nstill inside\n````",
  "~~~\nnot a fence here\n~~~",
  "a lone ` backtick",
  "```",
  "`",
  "R&B https://example.com/?a=1&b=2 `a && b`",
];

describe("formatIssueBody", () => {
  test("writes each field in its own fence, with system info collapsed", () => {
    expect(formatIssueBody(validReport(goodBug()))).toBe(
      [
        "### Summary",
        "",
        "```text",
        "Vocals drop out",
        "```",
        "",
        "### Description",
        "",
        "```text",
        "The vocals stem goes silent after a minute.",
        "```",
        "",
        "### Steps to reproduce",
        "",
        "```text",
        "1. Open a song",
        "2. Wait",
        "```",
        "",
        "<details>",
        "<summary>System info</summary>",
        "",
        "```text",
        "Site version: 1a2b3c4",
        "Browser: Safari 26.1",
        "OS: macOS",
        "Memory: unknown",
        "```",
        "",
        "</details>",
        "",
      ].join("\n"),
    );
  });

  test("leaves out the steps and the system info when there are none", () => {
    const body = formatIssueBody(validReport({ type: "bug", title: "Weird", description: "No steps." }));
    expect(body).not.toContain("Steps to reproduce");
    expect(body).not.toContain("<details>");
  });

  test("keeps every value exactly as typed, inside a fence longer than any backtick run in it", () => {
    for (const value of TRICKY) {
      const block = fence(value);
      const [open, ...rest] = block.split("\n");
      const close = rest.pop();
      const ticks = open.replace(/text$/, "");
      expect(open, value).toMatch(/^`{3,}text$/);
      expect(close, value).toBe(ticks);
      expect(rest.join("\n"), value).toBe(value);
      const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
      expect(ticks.length, value).toBeGreaterThan(longestRun);
      // A report needs 3 characters, so the single backtick only goes through fence().
      if (value.length >= LIMITS.description.min) {
        expect(formatIssueBody(validReport({ type: "feature", title: "Tricky", description: value }))).toContain(block);
      }
    }
  });

  test("fences the summary like any other field", () => {
    const body = formatIssueBody(validReport({ type: "feature", title: "@octocat see #1", description: "Body." }));
    expect(body.startsWith("### Summary\n\n```text\n@octocat see #1\n```\n")).toBe(true);
  });

  test("an empty value reads the way GitHub's own forms show one", () => {
    expect(fence("")).toBe("_No response_");
  });
});
