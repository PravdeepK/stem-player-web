import { describe, expect, test } from "vitest";
import { formatIssueBody, issueLabels, LIMITS, validateReport } from "./issue";

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

test("issues are labelled by type and as coming from the site", () => {
  expect(issueLabels("feature")).toEqual(["enhancement", "from-web"]);
  expect(issueLabels("bug")).toEqual(["bug", "from-web"]);
});

describe("formatIssueBody", () => {
  test("writes clean markdown with a collapsed system info section", () => {
    expect(formatIssueBody(validReport(goodBug()))).toBe(
      [
        "### Description",
        "",
        "The vocals stem goes silent after a minute.",
        "",
        "### Steps to reproduce",
        "",
        "1. Open a song",
        "2. Wait",
        "",
        "<details>",
        "<summary>System info</summary>",
        "",
        "- Site version: 1a2b3c4",
        "- Browser: Safari 26.1",
        "- OS: macOS",
        "- Memory: unknown",
        "",
        "</details>",
        "",
      ].join("\n"),
    );
  });

  test("escapes HTML and mentions, and leaves out empty sections", () => {
    const report = validReport({
      type: "bug",
      title: "Weird",
      description: "Hey @octocat, </details><img src=x onerror=alert(1)> mail me@example.com",
      system: { browser: "<b>Chrome</b> `x` @bot" },
    });
    const body = formatIssueBody(report);
    expect(body).toContain("Hey @\u2060octocat, &lt;/details>&lt;img src=x onerror=alert(1)>");
    expect(body, "an email isn't a mention").toContain("me@example.com");
    expect(body).not.toContain("Steps to reproduce");
    expect(body).toContain("- Browser: bChrome/b x bot");
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    expect(formatIssueBody({ ...report, system: null })).not.toContain("<details>");
  });

  test("leaves no mention GitHub would act on, whatever is around it", () => {
    // GitHub's mention pattern: an @ at the start or after a non-word
    // character, then a letter or digit.
    const mention = /(?:^|\W)@[a-z0-9]/im;
    const inputs = [
      "hi `@octocat",
      "`@octocat`",
      "(@octocat)",
      "@octocat first",
      "two @@octocat",
      "*@octocat*",
      "[@octocat]",
      "@org/team",
      // GitHub reads both of these as mentions too, accent and backslash
      // notwithstanding.
      "café@octocat",
      "\\@octocat",
    ];
    for (const description of inputs) {
      const body = formatIssueBody(validReport({ type: "feature", title: "Ping", description }));
      expect(body, description).not.toMatch(mention);
      expect(body.replace(/\u2060/g, ""), "reads the same once rendered").toContain(description);
    }
  });

  test("spells out character references, so none can turn into an @ on GitHub", () => {
    for (const reference of ["&#64;", "&#0064;", "&#x40;", "&#X40;", "&commat;"]) {
      const description = `hi ${reference}octocat`;
      const body = formatIssueBody(validReport({ type: "feature", title: "Ping", description }));
      expect(body, reference).toContain(`hi &amp;${reference.slice(1)}octocat`);
      expect(body, reference).not.toMatch(/&(?:#0*64|#x0*40|commat);/i);
    }
  });

  test("leaves an & alone unless it starts a reference GitHub would decode", () => {
    const untouched = [
      "https://example.com/?a=1&b=2",
      "[the link](https://example.com/?a=1&b=2)",
      "`a && b`",
      "```\nif (a && b) play();\n```",
      "R&B",
      // No semicolon, so it doesn't decode.
      "&#64octocat",
    ];
    for (const description of untouched) {
      const body = formatIssueBody(validReport({ type: "feature", title: "Amp", description }));
      expect(body, description).toContain(description);
      expect(body, description).not.toContain("&amp;");
    }
  });

  test("escapes a reference's & before the <, so nothing comes out escaped twice", () => {
    const body = formatIssueBody(validReport({ type: "feature", title: "Amp", description: "R&B <3 &lt;" }));
    expect(body).toContain("R&B &lt;3 &amp;lt;");
  });

  test("leaves an @ after a word character alone, since GitHub doesn't treat it as a mention", () => {
    for (const description of ["mail me@example.com", "snake_@case"]) {
      expect(formatIssueBody(validReport({ type: "feature", title: "Mail", description }))).toContain(description);
    }
  });
});
