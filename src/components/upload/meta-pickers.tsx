"use client";

import type { Category, VaultProfile } from "@/schemas/index";
import { Avatar, type CatTint, Chip, ChipRow, GroupLabel, Icon, Section, categoryInfo } from "@/components/ui";

/** One category, or none. All of them visible at once: nothing to scroll for, nothing to discover. */
export function CategoryPicker({ categories, value, onChange }: {
  categories: Category[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  return (
    <Section>
      <GroupLabel as="h2">Category</GroupLabel>
      <ChipRow aria-label="Category" overflow="wrap">
        {categories.map((c) => {
          const info = categoryInfo(c.id, c.name);
          const selected = value === c.id;
          return (
            <Chip key={c.id} selected={selected} onClick={() => onChange(selected ? undefined : c.id)}
              avatar={<span className="grid size-6 place-items-center"><Icon icon={info.icon} className="size-4.5" /></span>}>
              {c.name}
            </Chip>
          );
        })}
      </ChipRow>
    </Section>
  );
}

/** Whose document it is. Organisational only: it decides where the document shows up, not who can open it. */
export function PeoplePicker({ profiles, value, onChange }: {
  profiles: VaultProfile[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  if (profiles.length === 0) return null;
  return (
    <Section>
      <GroupLabel as="h2">Whose is it?</GroupLabel>
      <ChipRow aria-label="Whose document" overflow="wrap">
        {profiles.map((p) => {
          const selected = value.includes(p.id);
          return (
            <Chip key={p.id} selected={selected}
              onClick={() => onChange(selected ? value.filter((x) => x !== p.id) : [...value, p.id])}
              avatar={<Avatar name={p.displayName} emoji={p.avatar?.type === "emoji" ? p.avatar.value : undefined} cat={(p.tint as CatTint) ?? "other"} />}>
              {p.displayName}
            </Chip>
          );
        })}
      </ChipRow>
    </Section>
  );
}
