import type { FeedbackType } from "@stem-player-web/core";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from "react";

// Report a Bug and Request a Feature, as a modal on the page where the desktop
// had its own window. The relay in server/feedback checks and posts the report.
// Nothing under server/ may reach the page, so the bits of its rules that the
// preview and the GitHub fallback need are copied here, and
// server/feedback/report.test.ts fails if the two copies disagree.

export interface FeedbackDialogProps {
  // The form to show, or null while the dialog is closed.
  type: FeedbackType | null;
  onClose: () => void;
}

const FEEDBACK_URL = "/api/feedback";
const TURNSTILE_HEADER = "X-Turnstile-Token";
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SITE_VERSION = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
export const ISSUES_URL = "https://github.com/PravdeepK/stem-player-web/issues";
// GitHub answers 414 for very long links; stay well under the usual 8 KB.
export const MAX_PREFILL_URL = 8000;
const TRUNCATED_NOTE = "\n\n[Cut short to fit in a link. The full report is on your clipboard.]";
const TIMEOUT_MS = 15000;
const TITLES = { bug: "Report a Bug", feature: "Request a Feature" };

// --- the report, as the relay reads it -------------------------------------

export const LIMITS = {
  title: { min: 3, max: 120 },
  description: { min: 3, max: 5000 },
  steps: { min: 0, max: 3000 },
  systemValue: 100,
};

export const SYSTEM_FIELDS = [
  ["app", "Site version"],
  ["browser", "Browser"],
  ["os", "OS"],
  ["memory", "Memory"],
] as const;

export type SystemInfo = Partial<Record<(typeof SYSTEM_FIELDS)[number][0], string>>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const NOT_SYSTEM = /[^\w .,()+:/~-]/g;

function cleanText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
}

function cleanLine(value: string) {
  return value.replace(/\s+/g, " ").replace(CONTROL, "").trim();
}

function escapeMarkdown(text: string) {
  return text.replace(/</g, "&lt;").replace(/(^|[^\w`])@([a-z0-9][a-z0-9-]*)/gi, "$1`@$2`");
}

export function systemLines(system: SystemInfo | null) {
  if (!system) return [];
  return SYSTEM_FIELDS.filter(([key]) => system[key]).map(([key, label]) => `${label}: ${system[key]}`);
}

interface Report {
  type: FeedbackType;
  title: string;
  description: string;
  steps: string;
  system: SystemInfo | null;
}

function formatIssueBody(report: Report) {
  const parts = ["### Description", "", escapeMarkdown(report.description)];
  if (report.type === "bug" && report.steps) {
    parts.push("", "### Steps to reproduce", "", escapeMarkdown(report.steps));
  }
  const lines = systemLines(report.system);
  if (lines.length) {
    parts.push("", "<details>", "<summary>System info</summary>", "");
    for (const line of lines) parts.push(`- ${line}`);
    parts.push("", "</details>");
  }
  return parts.join("\n") + "\n";
}

// --- system info -----------------------------------------------------------

// Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:A|iOS)?\/(\d+)/, "Edge"],
  [/\bOPR\/(\d+)/, "Opera"],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
  [/\b(?:Chrome|CriOS)\/(\d+)/, "Chrome"],
  [/\bVersion\/(\d+(?:\.\d+)?).*\bSafari\//, "Safari"],
];

export function describeBrowser(userAgent: string) {
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) return `${name} ${match[1]}`;
  }
  return "unknown";
}

// Browsers freeze the OS version in the user agent now (macOS at 10.15.7,
// Android at 10 in Chrome), so only the name is worth reporting.
export function describeOs(userAgent: string, touchPoints = 0) {
  if (/\b(?:iPhone|iPad|iPod)\b/.test(userAgent)) return "iOS";
  if (/\bAndroid\b/.test(userAgent)) return "Android";
  if (/\bCrOS\b/.test(userAgent)) return "ChromeOS";
  if (/\bWindows\b/.test(userAgent)) return "Windows";
  // An iPad asks for desktop sites with a Mac's user agent; only its touch
  // screen gives it away.
  if (/\bMacintosh\b/.test(userAgent)) return touchPoints > 1 ? "iPadOS" : "macOS";
  if (/\bLinux\b/.test(userAgent)) return "Linux";
  return "unknown";
}

// navigator.deviceMemory is Chromium only, rounded down to a power of two and
// capped at 8.
export function describeMemory(gigabytes: number | undefined) {
  if (!gigabytes) return "unknown";
  return gigabytes >= 8 ? "8 GB or more" : `${gigabytes} GB`;
}

export function collectSystemInfo({ appVersion, userAgent, touchPoints, memoryGb }: { appVersion?: string; userAgent: string; touchPoints?: number; memoryGb?: number }) {
  const system: Required<SystemInfo> = {
    app: appVersion || "unknown",
    browser: describeBrowser(userAgent),
    os: describeOs(userAgent, touchPoints),
    memory: describeMemory(memoryGb),
  };
  for (const key of Object.keys(system) as (keyof SystemInfo)[]) {
    system[key] = cleanLine(system[key]).replace(NOT_SYSTEM, "").slice(0, LIMITS.systemValue) || "unknown";
  }
  return system;
}

function browserSystemInfo() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return collectSystemInfo({ appVersion: SITE_VERSION, userAgent: nav.userAgent, touchPoints: nav.maxTouchPoints, memoryGb: nav.deviceMemory });
}

// --- building, sending and the ways out ------------------------------------

export interface Fields {
  title: string;
  description: string;
  steps: string;
  includeSystem: boolean;
  website: string;
}

export interface ReportInput {
  type: FeedbackType;
  title: string;
  description: string;
  steps?: string;
  system?: SystemInfo;
  website?: string;
}

/** The form's fields as the JSON the relay takes. */
export function buildReport(type: FeedbackType, fields: Partial<Fields>, system: SystemInfo | null): ReportInput {
  const report: ReportInput = { type, title: fields.title ?? "", description: fields.description ?? "" };
  if (type === "bug" && fields.steps) report.steps = fields.steps;
  if (fields.includeSystem && system) report.system = system;
  report.website = fields.website ?? "";
  return report;
}

function normalized(report: ReportInput): Report {
  return {
    type: report.type,
    title: cleanLine(report.title),
    description: cleanText(report.description),
    steps: report.type === "bug" ? cleanText(report.steps ?? "") : "",
    system: report.system ?? null,
  };
}

/** Title and body, for the clipboard or the preview. */
export function reportText(report: ReportInput) {
  const clean = normalized(report);
  return `${clean.title}\n\n${formatIssueBody(clean)}`;
}

function cutTo(text: string, length: number) {
  let end = length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // never split an emoji in half
  return text.slice(0, end).trimEnd() + TRUNCATED_NOTE;
}

/**
 * A link to GitHub's new-issue form for this report's template, with its
 * fields filled in. Too long a link gets the longest fields cut down to fit.
 */
export function buildPrefillUrl(report: ReportInput, limit = MAX_PREFILL_URL) {
  const clean = normalized(report);
  const fields: Record<string, string> = {
    template: clean.type === "bug" ? "bug.yml" : "feature.yml",
    title: clean.title,
    description: clean.description,
  };
  if (clean.type === "bug" && clean.steps) fields.steps = clean.steps;
  const lines = systemLines(clean.system);
  if (lines.length) fields.system = lines.join("\n");

  const make = () =>
    `${ISSUES_URL}/new?` +
    Object.entries(fields)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");

  let url = make();
  if (url.length <= limit) return { url, truncated: false };

  const longestFirst = ["description", "steps"].filter((k) => fields[k]).sort((a, b) => fields[b].length - fields[a].length);
  for (const key of longestFirst) {
    const full = fields[key];
    let lo = 0;
    let hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      fields[key] = cutTo(full, mid);
      if (make().length <= limit) lo = mid;
      else hi = mid - 1;
    }
    fields[key] = cutTo(full, lo);
    url = make();
    if (url.length <= limit) return { url, truncated: true };
  }
  delete fields.system;
  return { url: make(), truncated: true };
}

const FRIENDLY: Record<string, string> = {
  offline: "Couldn't reach the feedback server. You might be offline, or it might be down.",
  timeout: "The feedback server didn't answer in time.",
  not_configured: "The feedback server isn't set up yet.",
  unavailable: "The feedback server can't check reports just now.",
  github_error: "GitHub didn't take the report just now.",
  payload_too_large: "The report is too long to send.",
  origin_not_allowed: "The feedback server doesn't take reports from this address.",
  turnstile_failed: "The bot check didn't pass.",
  turnstile_unavailable: "The bot check didn't load. A content blocker might be stopping it.",
};

function plural(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** What to tell the user when a submission fails. */
export function friendlyError(code: string, { message, retryAfter, status }: { message?: string; retryAfter?: number | string | null; status?: number } = {}) {
  if (code === "rate_limited") {
    // The limits are per UTC day, so the wait can be most of a day.
    const seconds = Number(retryAfter) || 60 * 60;
    const wait = seconds >= 60 * 60 ? plural(Math.ceil(seconds / 3600), "hour") : plural(Math.max(1, Math.ceil(seconds / 60)), "minute");
    return `Too many reports have been sent today. Try again in ${wait}.`;
  }
  if (code === "invalid_field" && message) return `The report was turned down: ${message}`;
  if (FRIENDLY[code]) return FRIENDLY[code];
  return `Something went wrong sending the report${status ? ` (HTTP ${status})` : ""}.`;
}

export function isIssueUrl(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\/github\.com\/PravdeepK\/stem-player-web\/issues\/\d+$/.test(url);
}

export type SubmitResult = { ok: true; number: number; url: string } | { ok: false; code: string; message: string };

/** POST the report to the relay. Never rejects. */
export async function submitReport(
  report: ReportInput,
  { turnstileToken, url = FEEDBACK_URL, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS }: { turnstileToken: string; url?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number },
): Promise<SubmitResult> {
  const fail = (code: string, extra = {}): SubmitResult => ({ ok: false, code, message: friendlyError(code, extra) });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [TURNSTILE_HEADER]: turnstileToken },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "offline");
  }

  // Not JSON means a proxy's error page, or Vercel's own timeout page.
  const body = await res.json().catch(() => null);
  if (res.status === 201 && body?.ok && Number.isInteger(body.number) && isIssueUrl(body.url)) {
    return { ok: true, number: body.number, url: body.url };
  }
  if (body && typeof body.error === "string") {
    return fail(body.error, { message: body.message, retryAfter: body.retryAfter || res.headers.get("retry-after"), status: res.status });
  }
  return fail(res.status === 404 ? "offline" : "unexpected", { status: res.status });
}

// --- Turnstile -------------------------------------------------------------

interface TurnstileOptions {
  sitekey: string;
  theme: "dark";
  execution: "execute";
  appearance: "interaction-only";
  retry: "never";
  callback: (token: string) => void;
  "error-callback": () => void;
  "timeout-callback": () => void;
}

interface Turnstile {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  execute(widgetId: string): void;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let turnstileScript: Promise<Turnstile> | null = null;

// Loaded the first time the form opens, so a visit that never sends feedback
// never talks to Cloudflare.
function loadTurnstile() {
  turnstileScript ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("the script loaded without window.turnstile")));
    script.onerror = () => {
      turnstileScript = null;
      script.remove();
      reject(new Error("the script didn't load"));
    };
    document.head.append(script);
  });
  return turnstileScript;
}

type TokenResult = { ok: true; token: string } | { ok: false; code: "not_configured" | "turnstile_unavailable" | "turnstile_failed" };

// The widget only runs when asked, on submit, so each report gets a fresh
// token instead of one that may expire while someone is still typing. It only
// shows itself when Cloudflare wants an interaction.
function useTurnstile(container: RefObject<HTMLDivElement | null>) {
  const widget = useRef<Promise<{ api: Turnstile; id: string }> | null>(null);
  const pending = useRef<((result: TokenResult) => void) | null>(null);

  useEffect(() => {
    if (!SITE_KEY) return;
    const sitekey = SITE_KEY;
    let closed = false;
    let rendered: { api: Turnstile; id: string } | null = null;
    const settle = (result: TokenResult) => {
      const resolve = pending.current;
      pending.current = null;
      resolve?.(result);
    };
    const ready = loadTurnstile().then((api) => {
      if (closed || !container.current) throw new Error("the form closed before the widget loaded");
      const id = api.render(container.current, {
        sitekey,
        theme: "dark",
        execution: "execute",
        appearance: "interaction-only",
        retry: "never",
        callback: (token) => settle({ ok: true, token }),
        "error-callback": () => settle({ ok: false, code: "turnstile_failed" }),
        "timeout-callback": () => settle({ ok: false, code: "turnstile_failed" }),
      });
      if (!id) throw new Error("the widget didn't render");
      rendered = { api, id };
      return rendered;
    });
    ready.catch((err: Error) => console.warn("[feedback] Turnstile:", err.message));
    widget.current = ready;
    return () => {
      closed = true;
      if (rendered) rendered.api.remove(rendered.id);
      widget.current = null;
      settle({ ok: false, code: "turnstile_failed" });
    };
  }, [container]);

  return useCallback(async (): Promise<TokenResult> => {
    if (!SITE_KEY) return { ok: false, code: "not_configured" };
    let ready: { api: Turnstile; id: string } | null;
    try {
      ready = await widget.current;
    } catch {
      return { ok: false, code: "turnstile_unavailable" };
    }
    if (!ready) return { ok: false, code: "turnstile_unavailable" };
    const { api, id } = ready;
    return new Promise((resolve) => {
      pending.current = (result) => {
        // A token is good once, so the next submit needs the widget fresh.
        api.reset(id);
        resolve(result);
      };
      api.execute(id);
    });
  }, []);
}

// --- the dialog ------------------------------------------------------------

type Invalid = Partial<Record<"title" | "description", string>>;

function FeedbackForm({ type, onClose }: { type: FeedbackType; onClose: () => void }) {
  const isBug = type === "bug";
  const [system] = useState(browserSystemInfo);
  const [fields, setFields] = useState<Fields>({ title: "", description: "", steps: "", includeSystem: true, website: "" });
  const [invalid, setInvalid] = useState<Invalid>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [posted, setPosted] = useState<{ number: number; url: string } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const getToken = useTurnstile(widgetRef);

  useEffect(() => {
    if (failure) failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

  const report = buildReport(type, fields, system);

  function edit(key: "title" | "description" | "steps" | "website") {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const { value } = event.target;
      setFields((current) => ({ ...current, [key]: value }));
      if (key === "title" || key === "description") setInvalid((current) => ({ ...current, [key]: undefined }));
    };
  }

  function check() {
    const problems: Invalid = {};
    if (fields.title.trim().length < LIMITS.title.min) problems.title = `Add a title (at least ${LIMITS.title.min} characters).`;
    if (fields.description.trim().length < LIMITS.description.min) {
      problems.description = `Describe it in at least ${LIMITS.description.min} characters.`;
    }
    setInvalid(problems);
    if (problems.title) titleRef.current?.focus();
    else if (problems.description) descriptionRef.current?.focus();
    return !problems.title && !problems.description;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !check()) return;
    setFailure(null);
    setNote(null);
    setBusy(true);
    const token = await getToken();
    const result: SubmitResult = token.ok
      ? await submitReport(report, { turnstileToken: token.token })
      : { ok: false, code: token.code, message: friendlyError(token.code) };
    setBusy(false);
    if (result.ok) setPosted(result);
    else setFailure(result.message);
  }

  function copy() {
    navigator.clipboard.writeText(reportText(report)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setNote("Couldn't copy. Open “Show exactly what will be posted” and copy it from there."),
    );
  }

  // A real link rather than window.open, so no popup blocker can stop it.
  const prefill = failure ? buildPrefillUrl(report) : null;
  function openedGitHub() {
    if (!prefill?.truncated) {
      setNote("Opened GitHub in a new tab with the report filled in. Sign in there to post it.");
      return;
    }
    navigator.clipboard.writeText(reportText(report)).then(
      () => setNote("Opened GitHub in a new tab. The report was too long for a link, so it was cut short there; the full text is on your clipboard to paste in."),
      () => setNote("Opened GitHub in a new tab. The report was too long for a link, so it was cut short there. Copy the full text from “Show exactly what will be posted”."),
    );
  }

  if (posted) {
    return (
      <div className="feedback-body">
        <header className="feedback-header">
          <h2 id="feedback-heading">{TITLES[type]}</h2>
        </header>
        <p className="feedback-posted">
          Posted as{" "}
          <a href={posted.url} target="_blank" rel="noreferrer">
            issue #{posted.number}
          </a>{" "}
          on GitHub.
        </p>
        <footer className="feedback-actions">
          <button type="button" className="primary" onClick={onClose} autoFocus>
            Done
          </button>
        </footer>
      </div>
    );
  }

  const lines = systemLines(system);
  return (
    <form className="feedback-body" onSubmit={submit} noValidate>
      <header className="feedback-header">
        <h2 id="feedback-heading">{TITLES[type]}</h2>
        <p className="feedback-public">This is posted publicly on GitHub.</p>
      </header>

      <div className="feedback-fields">
        <label className="feedback-field">
          <span className="feedback-label">Title</span>
          <input
            ref={titleRef}
            type="text"
            disabled={busy}
            autoComplete="off"
            maxLength={LIMITS.title.max}
            value={fields.title}
            onChange={edit("title")}
            aria-invalid={!!invalid.title}
            aria-describedby={invalid.title ? "feedback-title-error" : undefined}
          />
          {invalid.title && (
            <span className="feedback-error" id="feedback-title-error">
              {invalid.title}
            </span>
          )}
        </label>

        <label className="feedback-field">
          <span className="feedback-label">{isBug ? "What happened?" : "What would you like?"}</span>
          <textarea
            ref={descriptionRef}
            rows={4}
            disabled={busy}
            maxLength={LIMITS.description.max}
            placeholder={isBug ? "What you did, what you expected, and what happened instead." : "What it would do, and how it would help."}
            value={fields.description}
            onChange={edit("description")}
            aria-invalid={!!invalid.description}
            aria-describedby={invalid.description ? "feedback-description-error" : undefined}
          />
          {invalid.description && (
            <span className="feedback-error" id="feedback-description-error">
              {invalid.description}
            </span>
          )}
        </label>

        {isBug && (
          <label className="feedback-field">
            <span className="feedback-label">
              Steps to reproduce <span className="feedback-dim">(optional)</span>
            </span>
            <textarea rows={3} disabled={busy} maxLength={LIMITS.steps.max} placeholder={"1. Open a song\n2. …"} value={fields.steps} onChange={edit("steps")} />
          </label>
        )}

        {/* Hidden from people, filled in by form bots. */}
        <div className="feedback-hp" aria-hidden="true">
          <label>
            Website <input type="text" tabIndex={-1} autoComplete="off" value={fields.website} onChange={edit("website")} />
          </label>
        </div>

        <div className="feedback-system">
          <label className="feedback-check">
            <input
              type="checkbox"
              disabled={busy}
              checked={fields.includeSystem}
              onChange={(event) => setFields((current) => ({ ...current, includeSystem: event.target.checked }))}
            />
            <span>Include system info</span>
          </label>
          {fields.includeSystem && (
            <pre className="feedback-mono feedback-system-lines" aria-label="System info that will be sent">
              {lines.join("\n")}
            </pre>
          )}
        </div>

        <details className="feedback-preview" onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
          <summary>Show exactly what will be posted</summary>
          <pre className="feedback-mono">{previewOpen ? reportText(report) : ""}</pre>
        </details>

        <p className="feedback-small feedback-dim">Never sent: song names or file names.</p>

        <div ref={widgetRef} className="feedback-turnstile" />

        {failure && prefill && (
          <div ref={failureRef} className="feedback-banner" role="alert">
            <p className="feedback-failure">{failure}</p>
            <p className="feedback-small">Your text is still here. You can send it another way:</p>
            <div className="feedback-row">
              <button type="button" onClick={copy}>
                {copied ? "Copied" : "Copy report"}
              </button>
              <a className="feedback-button" href={prefill.url} target="_blank" rel="noreferrer" onClick={openedGitHub}>
                Open on GitHub instead
              </a>
            </div>
            {note && <p className="feedback-small">{note}</p>}
          </div>
        )}
      </div>

      <footer className="feedback-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Posting…" : "Post to GitHub"}
        </button>
      </footer>
    </form>
  );
}

export default function FeedbackDialog({ type, onClose }: FeedbackDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (type && !dialog.open) dialog.showModal();
    if (!type && dialog.open) dialog.close();
  }, [type]);

  return (
    // Escape closes a modal <dialog> by itself, and that ends up here too.
    <dialog ref={dialogRef} className="feedback" aria-labelledby="feedback-heading" onClose={onClose}>
      {type && <FeedbackForm key={type} type={type} onClose={onClose} />}
      <style jsx global>{`
        .feedback {
          --bg: #0d0d0d;
          --panel: #161616;
          --panel-2: #1e1e1e;
          --line: #2c2c2c;
          --text: #ededed;
          --muted: #8a8a8a;
          --accent: #f5f5f5;
          --danger: #ff6b6b;
          width: min(540px, calc(100vw - 32px));
          max-height: min(680px, calc(100dvh - 32px));
          padding: 0;
          border: 1px solid var(--line);
          border-radius: 14px;
          background: var(--bg);
          color: var(--text);
          color-scheme: dark;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px;
          line-height: 1.5;
          -webkit-font-smoothing: antialiased;
        }

        .feedback[open] {
          display: flex;
          flex-direction: column;
        }

        .feedback::backdrop {
          background: rgba(0, 0, 0, 0.6);
        }

        .feedback *,
        .feedback *::before {
          box-sizing: border-box;
        }

        .feedback p {
          margin: 0;
        }

        /* The fields scroll; the title and the buttons stay put. */
        .feedback-body {
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          min-height: 0;
          padding: 22px 0 16px;
        }

        .feedback-header {
          padding: 0 24px;
          margin-bottom: 16px;
        }

        .feedback h2 {
          margin: 0;
          font-size: 17px;
          font-weight: 600;
        }

        .feedback .feedback-public {
          margin-top: 4px;
          color: var(--muted);
        }

        .feedback-public::before {
          content: "";
          display: inline-block;
          width: 7px;
          height: 7px;
          margin-right: 7px;
          border-radius: 50%;
          background: #f0b429;
          vertical-align: 1px;
        }

        .feedback-fields {
          display: flex;
          flex-direction: column;
          gap: 14px;
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 2px 24px 14px;
        }

        .feedback-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .feedback-label {
          font-weight: 600;
        }

        .feedback-dim {
          color: var(--muted);
          font-weight: 400;
        }

        .feedback-small {
          font-size: 12px;
        }

        .feedback input[type="text"],
        .feedback textarea {
          width: 100%;
          font: inherit;
          color: var(--text);
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 7px;
          padding: 8px 10px;
          outline: none;
          transition: border-color 120ms ease;
        }

        .feedback textarea {
          resize: none;
        }

        /* iOS zooms into any field with text under 16px. */
        @media (pointer: coarse) {
          .feedback input[type="text"],
          .feedback textarea {
            font-size: 16px;
          }
        }

        .feedback input[type="text"]:focus,
        .feedback textarea:focus {
          border-color: #5a5a5a;
        }

        .feedback ::placeholder {
          color: #5c5c5c;
        }

        .feedback .feedback-field [aria-invalid="true"] {
          border-color: rgba(255, 107, 107, 0.6);
        }

        .feedback-error {
          color: var(--danger);
          font-size: 12px;
        }

        .feedback-hp {
          position: absolute;
          left: -10000px;
          width: 1px;
          height: 1px;
          overflow: hidden;
        }

        .feedback-system {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 10px 12px;
        }

        .feedback-check {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
          font-weight: 600;
        }

        .feedback-check input {
          accent-color: var(--accent);
          width: 14px;
          height: 14px;
          margin: 0;
        }

        .feedback-mono {
          font-family: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11.5px;
        }

        .feedback pre {
          margin: 8px 0 0;
          white-space: pre-wrap;
          word-break: break-word;
          color: var(--muted);
          user-select: text;
        }

        .feedback-system-lines {
          columns: 2;
          column-gap: 16px;
        }

        @media (max-width: 480px) {
          .feedback-system-lines {
            columns: 1;
          }
        }

        .feedback-preview summary {
          cursor: pointer;
          color: var(--muted);
        }

        .feedback-preview summary:hover {
          color: var(--text);
        }

        .feedback-preview pre {
          max-height: 180px;
          overflow-y: auto;
          padding: 10px 12px;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 10px;
        }

        .feedback-turnstile:empty {
          display: none;
        }

        .feedback button,
        .feedback-button {
          font: inherit;
          cursor: pointer;
          border: 1px solid var(--line);
          background: var(--panel-2);
          color: var(--text);
          padding: 7px 14px;
          border-radius: 7px;
          text-decoration: none;
          transition:
            background 120ms ease,
            border-color 120ms ease,
            opacity 120ms ease;
        }

        .feedback button:hover:not(:disabled),
        .feedback-button:hover {
          background: #262626;
          border-color: #3a3a3a;
        }

        .feedback button:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .feedback button:focus-visible,
        .feedback-button:focus-visible,
        .feedback a:focus-visible {
          outline: 2px solid #5a5a5a;
          outline-offset: 2px;
        }

        .feedback button.primary {
          background: var(--accent);
          color: #0d0d0d;
          border-color: var(--accent);
          font-weight: 600;
        }

        .feedback button.primary:hover:not(:disabled) {
          background: #ffffff;
        }

        .feedback-banner {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 10px 12px;
          border-radius: 10px;
          background: rgba(255, 107, 107, 0.08);
          border: 1px solid rgba(255, 107, 107, 0.3);
        }

        .feedback-failure {
          color: var(--danger);
          font-weight: 600;
        }

        .feedback-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .feedback-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: auto;
          padding: 12px 24px 0;
          border-top: 1px solid var(--line);
        }

        .feedback-posted {
          padding: 8px 24px 24px;
        }

        .feedback-posted a {
          color: var(--text);
          font-weight: 600;
          text-underline-offset: 2px;
        }

        .feedback-posted + .feedback-actions {
          border-top: none;
        }
      `}</style>
    </dialog>
  );
}
