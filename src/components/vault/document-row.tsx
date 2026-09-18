"use client";

import { Clock, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Row, StatusPill, Tile } from "@/components/ui";
import { ownersLabel } from "@/lib/documents";
import { formatCountdown, formatDate, formatRelative } from "@/lib/format";
import type { IndexEntry, VaultIndex } from "@/schemas/index";
import { categoryOf, documentHref } from "./category";

export type DocumentRowDescription = "category-person" | "expiry" | "added";

export interface DocumentRowProps {
  entry: IndexEntry;
  index: VaultIndex;
  /**
   * What the second line says. A preset, or any node of your own.
   *  - "category-person": "Identity · Mom" (the default)
   *  - "expiry": "Expires 12 Mar 2031"
   *  - "added": "Identity · Added yesterday"
   */
  description?: DocumentRowDescription | ReactNode;
  /** One thing: a pill, usually. Left out, temporary files get a countdown pill; pass `null` for nothing at all. */
  trailing?: ReactNode;
  /** [start, end) ranges of the name to set in 600 weight (search matches). No highlight colour. */
  nameRanges?: Array<[number, number]>;
  /** Defaults to the document screen, unless `onClick` is given without it. */
  href?: string;
  /** Alone, makes the row a button (the trash sheet). With `href`, runs as the link is followed. */
  onClick?: () => void;
  /** Defaults to on when there's nothing in the trailing slot. */
  chevron?: boolean;
}

function describe(kind: DocumentRowDescription, entry: IndexEntry, index: VaultIndex): string {
  const category = categoryOf(index, entry.category).label;
  switch (kind) {
    case "expiry":
      return entry.document?.expiryDate ? `Expires ${formatDate(entry.document.expiryDate)}` : "No expiry date";
    case "added":
      return `${category} · Added ${formatRelative(entry.createdAt)}`;
    case "category-person": {
      const owners = ownersLabel(index, entry);
      return owners ? `${category} · ${owners}` : category;
    }
  }
}

/** Merges overlapping ranges and clamps them to the name, so a sloppy caller can't produce overlapping markup. */
function normalise(ranges: Array<[number, number]>, length: number): Array<[number, number]> {
  const sorted = ranges
    .map(([s, e]) => [Math.max(0, s), Math.min(length, e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** The matched text is set in 600 weight. Weight, not colour: it reads in both themes and in greyscale. */
export function MatchedName({ name, ranges }: { name: string; ranges?: Array<[number, number]> }) {
  const parts = normalise(ranges ?? [], name.length);
  if (parts.length === 0) return <>{name}</>;
  const out: ReactNode[] = [];
  let at = 0;
  parts.forEach(([start, end], i) => {
    if (start > at) out.push(name.slice(at, start));
    out.push(<span key={i} className="font-semibold">{name.slice(start, end)}</span>);
    at = end;
  });
  if (at < name.length) out.push(name.slice(at));
  return <>{out}</>;
}

/** A warn pill for anything inside its reminder window. Icon and words, never colour alone. */
export function ExpiryPill({ days }: { days: number }) {
  if (days < 0) return <StatusPill tone="danger" icon={TriangleAlert}>Expired</StatusPill>;
  const words = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days > 60 ? `${Math.round(days / 30)} months` : `${days} days`;
  return <StatusPill tone="warn" icon={Clock}>{words}</StatusPill>;
}

const PRESETS = new Set<unknown>(["category-person", "expiry", "added"]);

/**
 * The document row: category tile, name on one line, one line of context.
 * The whole row is the target; anything else you can do to a document lives on
 * its own screen.
 */
export function DocumentRow({ entry, index, description = "category-person", trailing, nameRanges, href, onClick, chevron }: DocumentRowProps) {
  const category = categoryOf(index, entry.category);
  const slot =
    trailing !== undefined ? trailing
    : entry.temporary ? <StatusPill tone="neutral" icon={Clock}>{formatCountdown(entry.temporary.expiresAt)}</StatusPill>
    : undefined;

  return (
    <Row
      truncate
      leading={<Tile cat={category.cat} icon={category.icon} />}
      label={<MatchedName name={entry.name} ranges={nameRanges} />}
      description={PRESETS.has(description) ? describe(description as DocumentRowDescription, entry, index) : description}
      trailing={slot}
      chevron={chevron ?? !slot}
      href={href ?? (onClick ? undefined : documentHref(entry))}
      onClick={onClick}
    />
  );
}
