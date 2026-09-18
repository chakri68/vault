"use client";

import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { cn } from "./cn";
import { Icon, type LucideIcon } from "./icon";

export type ButtonVariant = "primary" | "secondary" | "text" | "danger" | "danger-text";
export type ButtonSize = "lg" | "md" | "sm";

const base =
  // max-w-full + wrapping label: at 200% text a long label grows the pill instead of overflowing
  "relative inline-flex max-w-full shrink-0 items-center justify-center rounded-full py-1.5 text-center font-semibold " +
  "transition-[background-color,opacity,scale] duration-150 ease-out " +
  "motion-safe:active:scale-[.98] active:duration-0 " +
  "disabled:opacity-45 disabled:pointer-events-none aria-disabled:cursor-default";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-on-ink hover:opacity-92 active:opacity-88",
  secondary: "bg-sunken text-ink hover:bg-sunken-pressed active:bg-sunken-pressed",
  text: "text-accent hover:opacity-80 active:opacity-70",
  danger: "bg-danger text-on-danger hover:opacity-92 active:opacity-88",
  "danger-text": "text-danger hover:opacity-80 active:opacity-70",
};

// sm is 36 px tall; the ::after pads its hit area out to 44.
const hit = "after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']";

function sizeClass(variant: ButtonVariant, size: ButtonSize): string {
  const filled = variant !== "text" && variant !== "danger-text";
  if (!filled) {
    // text actions: no fill, 44 px target, tight horizontal padding
    return size === "sm" ? cn("min-h-9 px-1 text-callout", hit) : "min-h-11 px-2 text-label";
  }
  if (size === "lg") return "min-h-13 w-full px-5 text-label";
  if (size === "sm") return cn("min-h-9 px-3.5 text-callout", hit);
  return "min-h-12 px-5 text-label";
}

export function Spinner({ className }: { className?: string }) {
  return <Icon icon={LoaderCircle} className={cn("ui-spin size-5 animate-spin", className)} />;
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading 20 px icon. */
  icon?: LucideIcon;
  /** Keeps the width, swaps the icon for a spinner and shows `loadingLabel`. */
  loading?: boolean;
  /** The "-ing" form: "Saving…", "Unlocking…". */
  loadingLabel?: string;
  /** Renders a Next link that looks like a button. */
  href?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  loadingLabel,
  href,
  className,
  children,
  onClick,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  const classes = cn(base, variants[variant], sizeClass(variant, size), className);
  const iconSize = size === "sm" ? "size-4.5" : "size-5";

  // Both states share one grid cell, so the button is as wide as the wider one
  // and doesn't jump when the label changes to its "-ing" form. Buttons that
  // never load don't get the second layer, so it can't pad them out.
  const hasLoadingLayer = loading || loadingLabel !== undefined;
  const content = (
    <span className="grid place-items-center">
      <span className={cn("col-start-1 row-start-1 inline-flex items-center gap-2", loading && "invisible")}>
        {icon && <Icon icon={icon} className={iconSize} />}
        {children}
      </span>
      {hasLoadingLayer && (
        <span
          className={cn("col-start-1 row-start-1 inline-flex items-center gap-2", !loading && "invisible")}
          aria-hidden={!loading}
        >
          <Spinner className={iconSize} />
          {loadingLabel ?? <span className="sr-only">Working…</span>}
        </span>
      )}
    </span>
  );

  if (href && !loading && !rest.disabled) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClick={handleClick}
      {...rest}
    >
      {content}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  icon: LucideIcon;
  /** Required: back, close and clear-search are the only icon-only controls. */
  "aria-label": string;
  /**
   * `filled` draws the 32 px sunken disc (sheet close), `on-sunken` the same disc
   * one step darker for use inside the search pill, `plain` is just the glyph (back).
   */
  variant?: "filled" | "on-sunken" | "plain";
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ icon, variant = "filled", className, type = "button", ref, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "group/ib inline-grid size-11 shrink-0 place-items-center rounded-full text-ink-2",
        "disabled:opacity-45 disabled:pointer-events-none",
        className,
      )}
      {...rest}
    >
      <span
        className={cn(
          "grid place-items-center rounded-full transition-colors duration-150 ease-out group-active/ib:duration-0",
          variant === "filled" && "size-8 bg-sunken group-hover/ib:bg-sunken-pressed group-active/ib:bg-sunken-pressed",
          variant === "on-sunken" && "size-8 bg-sunken-pressed group-hover/ib:opacity-80 group-active/ib:opacity-70",
          variant === "plain" && "size-10 group-hover/ib:bg-pressed group-active/ib:bg-pressed",
        )}
      >
        <Icon icon={icon} className={variant === "plain" ? "size-6" : "size-4.5"} />
      </span>
    </button>
  );
}
