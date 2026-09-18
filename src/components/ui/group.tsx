"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { Icon, type LucideIcon } from "./icon";
import { Switch } from "./switch";

/* ---------- Group ---------- */

export interface GroupProps {
  children: ReactNode;
  className?: string;
  /** Marks the group as loading for assistive tech (pair with SkeletonRows). */
  busy?: boolean;
}

/** A surface that holds rows together. No shadow, no border: colour difference only. */
export function Group({ children, className, busy }: GroupProps) {
  return (
    <div aria-busy={busy || undefined} className={cn("overflow-hidden rounded-lg bg-surface", className)}>
      {children}
    </div>
  );
}

export interface GroupLabelProps {
  children: ReactNode;
  /** One trailing text action, e.g. <Button variant="text" size="sm">See all</Button>. */
  action?: ReactNode;
  /** Heading level for the document outline. */
  as?: "h2" | "h3" | "h4";
  id?: string;
  className?: string;
}

/** Sentence case, 15/600, ink-2. Sits 8 px above its group. */
export function GroupLabel({ children, action, as: Heading = "h2", id, className }: GroupLabelProps) {
  return (
    <div className={cn("flex min-h-7 items-center justify-between gap-3 px-1 pb-2", className)}>
      <Heading id={id} className="text-callout font-semibold text-ink-2">
        {children}
      </Heading>
      {action}
    </div>
  );
}

/* ---------- Row ---------- */

const rowBase =
  // flex-wrap: at 200% text the trailing slot drops under the label instead of overflowing
  "relative flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 bg-surface px-4 py-2.5 text-left " +
  // hairline between rows, inset to line up with the label
  "before:absolute before:top-0 before:right-0 before:h-px before:bg-line before:content-[''] first:before:hidden";

const rowInteractive =
  "transition-colors duration-150 ease-out hover:bg-pressed active:bg-pressed active:duration-0 " +
  "focus-visible:-outline-offset-2";

type Leading = "none" | "icon" | "tile";

const dividerInset: Record<Leading, string> = {
  none: "before:left-4",
  icon: "before:left-12",
  tile: "before:left-17",
};

export interface RowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Plain 20 px leading icon. */
  icon?: LucideIcon;
  /** Leading 40 px slot: a <Tile> or <Avatar size={40}>. Wins over `icon`. */
  leading?: ReactNode;
  /** Trailing value text (callout, ink-3). */
  value?: ReactNode;
  /** Trailing slot for anything else: a StatusPill, a text-action label. One thing only. */
  trailing?: ReactNode;
  /** Defaults to true for rows that navigate (href / onClick) and have no switch. */
  chevron?: boolean;
  /** Destructive row: danger label and icon. Lives in its own group. */
  danger?: boolean;
  /** Single line with ellipsis (document rows). Otherwise labels wrap. */
  truncate?: boolean;
  href?: string;
  onClick?: () => void;
  /** Switch row: pass both. The whole row is role="switch". */
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * The workhorse. 56 px single-line, 68 px with a description, and it grows
 * from there at larger text sizes. The whole row is the target; no nested
 * buttons inside a row that navigates.
 */
export function Row({
  label,
  description,
  icon,
  leading,
  value,
  trailing,
  chevron,
  danger = false,
  truncate = false,
  href,
  onClick,
  checked,
  onCheckedChange,
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: RowProps) {
  const isSwitch = checked !== undefined;
  const interactive = Boolean(href || onClick || isSwitch);
  const showChevron = chevron ?? (interactive && !isSwitch && !danger);
  const lead: Leading = leading ? "tile" : icon ? "icon" : "none";
  // no clamp by default: at large text sizes a label takes the lines it needs rather than clipping
  const clamp = truncate ? "truncate" : "break-words";

  const classes = cn(
    rowBase,
    dividerInset[lead],
    description ? "min-h-17" : "min-h-14",
    interactive && rowInteractive,
    disabled && "pointer-events-none opacity-45",
    className,
  );

  const body = (
    <>
      {/* Leading + text never split. Basis 9rem: once they'd get less than that, the trailing slot wraps under them. */}
      <span className="flex min-w-0 flex-[1_1_9rem] items-center gap-3">
        {leading ?? (icon && <Icon icon={icon} className={cn("size-5", danger ? "text-danger" : "text-ink-2")} />)}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("text-label", clamp, danger && "text-danger")}>{label}</span>
          {description && <span className={cn("text-callout text-ink-2", clamp)}>{description}</span>}
        </span>
      </span>
      {value && <span className="tabular ml-auto max-w-full text-right text-callout text-ink-3">{value}</span>}
      {trailing && <span className="ml-auto flex max-w-full shrink-0 items-center">{trailing}</span>}
      {isSwitch && <Switch checked={checked} className="ml-auto" />}
      {showChevron && <Icon icon={ChevronRight} className="size-4 text-ink-3" />}
    </>
  );

  if (isSwitch) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        className={classes}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {body}
      </button>
    );
  }
  if (href) {
    return (
      <Link href={href} aria-label={ariaLabel} className={classes} onClick={onClick}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" aria-label={ariaLabel} disabled={disabled} className={classes} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <div aria-label={ariaLabel} className={classes}>
      {body}
    </div>
  );
}

/* ---------- KeyValueRow ---------- */

export interface KeyValueRowProps {
  label: ReactNode;
  /** 17/500, right-aligned, tabular. */
  value: ReactNode;
  /** Smaller ink-3 text after the value: "in 4 yrs". */
  hint?: ReactNode;
  /** Set document numbers and codes in mono. */
  mono?: boolean;
  /** One text action beside the value: <Button variant="text" size="sm">Show</Button>. */
  action?: ReactNode;
  className?: string;
}

/** Details list row. Static: the only interactive thing in it is the optional action. */
export function KeyValueRow({ label, value, hint, mono = false, action, className }: KeyValueRowProps) {
  return (
    <div
      className={cn(
        rowBase,
        dividerInset.none,
        "min-h-13 justify-between",
        className,
      )}
    >
      <span className="text-callout text-ink-2">{label}</span>
      <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2.5 text-right">
        <span className={cn("tabular text-label break-words", mono && "font-mono tracking-[0.06em]")}>{value}</span>
        {hint && <span className="tabular text-callout text-ink-3">{hint}</span>}
        {action}
      </span>
    </div>
  );
}
