import type { ReactNode } from "react";
import type { CatTint } from "./categories";
import { cn } from "./cn";
import { Icon, type LucideIcon } from "./icon";

export interface TileProps {
  /** Category tint. Custom categories use "other". */
  cat?: CatTint;
  icon?: LucideIcon;
  /** 40 px in rows, 36 px in category tiles. */
  size?: 36 | 40;
  /** Replaces the icon (an encrypted thumbnail, later). */
  children?: ReactNode;
  className?: string;
}

/** The tinted icon square that leads a row. Colour is a scanning aid; the label carries meaning. */
export function Tile({ cat = "other", icon, size = 40, children, className }: TileProps) {
  return (
    <span
      data-cat={cat}
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden bg-(--cat-bg) text-(--cat-fg)",
        size === 40 ? "size-10 rounded-md" : "size-9 rounded-[0.625rem]",
        className,
      )}
    >
      {children ?? (icon && <Icon icon={icon} className={size === 40 ? "size-5.5" : "size-5"} />)}
    </span>
  );
}

export interface AvatarProps {
  /** Used for the initial when no emoji is given. */
  name: string;
  emoji?: string;
  cat?: CatTint;
  size?: 24 | 32 | 40;
  className?: string;
}

const avatarSize: Record<NonNullable<AvatarProps["size"]>, string> = {
  24: "size-6 text-[0.8125rem]",
  32: "size-8 text-callout",
  40: "size-10 text-body",
};

/** Organisational only. Nothing about an avatar implies privacy (§21.2). */
export function Avatar({ name, emoji, cat = "other", size = 24, className }: AvatarProps) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span
      data-cat={cat}
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-(--cat-bg) font-bold leading-none text-(--cat-fg)",
        avatarSize[size],
        className,
      )}
    >
      {emoji ?? initial}
    </span>
  );
}
