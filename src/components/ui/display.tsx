import Link from "next/link";
import type { ReactNode } from "react";
import type { CatTint } from "./categories";
import { cn } from "./cn";
import type { LucideIcon } from "./icon";
import { Tile } from "./tile";

/* ---------- AppMark ---------- */

/** Two-door almirah: a rounded rect split down the middle, two handles, two little feet. */
export function AlmirahGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("shrink-0", className ?? "size-6")}
    >
      <rect x="4" y="2.5" width="16" height="17.5" rx="2.5" />
      <path d="M12 2.5V20" />
      <path d="M9.75 9.5v3M14.25 9.5v3" />
      <path d="M6.5 20v1.75M17.5 20v1.75" />
    </svg>
  );
}

export interface AppMarkProps {
  /** 56 px on the lock screen, 40 px in the sidebar. */
  size?: 40 | 56;
  className?: string;
}

export function AppMark({ size = 56, className }: AppMarkProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-ink text-on-ink",
        size === 56 ? "size-14 rounded-lg" : "size-10 rounded-md",
        className,
      )}
    >
      <AlmirahGlyph className={size === 56 ? "size-7.5" : "size-5.5"} />
    </span>
  );
}

/* ---------- CategoryTile ---------- */

export interface CategoryTileProps {
  cat: CatTint;
  icon: LucideIcon;
  name: string;
  count: number;
  href?: string;
  onClick?: () => void;
  className?: string;
}

function countLabel(count: number): string {
  if (count === 0) return "No documents";
  return count === 1 ? "1 document" : `${count} documents`;
}

/** What people scan for: the category, and whether it has anything in it. */
export function CategoryTile({ cat, icon, name, count, href, onClick, className }: CategoryTileProps) {
  const classes = cn(
    "flex min-h-16 w-full items-center gap-2.5 rounded-lg bg-surface p-3 text-left",
    "transition-colors duration-150 ease-out hover:bg-pressed active:bg-pressed active:duration-0",
    className,
  );
  const body = (
    <>
      <Tile cat={cat} icon={icon} size={36} />
      <span className="flex min-w-0 flex-col">
        <span className="line-clamp-2 text-[1rem] leading-5 font-semibold break-words">{name}</span>
        <span className="tabular text-[0.875rem] leading-[1.125rem] break-words text-ink-3">{countLabel(count)}</span>
      </span>
    </>
  );
  return href ? (
    <Link href={href} className={classes} onClick={onClick}>
      {body}
    </Link>
  ) : (
    <button type="button" className={classes} onClick={onClick}>
      {body}
    </button>
  );
}

/**
 * 2 columns on phone, 3 on tablet, 4 on desktop. Column minimums are in rem, so
 * at large text sizes the grid drops columns instead of crushing the labels.
 */
export function CategoryGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(min(100%,8.5rem),1fr))]",
        "sm:grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ---------- EmptyState ---------- */

export interface EmptyStateProps {
  icon: LucideIcon;
  cat?: CatTint;
  /** One sentence that says what goes here: "No insurance documents yet." */
  message: string;
  /** One action: <Button size="sm" icon={Plus}>Add document</Button>. */
  action?: ReactNode;
  className?: string;
}

/** Tint tile, one sentence, one action. No illustrations of sad folders. */
export function EmptyState({ icon, cat = "other", message, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-start gap-2.5 px-1 py-2", className)}>
      <Tile cat={cat} icon={icon} />
      <p className="text-body text-ink-2">{message}</p>
      {action}
    </div>
  );
}

/* ---------- StepProgress ---------- */

export interface StepProgressProps {
  /** 1-based. Segments up to and including this one are filled. */
  current: number;
  total?: number;
  className?: string;
}

/** The setup flow's segmented bar. The words ("Step 4 of 6") live in the TopBar. */
export function StepProgress({ current, total = 6, className }: StepProgressProps) {
  return (
    <div
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-valuetext={`Step ${current} of ${total}`}
      className={cn("flex gap-1", className)}
    >
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn("h-1 flex-1 rounded-full", i < current ? "bg-ink" : "bg-sunken-pressed")} />
      ))}
    </div>
  );
}

/* ---------- RecoveryCodeGrid ---------- */

export interface RecoveryCodeGridProps {
  /** Eight 4-character groups, in order. */
  groups: readonly string[];
  className?: string;
}

/** 2 × 4 in a sunken block. It's a real sequence, so it's numbered. */
export function RecoveryCodeGrid({ groups, className }: RecoveryCodeGridProps) {
  return (
    <ol
      aria-label="Recovery code"
      className={cn(
        // never more than two columns (each is at least half the block); one column when a group no longer fits in half
        "grid grid-cols-[repeat(auto-fit,minmax(min(100%,max(7.5rem,calc((100%_-_1rem)_/_2))),1fr))]",
        "gap-x-4 gap-y-2.5 rounded-lg bg-sunken px-4 py-3.5 select-text",
        className,
      )}
    >
      {groups.map((group, i) => (
        <li key={i} className="flex items-baseline gap-2.5">
          <span aria-hidden className="tabular w-2.5 text-right text-[0.8125rem] leading-[1.125rem] text-ink-3">
            {i + 1}
          </span>
          <span className="font-mono text-[1.3125rem] leading-7 font-semibold tracking-[0.1em]">{group}</span>
        </li>
      ))}
    </ol>
  );
}
