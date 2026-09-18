export type ClassValue = string | false | null | undefined;

/** Joins truthy class names. No merge logic: later classes don't override earlier ones. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
