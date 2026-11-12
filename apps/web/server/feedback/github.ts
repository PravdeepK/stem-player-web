// Talks to GitHub as a GitHub App: sign a short-lived JWT with the app's private
// key, trade it for an installation token, then create the issue with that.
import crypto, { type KeyObject } from "node:crypto";

const API_VERSION = "2022-11-28";
const USER_AGENT = "stem-player-web-feedback";

export interface Issue {
  title: string;
  body: string;
  labels: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
  labels: string[];
}

// The relay only ever sees this, so a stand-in can replace GitHub.
export type CreateIssue = (issue: Issue, signal?: AbortSignal) => Promise<CreatedIssue>;

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

/**
 * An RS256 JWT for the GitHub App. Backdated a minute for clock drift and
 * valid for nine, under GitHub's ten-minute maximum.
 */
export function signAppJwt(appId: string, privateKey: KeyObject, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: String(appId) };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

/** Vercel env vars often hold a PEM pasted with literal "\n"s. */
export function normalizePem(pem: string) {
  return pem.replace(/\\n/g, "\n").trim();
}

export class GitHubError extends Error {
  step: "token" | "issue";
  status: number;

  constructor(step: "token" | "issue", status: number, detail: string) {
    super(`GitHub ${step} failed with ${status}: ${detail}`);
    this.step = step;
    this.status = status;
  }
}

function headers(auth: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: auth,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function detail(res: Response) {
  try {
    const body = await res.json();
    return body && body.message ? String(body.message).slice(0, 200) : "no message";
  } catch {
    return "unreadable response";
  }
}

export interface GitHubOptions {
  apiUrl?: string;
  appId: string;
  privateKey: string;
  installationId: string;
  owner: string;
  repo: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * A client for one repo. Installation tokens last an hour, so a warm function
 * reuses its token until five minutes before it expires.
 */
export function createGitHubClient({
  apiUrl = "https://api.github.com",
  appId,
  privateKey,
  installationId,
  owner,
  repo,
  fetch = globalThis.fetch,
  now = Date.now,
}: GitHubOptions) {
  const key = crypto.createPrivateKey(normalizePem(privateKey));
  let cached: { token: string; expiresAt: number } | null = null;

  async function installationToken(signal?: AbortSignal) {
    if (cached && cached.expiresAt - now() > 5 * 60 * 1000) return cached.token;
    const jwt = signAppJwt(appId, key, Math.floor(now() / 1000));
    const res = await fetch(`${apiUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: "POST",
      headers: headers(`Bearer ${jwt}`),
      // Narrowed to this repo's issues, whatever else the app is ever granted.
      body: JSON.stringify({ repositories: [repo], permissions: { issues: "write" } }),
      signal,
    });
    if (res.status !== 201) throw new GitHubError("token", res.status, await detail(res));
    const body = await res.json();
    if (!body || typeof body.token !== "string") throw new GitHubError("token", res.status, "no token");
    const expiresAt = Date.parse(body.expires_at);
    cached = { token: body.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 50 * 60 * 1000 };
    return cached.token;
  }

  const createIssue: CreateIssue = async ({ title, body, labels }, signal) => {
    const token = await installationToken(signal);
    const res = await fetch(`${apiUrl}/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: headers(`token ${token}`),
      body: JSON.stringify({ title, body, labels }),
      signal,
    });
    if (res.status === 401) cached = null;
    if (res.status !== 201) throw new GitHubError("issue", res.status, await detail(res));
    const issue = await res.json();
    return {
      number: issue.number,
      url: issue.html_url,
      labels: (issue.labels || []).map((l: string | { name: string }) => (typeof l === "string" ? l : l.name)),
    };
  };

  return { createIssue, installationToken };
}
