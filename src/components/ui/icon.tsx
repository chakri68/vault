import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";

export type { LucideIcon };

interface IconProps {
  icon: LucideIcon;
  /** Tailwind size class. Rem-based so icons follow the OS text size. Default 20 px. */
  className?: string;
  /** Only for the rare icon that stands alone. Beside a label, icons stay hidden. */
  label?: string;
}

/** Lucide at the house stroke (1.75). Hidden from assistive tech unless labelled. */
export function Icon({ icon: Glyph, className, label }: IconProps) {
  return (
    <Glyph
      strokeWidth={1.75}
      absoluteStrokeWidth={false}
      className={cn("shrink-0", className ?? "size-5")}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
