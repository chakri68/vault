import "server-only";

/**
 * §6.4. Sliding-window counters, in memory.
 *
 * Honest limitation: memory is per process. On one long-lived Node server this
 * is a real limit. On serverless, each warm instance counts separately, so the
 * effective ceiling is (limit × instances) — still a brake on a hammering
 * client, which lands on the same instance, but not a hard guarantee. Swap
 * `hits` for a shared KV to make it one.
 */
interface Bucket {
  hits: number[];
  strikes: number;
  blockedUntil: number;
}

const g = globalThis as unknown as { __fvLimits?: Map<string, Bucket> };
const buckets = (g.__fvLimits ??= new Map());

export interface Limit {
  name: string;
  max: number;
  windowMs: number;
}

const MIN = 60_000;
export const LIMITS = {
  authPassword: { name: "auth-password", max: 5, windowMs: 15 * MIN },
  authRecovery: { name: "auth-recovery", max: 5, windowMs: 15 * MIN },
  authWebauthn: { name: "auth-webauthn", max: 20, windowMs: 15 * MIN },
  setup: { name: "setup", max: 10, windowMs: 15 * MIN },
  config: { name: "config", max: 120, windowMs: MIN },
  objectGet: { name: "object-get", max: 300, windowMs: MIN },
  objectPut: { name: "object-put", max: 60, windowMs: MIN },
  objectDelete: { name: "object-delete", max: 30, windowMs: MIN },
  objectList: { name: "object-list", max: 30, windowMs: MIN },
  indexGet: { name: "index-get", max: 120, windowMs: MIN },
  indexPut: { name: "index-put", max: 60, windowMs: MIN },
  meta: { name: "meta", max: 60, windowMs: MIN },
  credentials: { name: "credentials", max: 20, windowMs: 15 * MIN },
} satisfies Record<string, Limit>;

function bucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = { hits: [], strikes: 0, blockedUntil: 0 }));
  return b;
}

/** Counts one hit. Returns seconds to wait when over the limit, else 0. */
export function hit(limit: Limit, who: string, now = Date.now()): number {
  const b = bucket(`${limit.name}:${who}`);
  if (b.blockedUntil > now) return Math.ceil((b.blockedUntil - now) / 1000);
  b.hits = b.hits.filter((t) => t > now - limit.windowMs);
  if (b.hits.length >= limit.max) return Math.ceil((b.hits[0] + limit.windowMs - now) / 1000);
  b.hits.push(now);
  return 0;
}

/**
 * Exponential backoff for credential guessing: each time the window fills with
 * failures, the lockout doubles (15 min, 30, 60 … capped at a day).
 */
export function recordAuthFailure(limit: Limit, who: string, now = Date.now()): void {
  const b = bucket(`${limit.name}:${who}`);
  const recent = b.hits.filter((t) => t > now - limit.windowMs).length;
  if (recent >= limit.max) {
    b.strikes += 1;
    b.blockedUntil = now + Math.min(limit.windowMs * 2 ** (b.strikes - 1), 24 * 60 * MIN);
  }
}

export function recordAuthSuccess(limit: Limit, who: string): void {
  buckets.delete(`${limit.name}:${who}`);
}

/** Keeps the map from growing without bound. Called opportunistically. */
export function sweep(now = Date.now()): void {
  if (buckets.size < 5000) return;
  for (const [key, b] of buckets) {
    if (b.blockedUntil < now && (b.hits.at(-1) ?? 0) < now - 60 * MIN) buckets.delete(key);
  }
}

/** test hook */
export function resetLimits(): void {
  buckets.clear();
}
