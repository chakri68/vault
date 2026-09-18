"use client";

import { Avatar, type CatTint, Chip, ChipRow } from "@/components/ui";
import type { VaultProfile } from "@/schemas/index";

export interface PeopleChipsProps {
  profiles: VaultProfile[];
  /** null is "All" */
  value: string | null;
  onChange: (profileId: string | null) => void;
  "aria-label"?: string;
  overflow?: "scroll" | "wrap";
  className?: string;
}

const TINTS = new Set(["identity", "medical", "finance", "education", "employment", "insurance", "travel", "property", "legal", "photos", "other"]);

export function profileTint(profile: VaultProfile): CatTint {
  return (profile.tint && TINTS.has(profile.tint) ? profile.tint : "other") as CatTint;
}

/** "All", then each person. Single-select. Renders nothing for a vault with no people, where there's nothing to filter. */
export function PeopleChips({ profiles, value, onChange, "aria-label": label = "Whose documents", overflow, className }: PeopleChipsProps) {
  if (profiles.length === 0) return null;
  return (
    <ChipRow aria-label={label} overflow={overflow} className={className}>
      <Chip selected={value === null} onClick={() => onChange(null)}>All</Chip>
      {profiles.map((p) => (
        <Chip
          key={p.id}
          selected={value === p.id}
          onClick={() => onChange(p.id)}
          avatar={<Avatar name={p.displayName} emoji={p.avatar?.type === "emoji" ? p.avatar.value : undefined} cat={profileTint(p)} />}
        >
          {p.displayName}
        </Chip>
      ))}
    </ChipRow>
  );
}
