import crypto from "node:crypto";
import { expect, test } from "vitest";
import { createGitHubClient, GitHubError, normalizePem, signAppJwt } from "./github";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const REPO = { owner: "PravdeepK", repo: "stem-player-web" };

function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split(".");
  const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  return { ok, header: JSON.parse(Buffer.from(h, "base64url").toString()), payload: JSON.parse(Buffer.from(p, "base64url").toString()) };
}

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: { labels?: string[] } & Record<string, unknown>;
}

// A stand-in for GitHub: records every call and answers like the real API.
function fakeGitHub({ issueStatus = 201, tokenStatus = 201 } = {}) {
  const calls: Call[] = [];
  let next = 41;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    if (call.url.endsWith("/access_tokens")) {
      if (tokenStatus !== 201) return Response.json({ message: "Bad credentials" }, { status: tokenStatus });
      return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3600e3).toISOString() }, { status: 201 });
    }
    if (issueStatus !== 201) return Response.json({ message: "Validation Failed" }, { status: issueStatus });
    next++;
    return Response.json(
      { number: next, html_url: `https://github.com/PravdeepK/stem-player-web/issues/${next}`, labels: (call.body.labels ?? []).map((name: string) => ({ name })) },
      { status: 201 },
    );
  };
  return { fetch, calls };
}

test("the app JWT is RS256, signed by the app's key, and short-lived", () => {
  const jwt = signAppJwt("123456", crypto.createPrivateKey(privateKey), 1_700_000_000);
  const { ok, header, payload } = decodeJwt(jwt);
  expect(ok).toBe(true);
  expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  expect(payload).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "123456" });
  expect(jwt, "base64url, no padding").not.toMatch(/[=+/]/);
});

test("a PEM pasted with literal \\n still loads", () => {
  const flat = privateKey.trim().replace(/\n/g, "\\n");
  expect(normalizePem(flat)).toBe(privateKey.trim());
  const jwt = signAppJwt("1", crypto.createPrivateKey(normalizePem(flat)));
  expect(decodeJwt(jwt).ok).toBe(true);
});

test("the client trades a JWT for a scoped token, creates the issue, and reuses the token", async () => {
  const gh = fakeGitHub();
  const client = createGitHubClient({ ...REPO, fetch: gh.fetch, apiUrl: "https://api.test", appId: "123456", privateKey, installationId: "987" });
  const first = await client.createIssue({ title: "T", body: "B", labels: ["bug", "from-web"] });
  await client.createIssue({ title: "T2", body: "B2", labels: ["bug", "from-web"] });

  expect(first).toEqual({ number: 42, url: "https://github.com/PravdeepK/stem-player-web/issues/42", labels: ["bug", "from-web"] });
  expect(gh.calls, "one token, two issues").toHaveLength(3);
  const [token, issue] = gh.calls;
  expect(token.url).toBe("https://api.test/app/installations/987/access_tokens");
  expect(token.method).toBe("POST");
  expect(token.body).toEqual({ repositories: ["stem-player-web"], permissions: { issues: "write" } });
  const jwt = token.headers.Authorization.replace(/^Bearer /, "");
  expect(decodeJwt(jwt).ok).toBe(true);
  expect(decodeJwt(jwt).payload.iss).toBe("123456");
  expect(issue.url).toBe("https://api.test/repos/PravdeepK/stem-player-web/issues");
  expect(issue.headers.Authorization).toBe("token ghs_test");
  expect(issue.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  expect(issue.headers["User-Agent"]).toBeTruthy();
  expect(issue.body).toEqual({ title: "T", body: "B", labels: ["bug", "from-web"] });
});

test("the client fetches a new token once the old one is nearly expired", async () => {
  let clock = Date.parse("2026-11-03T12:00:00Z");
  const calls: string[] = [];
  const fetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).endsWith("/access_tokens")) {
      return Response.json({ token: `t${calls.length}`, expires_at: new Date(clock + 60 * 60e3).toISOString() }, { status: 201 });
    }
    return Response.json({ number: 1, html_url: "https://github.com/PravdeepK/stem-player-web/issues/1", labels: [] }, { status: 201 });
  };
  const client = createGitHubClient({ fetch, now: () => clock, appId: "1", privateKey, installationId: "2", owner: "o", repo: "r" });
  await client.createIssue({ title: "a", body: "b", labels: [] });
  clock += 50 * 60e3;
  await client.createIssue({ title: "a", body: "b", labels: [] });
  clock += 6 * 60e3;
  await client.createIssue({ title: "a", body: "b", labels: [] });
  expect(calls.filter((u) => u.endsWith("/access_tokens"))).toHaveLength(2);
});

test("GitHub failures throw with the step and status", async () => {
  for (const [opts, step, status] of [
    [{ tokenStatus: 401 }, "token", 401],
    [{ issueStatus: 422 }, "issue", 422],
  ] as const) {
    const gh = fakeGitHub(opts);
    const client = createGitHubClient({ fetch: gh.fetch, appId: "1", privateKey, installationId: "2", owner: "o", repo: "r" });
    const err = await client.createIssue({ title: "a", body: "b", labels: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ step, status });
  }
});
