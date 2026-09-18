import { istDate, istDateStamp } from "@/lib/format";

/**
 * <input type="date"> speaks "2031-03-12". Stored dates are full timestamps at
 * noon IST, and every date in the app is read back in IST too, so the day is
 * the same on every device wherever it happens to be.
 */
export function dateInputToIso(value: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = istDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function isoToDateInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return istDateStamp(d);
}

export const TEMPORARY_OPTIONS = [
  { id: "1h", label: "1 hour", ms: 3_600_000 },
  { id: "24h", label: "24 hours", ms: 86_400_000 },
  { id: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 days", ms: 30 * 86_400_000 },
] as const;

export type TemporaryChoice = (typeof TEMPORARY_OPTIONS)[number]["id"] | "date";

/** When a temporary file should go, from the chip that was picked. A chosen date means the end of that day. */
export function temporaryExpiry(choice: TemporaryChoice, dateValue: string, now = Date.now()): string | undefined {
  if (choice === "date") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
    if (!m) return undefined;
    return istDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).toISOString();
  }
  const option = TEMPORARY_OPTIONS.find((o) => o.id === choice);
  return option ? new Date(now + option.ms).toISOString() : undefined;
}

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", avif: "image/avif", gif: "image/gif", bmp: "image/bmp",
  txt: "text/plain", csv: "text/csv", md: "text/plain",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Pickers sometimes hand over a file with no type at all; the extension is the next best thing. */
export function mimeTypeFor(file: { type: string }, extension: string): string {
  return file.type || EXTENSION_TYPES[extension] || "application/octet-stream";
}

/** "JPEG", "PDF", "Word document": what a person would call it. */
export function kindLabel(mimeType: string, extension: string): string {
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType === "image/jpeg") return "JPEG";
  if (mimeType.startsWith("image/")) return mimeType.slice(6).toUpperCase();
  if (mimeType.startsWith("text/")) return "Text";
  if (/word/.test(mimeType)) return "Word document";
  if (/sheet|excel/.test(mimeType)) return "Spreadsheet";
  return extension ? extension.toUpperCase() : "File";
}
