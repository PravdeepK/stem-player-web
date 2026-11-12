// The browser half of a report lives in FeedbackDialog, which can't import
// anything from server/. These tests cover it, and check its copy of the
// report rules still says what the relay says.
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import * as dialog from "../../components/FeedbackDialog";
import { fence, formatIssueBody, LIMITS, SYSTEM_FIELDS, systemLines, validateReport } from "./issue";

const {
  MAX_PREFILL_URL,
  buildPrefillUrl,
  buildReport,
  collectSystemInfo,
  describeBrowser,
  describeOs,
  friendlyError,
  reportText,
  submitReport,
} = dialog;

const UA = {
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.46 Mobile/15E148 Safari/604.1",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.53",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};

const FIELDS = { title: "Vocals drop out", description: "Silent after a minute.", steps: "1. Play", includeSystem: true, website: "" };
const SYSTEM = collectSystemInfo({ appVersion: "1a2b3c4", userAgent: UA.safariMac, touchPoints: 0 });

describe("the dialog's copy of the report rules", () => {
  test("has the relay's limits and system fields", () => {
    expect(dialog.LIMITS).toEqual(LIMITS);
    expect(dialog.SYSTEM_FIELDS).toEqual(SYSTEM_FIELDS);
    expect(dialog.systemLines(SYSTEM)).toEqual(systemLines(SYSTEM));
  });

  test("previews exactly the issue the relay would post", () => {
    const reports = [
      buildReport("bug", FIELDS, SYSTEM),
      buildReport("feature", { ...FIELDS, includeSystem: false }, SYSTEM),
      buildReport("bug", { title: "  Two\tspaces  ", description: "Hey @octocat </details> &#64;a &#x40;b &commat;c &#64d R&B https://example.com/?a=1&b=2 `a && b`\r\nnext `@line café@d\u0007\n```\nif (a && b) play();\n```", steps: "  " }, null),
      buildReport(
        "bug",
        { title: "Refs", description: "owner/repo#1 #1 GH-1 https://github.com/o/r/issues/1 \\@x", steps: "````\n~~~\n` lone", includeSystem: true },
        SYSTEM,
      ),
      buildReport("feature", { title: "Ticks", description: "```" }, null),
    ];
    for (const report of reports) {
      // The dialog's fence agrees with the relay's on its own too.
      for (const value of [report.description, report.steps ?? ""]) expect(dialog.fence(value)).toBe(fence(value));
    }
    for (const report of reports) {
      const checked = validateReport(report);
      if (!checked.ok) throw new Error(checked.message);
      expect(reportText(report)).toBe(formatIssueBody(checked.report));
    }
  });
});

describe("system info", () => {
  test("names the browser and its major version", () => {
    expect(describeBrowser(UA.safariMac)).toBe("Safari 26.1");
    expect(describeBrowser(UA.safariIphone)).toBe("Safari 26.0");
    expect(describeBrowser(UA.chromeWindows)).toBe("Chrome 142");
    expect(describeBrowser(UA.chromeIphone)).toBe("Chrome 142");
    expect(describeBrowser(UA.edge)).toBe("Edge 142");
    expect(describeBrowser(UA.firefoxLinux)).toBe("Firefox 145");
    expect(describeBrowser("curl/8.7.1")).toBe("unknown");
  });

  test("names the OS without the frozen version", () => {
    expect(describeOs(UA.safariMac)).toBe("macOS");
    expect(describeOs(UA.safariMac, 5), "an iPad asking for the desktop site").toBe("iPadOS");
    expect(describeOs(UA.safariIphone)).toBe("iOS");
    expect(describeOs(UA.chromeWindows)).toBe("Windows");
    expect(describeOs(UA.chromeAndroid)).toBe("Android");
    expect(describeOs(UA.chromebook)).toBe("ChromeOS");
    expect(describeOs(UA.firefoxLinux)).toBe("Linux");
  });

  test("says what the relay allows and nothing else", () => {
    expect(SYSTEM).toEqual({ app: "1a2b3c4", browser: "Safari 26.1", os: "macOS", memory: "unknown" });
    const chrome = collectSystemInfo({ userAgent: UA.chromeWindows, memoryGb: 8 });
    expect(chrome).toEqual({ app: "unknown", browser: "Chrome 142", os: "Windows", memory: "8 GB or more" });
    expect(collectSystemInfo({ userAgent: UA.chromeAndroid, memoryGb: 0.5 }).memory).toBe("0.5 GB");
    // Whatever it says passes the relay's validation unchanged.
    for (const system of [SYSTEM, chrome]) {
      const checked = validateReport(buildReport("bug", FIELDS, system));
      expect(checked.ok && checked.report.system).toEqual(system);
    }
  });
});

test("a report carries system info only when the box is ticked, and steps only for bugs", () => {
  const withInfo = buildReport("bug", FIELDS, SYSTEM);
  expect(withInfo).toEqual({ type: "bug", title: FIELDS.title, description: FIELDS.description, steps: "1. Play", system: SYSTEM, website: "" });
  expect(validateReport(withInfo).ok).toBe(true);
  expect(buildReport("bug", { ...FIELDS, includeSystem: false }, SYSTEM).system).toBeUndefined();
  const feature = buildReport("feature", FIELDS, SYSTEM);
  expect(feature.steps).toBeUndefined();
  expect(validateReport(feature).ok).toBe(true);
});

test("the copied report is the issue body, summary first", () => {
  const text = reportText(buildReport("bug", FIELDS, SYSTEM));
  expect(
    text.startsWith(
      "### Summary\n\n```text\nVocals drop out\n```\n\n### Description\n\n```text\nSilent after a minute.\n```\n\n### Steps to reproduce\n\n```text\n1. Play\n```\n",
    ),
  ).toBe(true);
  expect(text).toContain("<summary>System info</summary>");
  expect(text).toContain("\nBrowser: Safari 26.1\n");
  // A half-filled draft still previews.
  expect(reportText(buildReport("bug", { title: "", description: "" }, null))).toContain("### Description");
});

describe("the GitHub link", () => {
  test("opens the matching template with its fields filled in", () => {
    const { url, truncated } = buildPrefillUrl(buildReport("bug", FIELDS, SYSTEM));
    expect(truncated).toBe(false);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/PravdeepK/stem-player-web/issues/new");
    expect(parsed.searchParams.get("template")).toBe("bug.yml");
    expect(parsed.searchParams.get("title")).toBe("Vocals drop out");
    expect(parsed.searchParams.get("description")).toBe("Silent after a minute.");
    expect(parsed.searchParams.get("steps")).toBe("1. Play");
    expect(parsed.searchParams.get("system")?.split("\n")[0]).toBe("Site version: 1a2b3c4");
    expect(url, "spaces are %20, not +").not.toContain("+");

    const feature = new URL(buildPrefillUrl(buildReport("feature", { ...FIELDS, includeSystem: false }, SYSTEM)).url);
    expect(feature.searchParams.get("template")).toBe("feature.yml");
    expect(feature.searchParams.get("steps")).toBeNull();
    expect(feature.searchParams.get("system")).toBeNull();
  });

  test("can't ping anyone or link an issue through the title", () => {
    const title = "@octocat broke owner/repo#1 and #12";
    const url = new URL(buildPrefillUrl(buildReport("bug", { ...FIELDS, title }, SYSTEM)).url);
    const filled = url.searchParams.get("title") ?? "";
    expect(filled).toBe("@\u2060octocat broke owner/repo#\u20601 and #\u206012");
    expect(filled.replace(/\u2060/g, ""), "reads the same").toBe(title);
    expect(filled).not.toMatch(/[@#][^\u2060]/);
  });

  test("only fills fields the issue templates have", () => {
    for (const [type, file, labels] of [
      ["bug", "bug.yml", "bug"],
      ["feature", "feature.yml", "enhancement"],
    ] as const) {
      const yml = fs.readFileSync(new URL(`../../../../.github/ISSUE_TEMPLATE/${file}`, import.meta.url), "utf8");
      const ids = new Set([...yml.matchAll(/^\s+id: (\w+)$/gm)].map((m) => m[1]));
      expect(yml).toMatch(new RegExp(`^labels: \\["${labels}"\\]$`, "m"));
      const params = new URL(buildPrefillUrl(buildReport(type, FIELDS, SYSTEM)).url).searchParams;
      expect(params.get("template")).toBe(file);
      for (const key of params.keys()) {
        if (key !== "template" && key !== "title") expect(ids.has(key), `${file} has no field "${key}"`).toBe(true);
      }
    }
  });

  test("a report too long for a link is cut to fit, longest field first", () => {
    const long = buildReport("bug", { ...FIELDS, description: "word ".repeat(1000).trim(), steps: "ünïcødé ".repeat(375).trim() }, SYSTEM);
    const { url, truncated } = buildPrefillUrl(long);
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_PREFILL_URL);
    expect(url.length, "uses most of the room it has").toBeGreaterThan(MAX_PREFILL_URL - 200);
    const params = new URL(url).searchParams;
    expect(params.get("steps")).toMatch(/Cut short to fit in a link/);
    expect(params.get("title")).toBe(FIELDS.title);
    expect(params.get("system")).toBeTruthy();

    const tight = buildPrefillUrl(long, 1500);
    expect(tight.url.length).toBeLessThanOrEqual(1500);
    expect(new URL(tight.url).searchParams.get("description")).toMatch(/Cut short/);
  });

  test("cutting never splits an emoji", () => {
    const emoji = buildReport("feature", { title: "Emoji", description: "🎵".repeat(3000) }, null);
    const { url } = buildPrefillUrl(emoji, 2000);
    expect(url.length).toBeLessThanOrEqual(2000);
    expect(() => decodeURIComponent(url)).not.toThrow();
  });
});

test("failures read as plain sentences", () => {
  expect(friendlyError("offline")).toMatch(/Couldn't reach/);
  expect(friendlyError("rate_limited", { retryAfter: 6 * 3600 })).toMatch(/Try again in 6 hours\./);
  expect(friendlyError("rate_limited", { retryAfter: 3601 })).toMatch(/Try again in 2 hours\./);
  expect(friendlyError("rate_limited", { retryAfter: 61 })).toMatch(/Try again in 2 minutes\./);
  expect(friendlyError("rate_limited", { retryAfter: 30 })).toMatch(/Try again in 1 minute\./);
  expect(friendlyError("invalid_field", { message: "title is required." })).toMatch(/turned down: title is required/);
  expect(friendlyError("turnstile_unavailable")).toMatch(/content blocker/);
  expect(friendlyError("mystery", { status: 503 })).toMatch(/HTTP 503/);
});

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fetch, calls };
}

describe("submitting", () => {
  test("posts JSON with the Turnstile token and returns the new issue", async () => {
    const { fetch, calls } = stubFetch(201, { ok: true, number: 7, url: "https://github.com/PravdeepK/stem-player-web/issues/7" });
    const report = buildReport("bug", FIELDS, SYSTEM);
    const result = await submitReport(report, { fetch, turnstileToken: "tok" });
    expect(result).toEqual({ ok: true, number: 7, url: "https://github.com/PravdeepK/stem-player-web/issues/7" });
    expect(calls[0].url).toBe("/api/feedback");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Turnstile-Token"]).toBe("tok");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(report);
  });

  test("maps every failure to a code and a message, and never throws", async () => {
    const cases: [typeof globalThis.fetch, string][] = [
      [
        async () => {
          throw new TypeError("fetch failed");
        },
        "offline",
      ],
      [
        async () => {
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        },
        "timeout",
      ],
      [stubFetch(429, { ok: false, error: "rate_limited", retryAfter: 300 }).fetch, "rate_limited"],
      [stubFetch(400, { ok: false, error: "invalid_field", field: "title", message: "title is required." }).fetch, "invalid_field"],
      [stubFetch(403, { ok: false, error: "turnstile_failed" }).fetch, "turnstile_failed"],
      [stubFetch(502, { ok: false, error: "github_error" }).fetch, "github_error"],
      [stubFetch(404, "<html>Not found</html>").fetch, "offline"],
      [stubFetch(504, "An error occurred with your deployment").fetch, "unexpected"],
      // Success that doesn't point at this repo isn't trusted.
      [stubFetch(201, { ok: true, number: 1, url: "https://evil.example/issues/1" }).fetch, "unexpected"],
      [stubFetch(201, { ok: true, number: 1, url: "https://github.com/PravdeepK/stem-player/issues/1" }).fetch, "unexpected"],
      [stubFetch(200, { ok: true }).fetch, "unexpected"],
    ];
    for (const [fetch, code] of cases) {
      const result = await submitReport(buildReport("bug", FIELDS, SYSTEM), { fetch, turnstileToken: "tok" });
      expect(result.ok, code).toBe(false);
      expect(result).toMatchObject({ code, message: expect.any(String) });
    }
    const limited = await submitReport(buildReport("bug", FIELDS, SYSTEM), {
      fetch: stubFetch(429, { ok: false, error: "rate_limited", retryAfter: 300 }).fetch,
      turnstileToken: "tok",
    });
    expect(!limited.ok && limited.message).toMatch(/5 minutes/);
  });

  test("a slow relay times out", async () => {
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const result = await submitReport(buildReport("bug", FIELDS, SYSTEM), { fetch: hang, turnstileToken: "tok", timeoutMs: 20 });
    expect(!result.ok && result.code).toBe("timeout");
  });
});
