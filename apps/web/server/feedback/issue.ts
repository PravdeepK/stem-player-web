import type { FeedbackType } from "@stem-player-web/core";

// What a feedback report may contain and how it reads as a GitHub issue.
// FeedbackDialog keeps its own copy of the parts the browser needs for the
// preview and the GitHub fallback, since nothing under server/ may reach the
// page. report.test.ts fails if the two drift apart.

export const TYPE_LABELS: Record<FeedbackType, string> = { bug: "bug", feature: "enhancement" };
export const FROM_WEB_LABEL = "from-web";

export const LIMITS = {
  title: { min: 3, max: 120 },
  description: { min: 3, max: 5000 },
  steps: { min: 0, max: 3000 },
  systemValue: 100,
};

// Everything system info may say, in the order it's shown. Never song or file
// names.
export const SYSTEM_FIELDS = [
  ["app", "Site version"],
  ["browser", "Browser"],
  ["os", "OS"],
  ["memory", "Memory"],
] as const;

export type SystemKey = (typeof SYSTEM_FIELDS)[number][0];
export type SystemInfo = Partial<Record<SystemKey, string>>;

export interface Report {
  type: FeedbackType;
  title: string;
  description: string;
  steps: string;
  system: SystemInfo | null;
}

type Failure = { ok: false; field: string; message: string };
export type Checked = { ok: true; report: Report } | Failure;

const REPORT_KEYS = new Set(["type", "title", "description", "steps", "system", "website"]);

// Control characters other than tab and newline.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
// System values are plain facts like "Safari 26.1", so anything else goes.
const NOT_SYSTEM = /[^\w .,()+:/~-]/g;

function cleanText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
}

function cleanLine(value: string) {
  return value.replace(/\s+/g, " ").replace(CONTROL, "").trim();
}

/**
 * User text as issue markdown: no raw HTML (so nothing can close the system
 * info block or hide text), and no @mentions, so nobody gets pinged. A word
 * joiner after the @ breaks GitHub's mention pattern and renders as nothing.
 * Wrapping mentions in backticks didn't hold: a stray backtick before one
 * doesn't open a code span, so the mention still went out.
 */
export function escapeMarkdown(text: string) {
  return text.replace(/</g, "&lt;").replace(/(^|\W)@(?=[a-z0-9])/gi, "$1@⁠");
}

function fail(field: string, message: string): Failure {
  return { ok: false, field, message };
}

function text(input: Record<string, unknown>, field: "title" | "description" | "steps", required: boolean): string | Failure {
  const value = input[field];
  if (value === undefined || value === null) return required ? fail(field, `${field} is required.`) : "";
  if (typeof value !== "string") return fail(field, `${field} must be a string.`);
  const clean = field === "title" ? cleanLine(value) : cleanText(value);
  const { min, max } = LIMITS[field];
  if (clean.length > max) return fail(field, `${field} must be at most ${max} characters.`);
  if (clean.length < Math.max(min, required ? 1 : 0)) {
    return fail(field, `${field} must be at least ${Math.max(min, 1)} characters.`);
  }
  return clean;
}

/** Check a report strictly. Trims the fields it keeps. */
export function validateReport(input: unknown): Checked {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("body", "Expected a JSON object.");
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!REPORT_KEYS.has(key)) return fail(key, `Unknown field "${key}".`);
  }
  if (typeof body.type !== "string" || !Object.prototype.hasOwnProperty.call(TYPE_LABELS, body.type)) {
    return fail("type", 'type must be "bug" or "feature".');
  }
  const type = body.type as FeedbackType;

  const title = text(body, "title", true);
  if (typeof title !== "string") return title;
  const description = text(body, "description", true);
  if (typeof description !== "string") return description;
  const steps = text(body, "steps", false);
  if (typeof steps !== "string") return steps;
  if (steps && type !== "bug") return fail("steps", "Only bug reports have steps to reproduce.");

  let system: SystemInfo | null = null;
  if (body.system !== undefined && body.system !== null) {
    if (typeof body.system !== "object" || Array.isArray(body.system)) return fail("system", "system must be an object.");
    const known = new Set<string>(SYSTEM_FIELDS.map(([key]) => key));
    system = {};
    for (const [key, value] of Object.entries(body.system)) {
      if (!known.has(key)) return fail("system", `Unknown system field "${key}".`);
      if (typeof value !== "string") return fail("system", `system.${key} must be a string.`);
      const clean = cleanLine(value).replace(NOT_SYSTEM, "");
      if (clean.length > LIMITS.systemValue) return fail("system", `system.${key} is too long.`);
      if (clean) system[key as SystemKey] = clean;
    }
  }

  if (body.website !== undefined && typeof body.website !== "string") return fail("website", "website must be a string.");

  return { ok: true, report: { type, title, description, steps, system } };
}

/** The system info as "Label: value" lines, in a fixed order. */
export function systemLines(system: SystemInfo | null) {
  if (!system) return [];
  return SYSTEM_FIELDS.filter(([key]) => system[key]).map(([key, label]) => `${label}: ${system[key]}`);
}

/** A validated report as the issue's markdown body. */
export function formatIssueBody(report: Report) {
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

export function issueLabels(type: FeedbackType) {
  return [TYPE_LABELS[type], FROM_WEB_LABEL];
}
