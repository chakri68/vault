import {
  Briefcase,
  Folder,
  GraduationCap,
  HeartPulse,
  House,
  IdCard,
  Image as ImageIcon,
  Plane,
  Receipt,
  Scale,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/** Values of the `data-cat` attribute that globals.css knows how to tint. */
export type CatTint =
  | "identity"
  | "medical"
  | "finance"
  | "education"
  | "employment"
  | "insurance"
  | "travel"
  | "property"
  | "legal"
  | "photos"
  | "other";

export type DefaultCategoryId = Exclude<CatTint, "other"> | "receipts" | "other";

export interface CategoryInfo {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Pass to `data-cat` (Tile, Avatar, CategoryTile do this for you). */
  cat: CatTint;
}

export const CATEGORIES: Record<DefaultCategoryId, CategoryInfo> = {
  identity: { id: "identity", label: "Identity", icon: IdCard, cat: "identity" },
  medical: { id: "medical", label: "Medical", icon: HeartPulse, cat: "medical" },
  finance: { id: "finance", label: "Finance", icon: Wallet, cat: "finance" },
  education: { id: "education", label: "Education", icon: GraduationCap, cat: "education" },
  employment: { id: "employment", label: "Employment", icon: Briefcase, cat: "employment" },
  insurance: { id: "insurance", label: "Insurance", icon: ShieldCheck, cat: "insurance" },
  travel: { id: "travel", label: "Travel", icon: Plane, cat: "travel" },
  property: { id: "property", label: "Property", icon: House, cat: "property" },
  legal: { id: "legal", label: "Legal", icon: Scale, cat: "legal" },
  photos: { id: "photos", label: "Photos", icon: ImageIcon, cat: "photos" },
  receipts: { id: "receipts", label: "Receipts", icon: Receipt, cat: "other" },
  other: { id: "other", label: "Other", icon: Folder, cat: "other" },
};

export const DEFAULT_CATEGORY_IDS = Object.keys(CATEGORIES) as DefaultCategoryId[];

/** Tints that make sense for a profile avatar (everything but the neutral). */
export const AVATAR_TINTS: CatTint[] = [
  "photos",
  "identity",
  "finance",
  "education",
  "employment",
  "insurance",
  "travel",
  "property",
  "medical",
  "legal",
];

/** Custom categories get the neutral tint and a folder. */
export function categoryInfo(id: string | undefined, customLabel?: string): CategoryInfo {
  if (id && id in CATEGORIES) return CATEGORIES[id as DefaultCategoryId];
  return { id: id ?? "other", label: customLabel ?? id ?? "Other", icon: Folder, cat: "other" };
}
