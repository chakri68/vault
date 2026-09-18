import { Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./cn";
import { Icon, type LucideIcon } from "./icon";

/* ---------- Banner ---------- */

export type BannerTone = "warn" | "danger" | "info";

export interface BannerAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface BannerProps {
  tone?: BannerTone;
  /** Defaults per tone: triangle-alert for warn/danger, info for info. */
  icon?: LucideIcon;
  title: string;
  children?: ReactNode;
  /** Rendered as a small secondary button. */
  action?: BannerAction;
  /** Rendered as a text action. Two actions at most. */
  secondaryAction?: BannerAction;
  className?: string;
}

const bannerTone: Record<BannerTone, { bg: string; fg: string; icon: LucideIcon }> = {
  warn: { bg: "bg-warn-soft", fg: "text-warn", icon: TriangleAlert },
  danger: { bg: "bg-danger-soft", fg: "text-danger", icon: TriangleAlert },
  info: { bg: "bg-accent-soft", fg: "text-accent", icon: Info },
};

/** An inline notice in the content flow. Never a modal. */
export function Banner({ tone = "warn", icon, title, children, action, secondaryAction, className }: BannerProps) {
  const t = bannerTone[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-lg p-4", t.bg, className)}>
      <Icon icon={icon ?? t.icon} className={cn("mt-px size-5", t.fg)} />
      <div className="min-w-0 flex-1">
        <h3 className="text-label font-semibold">{title}</h3>
        {children && <div className="mt-0.5 text-callout text-ink-2">{children}</div>}
        {(action || secondaryAction) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            {action && (
              <Button
                variant="secondary"
                size="sm"
                href={action.href}
                onClick={action.onClick}
                className="bg-surface! hover:bg-pressed! active:bg-pressed!"
              >
                {action.label}
              </Button>
            )}
            {secondaryAction && (
              <Button variant="text" size="sm" href={secondaryAction.href} onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- ProgressBar ---------- */

export interface ProgressBarProps {
  /** Plain words: "Encrypting on your phone…". Shown above the track. */
  label: string;
  /** 0–100. Omit for indeterminate. */
  value?: number;
  className?: string;
}

/** 8 px track with the label above it. Never a lone spinner for anything over 2 s. */
export function ProgressBar({ label, value, className }: ProgressBarProps) {
  const determinate = value !== undefined;
  const pct = determinate ? Math.max(0, Math.min(100, Math.round(value))) : undefined;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3 text-callout">
        <span>{label}</span>
        {determinate && <span className="tabular text-ink-2">{pct}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full bg-sunken"
      >
        {determinate ? (
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <span className="ui-loop anim-shimmer block h-full w-2/5 rounded-full bg-accent" />
        )}
      </div>
    </div>
  );
}

/* ---------- StatusPill ---------- */

export type StatusTone = "good" | "warn" | "danger" | "neutral";

const pillTone: Record<StatusTone, string> = {
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-sunken text-ink-2",
};

export interface StatusPillProps {
  tone: StatusTone;
  /** Required: status is never colour alone, so every pill has an icon and a word. */
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}

export function StatusPill({ tone, icon, children, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        // no nowrap: at 200% text a long status wraps inside the pill rather than overflowing
        "tabular inline-flex min-h-7 max-w-full shrink-0 items-center gap-1.5 rounded-[0.875rem] px-2.5 py-0.5 text-[0.875rem] leading-5 font-semibold",
        pillTone[tone],
        className,
      )}
    >
      <Icon icon={icon} className="size-[0.9375rem]" />
      {children}
    </span>
  );
}

/** A neutral pill that takes any leading node (a category glyph, a tiny avatar). For meta chips on the document screen. */
export function MetaPill({ leading, children, className }: { leading?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 max-w-full shrink-0 items-center gap-1.5 rounded-[0.875rem] bg-sunken px-2.5 py-0.5 text-[0.875rem] leading-5 font-semibold text-ink-2",
        className,
      )}
    >
      {leading}
      {children}
    </span>
  );
}

/* ---------- Availability ---------- */

export interface AvailabilityProps {
  onDevice: boolean;
  className?: string;
}

/** Two states, plain words, a filled or hollow dot. Detail screen and search results only. */
export function Availability({ onDevice, className }: AvailabilityProps) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-callout whitespace-nowrap text-ink-2", className)}>
      <span
        aria-hidden
        className={cn("size-2.5 shrink-0 rounded-full", onDevice ? "bg-good" : "border-2 border-ink-3")}
      />
      {onDevice ? "On this device" : "Needs internet"}
    </span>
  );
}

/* ---------- Skeleton ---------- */

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("ui-loop anim-pulse block rounded-sm bg-sunken", className)} />;
}

/** Same geometry as a real two-line row with a tile, so nothing jumps when data lands. */
export function SkeletonRow({ tile = true }: { tile?: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex min-h-17 items-center gap-3 bg-surface px-4 py-2.5",
        "before:absolute before:top-0 before:right-0 before:h-px before:bg-line before:content-[''] first:before:hidden",
        tile ? "before:left-17" : "before:left-4",
      )}
    >
      {tile && <Skeleton className="size-10 rounded-md" />}
      <span className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3.5 w-2/5" />
      </span>
    </div>
  );
}

export function SkeletonRows({ count = 3, tile = true }: { count?: number; tile?: boolean }) {
  return (
    <div role="status" aria-label="Loading" className="overflow-hidden rounded-lg bg-surface">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} tile={tile} />
      ))}
    </div>
  );
}
