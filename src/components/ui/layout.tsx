"use client";

import Link from "next/link";
import { ChevronLeft, Folder, Plus, Settings } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "./cn";
import { Icon, type LucideIcon } from "./icon";

/* ---------- Screen ---------- */

export interface ScreenProps {
  children: ReactNode;
  /** Leaves room for the fixed bottom bar on phone and tablet. */
  bottomBar?: boolean;
  /** Vertical rhythm between sections. 24 px by default. */
  gap?: "sm" | "md" | "lg";
  className?: string;
}

const gaps = { sm: "gap-4", md: "gap-6", lg: "gap-7" };

/**
 * Page container. Gutters 16 / 24 / 32, content column 720 px on tablet and
 * 760 px on desktop, centred.
 */
export function Screen({ children, bottomBar = false, gap = "md", className }: ScreenProps) {
  return (
    <main
      className={cn(
        "flex w-full flex-1 flex-col px-4 pt-[env(safe-area-inset-top)] sm:px-6 lg:px-8",
        bottomBar ? "pb-[calc(env(safe-area-inset-bottom)+6rem)] lg:pb-10" : "pb-[calc(env(safe-area-inset-bottom)+2rem)]",
      )}
    >
      <div className={cn("mx-auto flex w-full max-w-[45rem] flex-1 flex-col lg:max-w-[47.5rem]", gaps[gap], className)}>
        {children}
      </div>
    </main>
  );
}

export interface ScreenHeaderProps {
  /** `display` for top-level screens, `title` for detail and step screens. */
  title: string;
  size?: "display" | "title";
  /** e.g. the labelled Lock pill. */
  trailing?: ReactNode;
  /** Body text under the title. */
  children?: ReactNode;
  className?: string;
}

/** Titles live below the bar as type, not inside it. */
export function ScreenHeader({ title, size = "display", trailing, children, className }: ScreenHeaderProps) {
  return (
    <header className={cn("pt-1.5", className)}>
      {/* wraps at large text sizes: the trailing action drops under the title instead of pushing it off-screen */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className={cn("min-w-0 break-words", size === "display" ? "text-display" : "text-title")}>{title}</h1>
        {trailing}
      </div>
      {children && <div className="mt-2 max-w-[65ch] text-callout text-ink-2">{children}</div>}
    </header>
  );
}

/** A group label plus whatever it labels, with the 8 px between them built in. */
export function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("flex flex-col", className)}>{children}</section>;
}

/* ---------- TopBar ---------- */

export interface TopBarProps {
  /** The previous screen's name: "Documents". Omit for no back button. */
  backLabel?: string;
  backHref?: string;
  onBack?: () => void;
  /** At most one text action: <Button variant="text">Edit</Button>. */
  action?: ReactNode;
  /** Quiet trailing text instead of an action: "Step 4 of 6". */
  trailing?: ReactNode;
  className?: string;
}

const backClass =
  "-ml-2 inline-flex min-h-11 min-w-0 items-center gap-0.5 rounded-full pr-2 pl-1 text-label text-accent " +
  "transition-opacity duration-150 hover:opacity-80 active:opacity-70 active:duration-0";

/** 52 px. Back on the left (chevron + where you came from), one text action on the right. */
export function TopBar({ backLabel, backHref, onBack, action, trailing, className }: TopBarProps) {
  const back = backLabel && (
    <>
      <Icon icon={ChevronLeft} className="size-6" />
      <span className="truncate">{backLabel}</span>
    </>
  );
  return (
    <div className={cn("flex min-h-13 items-center justify-between gap-3", className)}>
      {backLabel ? (
        backHref ? (
          <Link href={backHref} className={backClass} onClick={onBack} aria-label={backLabel === "Back" || backLabel === "Cancel" ? backLabel : `Back to ${backLabel}`}>
            {back}
          </Link>
        ) : (
          <button type="button" className={backClass} onClick={onBack} aria-label={backLabel === "Back" || backLabel === "Cancel" ? backLabel : `Back to ${backLabel}`}>
            {back}
          </button>
        )
      ) : (
        <span />
      )}
      {action && <span className="flex shrink-0 items-center">{action}</span>}
      {trailing && <span className="tabular shrink-0 text-callout text-ink-3">{trailing}</span>}
    </div>
  );
}

/* ---------- BottomBar ---------- */

export type BottomBarTab = "documents" | "settings";

export interface BottomBarProps {
  active: BottomBarTab | null;
  onAdd: () => void;
  documentsHref?: string;
  settingsHref?: string;
}

function Tab({ href, icon, label, current }: { href: string; icon: LucideIcon; label: string; current: boolean }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex min-h-[3em] min-w-0 flex-col items-center justify-center gap-[0.1875em] rounded-md transition-colors duration-150",
        current ? "text-ink" : "text-ink-3 hover:text-ink-2",
      )}
    >
      <Icon icon={icon} className="size-[1.5em]" />
      <span className="text-[0.8125em] leading-[1.125em] font-semibold tracking-[0.01em]">{label}</span>
    </Link>
  );
}

/**
 * Documents · Add · Settings, all labelled. Phone and tablet only; the desktop
 * sidebar replaces it from 1024 px.
 *
 * Sized in em off a capped font size: three labelled items can't physically
 * double on a 360 px screen, so the bar follows the OS text size up to ~120%
 * and then holds (what iOS tab bars do). Everything else scales all the way.
 */
export function BottomBar({ active, onAdd, documentsHref = "/", settingsHref = "/settings" }: BottomBarProps) {
  // lets the toast float above the bar instead of over it
  useEffect(() => {
    document.documentElement.dataset.bottomBar = "";
    return () => {
      delete document.documentElement.dataset.bottomBar;
    };
  }, []);

  return (
    <nav
      aria-label="Main"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface text-[min(1rem,19px)] lg:hidden",
        "px-[max(1.125em,env(safe-area-inset-left))] pt-[0.5em] pb-[max(0.5em,env(safe-area-inset-bottom))]",
      )}
    >
      <div className="mx-auto grid max-w-[45rem] grid-cols-[1fr_auto_1fr] items-center gap-[0.5em]">
        <Tab href={documentsHref} icon={Folder} label="Documents" current={active === "documents"} />
        <button
          type="button"
          onClick={onAdd}
          className={cn(
            "inline-flex min-h-[3em] items-center gap-[0.5em] rounded-full bg-ink pr-[1.375em] pl-[1.125em] text-on-ink",
            "transition-[opacity,scale] duration-150 ease-out hover:opacity-92 active:opacity-88 active:duration-0 motion-safe:active:scale-[.98]",
          )}
        >
          <Icon icon={Plus} className="size-[1.25em]" />
          <span className="text-[1.0625em] leading-[1.375em] font-semibold">Add</span>
        </button>
        <Tab href={settingsHref} icon={Settings} label="Settings" current={active === "settings"} />
      </div>
    </nav>
  );
}
