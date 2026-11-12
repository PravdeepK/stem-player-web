// Turns a feedback POST from the site into a GitHub issue. The handler is plain
// data in, data out ({ status, headers, body }), so the API route and the tests
// drive the same code.
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { FEEDBACK_LIMIT, takeDaily, upstashFromEnv, type Redis } from "../limits";
import { createGitHubClient, type CreatedIssue, type CreateIssue } from "./github";
import { formatIssueBody, issueLabels, issueTitle, validateReport } from "./issue";
import { MAX_TOKEN_LENGTH, verifyTurnstile } from "./turnstile";

const OWNER = "PravdeepK";
const REPO = "stem-player-web";
export const MAX_BODY_BYTES = 16 * 1024;
// The token rides in a header so the report body keeps the desktop relay's shape.
export const TURNSTILE_HEADER = "x-turnstile-token";
// Set by FeedbackDialog's widget, so a token solved for another form fails here.
export const TURNSTILE_ACTION = "feedback";
// Vercel stops the function at 10 s. Every outside call shares this deadline,
// which leaves time to send an error before that.
const DEADLINE_MS = 8000;

const MESSAGES = {
  method_not_allowed: "Use POST.",
  origin_not_allowed: "This origin can't send feedback.",
  turnstile_failed: "The bot check didn't pass. Try again.",
  rate_limited: "Too many reports today. Try again later.",
  unsupported_media_type: "Send JSON.",
  payload_too_large: `The report is larger than ${MAX_BODY_BYTES / 1024} KB.`,
  invalid_json: "The report isn't valid JSON.",
  invalid_field: "The report isn't valid.",
  not_configured: "The feedback relay isn't set up yet.",
  unavailable: "The feedback relay can't check reports just now. Try again in a bit.",
  github_error: "GitHub didn't take the issue. Try again in a bit.",
  internal: "Something went wrong in the relay.",
};

export type ErrorCode = keyof typeof MESSAGES;

export type Env = Record<string, string | undefined>;

export interface RelayRequest {
  method?: string;
  headers: IncomingHttpHeaders;
  body: string;
  tooLarge?: boolean;
  ip: string;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Log = Pick<Console, "log" | "warn" | "error">;

export interface RelayOptions {
  env?: Env;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Log;
  // Stands in for the GitHub App, so a deploy without its keys can still run
  // the whole relay.
  createIssue?: CreateIssue;
  // Whether Cloudflare's answer has to name an allowed origin's hostname and
  // the feedback action. Only off where Cloudflare's test keys are in use,
  // since they always answer example.com with no action.
  checkTurnstileSource?: boolean;
  deadlineMs?: number;
}

function json(status: number, body: object, extraHeaders: Record<string, string> = {}): RelayResponse {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function error(status: number, code: ErrorCode, extra: { message?: string } & Record<string, unknown> = {}, extraHeaders?: Record<string, string>) {
  return json(status, { ok: false, error: code, ...extra, message: extra.message || MESSAGES[code] }, extraHeaders);
}

/** FEEDBACK_ALLOWED_ORIGINS, comma-separated, as exact origins. */
export function allowedOrigins(value: string | undefined) {
  return new Set(
    (value || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

// Starts with a letter and has no #, so it can't read as an issue number
// even if GitHub looks for references in titles.
function reportId() {
  return `r${randomUUID().slice(0, 6)}`;
}

function header(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Build the handler. `env` holds FEEDBACK_ALLOWED_ORIGINS, TURNSTILE_SECRET_KEY,
 * UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, GITHUB_APP_ID,
 * GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID, and optionally
 * GITHUB_API_URL (for a mock GitHub).
 */
export function createRelay({
  env = process.env,
  fetch = globalThis.fetch,
  now = Date.now,
  log = console,
  createIssue,
  checkTurnstileSource = true,
  deadlineMs = DEADLINE_MS,
}: RelayOptions = {}) {
  const origins = allowedOrigins(env.FEEDBACK_ALLOWED_ORIGINS);
  const turnstileExpect = checkTurnstileSource
    ? { action: TURNSTILE_ACTION, hostnames: new Set([...origins].filter((origin) => URL.canParse(origin)).map((origin) => new URL(origin).hostname)) }
    : undefined;
  let redis: Redis | null = null;
  let github: CreateIssue | null = createIssue ?? null;

  function limits() {
    redis ??= upstashFromEnv(env, fetch);
    return redis;
  }

  function issues() {
    if (github) return github;
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID } = env;
    if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY || !GITHUB_APP_INSTALLATION_ID) return null;
    github = createGitHubClient({
      apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
      appId: GITHUB_APP_ID,
      privateKey: GITHUB_APP_PRIVATE_KEY,
      installationId: GITHUB_APP_INSTALLATION_ID,
      owner: OWNER,
      repo: REPO,
      fetch,
      now,
    }).createIssue;
    return github;
  }

  return async function handle(req: RelayRequest): Promise<RelayResponse> {
    const headers = req.headers;
    if (!origins.size) {
      log.error("[feedback] FEEDBACK_ALLOWED_ORIGINS is empty");
      return error(500, "not_configured");
    }
    // Browsers always send Origin on a POST, so a request without one isn't
    // from the site. Anyone can forge it; Turnstile is what actually checks.
    const origin = header(headers, "origin");
    if (!origin || !origins.has(origin)) return error(403, "origin_not_allowed");
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": `Content-Type, ${TURNSTILE_HEADER}`,
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return { status: 204, headers: cors, body: "" };
    if (req.method !== "POST") return error(405, "method_not_allowed", {}, { Allow: "POST", ...cors });

    if (!/^application\/json\s*(;|$)/i.test(header(headers, "content-type") || "")) {
      return error(415, "unsupported_media_type", {}, cors);
    }
    if (req.tooLarge || Buffer.byteLength(req.body || "") > MAX_BODY_BYTES) return error(413, "payload_too_large", {}, cors);

    let input: unknown;
    try {
      input = JSON.parse(req.body);
    } catch {
      return error(400, "invalid_json", {}, cors);
    }

    // Hidden in the form: people leave it empty, form-filling bots don't.
    // They get a success that creates nothing, so there's nothing to learn.
    const website = input && typeof input === "object" ? (input as { website?: unknown }).website : undefined;
    if (typeof website === "string" && website.trim()) {
      log.warn("[feedback] honeypot filled, dropped");
      return json(200, { ok: true }, cors);
    }

    // Checked before Turnstile and the limits, so a malformed report costs no
    // outside calls and doesn't use up the sender's allowance.
    const checked = validateReport(input);
    if (!checked.ok) return error(400, "invalid_field", { field: checked.field, message: checked.message }, cors);
    const { report } = checked;

    const secret = env.TURNSTILE_SECRET_KEY;
    const redisClient = limits();
    const createIssueFn = issues();
    if (!secret || !redisClient || !createIssueFn) {
      const missing = [
        !secret && "TURNSTILE_SECRET_KEY",
        !redisClient && "UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN",
        !createIssueFn && "GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY or GITHUB_APP_INSTALLATION_ID",
      ].filter(Boolean);
      log.error(`[feedback] missing ${missing.join("; ")}`);
      return error(500, "not_configured", {}, cors);
    }

    const signal = AbortSignal.timeout(deadlineMs);
    const ip = req.ip || "unknown";

    // Before the limits, so a caller without a real token can't use up the
    // allowance everybody shares.
    const token = header(headers, TURNSTILE_HEADER) || "";
    if (!token || token.length > MAX_TOKEN_LENGTH) return error(403, "turnstile_failed", {}, cors);
    try {
      const verdict = await verifyTurnstile({ secret, token, ip, expect: turnstileExpect, fetch, signal });
      if (!verdict.ok) {
        log.warn(`[feedback] turnstile refused: ${verdict.codes.join(", ") || "no reason"}`);
        return error(403, "turnstile_failed", {}, cors);
      }
    } catch (err) {
      log.error("[feedback] turnstile:", err instanceof Error ? err.message : err);
      return error(503, "unavailable", {}, cors);
    }

    try {
      const take = await takeDaily(redisClient, FEEDBACK_LIMIT, ip, { now: now(), signal });
      if (!take.ok) {
        return error(429, "rate_limited", { retryAfter: take.retryAfter }, { "Retry-After": String(take.retryAfter), ...cors });
      }
    } catch (err) {
      log.error("[feedback] limits:", err instanceof Error ? err.message : err);
      return error(503, "unavailable", {}, cors);
    }

    const labels = issueLabels(report.type);
    let issue: CreatedIssue;
    try {
      issue = await createIssueFn({ title: issueTitle(report.type, reportId()), body: formatIssueBody(report), labels }, signal);
    } catch (err) {
      log.error("[feedback]", err instanceof Error ? err.message : err);
      return error(502, "github_error", {}, cors);
    }
    const dropped = labels.filter((l) => !issue.labels.includes(l));
    if (dropped.length) log.warn(`[feedback] #${issue.number} is missing labels: ${dropped.join(", ")}`);
    log.log(`[feedback] created #${issue.number} (${report.type})`);
    return json(201, { ok: true, number: issue.number, url: issue.url }, cors);
  };
}

/** The caller's IP. Only trust proxy headers behind a proxy that sets them, like Vercel. */
export function clientIp(req: { headers: IncomingHttpHeaders; socket?: { remoteAddress?: string } }, trustProxy: boolean) {
  if (trustProxy) {
    const real = header(req.headers, "x-real-ip");
    if (real) return real.trim();
    const forwarded = header(req.headers, "x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/** Read a request body as text, stopping early once it's too large. */
export async function readBody(req: IncomingMessage, max = MAX_BODY_BYTES) {
  const declared = Number(req.headers["content-length"]);
  if (declared > max) return { tooLarge: true, body: "" };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return { tooLarge: true, body: "" };
    chunks.push(chunk);
  }
  return { tooLarge: false, body: Buffer.concat(chunks).toString("utf8") };
}

/** The handler as a Node (req, res) function, the shape a Next API route exports. */
export function nodeHandler(handle: (req: RelayRequest) => Promise<RelayResponse>, { trustProxy = false } = {}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let result: RelayResponse;
    try {
      const { body, tooLarge } = req.method === "POST" ? await readBody(req) : { body: "", tooLarge: false };
      result = await handle({ method: req.method, headers: req.headers, body, tooLarge, ip: clientIp(req, trustProxy) });
    } catch (err) {
      console.error("[feedback] unexpected:", err);
      result = error(500, "internal");
    }
    res.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.end(result.body);
  };
}
