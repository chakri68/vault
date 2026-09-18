import type { IndexEntry, Setting, Tombstone, VaultIndex } from "@/schemas/index";
import { MUTABLE_FIELDS, getField, setField } from "./index-model";

/**
 * §9.3. A pure function over two decrypted index states.
 *
 * Every rule below is a join on a total order, which makes the whole merge
 * commutative, associative and idempotent. That's the property that matters:
 * it doesn't matter who merges whom, how many times, or in what order — every
 * device converges on the same index and nothing is silently dropped.
 */

/** Deterministic serialisation, so ties break the same way on every device. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return ""; // sorts lowest: a defined value beats a missing one on a tie
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** true when `b` should win over `a`. Higher clock first, then a stable tiebreak on the value. */
function later(av: number, a: unknown, bv: number, b: unknown): boolean {
  if (av !== bv) return bv > av;
  return stableStringify(b) > stableStringify(a);
}

const maxIso = (a: string, b: string) => (a >= b ? a : b);

// Keys owned by the LWW fields below; everything else on an entry is a fact.
const MUTABLE_KEYS = new Set([
  "name", "ownerProfileIds", "category", "tags", "note", "document", "temporary", "reminders",
  "state", "trashedAt", "updatedAt", "fieldVersions",
]);

export function mergeEntry(a: IndexEntry, b: IndexEntry): IndexEntry {
  const out: IndexEntry = structuredClone(a);
  const target = out as Record<string, unknown>;

  // Facts (checksum, size, …) are fixed at upload and identical on both sides.
  // If they ever aren't, take a per-key join so the result still doesn't depend
  // on argument order.
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (MUTABLE_KEYS.has(key)) continue;
    const bv = (b as Record<string, unknown>)[key];
    if (stableStringify(bv) > stableStringify(target[key])) target[key] = structuredClone(bv);
  }

  for (const field of MUTABLE_FIELDS) {
    const av = a.fieldVersions[field] ?? 0;
    const bv = b.fieldVersions[field] ?? 0;
    if (later(av, getField(a, field), bv, getField(b, field))) {
      setField(out, field, structuredClone(getField(b, field)));
      out.fieldVersions[field] = bv;
    }
  }
  // carry clocks for fields this build doesn't know about
  for (const [field, bv] of Object.entries(b.fieldVersions)) {
    if ((out.fieldVersions[field] ?? -1) < bv) out.fieldVersions[field] = bv;
  }
  out.updatedAt = maxIso(a.updatedAt, b.updatedAt);
  return out;
}

function mergeTombstone(a: Tombstone, b: Tombstone): Tombstone {
  return {
    // earliest deletion is the true one; later copies are echoes
    deletedAt: a.deletedAt <= b.deletedAt ? a.deletedAt : b.deletedAt,
    purgeAfter: maxIso(a.purgeAfter, b.purgeAfter),
    // shred wins over everything and is never un-shredded by a merge
    shredded: a.shredded || b.shredded,
  };
}

interface Stamped { id: string; updatedAt: string; deletedAt?: string }

/** Set union by id. A deleted record is a tombstone, and deletion wins. */
function mergeStamped<T extends Stamped>(a: T[], b: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of [...a, ...b]) {
    const seen = byId.get(item.id);
    if (!seen) {
      byId.set(item.id, item);
      continue;
    }
    let winner: T;
    if (!!seen.deletedAt !== !!item.deletedAt) winner = seen.deletedAt ? seen : item;
    else if (seen.updatedAt !== item.updatedAt) winner = seen.updatedAt > item.updatedAt ? seen : item;
    else winner = stableStringify(seen) >= stableStringify(item) ? seen : item;
    byId.set(item.id, winner);
  }
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function mergeSettings(a: Record<string, Setting>, b: Record<string, Setting>) {
  const out: Record<string, Setting> = { ...a };
  for (const [key, s] of Object.entries(b)) {
    const seen = out[key];
    if (!seen || later(seen.v, seen.value, s.v, s.value)) out[key] = s;
  }
  return out;
}

export function mergeIndexes(a: VaultIndex, b: VaultIndex): VaultIndex {
  const tombstones: Record<string, Tombstone> = { ...a.tombstones };
  for (const [id, t] of Object.entries(b.tombstones)) {
    tombstones[id] = tombstones[id] ? mergeTombstone(tombstones[id], t) : t;
  }

  const entries: Record<string, IndexEntry> = {};
  for (const id of new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])) {
    // Tombstones win over edits: an offline client that still holds the entry
    // must not resurrect a purged document on reconnect.
    if (tombstones[id]) continue;
    const ea = a.entries[id];
    const eb = b.entries[id];
    entries[id] = ea && eb ? mergeEntry(ea, eb) : structuredClone(ea ?? eb);
  }

  return {
    version: 1,
    updatedAt: maxIso(a.updatedAt, b.updatedAt),
    entries,
    tombstones,
    profiles: mergeStamped(a.profiles, b.profiles),
    categories: mergeStamped(a.categories, b.categories),
    settings: mergeSettings(a.settings ?? {}, b.settings ?? {}),
  };
}

const DAY = 86_400_000;

/** Tombstones outlive the trash window by a margin, then go (§9.3). */
export function pruneTombstones(index: VaultIndex, now = Date.now(), graceDays = 180): VaultIndex {
  const tombstones: Record<string, Tombstone> = {};
  for (const [id, t] of Object.entries(index.tombstones)) {
    if (Date.parse(t.purgeAfter) + graceDays * DAY > now) tombstones[id] = t;
  }
  return { ...index, tombstones };
}

/** For tests and for deciding whether a merge produced anything new to write. */
export function sameIndex(a: VaultIndex, b: VaultIndex): boolean {
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : 1));
  const strip = (i: VaultIndex) =>
    stableStringify({ ...i, updatedAt: undefined, profiles: byId(i.profiles), categories: byId(i.categories) });
  return strip(a) === strip(b);
}
