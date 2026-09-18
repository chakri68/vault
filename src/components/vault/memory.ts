import type { Orphan } from "@/vault/engine";

/**
 * Things the browse screens remember between navigations, in this page's
 * memory and nowhere else: never localStorage, never IndexedDB, gone on reload.
 *
 * Both hold plaintext (what someone searched for, the names of stray files), so
 * `forgetBrowseMemory()` must run whenever the vault locks.
 */
const MAX_RECENT = 6;
let recentSearches: string[] = [];

export function rememberSearch(query: string): void {
  const q = query.trim();
  if (q.length < 2) return;
  recentSearches = [q, ...recentSearches.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT);
}

export function getRecentSearches(): string[] {
  return recentSearches;
}

/** §7.8 says reconcile at most once a day; the listing route is rate-limited too. One check per unlock is plenty. */
let orphanCheck: { at: number; orphans: Orphan[] } | null = null;
const ORPHAN_RECHECK_MS = 6 * 60 * 60 * 1000;

export function cachedOrphans(): Orphan[] | null {
  if (!orphanCheck || Date.now() - orphanCheck.at > ORPHAN_RECHECK_MS) return null;
  return orphanCheck.orphans;
}

export function setCachedOrphans(orphans: Orphan[]): void {
  orphanCheck = { at: Date.now(), orphans };
}

export function forgetBrowseMemory(): void {
  recentSearches = [];
  orphanCheck = null;
}
