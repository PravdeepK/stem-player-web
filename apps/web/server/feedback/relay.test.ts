import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DAILY_COUNTER_TTL_SECONDS, feedbackTodayKey, FEEDBACK_PER_IP_PREFIX } from "@stem-player-web/core";
import { describe, expect, test } from "vitest";
import { FEEDBACK_LIMIT, takeDaily, upstash, utcDay } from "../limits";
import type { CreateIssue } from "./github";
import { formatIssueBody, validateReport } from "./issue";
import { allowedOrigins, clientIp, createRelay, MAX_BODY_BYTES, nodeHandler, type RelayRequest, type RelayResponse } from "./relay";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const ORIGIN = "https://stems.test";
const ENV = {
  FEEDBACK_ALLOWED_ORIGINS: `${ORIGIN}, https://preview.stems.test/`,
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  UPSTASH_REDIS_REST_URL: "https://redis.test/",
  UPSTASH_REDIS_REST_TOKEN: "redis-token",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_INSTALLATION_ID: "987",
  GITHUB_API_URL: "https://api.test/",
};
// 18:00 UTC, six hours before the counters roll over.
const EVENING = Date.parse("2026-11-12T18:00:00Z");

const SYSTEM = { app: "1a2b3c4", browser: "Chrome 142", os: "Windows", memory: "8 GB or more" };
const goodBug = (extra: Record<string, unknown> = {}) => ({
  type: "bug",
  title: "Vocals drop out",
  description: "The vocals stem goes silent after a minute.",
  steps: "1. Open a song\n2. Wait",
  system: SYSTEM,
  website: "",
  ...extra,
});

interface Options {
  turnstile?: "pass" | "fail" | "down" | "hang";
  redis?: "up" | "down" | "hang";
  issueStatus?: number;
  labels?: string[];
}

// Cloudflare, Upstash and GitHub in one fetch: records every call and answers
// like the real APIs.
function fakeWorld({ turnstile = "pass", redis = "up", issueStatus = 201, labels }: Options = {}) {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const calls = { turnstile: [] as Record<string, string>[], redis: [] as unknown[][][], github: [] as { url: string; body: Record<string, unknown> }[] };
  let next = 41;

  const hang = (signal?: AbortSignal | null) =>
    new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      calls.turnstile.push(body);
      if (turnstile === "hang") return hang(init?.signal);
      if (turnstile === "down") return new Response("bad gateway", { status: 502 });
      return Response.json(turnstile === "pass" ? { success: true, "error-codes": [] } : { success: false, "error-codes": ["invalid-input-response"] });
    }
    if (url === "https://redis.test/multi-exec") {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer redis-token");
      calls.redis.push(body);
      if (redis === "hang") return hang(init?.signal);
      if (redis === "down") throw new TypeError("fetch failed");
      return Response.json(
        body.map(([command, key, ttl]: [string, string, number]) => {
          if (command === "INCR") {
            counters.set(key, (counters.get(key) ?? 0) + 1);
            return { result: counters.get(key) };
          }
          ttls.set(key, ttl);
          return { result: 1 };
        }),
      );
    }
    if (url.startsWith("https://api.test/")) {
      calls.github.push({ url, body });
      if (url.endsWith("/access_tokens")) {
        return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3600e3).toISOString() }, { status: 201 });
      }
      if (issueStatus !== 201) return Response.json({ message: "Validation Failed" }, { status: issueStatus });
      next++;
      const names = labels ?? (body.labels as string[]);
      return Response.json(
        { number: next, html_url: `https://github.com/PravdeepK/stem-player-web/issues/${next}`, labels: names.map((name) => ({ name })) },
        { status: 201 },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  const outsideCalls = () => calls.turnstile.length + calls.redis.length + calls.github.length;
  return { fetch, calls, counters, ttls, outsideCalls };
}

const quiet = { log() {}, warn() {}, error() {} };

function request(body: unknown, headers: Record<string, string | undefined> = {}): RelayRequest {
  return {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-turnstile-token": "token-from-widget", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ip: "203.0.113.7",
  };
}

const parse = (res: RelayResponse) => JSON.parse(res.body);

describe("the relay", () => {
  test("posts a valid report to this repo as a labelled issue", async () => {
    const world = fakeWorld();
    const handle = createRelay({ env: ENV, fetch: world.fetch, now: () => EVENING, log: quiet });
    const res = await handle(request(goodBug()));
    expect(res.status).toBe(201);
    expect(parse(res)).toEqual({ ok: true, number: 42, url: "https://github.com/PravdeepK/stem-player-web/issues/42" });
    const issue = world.calls.github.find((c) => c.url.endsWith("/issues"))!;
    expect(issue.url).toBe("https://api.test/repos/PravdeepK/stem-player-web/issues");
    expect(issue.body.title).toBe("Vocals drop out");
    expect(issue.body.labels).toEqual(["bug", "from-web"]);
    const checked = validateReport(goodBug());
    expect(checked.ok && issue.body.body).toBe(checked.ok && formatIssueBody(checked.report));
  });

  test("hands the issue to a stand-in when one is given, with no GitHub App set up", async () => {
    const world = fakeWorld();
    const seen: Parameters<CreateIssue>[0][] = [];
    const createIssue: CreateIssue = async (issue) => {
      seen.push(issue);
      return { number: 7, url: "https://github.com/PravdeepK/stem-player-web/issues/7", labels: issue.labels };
    };
    const { GITHUB_APP_ID: _id, GITHUB_APP_PRIVATE_KEY: _key, GITHUB_APP_INSTALLATION_ID: _install, ...env } = ENV;
    const handle = createRelay({ env, fetch: world.fetch, createIssue, log: quiet });
    const res = await handle(request(goodBug({ type: "feature", steps: undefined })));
    expect(res.status).toBe(201);
    expect(parse(res).number).toBe(7);
    expect(seen[0].labels).toEqual(["enhancement", "from-web"]);
    expect(world.calls.github).toHaveLength(0);
  });

  test("warns when GitHub drops a label", async () => {
    const warnings: string[] = [];
    const world = fakeWorld({ labels: ["bug"] });
    const handle = createRelay({ env: ENV, fetch: world.fetch, log: { ...quiet, warn: (m: string) => warnings.push(m) } });
    expect((await handle(request(goodBug()))).status).toBe(201);
    expect(warnings[0]).toMatch(/missing labels: from-web/);
  });

  test("turns away the wrong method, content type, size and JSON without calling anyone", async () => {
    const world = fakeWorld();
    const handle = createRelay({ env: ENV, fetch: world.fetch, log: quiet });
    const cases: [RelayRequest, number, string][] = [
      [{ ...request(goodBug()), method: "GET" }, 405, "method_not_allowed"],
      [request(goodBug(), { "content-type": "text/plain" }), 415, "unsupported_media_type"],
      [request(goodBug(), { "content-type": "application/jsonp" }), 415, "unsupported_media_type"],
      [request("x".repeat(MAX_BODY_BYTES + 1)), 413, "payload_too_large"],
      [{ ...request(goodBug()), tooLarge: true }, 413, "payload_too_large"],
      [request("{not json"), 400, "invalid_json"],
      [request(goodBug({ type: "nope" })), 400, "invalid_field"],
      [request(goodBug({ system: { chip: "Apple M2" } })), 400, "invalid_field"],
    ];
    for (const [req, status, code] of cases) {
      const res = await handle(req);
      expect(res.status, code).toBe(status);
      expect(parse(res)).toMatchObject({ ok: false, error: code, message: expect.any(String) });
    }
    expect(world.outsideCalls()).toBe(0);
    expect(parse(await handle(request(goodBug({ title: "" })))).field).toBe("title");
  });

  test("a filled honeypot looks like success but creates nothing", async () => {
    const world = fakeWorld();
    const handle = createRelay({ env: ENV, fetch: world.fetch, log: quiet });
    const res = await handle(request(goodBug({ website: "http://spam.example" })));
    expect(res.status).toBe(200);
    expect(parse(res)).toEqual({ ok: true });
    expect(world.outsideCalls()).toBe(0);
  });

  test("says when it isn't configured, and when GitHub fails", async () => {
    const world = fakeWorld();
    for (const missing of ["FEEDBACK_ALLOWED_ORIGINS", "TURNSTILE_SECRET_KEY", "UPSTASH_REDIS_REST_TOKEN", "GITHUB_APP_PRIVATE_KEY"]) {
      const handle = createRelay({ env: { ...ENV, [missing]: "" }, fetch: world.fetch, log: quiet });
      const res = await handle(request(goodBug()));
      expect(res.status, missing).toBe(500);
      expect(parse(res).error).toBe("not_configured");
    }
    expect(world.outsideCalls()).toBe(0);

    const failing = createRelay({ env: ENV, fetch: fakeWorld({ issueStatus: 403 }).fetch, log: quiet });
    const bad = await failing(request(goodBug()));
    expect(bad.status).toBe(502);
    expect(parse(bad).error).toBe("github_error");
  });
});

describe("origins", () => {
  test("come from env, comma-separated, without trailing slashes", () => {
    expect([...allowedOrigins(ENV.FEEDBACK_ALLOWED_ORIGINS)]).toEqual([ORIGIN, "https://preview.stems.test"]);
    expect(allowedOrigins(undefined).size).toBe(0);
  });

  test("anything not listed is refused, including no origin at all", async () => {
    const world = fakeWorld();
    const handle = createRelay({ env: ENV, fetch: world.fetch, log: quiet });
    for (const origin of ["https://evil.example", undefined, "https://stems.test.evil.example"]) {
      const res = await handle(request(goodBug(), { origin }));
      expect(res.status, origin).toBe(403);
      expect(parse(res).error).toBe("origin_not_allowed");
    }
    expect((await handle({ method: "OPTIONS", headers: { origin: "https://evil.example" }, body: "", ip: "1.1.1.1" })).status).toBe(403);
    expect(world.outsideCalls()).toBe(0);
  });

  test("a listed origin gets a preflight answer and CORS headers", async () => {
    const handle = createRelay({ env: ENV, fetch: fakeWorld().fetch, log: quiet });
    const preflight = await handle({ method: "OPTIONS", headers: { origin: "https://preview.stems.test" }, body: "", ip: "1.1.1.1" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["Access-Control-Allow-Origin"]).toBe("https://preview.stems.test");
    expect(preflight.headers["Access-Control-Allow-Headers"]).toMatch(/x-turnstile-token/i);
    const res = await handle(request(goodBug()));
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(ORIGIN);
  });
});

describe("Turnstile", () => {
  test("the token, secret and IP go to Cloudflare", async () => {
    const world = fakeWorld();
    const handle = createRelay({ env: ENV, fetch: world.fetch, log: quiet });
    await handle(request(goodBug()));
    expect(world.calls.turnstile).toEqual([{ secret: "turnstile-secret", response: "token-from-widget", remoteip: "203.0.113.7" }]);
  });

  test("a missing, oversized or refused token creates nothing", async () => {
    const world = fakeWorld({ turnstile: "fail" });
    const handle = createRelay({ env: ENV, fetch: world.fetch, log: quiet });
    for (const token of [undefined, "", "x".repeat(2049)]) {
      const res = await handle(request(goodBug(), { "x-turnstile-token": token }));
      expect(res.status).toBe(403);
      expect(parse(res).error).toBe("turnstile_failed");
    }
    expect(world.calls.turnstile, "no call for a token that can't be real").toHaveLength(0);

    const refused = await handle(request(goodBug()));
    expect(refused.status).toBe(403);
    expect(parse(refused).error).toBe("turnstile_failed");
    expect(world.calls.redis, "a refused token never counts against the limits").toHaveLength(0);
    expect(world.calls.github).toHaveLength(0);
  });

  test("Cloudflare being down is a 503, not a refusal", async () => {
    const world = fakeWorld({ turnstile: "down" });
    const res = await createRelay({ env: ENV, fetch: world.fetch, log: quiet })(request(goodBug()));
    expect(res.status).toBe(503);
    expect(parse(res).error).toBe("unavailable");
    expect(world.calls.github).toHaveLength(0);
  });
});

describe("daily limits", () => {
  test("5 a day per IP, and the next UTC day starts over", async () => {
    let clock = EVENING;
    const world = fakeWorld();
    const handle = createRelay({ env: ENV, fetch: world.fetch, now: () => clock, log: quiet });
    for (let i = 0; i < 5; i++) expect((await handle(request(goodBug()))).status).toBe(201);
    const limited = await handle(request(goodBug()));
    expect(limited.status).toBe(429);
    expect(parse(limited)).toMatchObject({ error: "rate_limited", retryAfter: 6 * 60 * 60 });
    expect(limited.headers["Retry-After"]).toBe(String(6 * 60 * 60));
    // Another IP still gets through; this one does once the day turns over.
    expect((await handle({ ...request(goodBug()), ip: "192.0.2.1" })).status).toBe(201);
    clock += 6 * 60 * 60 * 1000;
    expect((await handle(request(goodBug()))).status).toBe(201);
  });

  test("30 a day across every IP, and one IP over its limit doesn't spend everybody's", async () => {
    const world = fakeWorld();
    const handle = createRelay({ env: ENV, fetch: world.fetch, now: () => EVENING, log: quiet });
    for (let i = 0; i < 10; i++) await handle(request(goodBug()));
    for (let i = 0; i < 25; i++) expect((await handle({ ...request(goodBug()), ip: `10.0.0.${i}` })).status).toBe(201);
    expect((await handle({ ...request(goodBug()), ip: "10.0.1.1" })).status).toBe(429);
    expect(world.calls.github.filter((c) => c.url.endsWith("/issues"))).toHaveLength(30);
  });

  test("uses the shared key names and lets them expire", async () => {
    const world = fakeWorld();
    const handle = createRelay({ env: ENV, fetch: world.fetch, now: () => EVENING, log: quiet });
    await handle({ ...request(goodBug()), ip: "2001:db8::1" });
    const ipKey = `${FEEDBACK_PER_IP_PREFIX}:2026-11-12:2001:db8::1`;
    const dayKey = feedbackTodayKey("2026-11-12");
    expect(world.counters).toEqual(new Map([[ipKey, 1], [dayKey, 1]]));
    expect(world.ttls).toEqual(new Map([[ipKey, DAILY_COUNTER_TTL_SECONDS], [dayKey, DAILY_COUNTER_TTL_SECONDS]]));
  });

  test("Upstash being down is a 503 and creates nothing", async () => {
    const world = fakeWorld({ redis: "down" });
    const res = await createRelay({ env: ENV, fetch: world.fetch, log: quiet })(request(goodBug()));
    expect(res.status).toBe(503);
    expect(parse(res).error).toBe("unavailable");
    expect(world.calls.github).toHaveLength(0);
  });

  test("a counter that answers with an error is treated as down", async () => {
    const redis = upstash({
      url: "https://redis.test",
      token: "t",
      fetch: async () => Response.json([{ error: "WRONGTYPE" }, { result: 1 }]),
    });
    await expect(takeDaily(redis, FEEDBACK_LIMIT, "1.1.1.1")).rejects.toThrow(/INCR failed: WRONGTYPE/);
  });

  test("each counter and its expiry go in one transaction", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const redis = upstash({
      url: "https://redis.test/",
      token: "t",
      fetch: async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json([{ result: 1 }, { result: 1 }]);
      },
    });
    await takeDaily(redis, FEEDBACK_LIMIT, "1.1.1.1", { now: EVENING });
    const ipKey = `${FEEDBACK_PER_IP_PREFIX}:2026-11-12:1.1.1.1`;
    expect(sent[0]).toEqual({ url: "https://redis.test/multi-exec", body: [["INCR", ipKey], ["EXPIRE", ipKey, DAILY_COUNTER_TTL_SECONDS]] });
    expect(sent).toHaveLength(2);
  });

  test("an aborted transaction is treated as down", async () => {
    const redis = upstash({ url: "https://redis.test", token: "t", fetch: async () => Response.json({ error: "EXECABORT" }, { status: 400 }) });
    await expect(takeDaily(redis, FEEDBACK_LIMIT, "1.1.1.1")).rejects.toThrow(/Upstash answered 400/);
  });

  test("days are UTC dates", () => {
    expect(utcDay(Date.parse("2026-11-12T23:59:59Z"))).toBe("2026-11-12");
    expect(utcDay(Date.parse("2026-11-13T00:00:00Z"))).toBe("2026-11-13");
  });
});

test("a hung service runs into the deadline instead of Vercel's", async () => {
  for (const options of [{ turnstile: "hang" }, { redis: "hang" }] as const) {
    const world = fakeWorld(options);
    const started = Date.now();
    const res = await createRelay({ env: ENV, fetch: world.fetch, log: quiet, deadlineMs: 30 })(request(goodBug()));
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1000);
  }
});

test("the caller's IP comes from proxy headers only when trusted", () => {
  const req = { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, socket: { remoteAddress: "127.0.0.1" } };
  expect(clientIp(req, true)).toBe("1.1.1.1");
  expect(clientIp({ ...req, headers: { ...req.headers, "x-real-ip": "3.3.3.3" } }, true)).toBe("3.3.3.3");
  expect(clientIp(req, false)).toBe("127.0.0.1");
});

test("the Node adapter serves the handler over HTTP and stops reading oversized bodies", async () => {
  const world = fakeWorld();
  const server = http.createServer(nodeHandler(createRelay({ env: ENV, fetch: world.fetch, log: quiet })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/feedback`;
  const headers = { "Content-Type": "application/json", Origin: ORIGIN, "X-Turnstile-Token": "token-from-widget" };
  try {
    const ok = await fetch(url, { method: "POST", headers, body: JSON.stringify(goodBug()) });
    expect(ok.status).toBe(201);
    expect((await ok.json()).number).toBe(42);
    expect(ok.headers.get("cache-control")).toBe("no-store");

    const big = await fetch(url, { method: "POST", headers, body: JSON.stringify(goodBug({ description: "x".repeat(20000) })) });
    expect(big.status).toBe(413);
  } finally {
    server.close();
  }
});
