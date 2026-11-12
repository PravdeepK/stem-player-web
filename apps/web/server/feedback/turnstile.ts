// Checks the token the page's Turnstile widget handed the browser. Tokens are
// single-use and last five minutes, and only Cloudflare can say whether one is
// real, so every report costs one call here.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// Cloudflare's own cap on a token's length; anything longer is never real.
export const MAX_TOKEN_LENGTH = 2048;

export type TurnstileResult = { ok: true } | { ok: false; codes: string[] };

export class TurnstileError extends Error {}

export interface VerifyOptions {
  secret: string;
  token: string;
  // Cloudflare uses it as one more signal. "unknown" isn't worth sending.
  ip?: string;
  // Where the widget ran and which form it was for. Every form on the site
  // shares one site key, so without these a token solved for one form would
  // pass for another. Cloudflare's test keys always answer example.com with no
  // action, so they can only be checked with real keys.
  expect?: { action: string; hostnames: Set<string> };
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Throws a TurnstileError when Cloudflare can't be asked, so the caller can tell "no" from "down". */
export async function verifyTurnstile({ secret, token, ip, expect, fetch = globalThis.fetch, signal }: VerifyOptions): Promise<TurnstileResult> {
  const payload: Record<string, string> = { secret, response: token };
  if (ip && ip !== "unknown") payload.remoteip = ip;
  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    throw new TurnstileError(`siteverify unreachable: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) throw new TurnstileError(`siteverify answered ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || typeof body.success !== "boolean") throw new TurnstileError("siteverify sent no verdict");
  if (!body.success) return { ok: false, codes: Array.isArray(body["error-codes"]) ? body["error-codes"].map(String) : [] };
  if (expect && body.action !== expect.action) return { ok: false, codes: [`action-mismatch: ${String(body.action)}`] };
  if (expect && !expect.hostnames.has(body.hostname)) return { ok: false, codes: [`hostname-mismatch: ${String(body.hostname)}`] };
  return { ok: true };
}
