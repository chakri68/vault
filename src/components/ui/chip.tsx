"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";

export interface ChipProps {
  selected: boolean;
  onClick?: () => void;
  /** A 24 px <Avatar> for person chips. */
  avatar?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 36 px filter pill. Single-select for people, multi-select for tags; the parent decides. */
export function Chip({ selected, onClick, avatar, children, className }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "relative inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full border text-callout font-medium whitespace-nowrap",
        "transition-colors duration-150 ease-out motion-safe:active:scale-[.98] active:duration-0",
        // hit area out to 44
        "after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
        avatar ? "pr-3.5 pl-1.5" : "px-3.5",
        selected
          ? "border-ink bg-ink text-on-ink"
          : "border-line bg-surface text-ink hover:bg-pressed active:bg-pressed",
        className,
      )}
    >
      {avatar}
      {children}
    </button>
  );
}

export interface ChipRowProps {
  /** Names the filter: "Whose documents". */
  "aria-label": string;
  children: ReactNode;
  /** Scroll sideways (people on Home) or wrap (review screen). */
  overflow?: "scroll" | "wrap";
  className?: string;
}

export function ChipRow({ "aria-label": ariaLabel, children, overflow = "scroll", className }: ChipRowProps) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "flex gap-2",
        overflow === "scroll"
          ? // bleed to the screen edge so chips scroll under the gutter; room for the focus ring
            "-mx-4 overflow-x-auto px-4 py-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0.5 [&::-webkit-scrollbar]:hidden"
          : "flex-wrap",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  /** 2–4 mutually exclusive options. */
  options: ReadonlyArray<SegmentedOption<T>>;
  "aria-label": string;
  /** Stretch to the container, segments sharing the width equally. */
  fullWidth?: boolean;
  className?: string;
}

/** Radio group drawn as a pill. Arrow keys move the selection, as radios do. */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  "aria-label": ariaLabel,
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const hasSelection = options.some((o) => o.value === value);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = options.findIndex((o) => o.value === value);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % options.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    onValueChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn("gap-0.5 rounded-[1.375rem] bg-sunken p-[3px]", fullWidth ? "flex w-full" : "inline-flex", "flex-wrap", className)}
    >
      {options.map((option, i) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!hasSelection && i === 0) ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "min-h-9 rounded-full px-3.5 text-callout font-semibold transition-colors duration-150",
              fullWidth && "flex-1",
              selected ? "bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/.1)]" : "text-ink-2 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
