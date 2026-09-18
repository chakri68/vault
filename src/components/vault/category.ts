import { type CategoryInfo, categoryInfo } from "@/components/ui";
import type { IndexEntry, VaultIndex } from "@/schemas/index";

/** Icon and tint from the design system, name from the vault (so a custom category reads as the family typed it). */
export function categoryOf(index: VaultIndex, id: string | undefined): CategoryInfo {
  const stored = index.categories.find((c) => c.id === (id ?? "other") && !c.deletedAt);
  const info = categoryInfo(id ?? "other", stored?.name);
  return stored ? { ...info, label: stored.name } : info;
}

export const categoryHref = (id: string, from?: "categories") =>
  `/category?c=${encodeURIComponent(id)}${from ? `&from=${from}` : ""}`;

export const documentHref = (entry: Pick<IndexEntry, "id">) => `/doc?id=${entry.id}`;

/** "No insurance documents yet." Default names read better lowercased; a custom one stays as typed. */
export function emptyCategoryMessage(info: CategoryInfo, isDefault: boolean): string {
  return `No ${isDefault ? info.label.toLowerCase() : info.label} documents yet.`;
}
