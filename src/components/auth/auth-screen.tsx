"use client";

import { TriangleAlert } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { Icon, cn } from "@/components/ui";

interface AuthScreenProps {
  /** a TopBar, plus anything pinned under it (step progress) */
  bar?: ReactNode;
  children: ReactNode;
  /** the action stack: bottom of the screen on a phone, in thumb reach */
  actions?: ReactNode;
  /** wraps everything in a form, so Enter does what the primary button does */
  onSubmit?: () => void;
  className?: string;
}

/**
 * The scaffold for every screen outside the vault: lock, help, setup. A phone
 * column (centred on anything wider) with the content at the top and the
 * actions anchored at the bottom. Nothing is fixed, so at 200% text the page
 * just gets taller and scrolls.
 */
export function AuthScreen({ bar, children, actions, onSubmit, className }: AuthScreenProps) {
  const body = (
    <>
      {bar && <div className="flex flex-col gap-1 pt-[env(safe-area-inset-top)]">{bar}</div>}
      <div className={cn("flex flex-1 flex-col gap-5 sm:flex-none", !bar && "pt-[calc(env(safe-area-inset-top)+2.75rem)]", className)}>
        {children}
      </div>
      {actions && (
        <div className="flex flex-col gap-3.5 pt-8 pb-[calc(env(safe-area-inset-bottom)+1.875rem)]">{actions}</div>
      )}
    </>
  );
  const column = "mx-auto flex w-full max-w-[27.5rem] flex-1 flex-col px-5 sm:my-auto sm:flex-none sm:py-10";
  return (
    <main className="flex min-h-dvh w-full flex-col print:hidden">
      {onSubmit ? (
        <form
          noValidate
          className={column}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {body}
        </form>
      ) : (
        <div className={column}>{body}</div>
      )}
    </main>
  );
}

/** Title + lede for step and help screens. */
export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2 pt-3">
      <h1 className="text-title">{title}</h1>
      {children && <div className="flex max-w-[65ch] flex-col gap-2 text-callout text-ink-2">{children}</div>}
    </header>
  );
}

/** An error that belongs to a button rather than a field. Says what to do next. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-callout text-danger">
      <Icon icon={TriangleAlert} className="mt-px size-4.5" />
      <span>{children}</span>
    </p>
  );
}

/** Thin indeterminate line for work that takes about a second (§37). Keeps its space, so nothing jumps. */
export function WorkingLine({ active, label }: { active: boolean; label: string }) {
  return (
    <div
      role={active ? "progressbar" : undefined}
      aria-label={active ? label : undefined}
      aria-hidden={!active}
      className={cn("h-1 overflow-hidden rounded-full", active ? "bg-sunken" : "bg-transparent")}
    >
      {active && <span className="ui-loop anim-shimmer block h-full w-2/5 rounded-full bg-accent" />}
    </div>
  );
}

/** "about 15 minutes", "a minute": how long a rate limit asks someone to wait, in words. */
export function waitWords(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "a few minutes";
  if (seconds < 90) return "a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}
