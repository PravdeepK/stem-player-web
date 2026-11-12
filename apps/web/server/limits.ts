import { DAILY_COUNTER_TTL_SECONDS, FEEDBACK_PER_IP_PREFIX, feedbackTodayKey } from "@stem-player-web/core";

// Daily caps, counted in Upstash Redis so every function instance shares them.
// The desktop relay counted in memory, which reset on every cold start.
// Each cap is a fixed UTC day: one counter per IP and one for everybody, both
// keyed by the date so a new day starts from zero without anything resetting.

export interface DailyLimit {
  perIp: number;
  overall: number;
  ipKey(day: string, ip: string): string;
  dayKey(day: string): string;
}

export const FEEDBACK_LIMIT: DailyLimit = {
  perIp: 5,
  overall: 30,
  // The date goes before the IP because IPv6 addresses are full of colons.
  ipKey: (day, ip) => `${FEEDBACK_PER_IP_PREFIX}:${day}:${ip}`,
  dayKey: feedbackTodayKey,
};

export type LimitResult = { ok: true } | { ok: false; retryAfter: number };

export type RedisCommand = (string | number)[];

export interface Redis {
  /** Runs the commands in order in one round trip and resolves to their results. */
  pipeline(commands: RedisCommand[], signal?: AbortSignal): Promise<unknown[]>;
}

export class RedisError extends Error {}

/** Upstash's REST API, which is a fetch away and needs no connection pool. */
export function upstash({ url, token, fetch = globalThis.fetch }: { url: string; token: string; fetch?: typeof globalThis.fetch }): Redis {
  const base = url.replace(/\/+$/, "");
  return {
    async pipeline(commands, signal) {
      let res: Response;
      try {
        res = await fetch(`${base}/pipeline`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(commands),
          signal,
        });
      } catch (err) {
        throw new RedisError(`Upstash unreachable: ${err instanceof Error ? err.message : err}`);
      }
      if (!res.ok) throw new RedisError(`Upstash answered ${res.status}`);
      const body = await res.json().catch(() => null);
      if (!Array.isArray(body) || body.length !== commands.length) throw new RedisError("Upstash sent an unexpected reply");
      return body.map((entry, i) => {
        if (entry && typeof entry.error === "string") throw new RedisError(`${commands[i][0]} failed: ${entry.error}`);
        return entry?.result;
      });
    },
  };
}

/** The Upstash client from env, or null when either variable is missing. */
export function upstashFromEnv(env: Record<string, string | undefined>, fetch?: typeof globalThis.fetch): Redis | null {
  const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = env;
  return url && token ? upstash({ url, token, fetch }) : null;
}

/** YYYY-MM-DD in UTC, the shape the daily keys take. */
export function utcDay(now: number) {
  return new Date(now).toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay(now: number) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}

async function count(redis: Redis, key: string, signal?: AbortSignal) {
  // EXPIRE on every hit is harmless: the date in the key already ends the window.
  const [value] = await redis.pipeline([["INCR", key], ["EXPIRE", key, DAILY_COUNTER_TTL_SECONDS]], signal);
  if (typeof value !== "number") throw new RedisError(`INCR ${key} gave ${JSON.stringify(value)}`);
  return value;
}

/**
 * Count one request against a daily limit. The IP's own counter goes first,
 * and a request it turns away never reaches the shared one, so a single
 * caller can't use up everybody's allowance.
 */
export async function takeDaily(redis: Redis, limit: DailyLimit, ip: string, { now = Date.now(), signal }: { now?: number; signal?: AbortSignal } = {}): Promise<LimitResult> {
  const day = utcDay(now);
  if ((await count(redis, limit.ipKey(day, ip), signal)) > limit.perIp) return { ok: false, retryAfter: secondsUntilNextUtcDay(now) };
  if ((await count(redis, limit.dayKey(day), signal)) > limit.overall) return { ok: false, retryAfter: secondsUntilNextUtcDay(now) };
  return { ok: true };
}
