import { cn } from "./cn";

/**
 * Visual only, 51 × 31. The Row that contains it owns role="switch" and the
 * click, because the whole row toggles, not just this.
 */
export function Switch({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative h-[1.9375rem] w-[3.1875rem] shrink-0 rounded-full transition-colors duration-200",
        checked ? "bg-accent" : "bg-sunken-pressed",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-[1.6875rem] rounded-full bg-knob shadow-[0_1px_3px_rgb(0_0_0/.25)]",
          "transition-transform duration-200 ease-enter",
          checked && "translate-x-5",
        )}
      />
    </span>
  );
}
