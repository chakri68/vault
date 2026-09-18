import type { IndexEntry, VaultIndex, VaultProfile } from "@/schemas/index";
import { activeProfiles, visibleEntries } from "@/vault/index-model";
import { daysFromToday, formatMonthYear } from "./format";

export { activeCategories, activeProfiles, getSetting, visibleEntries } from "@/vault/index-model";

const DEFAULT_REMINDERS = [6, 3, 1]; // months before expiry (§22.1)

export function forProfile(entries: IndexEntry[], profileId: string | null): IndexEntry[] {
  return profileId ? entries.filter((e) => e.ownerProfileIds.includes(profileId)) : entries;
}

/**
 * Documents inside their reminder window, soonest first. The window opens at
 * the earliest reminder the document has ticked, and stays open a month past
 * expiry so a lapsed policy doesn't quietly drop off the list.
 */
export function expiringSoon(entries: IndexEntry[], now = new Date()): Array<{ entry: IndexEntry; days: number }> {
  return entries
    .flatMap((entry) => {
      const expiry = entry.document?.expiryDate;
      if (!expiry) return [];
      const reminders = entry.reminders ?? DEFAULT_REMINDERS;
      if (reminders.length === 0) return [];
      const days = daysFromToday(expiry, now);
      return days <= Math.max(...reminders) * 30.5 && days >= -30 ? [{ entry, days }] : [];
    })
    .sort((a, b) => a.days - b.days);
}

/** Last added or opened. `recentIds` is this device's own open history; the rest falls back to newest first. */
export function recent(entries: IndexEntry[], recentIds: string[], limit = 5): IndexEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const opened = recentIds.map((id) => byId.get(id)).filter((e): e is IndexEntry => !!e);
  const newest = [...entries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const out: IndexEntry[] = [];
  for (const e of [...newest.slice(0, 2), ...opened, ...newest]) {
    if (!out.includes(e)) out.push(e);
    if (out.length === limit) break;
  }
  return out.sort((a, b) => {
    const ai = recentIds.indexOf(a.id), bi = recentIds.indexOf(b.id);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || (a.createdAt < b.createdAt ? 1 : -1);
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

export function categoryCounts(entries: IndexEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.category ?? "other", (counts.get(e.category ?? "other") ?? 0) + 1);
  return counts;
}

export function trashed(index: VaultIndex): IndexEntry[] {
  return Object.values(index.entries)
    .filter((e) => e.state === "trashed")
    .sort((a, b) => ((a.trashedAt ?? "") < (b.trashedAt ?? "") ? 1 : -1));
}

export function profileName(index: VaultIndex, id: string): string {
  return index.profiles.find((p) => p.id === id)?.displayName ?? "Family member";
}

export function ownersLabel(index: VaultIndex, entry: IndexEntry): string {
  return entry.ownerProfileIds.map((id) => profileName(index, id)).join(", ");
}

// ───────────────────────── search (§8.5) ─────────────────────────

export interface SearchHit {
  entry: IndexEntry;
  /** [start, end) ranges within entry.name, for setting matched text in 600 weight */
  nameRanges: Array<[number, number]>;
  /** where else it matched, in plain words */
  matchedIn: string[];
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Entirely local: a linear scan over the decrypted index. A few hundred
 * entries is instant, and nothing about the query ever leaves the device.
 * Every word must match somewhere: name, people, tags, notes, issuer, number, category.
 */
export function search(index: VaultIndex, query: string, filters: { profileId?: string | null; category?: string | null } = {}): SearchHit[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  let pool = visibleEntries(index);
  if (filters.profileId) pool = pool.filter((e) => e.ownerProfileIds.includes(filters.profileId!));
  if (filters.category) pool = pool.filter((e) => (e.category ?? "other") === filters.category);
  if (words.length === 0) return [];

  const hits: Array<SearchHit & { score: number }> = [];
  for (const entry of pool) {
    const fields: Array<[string, string]> = [
      ["name", entry.name],
      ["person", ownersLabel(index, entry)],
      ["tag", entry.tags.join(" ")],
      ["category", index.categories.find((c) => c.id === entry.category)?.name ?? ""],
      ["note", entry.note ?? ""],
      ["issuer", entry.document?.issuer ?? ""],
      ["number", (entry.document?.referenceNumber ?? "").replace(/\s/g, "")],
    ];
    const folded = fields.map(([k, v]) => [k, fold(v)] as const);
    const matchedIn = new Set<string>();
    const nameRanges: Array<[number, number]> = [];
    let score = 0;
    const all = words.every((w) => {
      let found = false;
      for (const [k, v] of folded) {
        const at = v.indexOf(k === "number" ? w.replace(/\s/g, "") : w);
        if (at === -1) continue;
        found = true;
        if (k === "name") {
          nameRanges.push([at, at + w.length]);
          score += at === 0 ? 4 : 3;
        } else {
          matchedIn.add(k);
          score += 1;
        }
      }
      return found;
    });
    if (all) hits.push({ entry, nameRanges, matchedIn: [...matchedIn], score });
  }
  return hits.sort((a, b) => b.score - a.score || (a.entry.name < b.entry.name ? -1 : 1));
}

// ───────────────────────── naming (§16) ─────────────────────────

const JUNK_NAME = /^(img|image|dsc|pxl|scan|document|doc|photo|screenshot|whatsapp|file|untitled|cam|\d)[\w\s().-]*$/i;

/** True for names a camera or scanner made up: IMG_20260918_172914, scan0004, document (17). */
export function looksAutoNamed(stem: string): boolean {
  return JUNK_NAME.test(stem.trim()) || /^\d[\d_-]+$/.test(stem.trim());
}

const DATED = new Set(["finance", "employment", "receipts", "medical"]);

/**
 * A readable name from local signals only: what it is, whose it is, when.
 * Deterministic, and nothing about the file goes anywhere to produce it.
 */
export function suggestName(opts: { fileName: string; categoryName?: string; categoryId?: string; person?: VaultProfile; date?: Date }): string {
  const stem = opts.fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  const thing = looksAutoNamed(stem) || !stem ? (opts.categoryName ? `${opts.categoryName} document` : "Document") : stem[0].toUpperCase() + stem.slice(1);
  if (opts.categoryId && DATED.has(opts.categoryId)) return `${thing} — ${formatMonthYear(opts.date ?? new Date())}`;
  if (opts.person) return `${thing} — ${opts.person.displayName}`;
  return thing;
}

export function firstProfile(index: VaultIndex, id: string | null): VaultProfile | undefined {
  return activeProfiles(index).find((p) => p.id === id);
}

export function splitFileName(fileName: string): { stem: string; extension: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return { stem: fileName, extension: "" };
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot + 1).toLowerCase().slice(0, 16) };
}

/** §13 thresholds. The server enforces the real ceiling; this is guidance. */
export function sizeAdvice(bytes: number, maxBytes: number): "fine" | "gentle" | "strong" | "confirm" | "blocked" {
  const mb = bytes / (1024 * 1024);
  if (bytes > maxBytes) return "blocked";
  if (mb > 20) return "confirm";
  if (mb > 5) return "strong";
  if (mb > 1) return "gentle";
  return "fine";
}
